import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { loadDiscipline } from '../src/modules/telegram/telegram.report.data';
import { dailyScore } from '../src/utils/dayScore';
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

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z';
const Q = 'from=2026-10-01&to=2026-10-14';

let school: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let cls: Doc;
let s1: Doc, s2: Doc, s3: Doc;
let teacher: Doc, other: Doc;
let pen20: Doc, pen0: Doc;
let root: string, rep: string, tch: string, adm: string;

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('demo-po');
  year = await makeYear(school.id);
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  other = await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['scores.create', 'scores.edit', 'reports.view', 'dashboard.view'],
  });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view', 'reports.export', 'dashboard.view'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  cls = await makeClass(school.id, year.id, '5-A', [teacher.id], {
    homeroomTeacherId: teacher.id,
  });
  s1 = await makeStudent(school.id, cls.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, cls.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, cls.id, 'Karimov Karim');
  pen20 = await makeBehaviorType('Dars paytida bezovtalik', 'negative', { ratingPenalty: 20 });
  pen0 = await makeBehaviorType('Namunali xulq', 'positive');
  const base = (st: Doc, v: number, days = [1, 2, 3]) =>
    Score.insertMany(
      days.map((n) => ({
        schoolId: school.id,
        studentId: st._id,
        classId: cls._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: pen0._id,
        value: v,
        date: `2026-10-0${n}`,
      })),
    );
  await base(s1, 90);
  await base(s2, 80);
  await base(s3, 80, [1, 2]); // 2 ta ballik kun: minScoresCount (3) ga yetmaydi
  [root, rep, tch, adm] = await Promise.all(
    ['root', 'rep', 'teacher1', 'adm'].map(async (u) => (await login(u)).token),
  );
  await request(app)
    .put('/api/v1/settings/scoring')
    .set(bearer(root))
    .send({ scope: 'global', values: { backdateDays: 30, requireBehaviorType: false } });
});

// Debounce/qayta hisob poygasiga bog'liq bo'lmaslik uchun: kutilayotganini bajarib, qo'lda qayta hisoblaymiz
const settle = async () => {
  await ratingEvents.flushAll();
  await request(app)
    .post('/api/v1/ratings/recalculate')
    .set(bearer(root))
    .set({ 'X-School-Id': school.id });
};
const put = (key: string, body: object) =>
  request(app).put(`/api/v1/settings/${key}`).set(bearer(root)).send(body);
const enable = async (on = true) => {
  const r = await put('rating', {
    scope: 'school',
    schoolId: school.id,
    values: { behaviorPenaltyEnabled: on },
  });
  await settle();
  return r;
};
const H = () => ({ 'X-School-Id': school.id });
const post = (t: string, body: object) =>
  request(app).post('/api/v1/scores').set(bearer(t)).set(H()).send(body);
const bulk = (t: string, items: object[], date = '2026-10-05') =>
  request(app)
    .post('/api/v1/scores/bulk')
    .set(bearer(t))
    .set(H())
    .send({ classId: cls.id, date, items });
const patch = (t: string, id: string, body: object) =>
  request(app).patch(`/api/v1/scores/${id}`).set(bearer(t)).set(H()).send(body);
const only = (studentId: string, date = '2026-10-05', typeId: Doc | null = pen20) => ({
  studentId,
  date,
  value: null,
  behaviorTypeId: typeId?.id ?? null,
});
const rows = async (q = '') =>
  (await request(app).get(`/api/v1/ratings/students${q}`).set(bearer(rep)).set(H())).body.data
    .items as {
    studentId: string;
    score: number;
    behaviorPenalty: number;
    daysCount: number;
    scoresCount: number;
    eligible: boolean;
    rank: number | null;
  }[];
const INC = '?includeIneligible=true';
const of = async (id: string, q = '') => (await rows(q)).find((i) => i.studentId === id)!;

