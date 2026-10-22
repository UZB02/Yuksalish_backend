import { Types } from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Photo } from '../src/models/Photo';
import { Student } from '../src/models/Student';
import { User } from '../src/models/User';
import { publicCache } from '../src/modules/public/public.cache';
import { photoExpiry, signPhoto } from '../src/modules/photos/photos.url';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  Score,
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let cls: Doc;
let student: Doc;
let teacher: Doc;
let admin: string;
let teacherToken: string;
let root: string;

const NOW = '2026-10-14T07:00:00Z';

async function img(
  format: 'jpeg' | 'png' | 'webp',
  w = 800,
  h = 600,
  meta: Record<string, unknown> = {},
) {
  const base = sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } },
  });
  const withMeta = Object.keys(meta).length ? base.withMetadata(meta) : base;
  return withMeta.toFormat(format).toBuffer();
}

function binaryParser(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

const sendPhoto = (
  path: string,
  token: string,
  buf: Buffer,
  opts: { type?: string; name?: string; extra?: Record<string, string> } = {},
) =>
  request(app)
    .put(`/api/v1${path}`)
    .set(bearer(token))
    .set(opts.extra ?? {})
    .attach('photo', buf, {
      filename: opts.name ?? 'rasm.jpg',
      contentType: opts.type ?? 'image/jpeg',
    });

const putStudentPhoto = (token: string, buf: Buffer, id = student.id) =>
  sendPhoto(`/students/${id}/photo`, token, buf);

const del = (path: string, token: string) =>
  request(app).delete(`/api/v1${path}`).set(bearer(token));

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('demo-a');
  other = await makeSchool('demo-b');
  year = await makeYear(school.id);
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'teacher2', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'adm-noperm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  await makeUser({
    username: 'adm-other',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  cls = await makeClass(school.id, year.id, '5-A', [teacher.id]);
  student = await makeStudent(school.id, cls.id, 'Aliyev Ali');
  admin = (await login('adm')).token;
  teacherToken = (await login('teacher1')).token;
  root = (await login('root')).token;
});

describe('Rasm yuklash: qayta ishlash', () => {
  it('JPEG: WebP, max 512x512, kvadrat, EXIF/GPS metadata ochadi', async () => {
    const src = await img('jpeg', 1600, 1200, {
      orientation: 6,
      exif: { IFD0: { Copyright: 'maxfiy-egasi', Artist: 'maxfiy-fotograf' } },
    });
    expect((await sharp(src).metadata()).exif).toBeDefined(); // manbada EXIF bor
    const res = await putStudentPhoto(admin, src);
    expect(res.status).toBe(200);
    const url = res.body.data.photo as string;
    expect(url).toMatch(/^\/api\/v1\/photos\/[0-9a-f]{24}\?exp=\d+&sig=[\w-]+$/);

    const doc = await Photo.findOne({ ownerId: student.id }).select('+data');
    expect(doc!.contentType).toBe('image/webp');
    expect(doc!.width).toBe(512);
    expect(doc!.height).toBe(512);
    const meta = await sharp(doc!.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(doc!.data.includes('maxfiy')).toBe(false);
    expect(doc!.data.includes(Buffer.from('EXIF'))).toBe(false);
  });

  it('PNG va WebP qabul qilinadi; kichik rasm kattalashtirilmaydi (kvadrat kesiladi)', async () => {
    expect((await putStudentPhoto(admin, await img('png', 300, 200))).status).toBe(200);
    let p = await Photo.findOne({ ownerId: student.id });
    expect([p!.width, p!.height]).toEqual([200, 200]);
    expect((await putStudentPhoto(admin, await img('webp', 700, 900))).status).toBe(200);
    p = await Photo.findOne({ ownerId: student.id });
    expect([p!.width, p!.height]).toEqual([512, 512]);
  });

  it('notogri tur, soxta magic bytes, katta hajm va fayl yoq - 400', async () => {
    const txt = await sendPhoto(`/students/${student.id}/photo`, admin, Buffer.from('hi'), {
      type: 'text/plain',
      name: 'a.txt',
    });
    expect(txt.status).toBe(400);
    const gif = Buffer.from('GIF89a' + 'x'.repeat(50));
    expect((await putStudentPhoto(admin, gif)).status).toBe(400); // jpeg deb yuborilgan GIF
    const fake = await putStudentPhoto(admin, Buffer.from('bu rasm emas, oddiy matn'));
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('VALIDATION_ERROR');
    // magic bytes togri, lekin ichi buzuq
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    expect((await putStudentPhoto(admin, broken)).status).toBe(400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)]);
    const bigRes = await putStudentPhoto(admin, big);
    expect(bigRes.status).toBe(400);
    expect(bigRes.body.error.message).toContain('5 MB');
    const none = await request(app).put(`/api/v1/students/${student.id}/photo`).set(bearer(admin));
    expect(none.status).toBe(400);
    expect(await Photo.countDocuments()).toBe(0);
  });
});

