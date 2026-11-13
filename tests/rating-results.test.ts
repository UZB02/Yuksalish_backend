import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AcademicYear } from '../src/models/AcademicYear';
import { AuditLog } from '../src/models/AuditLog';
import { RatingResult } from '../src/models/RatingResult';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import {
  announceDate,
  announceMoment,
  previousPeriod,
  runRatingResults,
} from '../src/modules/ratings/rating.results';
import { resolvePeriod } from '../src/modules/ratings/rating.period';
import { computeLive } from '../src/modules/ratings/ratings.service';
import { publicCache } from '../src/modules/public/public.cache';
import { settingsStore } from '../src/modules/settings/settings.store';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { buildRatingResultsMessage } from '../src/modules/telegram/telegram.rating-results';
import { clock } from '../src/utils/clock';
import {
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
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const BEFORE = '2026-11-14T12:59:00Z'; // shanba 17:59 Toshkent
const SAT_18 = '2026-11-14T13:00:00Z'; // shanba 18:00 Toshkent
const WEEK_KEY = 'week:2026-11-09';

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc;
let s1: Doc, s2: Doc, s3: Doc, s4: Doc;
let teacherUser: Doc, admin: Doc, admin2: Doc, rootUser: Doc;
let root: string, tch: string, adm: string, noPerm: string;
let btype: Doc;
let fake: FakeTelegram;

const setNow = (iso: string) => clock.set(() => new Date(iso));
const H = (id?: string): Record<string, string> => (id ? { 'X-School-Id': id } : {});
const get = (t: string, path: string, h: Record<string, string> = {}) =>
  request(app).get(`/api/v1${path}`).set(bearer(t)).set(h);
const put = (key: string, body: object, t = root) =>
  request(app).put(`/api/v1/settings/${key}`).set(bearer(t)).send(body);
const pub = (path: string) => request(app).get(`/api/v1/public${path}`);
/** Faqat shu maktab uchun e'lonni yoqadi (override) */
const enable = (extra: Record<string, unknown> = {}) =>
  put('rating', {
    scope: 'school',
    schoolId: school.id,
    values: { periodType: 'week', resultsEnabled: true, ...extra },
  });
const mine = (key = WEEK_KEY) =>
  RatingResult.findOne({ schoolId: school.id, periodKey: key }).lean();
const countMine = (key = WEEK_KEY) =>
  RatingResult.countDocuments({ schoolId: school.id, periodKey: key });
const enablePublic = (extra: object = {}) =>
  put('public', { scope: 'school', schoolId: school.id, values: { enabled: true, ...extra } });

/** Berilgan kunlarga bir xil ball yozadi */
async function give(student: Doc, cls: Doc, value: number, dates: string[]) {
  await Score.insertMany(
    dates.map((date) => ({
      schoolId: school.id,
      studentId: student._id,
      classId: cls._id,
      teacherId: teacherUser._id,
      academicYearId: year.id,
      behaviorTypeId: btype._id,
      value,
      comment: 'maxfiy izoh',
      date,
    })),
  );
}
const MON_WED = ['2026-11-09', '2026-11-10', '2026-11-11'];

async function seedWeek() {
  await give(s1, c5, 80, MON_WED);
  await give(s2, c5, 100, MON_WED);
  await give(s3, c5, 50, ['2026-11-09']); // eligible emas (3 kun yo'q)
  await give(s4, c6, 60, MON_WED);
}

async function startBot() {
  await TelegramBotConfig.create({
    key: 'platform',
    tokenEnc: encryptToken(VALID_TOKEN),
    tokenLast4: VALID_TOKEN.slice(-4),
    botUsername: 'yuksalish_test_bot',
    enabled: true,
  });
  await telegramManager.reload();
}
const link = (id: string, chatId: number) =>
  User.updateOne({ _id: id }, { 'telegram.chatId': chatId, 'telegram.linkedAt': new Date() });

beforeEach(async () => {
  setNow(BEFORE);
  publicCache.clear();
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  school = await makeSchool('res-a');
  other = await makeSchool('res-b');
  year = await makeYear(school.id);
  teacherUser = await makeUser({
    username: 'rt1',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  admin = await makeUser({
    username: 'radm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  admin2 = await makeUser({
    username: 'radm2',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({ username: 'rnone', role: 'school_admin', schoolId: school.id });
  rootUser = await makeUser({ username: 'rroot', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [teacherUser.id]);
  c6 = await makeClass(school.id, year.id, '6-A');
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  s4 = await makeStudent(school.id, c6.id, 'Cholpon <Chol>');
  btype = await makeBehaviorType('Namunali xulq');
  [root, tch, adm, noPerm] = await Promise.all(
    ['rroot', 'rt1', 'radm', 'rnone'].map(async (u) => (await login(u)).token),
  );
});

afterAll(() => {
  uninstallTelegram();
  clock.reset();
});

describe("E'lon lahzasi hisobi", () => {
  const week = { type: 'week' as const, from: '2026-11-09', to: '2026-11-15' };
  const C = (o: object = {}) => ({
    resultsWeekday: 6,
    resultsMonthDay: 0,
    resultsDate: null as string | null,
    ...o,
  });
  const T = { resultsTime: '18:00' };

  it('week: tanlangan hafta kuni, standart shanba 18:00 Toshkent', () => {
    expect(announceDate(week, C())).toBe('2026-11-14');
    expect(announceDate(week, C({ resultsWeekday: 1 }))).toBe('2026-11-09');
    expect(announceDate(week, C({ resultsWeekday: 7 }))).toBe('2026-11-15');
    const m = announceMoment(week, { ...C(), ...T });
    expect(m.date).toBe('2026-11-14');
    expect(m.at.toISOString()).toBe('2026-11-14T13:00:00.000Z');
  });

  it('standart: month/quarter/academic_year/custom davrning oxirgi kuni', () => {
    for (const type of ['month', 'quarter', 'academic_year', 'custom'] as const) {
      const p = { type, from: '2026-11-01', to: '2026-11-30' };
      expect(announceDate(p, C({ resultsWeekday: 3 }))).toBe('2026-11-30');
    }
    const m = announceMoment(
      { type: 'month', from: '2026-11-01', to: '2026-11-30' },
      { ...C(), resultsTime: '09:05' },
    );
    expect(m.at.toISOString()).toBe('2026-11-30T04:05:00.000Z');
  });

  it('month: aniq kun; oyda kun yetmasa oxirgi kun (30 kunlik oy, fevral)', () => {
    const nov = { type: 'month' as const, from: '2026-11-01', to: '2026-11-30' };
    expect(announceDate(nov, C({ resultsMonthDay: 25 }))).toBe('2026-11-25');
    expect(announceDate(nov, C({ resultsMonthDay: 31 }))).toBe('2026-11-30');
    expect(announceDate(nov, C({ resultsMonthDay: 1 }))).toBe('2026-11-01');
    expect(announceDate(nov, C({ resultsMonthDay: 0 }))).toBe('2026-11-30');
    const feb = { type: 'month' as const, from: '2026-02-01', to: '2026-02-28' };
    expect(announceDate(feb, C({ resultsMonthDay: 30 }))).toBe('2026-02-28');
    const leap = { type: 'month' as const, from: '2028-02-01', to: '2028-02-29' };
    expect(announceDate(leap, C({ resultsMonthDay: 31 }))).toBe('2028-02-29');
    expect(announceDate(leap, C({ resultsMonthDay: 29 }))).toBe('2028-02-29');
  });

  it("quarter/academic_year/custom: resultsDate davr ichida bo'lsa shu sana; null yoki tashqarida oxirgi kun", () => {
    for (const type of ['quarter', 'academic_year', 'custom'] as const) {
      const p = { type, from: '2026-10-01', to: '2026-12-31' };
      expect(announceDate(p, C({ resultsDate: '2026-12-25' }))).toBe('2026-12-25');
      expect(announceDate(p, C({ resultsDate: '2026-10-01' }))).toBe('2026-10-01'); // chegara
      expect(announceDate(p, C({ resultsDate: '2026-12-31' }))).toBe('2026-12-31'); // chegara
      expect(announceDate(p, C({ resultsDate: null }))).toBe('2026-12-31');
      expect(announceDate(p, C({ resultsDate: '2026-09-30' }))).toBe('2026-12-31'); // oldin
      expect(announceDate(p, C({ resultsDate: '2027-01-01' }))).toBe('2026-12-31'); // keyin
    }
    const m = announceMoment(
      { type: 'quarter', from: '2026-10-01', to: '2026-12-31' },
      { ...C({ resultsDate: '2026-12-25' }), ...T },
    );
    expect(m.at.toISOString()).toBe('2026-12-25T13:00:00.000Z');
  });

  it("davr oxiridan oshsa yoki boshidan oldin bo'lsa qisiladi", () => {
    expect(announceDate({ type: 'week', from: '2026-11-09', to: '2026-11-11' }, C())).toBe(
      '2026-11-11',
    );
    expect(
      announceDate(
        { type: 'week', from: '2026-11-09', to: '2026-11-15' },
        C({ resultsWeekday: 0 }),
      ),
    ).toBe('2026-11-09');
  });

  it("previousPeriod: hafta/oy; custom va oldingi chorak yo'q holatda null", () => {
    const base = { customFrom: null, customTo: null };
    const w = resolvePeriod({ periodType: 'week', ...base }, null, '2026-11-16');
    expect(previousPeriod(w, null)?.key).toBe('week:2026-11-09');
    const m = resolvePeriod({ periodType: 'month', ...base }, null, '2026-12-02');
    expect(previousPeriod(m, null)?.key).toBe('month:2026-11');
    const c = resolvePeriod(
      { periodType: 'custom', customFrom: '2026-11-01', customTo: '2026-11-30' },
      null,
      '2026-11-10',
    );
    expect(previousPeriod(c, null)).toBeNull();
    const y = {
      id: 'y',
      name: '2026/27',
      startDate: '2026-09-01',
      endDate: '2027-05-31',
      periods: [{ id: 'q1', name: '1-chorak', startDate: '2026-09-01', endDate: '2026-10-31' }],
    };
    const q = resolvePeriod({ periodType: 'quarter', ...base }, y, '2026-09-10');
    expect(previousPeriod(q, y)).toBeNull();
  });
});

describe('Sozlamalar', () => {
  it("standart: o'chiq, shanba, 18:00", async () => {
    const r = await get(root, '/settings/rating');
    expect(r.body.data.effective).toMatchObject({
      resultsEnabled: false,
      resultsWeekday: 6,
      resultsTime: '18:00',
    });
  });

  it('tekshiruv: kun 1–7, vaqt HH:mm 00:00–23:59', async () => {
    for (const values of [
      { resultsWeekday: 0 },
      { resultsWeekday: 8 },
      { resultsMonthDay: -1 },
      { resultsMonthDay: 32 },
      { resultsDate: '2026-02-30' },
      { resultsDate: '26-11-2026' },
      { resultsDate: '2026-1-5' },
      { resultsDate: 'abc' },
      { resultsTime: '24:00' },
      { resultsTime: '18:60' },
      { resultsTime: '9:00' },
    ]) {
      expect((await put('rating', { scope: 'global', values })).status).toBe(400);
    }
    const ok = await put('rating', {
      scope: 'global',
      values: { resultsWeekday: 7, resultsTime: '00:00', resultsEnabled: true },
    });
    expect(ok.status).toBe(200);
    const ok2 = await put('rating', {
      scope: 'global',
      values: { resultsMonthDay: 31, resultsDate: '2026-12-25' },
    });
    expect(ok2.status).toBe(200);
    const ok3 = await put('rating', { scope: 'global', values: { resultsDate: null } });
    expect(ok3.status).toBe(200);
  });

  it('faqat superadmin yozadi (school_admin 403); maktab override ishlaydi', async () => {
    const r = await put(
      'rating',
      { scope: 'school', schoolId: school.id, values: { resultsEnabled: true } },
      adm,
    );
    expect(r.status).toBe(403);
    const o = await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { resultsEnabled: true, resultsTime: '17:30' },
    });
    expect(o.status).toBe(200);
    const eff = await get(root, '/settings/rating', H(school.id));
    expect(eff.body.data.effective).toMatchObject({ resultsEnabled: true, resultsTime: '17:30' });
  });

  it("faqat e'lon sozlamalari o'zgarsa reyting qayta hisoblanmaydi; boshqasi o'zgarsa hisoblanadi", async () => {
    await enable(); // davr turi (week) o'zgaradi: hisoblash rejalashtiriladi
    await ratingEvents.flushAll();
    await enable({
      resultsTime: '17:00',
      resultsWeekday: 5,
      resultsMonthDay: 20,
      resultsDate: '2026-12-20',
    });
    expect(ratingEvents.pending).toEqual([]);
    await put('rating', { scope: 'global', values: { method: 'sum' } });
    expect(ratingEvents.pending.length).toBeGreaterThan(0);
    await ratingEvents.flushAll();
  });
});

describe("E'lon vazifasi", () => {
  it("o'chiq bo'lsa hech narsa yaratmaydi", async () => {
    await seedWeek();
    setNow(SAT_18);
    expect((await runRatingResults()).created).toBe(0);
    expect(await RatingResult.countDocuments()).toBe(0);
  });

  it("e'lon vaqtigacha yaratmaydi; vaqti kelganda muzlatadi; qayta ishga tushsa takrorlamaydi", async () => {
    await seedWeek();
    await enable();
    setNow(BEFORE);
    // yoqilgan zahoti faqat o'tgan hafta (kuni o'tib ketgan) to'ldiriladi
    await runRatingResults();
    expect(await countMine()).toBe(0);
    setNow(SAT_18);
    expect((await runRatingResults()).created).toBe(1);
    expect((await runRatingResults()).created).toBe(0);
    expect(await countMine()).toBe(1);
    const doc = (await mine())!;
    expect(doc).toMatchObject({
      periodType: 'week',
      periodKey: WEEK_KEY,
      from: '2026-11-09',
      to: '2026-11-14',
      periodTo: '2026-11-15',
      label: '9–15-noyabr',
      studentsCount: 3,
      classesCount: 2,
    });
    expect(String(doc.schoolId)).toBe(school.id);
    expect(doc.students.map((s) => [s.fullName, s.rank, s.score])).toEqual([
      ['Valiyev Vali', 1, 100],
      ['Aliyev Ali', 2, 80],
      ['Cholpon <Chol>', 3, 60],
    ]);
  });

  it('parallel ishga tushirish ham bitta arxiv beradi (unikal indeks)', async () => {
    await seedWeek();
    await enable();
    setNow(SAT_18);
    await Promise.all([runRatingResults(), runRatingResults(), runRatingResults()]);
    expect(await countMine()).toBe(1);
  });

  it("arxiv mazmuni [from, e'lon kuni] jonli hisobi bilan bir xil; yakshanba kiritilmaydi", async () => {
    await seedWeek();
    await give(s1, c5, 0, ['2026-11-15']); // yakshanba
    await enable();
    setNow(SAT_18);
    await runRatingResults();
    const doc = (await mine())!;
    const live = await computeLive(school.id, '2026-11-09', '2026-11-14');
    const liveRows = live.data.students
      .filter((r) => r.eligible && r.rank !== null)
      .sort((a, b) => (a.rank as number) - (b.rank as number));
    expect(doc.students.map((s) => [String(s.studentId), s.rank, s.score])).toEqual(
      liveRows.map((r) => [r.studentId, r.rank, r.score]),
    );
    expect(doc.classes.map((c) => [String(c.classId), c.rank, c.score])).toEqual(
      live.data.classes.map((c) => [c.classId, c.rank, c.score]),
    );
    // Butun hafta (yakshanba bilan) farq qilgan bo'lardi
    const full = await computeLive(school.id, '2026-11-09', '2026-11-15');
    const withSunday = full.data.students.find((r) => r.studentId === s1.id)!;
    const frozen = doc.students.find((s) => String(s.studentId) === s1.id)!;
    expect(withSunday.score).not.toBe(frozen.score);
  });

  it('weekday=7 bo‘lsa yakshanba ham kiradi', async () => {
    await seedWeek();
    await give(s1, c5, 0, ['2026-11-15']);
    await enable({ resultsWeekday: 7 });
    setNow('2026-11-15T13:00:00Z');
    await runRatingResults();
    const doc = (await mine())!;
    expect(doc.to).toBe('2026-11-15');
    const live = await computeLive(school.id, '2026-11-09', '2026-11-15');
    expect(doc.students.find((s) => String(s.studentId) === s1.id)!.score).toBe(
      live.data.students.find((r) => r.studentId === s1.id)!.score,
    );
  });

  it("e'londan keyin ball o'zgarsa arxiv o'zgarmaydi, jonli hisob o'zgaradi", async () => {
    await seedWeek();
    await enable();
    setNow(SAT_18);
    await runRatingResults();
    await give(s3, c5, 100, ['2026-11-10', '2026-11-11']);
    await runRatingResults();
    const doc = (await mine())!;
    expect(doc.students).toHaveLength(3);
    const live = await computeLive(school.id, '2026-11-09', '2026-11-14');
    expect(live.data.students.filter((r) => r.eligible)).toHaveLength(4);
  });

  it("server o'chiq edi: keyingi tick oldingi davrni arxivlaydi; eski bo'lgani uchun Telegram yubormaydi", async () => {
    await seedWeek();
    await enable();
    await startBot();
    await link(admin.id, 111);
    setNow('2026-11-17T05:00:00Z'); // keyingi dushanba
    expect((await runRatingResults()).created).toBe(1);
    const doc = (await mine())!;
    expect(doc.periodKey).toBe(WEEK_KEY);
    expect(doc.to).toBe('2026-11-14');
    expect(await TelegramOutbox.countDocuments()).toBe(0);
    expect((await runRatingResults()).created).toBe(0);
  });

  it("e'lon lahzasidan 24 soat ichida kechiksa Telegram yuboriladi", async () => {
    await seedWeek();
    await enable();
    await startBot();
    await link(admin.id, 111);
    setNow('2026-11-14T20:00:00Z');
    await runRatingResults();
    expect(await TelegramOutbox.countDocuments({ kind: 'ratingResults' })).toBe(1);
  });

  it("faqat bitta oldingi davr to'ldiriladi (bir necha hafta keyin ham)", async () => {
    await seedWeek();
    await enable();
    setNow('2026-12-02T05:00:00Z');
    await runRatingResults();
    const keys = (await RatingResult.find({ schoolId: school.id }).lean()).map((d) => d.periodKey);
    expect(keys).toEqual(['week:2026-11-23']);
  });

  it("oy davri: oxirgi kun e'lon vaqtida", async () => {
    await give(s1, c5, 90, ['2026-11-01', '2026-11-02', '2026-11-03']);
    await enable({ periodType: 'month', resultsTime: '20:30' });
    setNow('2026-11-30T15:29:00Z');
    await runRatingResults(); // faqat o'tgan oy (oktyabr) to'ldiriladi
    expect(await countMine('month:2026-11')).toBe(0);
    setNow('2026-11-30T15:30:00Z');
    expect((await runRatingResults()).created).toBe(1);
    const doc = (await mine('month:2026-11'))!;
    expect(doc).toMatchObject({ periodKey: 'month:2026-11', from: '2026-11-01', to: '2026-11-30' });
  });

  it("oy davri: resultsMonthDay=25 bo'lsa 25-kuni e'lon qilinadi, oldin emas", async () => {
    await give(s1, c5, 90, ['2026-11-01', '2026-11-02', '2026-11-03']);
    await enable({ periodType: 'month', resultsMonthDay: 25 });
    setNow('2026-11-25T12:59:00Z');
    await runRatingResults();
    expect(await countMine('month:2026-11')).toBe(0);
    setNow('2026-11-25T13:00:00Z');
    await runRatingResults();
    const doc = (await mine('month:2026-11'))!;
    expect(doc).toMatchObject({ from: '2026-11-01', to: '2026-11-25', periodTo: '2026-11-30' });
  });

  it("erkin davr: resultsDate=2026-11-27 bo'lsa shu kuni e'lon qilinadi", async () => {
    await give(s1, c5, 90, ['2026-11-01', '2026-11-02', '2026-11-03']);
    await enable({
      periodType: 'custom',
      customFrom: '2026-11-01',
      customTo: '2026-11-30',
      resultsDate: '2026-11-27',
    });
    setNow('2026-11-27T12:59:00Z');
    await runRatingResults();
    expect(await countMine('custom:2026-11-01:2026-11-30')).toBe(0);
    setNow('2026-11-27T13:00:00Z');
    await runRatingResults();
    const doc = (await mine('custom:2026-11-01:2026-11-30'))!;
    expect(doc.to).toBe('2026-11-27');
  });

  it("erkin davr: resultsDate davrdan tashqarida bo'lsa oxirgi kuni e'lon qilinadi", async () => {
    await give(s1, c5, 90, ['2026-11-01', '2026-11-02', '2026-11-03']);
    await enable({
      periodType: 'custom',
      customFrom: '2026-11-01',
      customTo: '2026-11-30',
      resultsDate: '2026-10-15',
    });
    setNow('2026-11-27T13:00:00Z');
    await runRatingResults();
    expect(await countMine('custom:2026-11-01:2026-11-30')).toBe(0);
    setNow('2026-11-30T13:00:00Z');
    await runRatingResults();
    expect((await mine('custom:2026-11-01:2026-11-30'))!.to).toBe('2026-11-30');
  });

  it("chorak: sana oldingi chorak ichida bo'lsa o'tkazib yuborilgan oldingi davr shu sana bilan arxivlanadi", async () => {
    await AcademicYear.updateOne(
      { _id: year.id },
      {
        periods: [
          { name: '1-chorak', startDate: new Date('2026-09-01'), endDate: new Date('2026-10-31') },
          { name: '2-chorak', startDate: new Date('2026-11-03'), endDate: new Date('2026-12-27') },
        ],
      },
    );
    await give(s1, c5, 90, ['2026-10-01', '2026-10-02', '2026-10-03']);
    await enable({ periodType: 'quarter', resultsDate: '2026-10-20' });
    setNow('2026-11-10T05:00:00Z');
    await runRatingResults();
    const prev = (await RatingResult.find({ schoolId: school.id }).lean()).filter(
      (d) => d.periodType === 'quarter',
    );
    expect(prev.map((d) => [d.from, d.to])).toEqual([['2026-09-01', '2026-10-20']]);
    // joriy chorakda sana tashqarida: oxirgi kun (2026-12-27) hali kelmagan
    expect(await countMine('quarter:2026-11-03:2026-12-27')).toBe(0);
  });

  it('maktab override: faqat yoqilgan maktab uchun yaratiladi', async () => {
    await put('rating', { scope: 'global', values: { periodType: 'week' } });
    await put('rating', {
      scope: 'school',
      schoolId: other.id,
      values: { resultsEnabled: true },
    });
    setNow(SAT_18);
    await runRatingResults();
    const docs = await RatingResult.find().lean();
    expect(new Set(docs.map((d) => String(d.schoolId)))).toEqual(new Set([other.id]));
  });
});

describe('Admin API', () => {
  async function announced() {
    await seedWeek();
    await enable();
    setNow(SAT_18);
    await runRatingResults();
  }

  it("ro'yxat: faqat o'z maktabi, sahifalash, o'quvchilar massivi yo'q", async () => {
    await announced();
    const r = await get(adm, '/ratings/results', H());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2); // joriy + (bo'sh) o'tgan hafta
    expect(r.body.data[1].studentsCount).toBe(0);
    expect(r.body.data[0]).toMatchObject({
      periodKey: WEEK_KEY,
      label: '9–15-noyabr',
      from: '2026-11-09',
      to: '2026-11-14',
      studentsCount: 3,
      classesCount: 2,
    });
    expect(r.body.data[0].students).toBeUndefined();
    expect(r.body.meta.total).toBe(2);
    const sup = await get(root, '/ratings/results', H(other.id));
    expect(sup.body.data).toHaveLength(0);
  });

  it("batafsil: admin hammasini, o'qituvchi faqat o'z sinfini ko'radi (o'rinlar maktab bo'yicha)", async () => {
    await announced();
    const id = (await get(adm, '/ratings/results', H())).body.data[0].id;
    const a = await get(adm, `/ratings/results/${id}`, H());
    expect(a.body.data.students).toHaveLength(3);
    expect(a.body.data.classes).toHaveLength(2);
    const t = await get(tch, `/ratings/results/${id}`, H());
    expect(t.status).toBe(200);
    expect(t.body.data.students.map((s: { fullName: string }) => s.fullName)).toEqual([
      'Valiyev Vali',
      'Aliyev Ali',
    ]);
    expect(t.body.data.students[1].rank).toBe(2);
    expect(t.body.data.classes.map((c: { name: string }) => c.name)).toEqual(['5-A']);
  });

  it("boshqa maktab arxivi 404; noto'g'ri id 400; ruxsatsiz 403; tokensiz 401", async () => {
    await announced();
    const id = (await get(adm, '/ratings/results', H())).body.data[0].id;
    expect((await get(root, `/ratings/results/${id}`, H(other.id))).status).toBe(404);
    expect((await get(adm, '/ratings/results/xyz', H())).status).toBe(400);
    expect((await get(noPerm, '/ratings/results', H())).status).toBe(403);
    expect((await request(app).get('/api/v1/ratings/results')).status).toBe(401);
  });

  it("qo'lda e'lon: superadmin; takror 409; school_admin 403; audit; [from, bugun]", async () => {
    await seedWeek();
    await put('rating', { scope: 'school', schoolId: school.id, values: { periodType: 'week' } });
    setNow('2026-11-12T05:00:00Z'); // payshanba
    const post = (t: string, h: Record<string, string>) =>
      request(app).post('/api/v1/ratings/results/announce').set(bearer(t)).set(h);
    expect((await post(adm, H())).status).toBe(403);
    const r = await post(root, H(school.id));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ manual: true, from: '2026-11-09', to: '2026-11-12' });
    expect((await post(root, H(school.id))).status).toBe(409);
    expect(await AuditLog.countDocuments({ action: 'ratings.announce' })).toBe(1);
  });
});

describe('Ochiq API (public)', () => {
  const FORBIDDEN = ['studentId', 'classId', 'schoolId', 'comment', 'maxfiy', 'daysCount'];

  async function announced() {
    await seedWeek();
    await enable();
    setNow(SAT_18);
    await runRatingResults();
  }

  it("maktab ochiq bo'lmasa 404; arxiv yo'q bo'lsa data=null", async () => {
    expect((await pub('/res-a/rating/results/latest')).status).toBe(404);
    await enablePublic();
    const r = await pub('/res-a/rating/results/latest');
    expect(r.status).toBe(200);
    expect(r.body.data).toBeNull();
  });

  it("e'lon o'chirilsa arxiv bo'lsa ham yashiriladi", async () => {
    await announced();
    await enablePublic();
    expect((await pub('/res-a/rating/results/latest')).body.data).not.toBeNull();
    await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { resultsEnabled: false },
    });
    expect((await pub('/res-a/rating/results/latest')).body.data).toBeNull();
  });

  it("oq ro'yxat: faqat ruxsat etilgan maydonlar, ichki id/izoh/davomat yo'q", async () => {
    await announced();
    await enablePublic();
    const r = await pub('/res-a/rating/results/latest');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.period).toEqual({
      type: 'week',
      from: '2026-11-09',
      to: '2026-11-15',
      label: '9–15-noyabr',
    });
    expect(d.students.map((s: { fullName: string; rank: number }) => [s.rank, s.fullName])).toEqual(
      [
        [1, 'Valiyev Vali'],
        [2, 'Aliyev Ali'],
        [3, 'Cholpon <Chol>'],
      ],
    );
    expect(Object.keys(d.students[0]).sort()).toEqual(
      ['className', 'fullName', 'rank', 'score', 'studentKey'].sort(),
    );
    expect(Object.keys(d.classes[0]).sort()).toEqual(['className', 'grade', 'rank', 'score']);
    expect(Object.keys(d).sort()).toEqual(['announcedAt', 'classes', 'period', 'students']);
    const raw = JSON.stringify(r.body);
    for (const f of FORBIDDEN) expect(raw).not.toContain(f);
    for (const id of [s1.id, c5.id, school.id]) expect(raw).not.toContain(id);
  });

  it("showScores/showStudents/showClasses/topStudents/showPhotos sozlamalariga bo'ysunadi", async () => {
    await announced();
    await enablePublic({ showScores: false, topStudents: 2, showClasses: false });
    let d = (await pub('/res-a/rating/results/latest')).body.data;
    expect(d.students).toHaveLength(2);
    expect(d.students[0].score).toBeUndefined();
    expect(d.classes).toEqual([]);
    await enablePublic({ showStudents: false, showClasses: true, showScores: true });
    d = (await pub('/res-a/rating/results/latest')).body.data;
    expect(d.students).toEqual([]);
    expect(d.classes).toHaveLength(2);
    expect(d.classes[0].score).toBeDefined();
    await enablePublic({ showStudents: true, showPhotos: true });
    d = (await pub('/res-a/rating/results/latest')).body.data;
    expect(d.students[0]).toHaveProperty('photoUrl', null); // rasm yo'q: null, ichki id yo'q
  });

  it('yangi arxiv chiqqach kesh tozalanadi', async () => {
    await seedWeek();
    await enable();
    await enablePublic();
    expect((await pub('/res-a/rating/results/latest')).body.data).toBeNull();
    setNow(SAT_18);
    await runRatingResults();
    expect((await pub('/res-a/rating/results/latest')).body.data).not.toBeNull();
  });
});

