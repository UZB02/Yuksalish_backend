import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendanceStatus } from '../src/models/AttendanceStatus';
import { AuditLog } from '../src/models/AuditLog';
import { BehaviorType } from '../src/models/BehaviorType';
import { BrandingAsset } from '../src/models/BrandingAsset';
import { Score } from '../src/models/Score';
import { School } from '../src/models/School';
import { Setting } from '../src/models/Setting';
import { Subject } from '../src/models/Subject';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { User } from '../src/models/User';
import { DELETE_MAX_ATTEMPTS, resetSchoolDeleteState } from '../src/modules/schools/schools.delete';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { SCHOOL_PURGE_STEPS } from '../src/modules/schools/schoolPurge';
import { app, bearer, login, makeSchool, makeUser, PASSWORD, useTestDb } from './helpers';

useTestDb();

const API = '/api/v1/schools';
const oid = () => new Types.ObjectId();
const FUTURE = new Date(Date.now() + 365 * 86_400_000);

type Seeder = (c: { sid: Types.ObjectId; tag: string; userIds: Types.ObjectId[] }) => object;

/**
 * HAR BIR ro'yxatdagi kolleksiya uchun hujjat yasaydi (xom insert: validatsiyasiz, faqat unique kalitlar
 * to'qnashmasligi uchun `tag` ishlatiladi). Yangi qadam qo'shilsa va bu yerga yozilmasa test yiqiladi.
 */
