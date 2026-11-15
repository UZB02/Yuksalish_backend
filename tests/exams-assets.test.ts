import request from 'supertest';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ExamAsset } from '../src/models/ExamAsset';
import {
  isShortAnswerCorrect,
  normalizeShortAnswer,
} from '../src/modules/exams/questions.normalize';
import { settingsStore } from '../src/modules/settings/settings.store';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let admin: string, otherAdmin: string, teacher: string, plain: string, offAdmin: string;

const png = (w = 40, h = 30, color = '#c81e1e') =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toBuffer();

const upload = (token: string, buf: Buffer, opts: { type?: string; name?: string } = {}) =>
  request(app)
    .post('/api/v1/exams/assets')
    .set(bearer(token))
    .attach('image', buf, {
      filename: opts.name ?? 'a.png',
      contentType: opts.type ?? 'image/png',
    });

const download = (token: string, id: string, extra: Record<string, string> = {}) =>
  request(app)
    .get(`/api/v1/exams/assets/${id}`)
    .set({ ...bearer(token), ...extra })
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const off = await makeSchool('off');
  const root = await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['exams.manage'],
  });
  await makeUser({
    username: 'oadmin',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['exams.manage'],
  });
  await makeUser({
    username: 'aoff',
    role: 'school_admin',
    schoolId: off.id,
    permissions: ['exams.manage'],
  });
  await makeUser({
    username: 'plain',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, root.id);
  admin = (await login('admin')).token;
  otherAdmin = (await login('oadmin')).token;
  offAdmin = (await login('aoff')).token;
  plain = (await login('plain')).token;
  teacher = (await login('tch')).token;
});

describe('Savol rasmlari (ExamAsset)', () => {
  it('PNG qayta kodlanadi: WebP, 1600 px gacha kichrayadi, metadata (EXIF) olib tashlanadi', async () => {
    const big = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: '#2563eb' },
    })
      .withMetadata({ exif: { IFD0: { Copyright: 'MAXFIY-EXIF' } } })
      .jpeg()
      .toBuffer();
    const res = await upload(admin, big, { type: 'image/jpeg', name: 'katta.jpg' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ contentType: 'image/webp', width: 1600, height: 800 });
    expect(res.body.data).not.toHaveProperty('data');
    expect(res.body.data).not.toHaveProperty('hash');

    const dl = await download(admin, res.body.data.id);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('image/webp');
    expect(dl.headers['cache-control']).toContain('private');
    const bytes = dl.body as Buffer;
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1600);
    expect(meta.exif).toBeUndefined();
    expect(bytes.toString('latin1')).not.toContain('MAXFIY-EXIF');
  });

  it('kichik rasm kattalashtirilmaydi', async () => {
    const res = await upload(admin, await png(50, 20));
    expect(res.body.data).toMatchObject({ width: 50, height: 20 });
  });

  it("magic-bytes: mimetype rasm deydi, lekin mazmuni rasm emas: 400; mimetype noto'g'ri: 400", async () => {
    const fake = Buffer.from('<script>alert(1)</script> bu rasm emas');
    expect((await upload(admin, fake, { type: 'image/png', name: 'x.png' })).status).toBe(400);
    expect((await upload(admin, await png(), { type: 'text/plain', name: 'x.txt' })).status).toBe(
      400,
    );
    expect(
      (await upload(admin, await png(), { type: 'image/svg+xml', name: 'x.svg' })).status,
    ).toBe(400);
    // Rasm sarlavhasi to'g'ri, ichi buzilgan
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('garbage')]);
    expect((await upload(admin, broken, { type: 'image/jpeg', name: 'x.jpg' })).status).toBe(400);
    expect(await ExamAsset.countDocuments()).toBe(0);
  });

  it('hajm: 5 MB dan katta fayl 400; fayl yuborilmasa 400', async () => {
    const huge = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(5 * 1024 * 1024 + 10),
    ]);
    const res = await upload(admin, huge, { type: 'image/jpeg', name: 'h.jpg' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('5 MB');
    const none = await request(app).post('/api/v1/exams/assets').set(bearer(admin));
    expect(none.status).toBe(400);
  });

  it('dedup: maktab ichida bir xil rasm bir marta saqlanadi (2-yuklash 200, bir xil id)', async () => {
    const buf = await png();
    const a = await upload(admin, buf);
    const b = await upload(admin, buf);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await ExamAsset.countDocuments({ schoolId: school.id })).toBe(1);
    // Parallel bir xil yuklash ham bitta hujjat beradi
    const buf2 = await png(33, 33);
    const [x, y] = await Promise.all([upload(admin, buf2), upload(admin, buf2)]);
    expect(x.body.data.id).toBe(y.body.data.id);
    expect(await ExamAsset.countDocuments({ schoolId: school.id })).toBe(2);
    // Boshqa rasm boshqa hujjat
    expect((await upload(admin, await png(40, 30, '#00ff00'))).body.data.id).not.toBe(
      a.body.data.id,
    );
  });

  it("tenant: boshqa maktabda bir xil rasm alohida hujjat; boshqa maktab rasmini olib bo'lmaydi (404)", async () => {
    const buf = await png();
    const mine = (await upload(admin, buf)).body.data.id;
    const theirs = await upload(otherAdmin, buf);
    expect(theirs.status).toBe(201);
    expect(theirs.body.data.id).not.toBe(mine);
    expect((await download(otherAdmin, mine)).status).toBe(404);
    expect((await download(admin, theirs.body.data.id)).status).toBe(404);
    expect((await download(admin, 'notanid')).status).toBe(400);
    expect((await download(admin, '64b000000000000000000001')).status).toBe(404);
  });

  it("ETag bilan 304; ruxsatlar: o'qituvchi yuklaydi/ko'radi, ruxsatsiz admin 403, auth yo'q 401, modul o'chiq 403", async () => {
    const id = (await upload(teacher, await png())).body.data.id;
    const first = await download(teacher, id);
    expect(first.status).toBe(200);
    const again = await download(teacher, id, { 'If-None-Match': first.headers.etag });
    expect(again.status).toBe(304);
    expect((await upload(plain, await png())).status).toBe(403);
    expect((await request(app).get(`/api/v1/exams/assets/${id}`)).status).toBe(401);
    expect((await upload(offAdmin, await png())).status).toBe(403);
  });

  it('audit: yuklash xulosa bilan yoziladi (baytlarsiz), takroriy yuklash yozilmaydi', async () => {
    const buf = await png();
    await upload(admin, buf);
    await upload(admin, buf);
    const logs = await AuditLog.find({ action: 'exam.asset.upload' }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].after).toMatchObject({ width: 40, height: 30 });
    expect(Object.keys(logs[0].after as object).sort()).toEqual([
      'hash',
      'height',
      'size',
      'width',
    ]);
  });

  it('data maydoni sxemada select:false', async () => {
    const id = (await upload(admin, await png())).body.data.id;
    const plainDoc = await ExamAsset.findById(id);
    expect(plainDoc?.data).toBeUndefined();
    expect((await ExamAsset.findById(id).select('+data'))?.data.length).toBeGreaterThan(0);
  });
});