describe('Rasm: ruxsatlar', () => {
  it('oquvchi rasmi: admin va superadmin ok; ruxsatsiz admin, oqituvchi 403; boshqa maktab 404', async () => {
    const buf = await img('jpeg');
    expect((await putStudentPhoto(admin, buf)).status).toBe(200);
    expect((await putStudentPhoto(root, buf)).status).toBe(400); // X-School-Id yoq
    const asRoot = await sendPhoto(`/students/${student.id}/photo`, root, buf, {
      extra: { 'X-School-Id': school.id },
    });
    expect(asRoot.status).toBe(200);
    const noPerm = (await login('adm-noperm')).token;
    expect((await putStudentPhoto(noPerm, buf)).status).toBe(403);
    expect((await putStudentPhoto(teacherToken, buf)).status).toBe(403);
    const otherAdmin = (await login('adm-other')).token;
    expect((await putStudentPhoto(otherAdmin, buf)).status).toBe(404);
    expect((await del(`/students/${student.id}/photo`, teacherToken)).status).toBe(403);
    expect((await del(`/students/${student.id}/photo`, otherAdmin)).status).toBe(404);
    const anon = await request(app)
      .put(`/api/v1/students/${student.id}/photo`)
      .attach('photo', buf, 'a.jpg');
    expect(anon.status).toBe(401);
  });

  it('oqituvchi rasmi: admin ok; oqituvchi boshqasiniki 403; ozini /auth/me/photo; boshqa maktab 404', async () => {
    const buf = await img('png', 400, 400);
    const png = { type: 'image/png', name: 'a.png' };
    const t = `/teachers/${teacher.id}/photo`;
    const ok = await sendPhoto(t, admin, buf, png);
    expect(ok.status).toBe(200);
    expect(ok.body.data.photo).toContain('/api/v1/photos/');
    expect((await sendPhoto(t, teacherToken, buf, png)).status).toBe(403);
    const noPerm = (await login('adm-noperm')).token;
    expect((await sendPhoto(t, noPerm, buf, png)).status).toBe(403);
    const otherAdmin = (await login('adm-other')).token;
    expect((await sendPhoto(t, otherAdmin, buf, png)).status).toBe(404);
    expect((await del(t, teacherToken)).status).toBe(403);

    const t2 = (await login('teacher2')).token;
    const own = await sendPhoto('/auth/me/photo', t2, buf, png);
    expect(own.status).toBe(200);
    expect(own.body.data.photo).toContain('/api/v1/photos/');
    expect((await User.findOne({ username: 'teacher2' }))!.photoId).not.toBeNull();
    const me = await request(app).get('/api/v1/auth/me').set(bearer(t2));
    expect(me.body.data.photo).toContain('/api/v1/photos/');
    const rm = await del('/auth/me/photo', t2);
    expect(rm.status).toBe(200);
    expect(rm.body.data.photo).toBeNull();
    expect((await User.findOne({ username: 'teacher2' }))!.photoId).toBeNull();
    // admin qoygan teacher1 rasmi tegilmadi
    expect((await User.findById(teacher.id))!.photoId).not.toBeNull();
    // superadmin (maktabsiz) ozi uchun qoya olmaydi
    expect((await sendPhoto('/auth/me/photo', root, buf, png)).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'teacher.photo_upload' })).toBe(2);
  });
});