const SEEDERS: Record<string, Seeder> = {
  questions: ({ sid, tag }) => ({ schoolId: sid, subjectId: oid(), topicId: oid(), tag }),
  examTopics: ({ sid, tag }) => ({ schoolId: sid, subjectId: oid(), nameKey: `t-${tag}` }),
  examAssets: ({ sid, tag }) => ({ schoolId: sid, hash: `h-${tag}`, data: Buffer.from('x') }),
  examImportSessions: ({ sid }) => ({ schoolId: sid, userId: oid(), expiresAt: FUTURE }),
  examSessions: ({ sid, tag }) => ({
    schoolId: sid,
    title: `s-${tag}`,
    type: 'quiz',
    academicYearId: oid(),
    scheduledStart: FUTURE,
    durationMin: 40,
    pinSalt: 'salt',
    createdBy: oid(),
  }),
  examAttempts: ({ sid, tag }) => ({
    schoolId: sid,
    sessionId: oid(),
    participantKey: `k-${tag}`,
    participantKind: 'student',
    fullName: `a-${tag}`,
    tokenHash: `th-${tag}`,
    tokenExpiresAt: FUTURE,
    deviceId: 'device-12345',
  }),
  examEntryCodes: ({ sid, tag }) => ({
    schoolId: sid,
    sessionId: oid(),
    participantKey: `k-${tag}`,
    codeHash: `ch-${tag}-${oid()}`,
    expiresAt: FUTURE,
  }),
  examTemplates: ({ sid, tag }) => ({ schoolId: sid, title: `t-${tag}`, createdBy: oid() }),
  examCandidates: ({ sid, tag }) => ({ schoolId: sid, fullName: `c-${tag}`, createdBy: oid() }),
  subjectGrades: ({ sid }) => ({ schoolId: sid, studentId: oid(), value: 5, isDeleted: true }),
  scores: ({ sid }) => ({ schoolId: sid, studentId: oid(), value: 90, isDeleted: true }),
  attendanceRecords: ({ sid }) => ({ schoolId: sid, studentId: oid(), isDeleted: true }),
  lessonOverrides: ({ sid }) => ({
    schoolId: sid,
    classId: oid(),
    date: '2026-11-16',
    lessonNo: 1,
    groupKey: null,
    targetTeacherId: oid(),
  }),
  timetableVersions: ({ sid }) => ({ schoolId: sid, classId: oid(), status: 'draft' }),
  classSubjects: ({ sid }) => ({
    schoolId: sid,
    classId: oid(),
    subjectId: oid(),
    teacherId: oid(),
  }),
  ratingResults: ({ sid, tag }) => ({ schoolId: sid, periodKey: `p-${tag}` }),
  ratingDailyRanks: ({ sid }) => ({
    schoolId: sid,
    scope: 'student',
    refId: oid(),
    periodKey: 'p',
    date: '2026-11-16',
  }),
  ratings: ({ sid }) => ({ schoolId: sid, scope: 'student', refId: oid(), periodKey: 'p' }),
  ratingStates: ({ sid }) => ({ kind: 'school', schoolId: sid, periodKey: 'p' }),
  photos: ({ sid }) => ({
    schoolId: sid,
    ownerType: 'student',
    ownerId: oid(),
    data: Buffer.from('x'),
  }),
  importSessions: ({ sid }) => ({ schoolId: sid, userId: oid(), expiresAt: FUTURE }),
  students: ({ sid, tag }) => ({ schoolId: sid, fullName: `S ${tag}`, classId: oid() }),
  classes: ({ sid, tag }) => ({ schoolId: sid, academicYearId: oid(), name: `C-${tag}` }),
  academicYears: ({ sid, tag }) => ({ schoolId: sid, name: `Y-${tag}`, isActive: false }),
  subjects: ({ sid, tag }) => ({ schoolId: sid, name: `Fan ${tag}`, nameKey: `fan-${tag}` }),
  behaviorTypes: ({ sid, tag }) => ({ schoolId: sid, name: `Xulq ${tag}`, nameKey: `xulq-${tag}` }),
  attendanceStatuses: ({ sid, tag }) => ({
    schoolId: sid,
    name: `Holat ${tag}`,
    nameKey: `h-${tag}`,
  }),
  settings: ({ sid, tag }) => ({ scope: 'school', schoolId: sid, key: `k-${tag}`, value: {} }),
  brandingAssets: ({ sid, tag }) => ({
    ownerType: 'school',
    schoolId: sid,
    variant: `v-${tag}`,
    data: Buffer.from('x'),
  }),
  auditLogs: ({ sid }) => ({ schoolId: sid, action: 'x', entity: 'x' }),
  refreshTokens: ({ userIds, tag }) => ({
    userId: userIds[0],
    tokenHash: `rt-${tag}`,
    expiresAt: FUTURE,
  }),
  passwordResetCodes: ({ userIds }) => ({ userId: userIds[0], codeHash: 'c', expiresAt: FUTURE }),
  telegramLinkTokens: ({ userIds, tag }) => ({
    userId: userIds[0],
    tokenHash: `tl-${tag}`,
    expiresAt: FUTURE,
  }),
  telegramOutbox: ({ userIds }) => ({
    userId: userIds[0],
    chatId: 1,
    text: 'x',
    status: 'pending',
  }),
  // 'users' qadami uchun hujjat foydalanuvchilar sifatida alohida yaratiladi (seedUsers)
  users: () => ({}),
};

const REPEAT = 2; // har kolleksiyadan nechta hujjat (sanash aniq bo'lsin)

async function seedSchool(tag: string) {
  const school = await makeSchool(tag);
  const sid = school._id as Types.ObjectId;
  const teacher = await makeUser({ username: `t-${tag}`, role: 'teacher', schoolId: school.id });
  const admin = await makeUser({ username: `a-${tag}`, role: 'school_admin', schoolId: school.id });
  const userIds = [teacher._id as Types.ObjectId, admin._id as Types.ObjectId];
  for (const step of SCHOOL_PURGE_STEPS) {
    if (step.key === 'users') continue;
    const seeder = SEEDERS[step.key];
    if (!seeder) throw new Error(`SEEDERS da '${step.key}' yo'q: yangi qadam uchun seed yozing`);
    const times = step.key === 'ratingStates' ? 1 : REPEAT; // RatingState: maktabga bitta (unique)
    for (let i = 0; i < times; i++) {
      const t = `${tag}${i}`;
      await step.model.collection.insertOne({ ...seeder({ sid, tag: t, userIds }) });
    }
  }
  return { school, sid, userIds, teacher, admin };
}