describe('Qisqa javobni normallashtirish', () => {
  const n = normalizeShortAnswer;

  it("katta-kichik harf va probellar e'tiborga olinmaydi", () => {
    expect(n('  Toshkent ')).toBe('toshkent');
    expect(n('TO  SH\tKENT')).toBe('to sh kent');
    expect(n('Ўзбекистон')).toBe(n('ўЗБЕКИСТОН'));
  });

  it('apostrof variantlari bir xil', () => {
    expect(n("o'zbek")).toBe(n('oʻzbek'));
    expect(n('O‘zbek')).toBe(n("o'zbek"));
    expect(n('g`ozal')).toBe(n("g'ozal"));
  });

  it('sonlar: 12,5 == 12.5 == 12.50 == +12.5; 007 == 7; -0 == 0; ming ajratgich', () => {
    for (const v of ['12,5', '12.5', '12.50', ' 12,50 ', '+12.5', '012.5'])
      expect(n(v)).toBe('12.5');
    expect(n('007')).toBe('7');
    expect(n('7.0')).toBe('7');
    expect(n('-0')).toBe('0');
    expect(n('-0,0')).toBe('0');
    expect(n('-3,50')).toBe('-3.5');
    expect(n('1 000')).toBe('1000');
    expect(n('12 500,5')).toBe('12500.5');
    expect(n('0,5')).toBe('0.5');
    expect(n('.5')).toBe('.5'); // son deb hisoblanmaydi (aniq format talab qilinadi)
  });

  it("son bo'lmagan qiymatlar matn sifatida qoladi", () => {
    expect(n('1,2,3')).toBe('1,2,3');
    expect(n('12abc')).toBe('12abc');
    expect(n('1e3')).toBe('1e3');
    expect(n('12 5')).toBe('12 5');
    expect(n('')).toBe('');
  });

  it('katta sonlarda aniqlik yo`qolmaydi (float ishlatilmaydi)', () => {
    expect(n('12345678901234567890,10')).toBe('12345678901234567890.1');
  });

  it("isShortAnswerCorrect: bir nechta qabul qilinadigan javob, bo'sh javob noto'g'ri", () => {
    const acc = ['2,5', 'ikki yarim', "O'zbekiston"];
    expect(isShortAnswerCorrect(acc, '2.5')).toBe(true);
    expect(isShortAnswerCorrect(acc, ' IKKI   YARIM ')).toBe(true);
    expect(isShortAnswerCorrect(acc, 'oʻzbekiston')).toBe(true);
    expect(isShortAnswerCorrect(acc, '2.6')).toBe(false);
    expect(isShortAnswerCorrect(acc, '   ')).toBe(false);
    expect(isShortAnswerCorrect([], 'x')).toBe(false);
  });
});
