import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { BehaviorType } from '../src/models/BehaviorType';
import { RatingResult } from '../src/models/RatingResult';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { applyPenalties, buildStudentRows } from '../src/modules/ratings/rating.calc';
import { runRatingResults } from '../src/modules/ratings/rating.results';
import { RATING_DEFAULTS } from '../src/modules/settings/rating.settings';
import { clock } from '../src/utils/clock';
import {
  AttendanceRecord,
  Score,
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z';
const WEEK_KEY = 'week:2026-11-09';

let school: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let cls: Doc;
let s1: Doc, s2: Doc;
let teacher: Doc;
let neg1: Doc, neg2: Doc, zero: Doc, big: Doc;
let root: string, rep: string, tch: string, adm: string;

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('demo-b');
  year = await makeYear(school.id);
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['scores.create', 'scores.edit'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  cls = await makeClass(school.id, year.id, '5-A', [teacher.id], {
    homeroomTeacherId: teacher.id,
  });
  s1 = await makeStudent(school.id, cls.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, cls.id, 'Valiyev Vali');
  zero = await makeBehaviorType('Namunali xulq');
  neg1 = await makeBehaviorType('Darsni buzdi', 'negative', { ratingPenalty: 5 });
  neg2 = await makeBehaviorType('Kech keldi', 'negative', { ratingPenalty: 3 });
  big = await makeBehaviorType('Janjal', 'negative', { ratingPenalty: 100 });
  const base = (st: Doc, v: number) =>
    Score.insertMany(
      [1, 2, 3].map((n) => ({
        schoolId: school.id,
        studentId: st._id,
        classId: cls._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: zero._id,
        value: v,
        date: `2026-10-0${n}`,
      })),
    );
  await base(s1, 90);
  await base(s2, 80);
  [root, rep, tch, adm] = await Promise.all(
    ['root', 'rep', 'teacher1', 'adm'].map(async (u) => (await login(u)).token),
  );
  // O'tgan sanalarga baho qo'yish uchun
  await request(app)
    .put('/api/v1/settings/scoring')
    .set(bearer(root))
    .send({ scope: 'global', values: { backdateDays: 30, requireBehaviorType: false } });
});

const put = (key: string, body: object) =>
  request(app).put(`/api/v1/settings/${key}`).set(bearer(root)).send(body);
const enable = async (on = true) => {
  const r = await put('rating', {
    scope: 'school',
    schoolId: school.id,
    values: { behaviorPenaltyEnabled: on },
  });
  await ratingEvents.flushAll();
  return r;
};
const postScore = (t: string, studentId: string, date: string, typeId: Doc | null, value = 90) =>
  request(app)
    .post('/api/v1/scores')
    .set(bearer(t))
    .set('X-School-Id', school.id)
    .send({ studentId, date, value, behaviorTypeId: typeId?.id ?? null });
const students = async (q = '') =>
  (
    await request(app)
      .get(`/api/v1/ratings/students${q}`)
      .set(bearer(rep))
      .set('X-School-Id', school.id)
  ).body.data.items as {
    studentId: string;
    score: number;
    penalty: number;
    behaviorPenalty: number;
    rank: number;
  }[];
const of = async (id: string, q = '') => (await students(q)).find((i) => i.studentId === id)!;
const recalc = async () => {
  await request(app)
    .post('/api/v1/ratings/recalculate')
    .set(bearer(root))
    .set('X-School-Id', school.id);
};