describe('POST /scores: faqat jarima qaydi', () => {
  it("jarima yoqilgan + jarimali tur: value null bilan yaratiladi (ball yo'q ham, null ham)", async () => {
    await enable();
    const a = await post(adm, only(s1.id));
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ value: null, behaviorPenalty: 20 });
    const { value: _omit, ...noValue } = only(s2.id);
    void _omit;
    const b = await post(adm, noValue);
    expect(b.status).toBe(201);
    expect(b.body.data.value).toBeNull();
    const doc = await Score.findById(a.body.data.id);
    expect(doc?.value).toBeNull();
    expect(doc?.behaviorPenalty).toBe(20);
  });

  it("rad etiladi (400): jarima o'chiq, jarimasiz tur, turisiz", async () => {
    // jarima o'chiq (standart)
    const off = await post(adm, only(s1.id));
    expect(off.status).toBe(400);
    expect(off.body.error.details[0].path).toBe('value');
    await enable();
    expect((await post(adm, only(s1.id, '2026-10-05', pen0))).status).toBe(400);
    expect((await post(adm, only(s1.id, '2026-10-05', null))).status).toBe(400);
    expect(await Score.countDocuments({ studentId: s1._id, date: '2026-10-05' })).toBe(0);
  });

  it("ball bilan ham yaratiladi (ikkalasi qo'llanadi); noto'g'ri ball hamon 400", async () => {
    await enable();
    const ok = await post(adm, { ...only(s1.id), value: 70 });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ value: 70, behaviorPenalty: 20 });
    expect((await post(adm, { ...only(s2.id), value: 101 })).status).toBe(400);
  });

  it("commentRequiredBelow ball bo'sh bo'lganda qo'llanmaydi", async () => {
    await enable();
    await put('scoring', {
      scope: 'global',
      values: { commentRequiredBelow: 60, backdateDays: 30, requireBehaviorType: false },
    });
    expect((await post(adm, only(s1.id))).status).toBe(201);
    expect((await post(adm, { ...only(s2.id), value: 40 })).status).toBe(400);
  });
});

describe('POST /scores/bulk: faqat jarima qaydi', () => {
  it("elementlar mustaqil: ruxsat etilgan yaratiladi, jarimasiz tur failed'ga tushadi", async () => {
    await enable();
    const res = await bulk(tch, [
      { studentId: s1.id, behaviorTypeId: pen20.id, value: null },
      { studentId: s2.id, behaviorTypeId: pen0.id, value: null },
      { studentId: s3.id, behaviorTypeId: pen20.id },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0]).toMatchObject({ studentId: s2.id, code: 'VALIDATION_ERROR' });
    expect((await Score.findOne({ studentId: s1._id, date: '2026-10-05' }))?.value).toBeNull();
  });

  it('jarima o`chiq bo`lsa hammasi failed', async () => {
    const res = await bulk(tch, [{ studentId: s1.id, behaviorTypeId: pen20.id, value: null }]);
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.failed).toHaveLength(1);
  });

  it('upsert: mavjud oddiy baho faqat jarimaga, so`ng ballga almashadi', async () => {
    await enable();
    await bulk(tch, [{ studentId: s1.id, behaviorTypeId: pen0.id, value: 75 }]);
    const r2 = await bulk(tch, [{ studentId: s1.id, behaviorTypeId: pen20.id, value: null }]);
    expect(r2.body.data).toMatchObject({ created: 0, updated: 1 });
    const d = await Score.findOne({ studentId: s1._id, date: '2026-10-05' });
    expect(d?.value).toBeNull();
    expect(d?.behaviorPenalty).toBe(20);
    await bulk(tch, [{ studentId: s1.id, behaviorTypeId: pen20.id, value: 60 }]);
    expect((await Score.findOne({ studentId: s1._id, date: '2026-10-05' }))?.value).toBe(60);
  });
});