describe('Rasm: almashtirish, ochirish, audit', () => {
  it('almashtirish eskisini ochiradi (yangi havola); ochirish photo=null; audit yoziladi', async () => {
    const r1 = await putStudentPhoto(admin, await img('jpeg'));
    const r2 = await putStudentPhoto(admin, await img('png', 500, 500));
    expect(r1.body.data.photo).not.toBe(r2.body.data.photo);
    expect(await Photo.countDocuments({ ownerId: student.id })).toBe(1);
    const stored = await Student.findById(student.id);
    expect(await Photo.exists({ _id: stored!.photoId })).toBeTruthy();

    const list = await request(app).get('/api/v1/students').set(bearer(admin));
    expect(list.body.data[0].photo).toBe(r2.body.data.photo);

    const rm = await del(`/students/${student.id}/photo`, admin);
    expect(rm.status).toBe(200);
    expect(rm.body.data.photo).toBeNull();
    expect(await Photo.countDocuments()).toBe(0);
    expect((await Student.findById(student.id))!.photoId).toBeNull();
    expect((await del(`/students/${student.id}/photo`, admin)).status).toBe(200);

    expect(await AuditLog.countDocuments({ action: 'student.photo_upload' })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'student.photo_delete' })).toBe(1);
  });

  it('oquvchi ochirilganda rasmi ham ochadi', async () => {
    await putStudentPhoto(admin, await img('jpeg'));
    expect(await Photo.countDocuments()).toBe(1);
    expect((await del(`/students/${student.id}`, admin)).status).toBe(200);
    expect(await Photo.countDocuments()).toBe(0);
  });
});

describe('Rasm berish (imzolangan havola)', () => {
  it('200 + ETag/Cache-Control, 304; imzo/muddat/id xato - 401/404', async () => {
    const up = await putStudentPhoto(admin, await img('jpeg'));
    const url = up.body.data.photo as string;

    const res = await request(app).get(url).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const etag = res.headers.etag;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await sharp(res.body as Buffer).metadata()).format).toBe('webp');

    expect((await request(app).get(url).set('If-None-Match', etag)).status).toBe(304);

    // tokensiz ishlaydi (img tegi), lekin imzosiz/yaroqsiz - yoq
    const [path] = url.split('?');
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(`${path}?exp=${photoExpiry()}&sig=abc`)).status).toBe(401);
    const id = path.split('/').pop() as string;
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = await request(app).get(`${path}?exp=${past}&sig=${signPhoto(id, past)}`);
    expect(expired.status).toBe(401);
    const otherId = new Types.ObjectId().toString();
    const exp = photoExpiry();
    const moved = await request(app).get(
      `/api/v1/photos/${otherId}?exp=${exp}&sig=${signPhoto(id, exp)}`,
    );
    expect(moved.status).toBe(401); // boshqa id ga kochirilgan imzo
    const missing = await request(app).get(
      `/api/v1/photos/${otherId}?exp=${exp}&sig=${signPhoto(otherId, exp)}`,
    );
    expect(missing.status).toBe(404);
  });

  it('royxatda havola bor, rasmsizlarda null', async () => {
    await putStudentPhoto(admin, await img('jpeg'));
    await makeStudent(school.id, cls.id, 'Valiyev Vali');
    const list = await request(app).get('/api/v1/students').set(bearer(teacherToken));
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(
      list.body.data.map((s: { fullName: string; photo: string | null }) => [s.fullName, s.photo]),
    );
    expect(byName['Aliyev Ali']).toContain('/api/v1/photos/');
    expect(byName['Valiyev Vali']).toBeNull();
  });
});