describe('applyPenalties: xulq jarimasi (toza funksiya)', () => {
  it('orqaga moslik, birgalikda ayirish va 0 chegarasi', () => {
    const base = buildStudentRows(
      [
        { id: 'a', fullName: 'A', classId: 'c' },
        { id: 'b', fullName: 'B', classId: 'c' },
      ],
      new Map([
        ['a', { daysCount: 3, scoresCount: 3, sumDays: 270 }],
        ['b', { daysCount: 3, scoresCount: 3, sumDays: 30 }],
      ]),
      { method: 'average', minScoresCount: 3 },
    );
    const old = applyPenalties(base, new Map([['a', 4]])); // 2 argumentli chaqiruv
    expect(old[0]).toMatchObject({ score: 86, penalty: 4, behaviorPenalty: 0 });
    const both = applyPenalties(base, new Map([['a', 4]]), new Map([['a', 6]]));
    expect(both[0]).toMatchObject({ score: 80, penalty: 4, behaviorPenalty: 6 });
    const floor = applyPenalties(base, new Map(), new Map([['b', 50]]));
    expect(floor[1]).toMatchObject({ score: 0, penalty: 0, behaviorPenalty: 50 });
    expect(base[0].score).toBe(90);
  });
});

describe('Xulq turi jarimasi: hisoblash', () => {
  it("o'chiq (standart): jarimali tur bahosi reytingni o'zgartirmaydi", async () => {
    expect(RATING_DEFAULTS.behaviorPenaltyEnabled).toBe(false);
    expect((await postScore(tch, s1.id, '2026-10-05', neg1)).status).toBe(201);
    await ratingEvents.flushAll();
    expect(await of(s1.id)).toMatchObject({ score: 90, penalty: 0, behaviorPenalty: 0 });
  });

  it("yoqilganda jarima ayiriladi; qayta o'chirsak asl holat qaytadi", async () => {
    await postScore(tch, s1.id, '2026-10-05', neg1);
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 85, penalty: 0, behaviorPenalty: 5, rank: 1 });
    expect(await of(s2.id)).toMatchObject({ score: 80, behaviorPenalty: 0, rank: 2 });
    await enable(false);
    expect(await of(s1.id)).toMatchObject({ score: 90, behaviorPenalty: 0, rank: 1 });
  });

  it("bir xil tur bir kunda ikki o'qituvchidan = bir marta", async () => {
    await postScore(tch, s1.id, '2026-10-05', neg1);
    expect((await postScore(adm, s1.id, '2026-10-05', neg1)).status).toBe(201);
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 85, behaviorPenalty: 5 });
    // boshqa kunda yana shu tur: alohida kun, qo'shiladi
    await postScore(tch, s1.id, '2026-10-06', neg1);
    await recalc();
    expect(await of(s1.id)).toMatchObject({ score: 80, behaviorPenalty: 10 });
  });

  it("turli turlar bir kunda: har biri hisoblanadi; jarimasiz va turisiz baholar ta'sir qilmaydi", async () => {
    await postScore(tch, s1.id, '2026-10-05', neg1);
    await postScore(adm, s1.id, '2026-10-05', neg2);
    await postScore(tch, s1.id, '2026-10-06', zero);
    await postScore(tch, s1.id, '2026-10-07', null);
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 82, behaviorPenalty: 8 });
  });

  it("davr tashqarisi va o'chirilgan baho hisobga olinmaydi; jonli (from/to) hisob ham", async () => {
    await postScore(tch, s1.id, '2026-09-20', neg1);
    const del = await postScore(tch, s1.id, '2026-10-05', neg1);
    await postScore(adm, s1.id, '2026-10-08', neg2);
    await request(app)
      .delete(`/api/v1/scores/${del.body.data.id}`)
      .set(bearer(tch))
      .set('X-School-Id', school.id);
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 87, behaviorPenalty: 3 });
    expect(await of(s1.id, '?from=2026-10-01&to=2026-10-07')).toMatchObject({
      score: 90,
      behaviorPenalty: 0,
    });
    expect(await of(s1.id, '?from=2026-10-01&to=2026-10-14')).toMatchObject({
      score: 87,
      behaviorPenalty: 3,
    });
  });

  it('0 dan pastga tushmaydi va davomat jarimasi bilan birga ishlaydi', async () => {
    await postScore(tch, s1.id, '2026-10-05', big);
    await postScore(tch, s2.id, '2026-10-05', neg1, 80);
    const late = await makeStatus('Kechikdi', 'late');
    await AttendanceRecord.create({
      schoolId: school.id,
      studentId: s2._id,
      classId: cls._id,
      academicYearId: year._id,
      date: '2026-10-12',
      lessonNo: 0,
      statusId: late._id,
      category: 'late',
      markedBy: teacher._id,
      updatedBy: teacher._id,
    });
    await put('attendance', {
      scope: 'school',
      schoolId: school.id,
      values: { ratingImpact: { enabled: true, penaltyLate: 2 } },
    });
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 0, behaviorPenalty: 100, penalty: 0 });
    // 80 - 2 (davomat) - 5 (xulq)
    expect(await of(s2.id)).toMatchObject({ score: 73, penalty: 2, behaviorPenalty: 5 });
  });

  it("sozlamani o'zgartirish qayta hisoblashni rejalashtiradi; faqat superadmin yoza oladi", async () => {
    await ratingEvents.flushAll();
    const r = await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { behaviorPenaltyEnabled: true },
    });
    expect(r.status).toBe(200);
    expect(ratingEvents.pending).toContain(school.id);
    await ratingEvents.flushAll();
    const forbidden = await request(app)
      .put('/api/v1/settings/rating')
      .set(bearer(adm))
      .send({ scope: 'school', schoolId: school.id, values: { behaviorPenaltyEnabled: false } });
    expect(forbidden.status).toBe(403);
  });
});