describe('PATCH /scores/:id', () => {
  it("oddiy bahoni faqat jarimaga o'tkazish va qaytarish", async () => {
    await enable();
    const c = await post(adm, {
      studentId: s1.id,
      date: '2026-10-05',
      value: 80,
      behaviorTypeId: pen20.id,
    });
    const id = c.body.data.id as string;
    const a = await patch(adm, id, { value: null });
    expect(a.status).toBe(200);
    expect(a.body.data.value).toBeNull();
    const b = await patch(adm, id, { value: 55 });
    expect(b.body.data.value).toBe(55);
    // value berilmasa o'zgarmaydi
    const c2 = await patch(adm, id, { comment: 'izoh' });
    expect(c2.body.data.value).toBe(55);
  });

  it("faqat jarima qaydini jarimasiz turga o'tkazish yoki jarima o'chganda null — 400", async () => {
    await enable();
    const c = await post(adm, only(s1.id));
    const id = c.body.data.id as string;
    expect((await patch(adm, id, { behaviorTypeId: pen0.id })).status).toBe(400);
    expect((await patch(adm, id, { behaviorTypeId: null })).status).toBe(400);
    // oddiy bahoni jarimasiz turda value=null qilib bo'lmaydi
    const d = await post(adm, {
      studentId: s2.id,
      date: '2026-10-05',
      value: 70,
      behaviorTypeId: pen0.id,
    });
    expect((await patch(adm, d.body.data.id, { value: null })).status).toBe(400);
    await enable(false);
    expect((await patch(adm, id, { comment: 'x' })).status).toBe(400);
  });
});

describe('Reyting', () => {
  it("o'rtacha o'zgarmaydi, yakuniy ball aynan jarimaga kamayadi, ballik kunlar soni o'zgarmaydi", async () => {
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 90, behaviorPenalty: 0, daysCount: 3 });
    await post(adm, only(s1.id)); // yangi kunda faqat jarima
    await settle();
    const r = await of(s1.id);
    expect(r).toMatchObject({
      score: 70,
      behaviorPenalty: 20,
      daysCount: 3,
      scoresCount: 3,
      eligible: true,
    });
  });

  it('ballik kunda qo`shimcha jarima qaydi: kun bali o`zgarmaydi (average/min/last), jarima ayiriladi', async () => {
    await enable();
    // s1: 2026-10-01 da 90 (teacher). Admin shu kunga faqat jarima qo'shadi (createdAt keyinroq).
    await post(adm, only(s1.id, '2026-10-01'));
    for (const mode of ['average', 'min', 'last'] as const) {
      await put('scoring', { scope: 'global', values: { dailyAggregation: mode } });
      await settle();
      expect(await of(s1.id)).toMatchObject({ score: 70, behaviorPenalty: 20, daysCount: 3 });
    }
  });

  it("aralash null: ikkinchi o'qituvchi 70 + faqat jarima — min/last/average faqat sonlardan", async () => {
    await enable();
    await post(adm, { studentId: s1.id, date: '2026-10-01', value: 70, behaviorTypeId: pen0.id });
    await makeUser({
      username: 'adm2',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['scores.create'],
    });
    const adm2 = (await login('adm2')).token;
    // eng oxirgi yozuv — faqat jarima qaydi (last rejimida e'tiborga olinmasligi kerak)
    expect((await post(adm2, only(s1.id, '2026-10-01'))).status).toBe(201);
    const expected: Record<string, number> = { average: 80, min: 70, last: 70 };
    for (const mode of ['average', 'min', 'last'] as const) {
      await put('scoring', { scope: 'global', values: { dailyAggregation: mode } });
      await settle();
      // kunlar: (1-okt) mode, 2,3-okt 90 -> o'rtacha
      const day1 = expected[mode];
      const avg = Math.round(((day1 + 90 + 90) / 3 + Number.EPSILON) * 100) / 100;
      expect((await of(s1.id)).score).toBe(Math.round((avg - 20) * 100) / 100); // jarima 20
    }
  });

  it("minScoresCount: faqat jarima kuni ballik kun hisoblanmaydi (eligible emas), ballik bo'lsa eligible", async () => {
    await enable();
    expect(await of(s3.id, INC)).toMatchObject({ eligible: false, daysCount: 2 });
    await post(adm, only(s3.id, '2026-10-03'));
    await settle();
    expect(await of(s3.id, INC)).toMatchObject({ eligible: false, daysCount: 2, rank: null });
    await post(adm, { studentId: s3.id, date: '2026-10-04', value: 80, behaviorTypeId: pen0.id });
    await settle();
    // aniqlik uchun qo'lda qayta hisoblash (yuklama ostida debounce poygasiga bog'liq bo'lmasin)
    await request(app).post('/api/v1/ratings/recalculate').set(bearer(root)).set(H());
    expect(await of(s3.id, INC)).toMatchObject({
      eligible: true,
      daysCount: 3,
      behaviorPenalty: 20,
    });
  });

  it("jarima keyin o'chirilsa (sozlama) faqat jarima qaydi reytingga ta'sir qilmaydi, NaN yo'q", async () => {
    await enable();
    await post(adm, only(s1.id));
    await enable(false);
    const r = await of(s1.id);
    expect(r).toMatchObject({ score: 90, behaviorPenalty: 0 });
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('jonli (from/to) hisob ham null ni o`tkazib yuboradi', async () => {
    await enable();
    await post(adm, only(s1.id));
    expect(await of(s1.id, '?from=2026-10-01&to=2026-10-14')).toMatchObject({
      score: 70,
      daysCount: 3,
    });
  });
});