/** Mustaqil sanash (registrdagi filtrdan foydalanmaydi): maktab bo'yicha yoki foydalanuvchi bo'yicha */
async function countAll(sid: Types.ObjectId, userIds: Types.ObjectId[]) {
  const out: Record<string, number> = {};
  for (const step of SCHOOL_PURGE_STEPS) {
    out[step.key] =
      step.scope === 'users'
        ? await step.model.countDocuments({ userId: { $in: userIds } })
        : await step.model.countDocuments({ schoolId: sid });
  }
  return out;
}

let root: string;
let rootUser: Awaited<ReturnType<typeof makeUser>>;

const preview = (id: string, t = root) =>
  request(app).get(`${API}/${id}/delete-preview`).set(bearer(t));
const del = (id: string, body: object, t = root) =>
  request(app).post(`${API}/${id}/delete`).set(bearer(t)).send(body);
const good = (name: string) => ({ confirmName: name, password: PASSWORD, acknowledge: true });

beforeEach(async () => {
  resetSchoolDeleteState();
  rootUser = await makeUser({ username: 'root', role: 'superadmin' });
  root = (await login('root')).token;
});
afterEach(() => vi.restoreAllMocks());

const deactivate = (id: string) => School.updateOne({ _id: id }, { isActive: false });

describe('maktabni butunlay o‘chirish: cascade va izolyatsiya', () => {
  it('A maktab hamma kolleksiyadan o‘chadi, B maktab, global va superadmin o‘zgarmaydi', async () => {
    const a = await seedSchool('a');
    const b = await seedSchool('b');
    // Global yozuvlar (schoolId = null)
    await Subject.create({ schoolId: null, name: 'Global fan', nameKey: 'global-fan', order: 1 });
    await BehaviorType.create({
      schoolId: null,
      name: 'Global xulq',
      nameKey: 'gx',
      kind: 'positive',
      color: '#000',
      order: 1,
    });
    await AttendanceStatus.create({
      schoolId: null,
      name: 'Global holat',
      nameKey: 'gh',
      shortName: 'G',
      color: '#000',
      category: 'present',
      order: 1,
    });
    await Setting.create({ scope: 'global', schoolId: null, key: 'scoring', value: {} });
    await BrandingAsset.create({
      ownerType: 'platform',
      schoolId: null,
      variant: 'logo',
      data: Buffer.from('x'),
      contentType: 'image/png',
      hash: 'h',
    });
    await TelegramBotConfig.create({ key: 'platform', tokenEnc: 'x', tokenLast4: '1234' });
    // Rahbariyat hisobot doirasi A ga qo'yilgan superadmin, B ga qo'yilgan superadmin
    await User.updateOne({ _id: rootUser._id }, { 'telegram.reportScope': a.school.id });
    const root2 = await makeUser({ username: 'root2', role: 'superadmin' });
    await User.updateOne({ _id: root2._id }, { 'telegram.reportScope': b.school.id });

    const beforeA = await countAll(a.sid, a.userIds);
    const beforeB = await countAll(b.sid, b.userIds);
    for (const step of SCHOOL_PURGE_STEPS) {
      // Har kolleksiyada A uchun hujjat bor (users: 2 ta foydalanuvchi)
      expect(beforeA[step.key], step.key).toBeGreaterThan(0);
    }
    const globalsBefore = {
      subject: await Subject.countDocuments({ schoolId: null }),
      behavior: await BehaviorType.countDocuments({ schoolId: null }),
      status: await AttendanceStatus.countDocuments({ schoolId: null }),
      setting: await Setting.countDocuments({ scope: 'global' }),
      branding: await BrandingAsset.countDocuments({ ownerType: 'platform' }),
      bot: await TelegramBotConfig.countDocuments({}),
      superadmins: await User.countDocuments({ role: 'superadmin' }),
    };

    await deactivate(a.school.id);
    const res = await del(a.school.id, good(a.school.name));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    expect(res.body.data.resumed).toBe(false);

    // A: hamma joyda 0, School hujjati ham yo'q
    expect(await School.findById(a.school.id)).toBeNull();
    const afterA = await countAll(a.sid, a.userIds);
    for (const step of SCHOOL_PURGE_STEPS) expect(afterA[step.key], step.key).toBe(0);
    // B: aynan avvalgidek
    expect(await countAll(b.sid, b.userIds)).toEqual(beforeB);
    expect(await School.findById(b.school.id)).not.toBeNull();
    // Global va superadminlar o'zgarmagan
    expect({
      subject: await Subject.countDocuments({ schoolId: null }),
      behavior: await BehaviorType.countDocuments({ schoolId: null }),
      status: await AttendanceStatus.countDocuments({ schoolId: null }),
      setting: await Setting.countDocuments({ scope: 'global' }),
      branding: await BrandingAsset.countDocuments({ ownerType: 'platform' }),
      bot: await TelegramBotConfig.countDocuments({}),
      superadmins: await User.countDocuments({ role: 'superadmin' }),
    }).toEqual(globalsBefore);
    // Telegram reportScope: A ga qo'yilgani tozalandi, B niki saqlandi
    expect((await User.findById(rootUser._id))?.telegram?.reportScope ?? null).toBeNull();
    expect((await User.findById(root2._id))?.telegram?.reportScope).toBe(b.school.id);
    // Javobdagi sonlar haqiqiy o'chirilganlarga teng
    for (const step of SCHOOL_PURGE_STEPS) {
      expect(res.body.data.counts[step.key], step.key).toBe(beforeA[step.key]);
    }
  });

  it('audit: maktab yozuvlari o‘chadi, global school.delete.start va school.delete qoladi', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    expect((await del(a.school.id, good(a.school.name))).status).toBe(200);
    expect(await AuditLog.countDocuments({ schoolId: a.sid })).toBe(0);
    const start = await AuditLog.findOne({ action: 'school.delete.start' }).lean();
    const done = await AuditLog.findOne({ action: 'school.delete' }).lean();
    expect(start?.schoolId).toBeNull();
    expect(done?.schoolId).toBeNull();
    expect(done?.entityId).toBe(a.school.id);
    expect(String(done?.userId)).toBe(rootUser.id);
    const after = done?.after as { name: string; counts: Record<string, number>; total: number };
    expect(after.name).toBe(a.school.name);
    expect(after.counts.students).toBe(2);
    expect(after.total).toBeGreaterThan(0);
  });

  it('kutayotgan reyting hisobi bekor qilinadi, umumiy (maktablar) reyting rejalashtiriladi', async () => {
    const a = await seedSchool('a');
    ratingEvents.schedule(a.school.id);
    expect(ratingEvents.pending).toContain(a.school.id);
    await deactivate(a.school.id);
    expect((await del(a.school.id, good(a.school.name))).status).toBe(200);
    expect(ratingEvents.pending).not.toContain(a.school.id);
    expect(ratingEvents.pending).toContain('*schools');
  });

  it('o‘chirilgan maktab foydalanuvchisi kira olmaydi, public 404 qaytaradi', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    await del(a.school.id, good(a.school.name));
    expect((await login('t-a')).res.status).toBe(401);
    expect((await request(app).get('/api/v1/public/a/config')).status).toBe(404);
  });

  it('maktabga bog‘langan superadmin o‘chirilmaydi, schoolId i tozalanadi (tizimdan chiqib qolmasligi uchun)', async () => {
    const a = await seedSchool('a');
    const odd = await makeUser({ username: 'odd', role: 'superadmin', schoolId: a.school.id });
    await deactivate(a.school.id);
    const pv = await preview(a.school.id);
    expect(pv.body.data.superadminsSkipped).toBe(1);
    const res = await del(a.school.id, good(a.school.name));
    expect(res.status).toBe(200);
    expect(res.body.data.superadminsRepaired).toBe(1);
    const u = await User.findById(odd.id);
    expect(u).not.toBeNull();
    expect(u?.schoolId).toBeNull();
  });
});