describe('Public rasm', () => {
  const put = (body: object) =>
    request(app).put('/api/v1/settings/public').set(bearer(root)).send(body);
  const enable = (extra: object = {}) =>
    put({ scope: 'school', schoolId: school.id, values: { enabled: true, ...extra } });
  const pub = (path: string) => request(app).get(`/api/v1/public${path}`);
  let photoId: string;

  beforeEach(async () => {
    publicCache.clear();
    const btype = await makeBehaviorType('Xulq');
    for (let d = 1; d <= 3; d++) {
      await Score.create({
        schoolId: school.id,
        studentId: student._id,
        classId: cls._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: btype._id,
        value: 90,
        date: `2026-10-0${d}`,
      });
    }
    await putStudentPhoto(admin, await img('jpeg'));
    photoId = String((await Student.findById(student.id))!.photoId);
  });

  it('standart: showPhotos=false -> 404 va reytingda photoUrl maydoni yoq', async () => {
    await enable();
    expect((await pub(`/demo-a/photos/${photoId}`)).status).toBe(404);
    const st = await pub('/demo-a/rating/students');
    expect(st.status).toBe(200);
    expect(st.body.data.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(st.body)).not.toContain('photoUrl');
    expect(JSON.stringify(st.body)).not.toContain(photoId);
    expect((await pub('/demo-a/config')).body.data.showPhotos).toBe(false);
  });

  it('showPhotos=true -> 200 (public kesh), reytingda photoUrl', async () => {
    expect((await enable({ showPhotos: true })).status).toBe(200);
    publicCache.clear();
    const res = await pub(`/demo-a/photos/${photoId}`).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const cond = await pub(`/demo-a/photos/${photoId}`).set('If-None-Match', res.headers.etag);
    expect(cond.status).toBe(304);
    const st = await pub('/demo-a/rating/students');
    expect(st.body.data.items[0].photoUrl).toBe(`/api/v1/public/demo-a/photos/${photoId}`);
    expect(JSON.stringify(st.body)).not.toContain(student.id);
    expect((await pub('/demo-a/config')).body.data.showPhotos).toBe(true);
  });

  it('nofaol oquvchi, boshqa maktab slug i, notogri id - 404', async () => {
    await enable({ showPhotos: true });
    await put({ scope: 'school', schoolId: other.id, values: { enabled: true, showPhotos: true } });
    publicCache.clear();
    expect((await pub(`/demo-b/photos/${photoId}`)).status).toBe(404);
    expect((await pub(`/demo-a/photos/${new Types.ObjectId()}`)).status).toBe(404);
    expect((await pub('/demo-a/photos/not-an-id')).status).toBe(404);
    expect((await pub(`/demo-a/photos/${photoId}`)).status).toBe(200);
    await Student.updateOne({ _id: student.id }, { status: 'transferred' });
    expect((await pub(`/demo-a/photos/${photoId}`)).status).toBe(404);
    await Student.updateOne({ _id: student.id }, { status: 'active', isDeleted: true });
    expect((await pub(`/demo-a/photos/${photoId}`)).status).toBe(404);
  });

  it('rasmsiz oquvchida photoUrl null; oqituvchi rasmi public orqali berilmaydi', async () => {
    const s2 = await makeStudent(school.id, cls.id, 'Rasmsiz Bola');
    const btype = await makeBehaviorType('Xulq2');
    for (let d = 1; d <= 3; d++) {
      await Score.create({
        schoolId: school.id,
        studentId: s2._id,
        classId: cls._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: btype._id,
        value: 50,
        date: `2026-10-0${d}`,
      });
    }
    await enable({ showPhotos: true });
    const items = (await pub('/demo-a/rating/students')).body.data.items as {
      fullName: string;
      photoUrl: string | null;
    }[];
    expect(items.find((i) => i.fullName === 'Rasmsiz Bola')!.photoUrl).toBeNull();
    await sendPhoto(`/teachers/${teacher.id}/photo`, admin, await img('jpeg'));
    const tphoto = String((await User.findById(teacher.id))!.photoId);
    expect((await pub(`/demo-a/photos/${tphoto}`)).status).toBe(404);
  });

  it('sozlama: showPhotos faqat boolean; maktab admini public sozlamani ozgartira olmaydi', async () => {
    const bad = await put({ scope: 'school', schoolId: school.id, values: { showPhotos: 'yes' } });
    expect(bad.status).toBe(400);
    const adminPut = await request(app)
      .put('/api/v1/settings/public')
      .set(bearer(admin))
      .send({ scope: 'school', schoolId: school.id, values: { showPhotos: true } });
    expect(adminPut.status).toBe(403);
    const global = await put({ scope: 'global', values: { showPhotos: true } });
    expect(global.status).toBe(200);
    const eff = await request(app).get('/api/v1/settings/public').set(bearer(root));
    expect(eff.body.data.global.showPhotos).toBe(true);
  });
});