describe('Hisobotlar, dashboard, telegram', () => {
  it("student/class/school hisoboti: o'rtacha null ni hisobga olmaydi, sonlar turi bo'yicha qoladi; eksport ishlaydi", async () => {
    await enable();
    await post(adm, only(s1.id));
    const r = await request(app)
      .get(`/api/v1/reports/student/${s1.id}?${Q}`)
      .set(bearer(rep))
      .set(H());
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.score).toMatchObject({ avgScore: 90, minScore: 90, maxScore: 90, daysCount: 3 });
    expect(
      d.behaviorDistribution.find((b: { name: string }) => b.name === 'Dars paytida bezovtalik')
        .count,
    ).toBe(1);
    expect(d.entries.some((e: { value: number | null }) => e.value === null)).toBe(true);
    expect(d.trend).toHaveLength(3);
    for (const fmt of ['xlsx', 'pdf']) {
      const x = await request(app)
        .get(`/api/v1/reports/student/${s1.id}/export?${Q}&format=${fmt}`)
        .set(bearer(rep))
        .set(H());
      expect(x.status).toBe(200);
    }
    const c = await request(app)
      .get(`/api/v1/reports/class?classId=${cls.id}&${Q}`)
      .set(bearer(rep))
      .set(H());
    expect(c.status).toBe(200);
    expect(JSON.stringify(c.body)).not.toContain('NaN');
    const sc = await request(app).get(`/api/v1/reports/school?${Q}`).set(bearer(rep)).set(H());
    expect(sc.status).toBe(200);
    const be = await request(app).get(`/api/v1/reports/behavior?${Q}`).set(bearer(rep)).set(H());
    expect(be.status).toBe(200);
  });

  it("dashboard: faqat jarima qaydi 'baholangan' hisoblanadi va e'tibor ro'yxatiga negativ sifatida kiradi", async () => {
    await enable();
    const today = '2026-10-14';
    for (const st of [s1, s2, s3]) await post(tch, only(st.id, today));
    const un = await request(app)
      .get('/api/v1/dashboard/unscored-classes')
      .set(bearer(adm))
      .set(H());
    expect(un.status).toBe(200);
    expect(un.body.data.classes).toHaveLength(0); // hamma baholangan
    // 3 ta negativ qayd (oxirgi 7 kun)
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12']) await post(adm, only(s2.id, d));
    const at = await request(app)
      .get('/api/v1/dashboard/attention-students')
      .set(bearer(adm))
      .set(H());
    expect(at.status).toBe(200);
    const st = at.body.data.students.find((s: { studentId: string }) => s.studentId === s2.id);
    expect(st.reasons.some((x: { type: string }) => x.type === 'negative')).toBe(true);
    expect(JSON.stringify(at.body)).not.toContain('NaN');
    const sum = await request(app).get('/api/v1/dashboard/summary').set(bearer(adm)).set(H());
    expect(sum.status).toBe(200);
    expect(sum.body.data.scoresToday).toBe(3);
  });

  it('GET /scores, sheet, today-progress, summary: null qiymat bilan ishlaydi', async () => {
    await enable();
    const today = '2026-10-14';
    await post(tch, only(s1.id, today));
    const list = await request(app)
      .get(`/api/v1/scores?studentId=${s1.id}`)
      .set(bearer(tch))
      .set(H());
    expect(list.body.data.find((i: { date: string }) => i.date === today)).toMatchObject({
      value: null,
      behaviorPenalty: 20,
    });
    const sheet = await request(app)
      .get(`/api/v1/classes/${cls.id}/scoring-sheet?date=${today}`)
      .set(bearer(tch))
      .set(H());
    expect(sheet.status).toBe(200);
    const st = sheet.body.data.students.find((s: { studentId: string }) => s.studentId === s1.id);
    expect(st.dayScore).toBeNull();
    expect(st.myScore.value).toBeNull();
    expect(st.scoresCount).toBe(1);
    const prog = await request(app).get('/api/v1/scores/today-progress').set(bearer(tch)).set(H());
    expect(prog.body.data[0]).toMatchObject({ scored: 1, total: 3 });
    const sum = await request(app)
      .get(`/api/v1/students/${s1.id}/score-summary?from=2026-10-01&to=${today}`)
      .set(bearer(tch))
      .set(H());
    expect(sum.status).toBe(200);
    expect(sum.body.data).toMatchObject({ average: 90, daysCount: 3, scoresCount: 4 });
    expect(sum.body.data.trend.every((t: { dayScore: number | null }) => t.dayScore !== null)).toBe(
      true,
    );
  });

  it('telegram intizom hisoboti: null ball NaN keltirmaydi, soni hisoblanadi', async () => {
    await enable();
    for (const d of ['2026-10-05', '2026-10-06']) await post(adm, only(s1.id, d));
    await post(adm, { studentId: s2.id, date: '2026-10-05', value: 50, behaviorTypeId: pen20.id });
    const r = await loadDiscipline(school.id, '2026-10-01', '2026-10-14');
    expect(r.negative).toBe(3);
    expect(r.topStudents[0]).toMatchObject({ fullName: 'Aliyev Ali', count: 2 });
    expect(JSON.stringify(r)).not.toContain('NaN');
  });
});