describe('maktabni butunlay o‘chirish: himoya qoidalari', () => {
  it('faol maktab: 409', async () => {
    const a = await seedSchool('a');
    const res = await del(a.school.id, good(a.school.name));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Avval maktabni nofaol qiling');
    expect(await School.findById(a.school.id)).not.toBeNull();
    expect(await Score.countDocuments({ schoolId: a.sid })).toBe(REPEAT);
  });

  it('noto‘g‘ri nom: 400 (registr muhim, chetdagi bo‘shliq e‘tiborsiz)', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    for (const name of [a.school.name.toUpperCase(), 'Boshqa', `${a.school.name} x`]) {
      const res = await del(a.school.id, good(name));
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('confirmName');
    }
    expect(await School.findById(a.school.id)).not.toBeNull();
    const ok = await del(a.school.id, good(`  ${a.school.name}  `));
    expect(ok.status).toBe(200);
  });

  it('noto‘g‘ri parol: 400 INVALID_PASSWORD (401 emas), hech narsa o‘chmaydi', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    const res = await del(a.school.id, { ...good(a.school.name), password: 'Notogri123' });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(401);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
    expect(res.body.error.details[0].path).toBe('password');
    expect(await School.findById(a.school.id)).not.toBeNull();
    expect((await School.findById(a.school.id))?.deletingAt).toBeNull();
    expect(await Score.countDocuments({ schoolId: a.sid })).toBe(REPEAT);
  });

  it('acknowledge false/yo‘q yoki parol yo‘q: 400', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    expect((await del(a.school.id, { ...good(a.school.name), acknowledge: false })).status).toBe(
      400,
    );
    expect(
      (await del(a.school.id, { confirmName: a.school.name, password: PASSWORD })).status,
    ).toBe(400);
    expect((await del(a.school.id, { confirmName: a.school.name, acknowledge: true })).status).toBe(
      400,
    );
    expect(await School.findById(a.school.id)).not.toBeNull();
  });

  it('superadmin bo‘lmagan rollar: 403 (preview ham)', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    await School.updateOne({ _id: a.school.id }, { isActive: true }); // admin kira olishi uchun
    const adm = (await login('a-a')).token;
    const tch = (await login('t-a')).token;
    for (const t of [adm, tch]) {
      expect((await del(a.school.id, good(a.school.name), t)).status).toBe(403);
      expect((await preview(a.school.id, t)).status).toBe(403);
    }
    expect((await request(app).post(`${API}/${a.school.id}/delete`).send(good('x'))).status).toBe(
      401,
    );
    expect(await School.findById(a.school.id)).not.toBeNull();
  });

  it('noma‘lum yoki noto‘g‘ri id: 404', async () => {
    expect((await del(String(oid()), good('x'))).status).toBe(404);
    expect((await del('not-an-id', good('x'))).status).toBe(404);
    expect((await preview(String(oid()))).status).toBe(404);
  });

  it('parol urinishlari cheklanadi: N ta xatodan so‘ng 429 (to‘g‘ri parol ham o‘tmaydi)', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    for (let i = 0; i < DELETE_MAX_ATTEMPTS; i++) {
      const r = await del(a.school.id, { ...good(a.school.name), password: 'Notogri123' });
      expect(r.status).toBe(400);
    }
    const blocked = await del(a.school.id, good(a.school.name));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(await School.findById(a.school.id)).not.toBeNull();
  });

  it('o‘chirish boshlangan maktabni qayta faollashtirib bo‘lmaydi', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    await School.updateOne({ _id: a.school.id }, { deletingAt: new Date() });
    const res = await request(app)
      .patch(`${API}/${a.school.id}`)
      .set(bearer(root))
      .send({ isActive: true });
    expect(res.status).toBe(409);
  });
});