describe('Xulq turi jarimasi: snapshot', () => {
  const patchType = (id: string, body: object) =>
    request(app).patch(`/api/v1/behavior-types/${id}`).set(bearer(root)).send(body);

  it("bahoga qo'yilgan paytdagi jarima saqlanadi; tur keyin o'zgarsa eski baho o'zgarmaydi", async () => {
    const created = await postScore(tch, s1.id, '2026-10-05', neg1);
    expect((await Score.findById(created.body.data.id))!.behaviorPenalty).toBe(5);
    expect((await patchType(neg1.id, { ratingPenalty: 20 })).status).toBe(200);
    await enable();
    expect(await of(s1.id)).toMatchObject({ behaviorPenalty: 5, score: 85 });
    // yangi baho yangi jarimani oladi
    const next = await postScore(tch, s1.id, '2026-10-06', neg1);
    expect((await Score.findById(next.body.data.id))!.behaviorPenalty).toBe(20);
  });

  it("tur yo'q bahoda snapshot 0", async () => {
    const r = await postScore(tch, s1.id, '2026-10-05', null);
    expect((await Score.findById(r.body.data.id))!.behaviorPenalty).toBe(0);
  });

  it("eski hujjat (maydonsiz) 0 deb o'qiladi; maydoni yo'q BehaviorType ham 0", async () => {
    const any = (await Score.findOne())!;
    await Score.collection.insertOne({
      schoolId: any.schoolId,
      studentId: s1._id,
      classId: cls._id,
      teacherId: teacher._id,
      academicYearId: any.academicYearId,
      behaviorTypeId: neg1._id,
      value: 90,
      comment: null,
      date: '2026-10-05',
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await BehaviorType.collection.updateOne({ _id: neg2._id }, { $unset: { ratingPenalty: '' } });
    await enable();
    expect(await of(s1.id)).toMatchObject({ score: 90, behaviorPenalty: 0 });
    const list = await request(app).get('/api/v1/behavior-types').set(bearer(tch));
    const legacy = list.body.data.find((t: { id: string }) => t.id === neg2.id);
    expect(legacy.ratingPenalty).toBe(0);
    // eski baho tahrirlanib, tur o'zgarmasa snapshot 0 qoladi (qayta hisoblanmaydi)
    const old = (await Score.findOne({ date: '2026-10-05', studentId: s1._id }))!;
    const upd = await request(app)
      .patch(`/api/v1/scores/${old.id}`)
      .set(bearer(tch))
      .set('X-School-Id', school.id)
      .send({ value: 91 });
    expect(upd.status).toBe(200);
    expect((await Score.findById(old.id))!.behaviorPenalty ?? 0).toBe(0);
  });

  it("tahrirda tur o'zgarsa qayta snapshot; o'zgarmasa saqlanadi", async () => {
    const created = await postScore(tch, s1.id, '2026-10-05', neg1);
    const id = created.body.data.id as string;
    const upd = (body: object) =>
      request(app)
        .patch(`/api/v1/scores/${id}`)
        .set(bearer(tch))
        .set('X-School-Id', school.id)
        .send(body);
    await BehaviorType.updateOne({ _id: neg1._id }, { ratingPenalty: 9 });
    expect((await upd({ value: 80 })).status).toBe(200);
    expect((await Score.findById(id))!.behaviorPenalty).toBe(5); // tur o'zgarmadi
    expect((await upd({ behaviorTypeId: neg2.id })).status).toBe(200);
    expect((await Score.findById(id))!.behaviorPenalty).toBe(3);
    expect((await upd({ behaviorTypeId: neg1.id })).status).toBe(200);
    expect((await Score.findById(id))!.behaviorPenalty).toBe(9); // yangi jarima
    expect((await upd({ behaviorTypeId: null })).status).toBe(200);
    expect((await Score.findById(id))!.behaviorPenalty).toBe(0);
  });

  it("bulk: yangi baho snapshot oladi; tur o'zgarsa qayta, o'zgarmasa saqlanadi", async () => {
    const bulk = (typeId: Doc | null) =>
      request(app)
        .post('/api/v1/scores/bulk')
        .set(bearer(tch))
        .set('X-School-Id', school.id)
        .send({
          classId: cls.id,
          date: '2026-10-05',
          items: [{ studentId: s1.id, value: 90, behaviorTypeId: typeId?.id ?? null }],
        });
    const snap = async () =>
      (await Score.findOne({ studentId: s1._id, date: '2026-10-05' }))!.behaviorPenalty;
    expect((await bulk(neg1)).body.data).toMatchObject({ created: 1, updated: 0 });
    expect(await snap()).toBe(5);
    await BehaviorType.updateOne({ _id: neg1._id }, { ratingPenalty: 9 });
    expect((await bulk(neg1)).body.data).toMatchObject({ created: 0, updated: 1 });
    expect(await snap()).toBe(5);
    await bulk(neg2);
    expect(await snap()).toBe(3);
    await bulk(null);
    expect(await snap()).toBe(0);
  });
});

describe('Xulq turlari API: ratingPenalty', () => {
  const post = (body: object) =>
    request(app).post('/api/v1/behavior-types').set(bearer(root)).send(body);
  const base = { name: 'Yangi tur', kind: 'negative', color: '#112233' };

  it('standart 0; 2 xonagacha yaxlitlanadi; DTO va audit snapshotda bor', async () => {
    const a = await post(base);
    expect(a.status).toBe(201);
    expect(a.body.data.ratingPenalty).toBe(0);
    const b = await post({ ...base, name: 'Ikkinchi tur', ratingPenalty: 2.345 });
    expect(b.body.data.ratingPenalty).toBe(2.35);
    const up = await request(app)
      .patch(`/api/v1/behavior-types/${a.body.data.id}`)
      .set(bearer(root))
      .send({ ratingPenalty: 7.5 });
    expect(up.body.data.ratingPenalty).toBe(7.5);
    const log = await AuditLog.findOne({ action: 'behavior_type.update' }).lean();
    expect(log?.before).toMatchObject({ ratingPenalty: 0 });
    expect(log?.after).toMatchObject({ ratingPenalty: 7.5 });
  });

  it('validatsiya: manfiy, 100 dan katta va son bo‘lmagan qiymat rad etiladi', async () => {
    expect((await post({ ...base, ratingPenalty: -1 })).status).toBe(400);
    expect((await post({ ...base, ratingPenalty: 100.01 })).status).toBe(400);
    expect((await post({ ...base, ratingPenalty: 'x' })).status).toBe(400);
    expect((await post({ ...base, ratingPenalty: 100 })).status).toBe(201);
    const id = (await BehaviorType.findOne({ name: 'Yangi tur' }))!.id;
    expect(
      (
        await request(app)
          .patch(`/api/v1/behavior-types/${id}`)
          .set(bearer(root))
          .send({ ratingPenalty: -5 })
      ).status,
    ).toBe(400);
  });
});

describe('Ochiq (public) va arxiv', () => {
  it('public javoblarda penalty/behaviorPenalty/behaviorType kalitlari chiqmaydi, ball esa jarimali', async () => {
    await postScore(tch, s1.id, '2026-10-05', neg1);
    await put('public', { scope: 'school', schoolId: school.id, values: { enabled: true } });
    await enable();
    const get = (p: string) => request(app).get(`/api/v1/public/demo-b/${p}`);
    const [st, cl, cfg] = await Promise.all([
      get('rating/students'),
      get('rating/classes'),
      get('config'),
    ]);
    expect(st.status).toBe(200);
    expect(st.body.data.items.map((i: { score: number }) => i.score)).toEqual([85, 80]);
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(x);
        }
      }
    };
    walk([st.body, cl.body, cfg.body]);
    for (const k of [
      'penalty',
      'behaviorpenalty',
      'ratingpenalty',
      'behaviorpenaltyenabled',
      'behaviortype',
      'behaviortypeid',
    ]) {
      expect(keys.has(k), k).toBe(false);
    }
  });

  it("arxivlangan natija (RatingResult) muzlatilgan: sxemada jarima yo'q, keyingi o'zgarish tegmaydi", async () => {
    expect(RatingResult.schema.path('behaviorPenalty')).toBeUndefined();
    const WEEK = ['2026-11-09', '2026-11-10', '2026-11-11'];
    await Score.insertMany(
      WEEK.map((date) => ({
        schoolId: school.id,
        studentId: s1._id,
        classId: cls._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: zero._id,
        value: 80,
        date,
      })),
    );
    await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { periodType: 'week', resultsEnabled: true },
    });
    clock.set(() => new Date('2026-11-14T12:59:00Z'));
    await runRatingResults();
    clock.set(() => new Date('2026-11-14T13:00:00Z'));
    await runRatingResults();
    const before = (await RatingResult.findOne({
      schoolId: school.id,
      periodKey: WEEK_KEY,
    }).lean())!;
    expect(before.students[0].score).toBe(80);
    // Keyin yoqiladi va jarimali baho qo'shiladi: arxiv o'zgarmaydi
    await Score.updateOne(
      { studentId: s1._id, date: '2026-11-09' },
      { behaviorTypeId: neg1._id, behaviorPenalty: 5 },
    );
    await enable();
    await runRatingResults();
    const after = (await RatingResult.findOne({
      schoolId: school.id,
      periodKey: WEEK_KEY,
    }).lean())!;
    expect(after.students).toEqual(before.students);
    expect(await RatingResult.countDocuments({ schoolId: school.id, periodKey: WEEK_KEY })).toBe(1);
  });
});