describe('Eski (legacy) hujjatlar va toza funksiyalar', () => {
  it("behaviorPenalty yo'q eski hujjat o'qiladi va yangilanadi", async () => {
    const { insertedId } = await Score.collection.insertOne({
      schoolId: school._id,
      studentId: s1._id,
      classId: cls._id,
      teacherId: other._id,
      academicYearId: year._id,
      behaviorTypeId: null,
      value: 77,
      comment: null,
      date: '2026-10-06',
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const list = await request(app)
      .get(`/api/v1/scores?studentId=${s1.id}`)
      .set(bearer(adm))
      .set(H());
    expect(list.body.data.find((i: { id: string }) => i.id === String(insertedId))).toMatchObject({
      value: 77,
      behaviorPenalty: 0,
    });
    const upd = await patch(adm, String(insertedId), { value: 66 });
    expect(upd.status).toBe(200);
    expect(upd.body.data.value).toBe(66);
  });

  it('dailyScore null larni o`tkazib yuboradi', () => {
    const at = (value: number | null, ms: number) => ({ value, createdAt: new Date(ms) });
    expect(dailyScore([at(null, 1)], 'average')).toBeNull();
    expect(dailyScore([at(80, 1), at(null, 2)], 'last')).toBe(80);
    expect(dailyScore([at(80, 1), at(null, 2), at(60, 3)], 'min')).toBe(60);
    expect(dailyScore([at(80, 1), at(null, 2), at(61, 3)], 'average')).toBe(70.5);
  });
});