describe('maktabni butunlay o‘chirish: yarim yo‘lda to‘xtash va davom ettirish', () => {
  it('xato bo‘lsa maktab nofaol + deletingAt bilan qoladi, qayta chaqirish tugatadi', async () => {
    const a = await seedSchool('a');
    const b = await seedSchool('b');
    const beforeB = await countAll(b.sid, b.userIds);
    await deactivate(a.school.id);

    const spy = vi.spyOn(Score, 'deleteMany').mockRejectedValueOnce(new Error('boom'));
    const r1 = await del(a.school.id, good(a.school.name));
    expect(r1.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);

    const left = await School.findById(a.school.id);
    expect(left).not.toBeNull();
    expect(left?.isActive).toBe(false);
    expect(left?.deletingAt).not.toBeNull();
    // Xatogacha bo'lgan qadamlar bajarilgan, keyingilari hali yo'q
    expect(await Score.countDocuments({ schoolId: a.sid })).toBe(REPEAT);
    expect(await User.countDocuments({ schoolId: a.sid })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'school.delete.failed' })).toBe(1);

    // Preview davom etayotgan maktabni ko'rsata oladi
    const pv = await preview(a.school.id);
    expect(pv.body.data.school.deletingAt).not.toBeNull();

    const r2 = await del(a.school.id, good(a.school.name));
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.data.resumed).toBe(true);
    expect(await School.findById(a.school.id)).toBeNull();
    const afterA = await countAll(a.sid, a.userIds);
    for (const step of SCHOOL_PURGE_STEPS) expect(afterA[step.key], step.key).toBe(0);
    expect(await countAll(b.sid, b.userIds)).toEqual(beforeB);
  });

  it('foydalanuvchilar o‘chirilgach School hujjati yiqilsa ham qayta chaqirish tugatadi', async () => {
    const a = await seedSchool('a');
    await deactivate(a.school.id);
    const spy = vi.spyOn(School, 'deleteOne').mockRejectedValueOnce(new Error('boom'));
    expect((await del(a.school.id, good(a.school.name))).status).toBe(500);
    expect(spy).toHaveBeenCalled();
    expect(await User.countDocuments({ schoolId: a.sid })).toBe(0);
    expect(await School.findById(a.school.id)).not.toBeNull();
    const r2 = await del(a.school.id, good(a.school.name));
    expect(r2.status).toBe(200);
    expect(await School.findById(a.school.id)).toBeNull();
  });
});