describe('Hisobotlar: xulq jarimasi', () => {
  it("sinf, maktab va o'quvchi hisobotlarida alohida ko'rinadi", async () => {
    await postScore(tch, s1.id, '2026-10-05', neg1);
    await postScore(adm, s1.id, '2026-10-06', neg2);
    await enable();
    const q = '?from=2026-10-01&to=2026-10-14';
    const get = async (path: string, pre = '') =>
      (
        await request(app)
          .get(`/api/v1/reports${path}${pre ? '?' + pre : '?'}${q.slice(1)}`)
          .set(bearer(rep))
          .set('X-School-Id', school.id)
      ).body.data;
    const cr = await get(`/class`, `classId=${cls.id}&`);
    expect(cr.students.find((s: { studentId: string }) => s.studentId === s1.id)).toMatchObject({
      behaviorPenalty: 8,
      penalty: 0,
      ratingScore: 82,
    });
    expect(cr.summary).toMatchObject({ behaviorPenaltyTotal: 8, penaltyTotal: 0 });
    expect((await get('/school')).totals).toMatchObject({ behaviorPenaltyTotal: 8 });
    expect((await get(`/student/${s1.id}`)).score).toMatchObject({
      behaviorPenalty: 8,
      ratingScore: 82,
    });
  });
});