describe('Telegram', () => {
  async function run() {
    await seedWeek();
    await enable();
    setNow(SAT_18);
    await runRatingResults();
  }

  it("rahbariyat va tanlagan superadminlarga; o'qituvchi, tanlamagan va nofaolga yo'q", async () => {
    await startBot();
    await link(admin.id, 111);
    await link(admin2.id, 112);
    await User.updateOne({ _id: admin2.id }, { isActive: false });
    await link(teacherUser.id, 113);
    await link(rootUser.id, 114);
    await User.updateOne({ _id: rootUser.id }, { 'telegram.reportScope': school.id });
    const rootB = await makeUser({ username: 'rroot2', role: 'superadmin' });
    await link(rootB.id, 115); // reportScope yo'q
    const rootC = await makeUser({ username: 'rroot3', role: 'superadmin' });
    await link(rootC.id, 116);
    await User.updateOne({ _id: rootC.id }, { 'telegram.reportScope': 'all' });
    const rootD = await makeUser({ username: 'rroot4', role: 'superadmin' });
    await link(rootD.id, 117);
    await User.updateOne({ _id: rootD.id }, { 'telegram.reportScope': other.id });
    await run();
    const rows = await TelegramOutbox.find({ kind: 'ratingResults' }).sort({ chatId: 1 });
    expect(rows.map((r) => r.chatId)).toEqual([111, 114, 116]);
    expect(rows[0]!.dedupeKey).toBe(`ratingResults:${school.id}:${admin.id}:${WEEK_KEY}`);
    expect(rows[0]!.parseMode).toBe('HTML');
  });

  it("notify.ratingResults o'chiq bo'lsa yuborilmaydi (arxiv baribir yaratiladi)", async () => {
    await startBot();
    await link(admin.id, 111);
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { ratingResults: false } },
      admin.id,
    );
    await run();
    expect(await countMine()).toBe(1);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it("bot ishlamasa arxiv yaratiladi, xabar yo'q", async () => {
    await link(admin.id, 111);
    await run();
    expect(await countMine()).toBe(1);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it('standart yoqilgan; takror ishga tushirish dublikat yozmaydi', async () => {
    await startBot();
    await link(admin.id, 111);
    await run();
    await runRatingResults();
    expect(await TelegramOutbox.countDocuments({ kind: 'ratingResults' })).toBe(1);
  });

  it('xabar matni: medallar, top 10, top 3 sinf, HTML escape', () => {
    const students = Array.from({ length: 12 }, (_, i) => ({
      studentId: `s${i}` as never,
      fullName: i === 2 ? 'Cholpon <Chol>' : `Oquvchi ${i + 1}`,
      classId: 'c' as never,
      className: '5-A',
      grade: 5,
      score: 96.4 - i,
      rank: i + 1,
      daysCount: 3,
      scoresCount: 3,
    }));
    const classes = [1, 2, 3, 4].map((r) => ({
      classId: `c${r}` as never,
      name: `${r}-A`,
      grade: r,
      score: 95 - r,
      rank: r,
      ratedStudents: 5,
    }));
    const text = buildRatingResultsMessage('1-maktab', {
      periodType: 'week',
      label: '9–15-noyabr',
      students,
      classes,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('🏆 <b>Hafta yakuni</b> · 1-maktab');
    expect(lines[1]).toBe('9–15-noyabr');
    expect(lines[3]).toBe('🥇 Oquvchi 1 · 5-A — 96,4');
    expect(lines[5]).toBe('🥉 Cholpon &lt;Chol&gt; · 5-A — 94,4');
    expect(lines[6]).toBe('4. Oquvchi 4 · 5-A — 93,4');
    expect(text).toContain('10. Oquvchi 10');
    expect(text).not.toContain('Oquvchi 11');
    expect(lines.at(-1)).toBe('🏫 Eng yaxshi sinflar: 1) 1-A 94 2) 2-A 93 3) 3-A 92');
    expect(text).not.toContain('4-A');
  });
});

describe("Yakunni o'chirish (yumshoq, tombstone)", () => {
  const PREV_KEY = 'week:2026-11-02';
  const del = (t: string, id: string, h: Record<string, string> = H(school.id)) =>
    request(app).delete(`/api/v1/ratings/results/${id}`).set(bearer(t)).set(h);
  const announce = (t = root) =>
    request(app).post('/api/v1/ratings/results/announce').set(bearer(t)).set(H(school.id));

  async function announced() {
    await seedWeek();
    await enable();
    setNow(SAT_18);
    await runRatingResults();
  }
  const idOf = async (key = WEEK_KEY) => String((await mine(key))?._id);

  it('superadmin yumshoq o‘chiradi: hujjat qoladi, audit yoziladi, ro‘yxat va batafsil yashiradi', async () => {
    await announced();
    const id = await idOf();
    const r = await del(root, id);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id });
    const doc = await mine();
    expect(doc?.deletedAt).toBeInstanceOf(Date);
    expect(String(doc?.deletedBy)).toBe(rootUser.id);
    expect(doc?.students).toHaveLength(3); // ma'lumot saqlanadi
    const audit = await AuditLog.findOne({ action: 'ratings.results.delete' }).lean();
    expect(audit?.before).toMatchObject({
      periodKey: WEEK_KEY,
      label: '9–15-noyabr',
      studentsCount: 3,
    });
    const list = await get(adm, '/ratings/results', H());
    expect(list.body.data.map((d: { periodKey: string }) => d.periodKey)).toEqual([PREV_KEY]);
    expect(list.body.meta.total).toBe(1);
    expect((await get(adm, `/ratings/results/${id}`, H())).status).toBe(404);
  });

  it('school_admin va o‘qituvchi 403, tokensiz 401; hech narsa o‘chmaydi', async () => {
    await announced();
    const id = await idOf();
    expect((await del(adm, id, H())).status).toBe(403);
    expect((await del(tch, id, H())).status).toBe(403);
    expect((await request(app).delete(`/api/v1/ratings/results/${id}`)).status).toBe(401);
    expect((await mine())?.deletedAt ?? null).toBeNull();
    expect((await del(root, 'xyz')).status).toBe(400);
  });

  it('boshqa maktab X-School-Id bilan 404; qayta o‘chirish 404', async () => {
    await announced();
    const id = await idOf();
    expect((await del(root, id, H(other.id))).status).toBe(404);
    expect((await mine())?.deletedAt ?? null).toBeNull();
    expect((await del(root, id)).status).toBe(200);
    expect((await del(root, id)).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'ratings.results.delete' })).toBe(1);
  });

  it('eski hujjat (deletedAt maydoni yo‘q) o‘chirilmagan hisoblanadi', async () => {
    await announced();
    await RatingResult.collection.updateMany({}, { $unset: { deletedAt: '', deletedBy: '' } });
    expect((await get(adm, '/ratings/results', H())).body.data).toHaveLength(2);
    const id = await idOf();
    expect((await get(adm, `/ratings/results/${id}`, H())).status).toBe(200);
    expect((await del(root, id)).status).toBe(200);
  });

  it('vazifa o‘chirilgan davrni qayta yaratmaydi (joriy va oldingi), Telegram yo‘q', async () => {
    await announced();
    await startBot();
    await link(admin.id, 111);
    for (const key of [WEEK_KEY, PREV_KEY])
      expect((await del(root, await idOf(key))).status).toBe(200);
    const before = await TelegramOutbox.countDocuments({});
    setNow('2026-11-14T13:05:00Z');
    expect((await runRatingResults()).created).toBe(0);
    expect(await countMine(WEEK_KEY)).toBe(1);
    expect(await countMine(PREV_KEY)).toBe(1);
    expect((await mine())?.deletedAt).toBeTruthy();
    expect(await TelegramOutbox.countDocuments({})).toBe(before);
    expect((await get(adm, '/ratings/results', H())).body.data).toHaveLength(0);
  });

  it('manual e‘lon: faqat tombstone bo‘lsa qayta yaratadi, faol bo‘lsa 409', async () => {
    await seedWeek();
    await put('rating', { scope: 'school', schoolId: school.id, values: { periodType: 'week' } });
    setNow('2026-11-12T05:00:00Z');
    const first = await announce();
    expect(first.status).toBe(200);
    expect((await announce()).status).toBe(409);
    expect((await del(root, first.body.data.id)).status).toBe(200);
    const again = await announce();
    expect(again.status).toBe(200);
    expect(again.body.data.id).not.toBe(first.body.data.id);
    expect(again.body.data).toMatchObject({ manual: true, periodKey: WEEK_KEY });
    expect(await countMine()).toBe(1); // tombstone almashtirildi
    expect((await mine())?.deletedAt ?? null).toBeNull();
    expect((await announce()).status).toBe(409);
    const list = await get(adm, '/ratings/results', H());
    expect(list.body.data).toHaveLength(1);
  });

  it('ochiq sayt: o‘chirilgach keshdan chiqadi va avvalgi (o‘quvchili) arxivga qaytadi', async () => {
    await announced();
    await enablePublic();
    await RatingResult.create({
      schoolId: school.id,
      periodType: 'week',
      periodKey: 'week:2026-10-26',
      from: '2026-10-26',
      to: '2026-10-31',
      periodTo: '2026-11-01',
      label: '26-oktabr–1-noyabr',
      announcedAt: new Date('2026-10-31T13:00:00Z'),
      settings: {},
      studentsCount: 1,
      students: [
        { studentId: s1._id, fullName: 'Aliyev Ali', classId: c5._id, score: 90, rank: 1 },
      ],
    });
    const a = await pub('/res-a/rating/results/latest');
    expect(a.body.data.period.label).toBe('9–15-noyabr');
    expect((await del(root, await idOf())).status).toBe(200);
    const b = await pub('/res-a/rating/results/latest');
    expect(b.body.data.period.label).toBe('26-oktabr–1-noyabr');
    // oldingi bo'sh (0 o'quvchi) arxiv sinfga tushmaydi; hammasi o'chsa null
    expect((await del(root, await idOf('week:2026-10-26'))).status).toBe(200);
    expect((await pub('/res-a/rating/results/latest')).body.data).toBeNull();
  });
});