describe('maktabni o‘chirish: preview', () => {
  it('sonlar haqiqiy hujjatlarga teng, hech narsa o‘chirmaydi', async () => {
    const a = await seedSchool('a');
    await seedSchool('b');
    const res = await preview(a.school.id);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.school).toMatchObject({ id: a.school.id, name: a.school.name, isActive: true });
    expect(d.school.deletingAt).toBeNull();
    const byKey = Object.fromEntries(
      d.items.map((i: { key: string; count: number }) => [i.key, i.count]),
    );
    expect(Object.keys(byKey)).toEqual(SCHOOL_PURGE_STEPS.map((s) => s.key));
    expect(byKey.students).toBe(REPEAT);
    expect(byKey.scores).toBe(REPEAT);
    expect(byKey.users).toBe(2);
    expect(byKey.refreshTokens).toBe(REPEAT);
    expect(d.users).toEqual({ teachers: 1, schoolAdmins: 1 });
    expect(d.total).toBe(Object.values(byKey as Record<string, number>).reduce((x, y) => x + y, 0));
    // Mustaqil sanoq bilan bir xil
    const real = await countAll(a.sid, a.userIds);
    expect(byKey).toEqual(real);
    // Hech narsa o'chmagan
    expect(await School.findById(a.school.id)).not.toBeNull();
    expect(await countAll(a.sid, a.userIds)).toEqual(real);
  });
});
