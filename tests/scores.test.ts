import { ObjectId } from 'mongodb';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Student } from '../src/models/Student';
import { addDaysStr, clock, todayTashkent } from '../src/utils/clock';
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

type Doc = { id: string; _id: unknown; updateOne: (u: object) => PromiseLike<unknown> };
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let s1: Doc, s2: Doc, s3: Doc, s4: Doc;
let pos: Doc, neg: Doc, off: Doc;
let t1: string,
  t2: string,
  scorer: string,
  editor: string,
  viewer: string,
  root: string,
  nope: string;
let teacher1: Doc;
const today = () => todayTashkent();
const d = (n: number) => addDaysStr(today(), n);

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  teacher1 = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  const teacher2 = await makeUser({ username: 'teacher2', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'scorer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['scores.create'],
  });
  await makeUser({
    username: 'editor',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['scores.create', 'scores.edit', 'reports.view'],
  });
  await makeUser({
    username: 'viewer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  await makeUser({
    username: 'nope',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'scores.create', 'scores.edit'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [teacher1.id], {
    homeroomTeacherId: teacher1.id,
  });
  c6 = await makeClass(school.id, year.id, '6-A', [teacher2.id], {
    homeroomTeacherId: teacher2.id,
  });
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  s4 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  pos = await makeBehaviorType('Namunali xulq', 'positive');
  neg = await makeBehaviorType('Darsga kechikish', 'negative');
  off = await makeBehaviorType('Eski tur', 'neutral', { isActive: false });
  [t1, t2, scorer, editor, viewer, root, nope] = await Promise.all(
    ['teacher1', 'teacher2', 'scorer', 'editor', 'viewer', 'root', 'nope'].map(
      async (u) => (await login(u)).token,
    ),
  );
});

const post = (t: string, body: object, h: Record<string, string> = {}) =>
  request(app).post('/api/v1/scores').set(bearer(t)).set(h).send(body);
const body = (studentId: string, extra: Record<string, unknown> = {}) => ({
  studentId,
  value: 85,
  behaviorTypeId: pos.id,
  ...extra,
});
const putScoring = (values: object, scope = 'global', schoolId?: string) =>
  request(app).put('/api/v1/settings/scoring').set(bearer(root)).send({ scope, schoolId, values });
const ageScore = (id: string, hours: number) =>
  Score.collection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { createdAt: new Date(Date.now() - hours * 3_600_000) } },
  );

describe("Baho qo'yish (POST /scores)", () => {
  it('yaratadi: DTO shakli, snapshot, editable, audit', async () => {
    const res = await post(t1, body(s1.id, { comment: '  yaxshi  ' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      schoolId: school.id,
      studentId: s1.id,
      student: { id: s1.id, fullName: 'Aliyev Ali' },
      classId: c5.id,
      class: { id: c5.id, name: '5-A' },
      teacher: { fullName: 'Test teacher1' },
      academicYearId: year.id,
      behaviorTypeId: pos.id,
      behaviorType: { id: pos.id, name: 'Namunali xulq', kind: 'positive', color: '#16A34A' },
      value: 85,
      comment: 'yaxshi',
      date: today(),
      editable: true,
    });
    expect(await AuditLog.countDocuments({ action: 'scores.create' })).toBe(1);
  });

  it('qoidalar: ball diapazoni/butun son, sana, xulq turi, izoh (har biri alohida)', async () => {
    const err = async (extra: Record<string, unknown>, path: string, b: object = body(s1.id)) => {
      const r = await post(t1, { ...b, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.details.map((x: { path: string }) => x.path)).toContain(path);
    };
    await err({ value: 101 }, 'value');
    await err({ value: -1 }, 'value');
    await err({ value: 80.5 }, 'value');
    await err({ value: '80' }, 'value');
    await err({ date: d(1) }, 'date'); // kelajak
    await err({ date: d(-4) }, 'date'); // backdateDays=3 dan eski
    await err({ date: '2026-02-30' }, 'date');
    await err({ date: '14.10.2026' }, 'date');
    await err({ behaviorTypeId: null }, 'behaviorTypeId'); // majburiy
    await err({ behaviorTypeId: undefined }, 'behaviorTypeId');
    await err({ behaviorTypeId: '64b64b64b64b64b64b64b64b' }, 'behaviorTypeId');
    await err({ behaviorTypeId: off.id }, 'behaviorTypeId'); // nofaol
    await err({ comment: 'x'.repeat(501) }, 'comment');
    expect((await post(t1, body(s1.id, { date: d(-3) }))).status).toBe(201); // chegara ichida
  });

  it("sozlamalar ta'siri: min/max, requireBehaviorType=false, commentRequiredBelow, backdateDays, maktab override", async () => {
    await putScoring({ minScore: 10, maxScore: 50 });
    expect((await post(t1, body(s1.id, { value: 5 }))).status).toBe(400);
    expect((await post(t1, body(s1.id, { value: 51 }))).status).toBe(400);
    expect((await post(t1, body(s1.id, { value: 50 }))).status).toBe(201);

    await putScoring({ requireBehaviorType: false, commentRequiredBelow: 60, backdateDays: 0 });
    const noType = await post(t1, { studentId: s2.id, value: 90 });
    expect(noType.status).toBe(201);
    expect(noType.body.data).toMatchObject({ behaviorTypeId: null, behaviorType: null });
    const low = await post(t1, body(s3.id, { value: 40 }));
    expect(low.status).toBe(400);
    expect(low.body.error.details[0].path).toBe('comment');
    expect((await post(t1, body(s3.id, { value: 40, comment: 'Sabab' }))).status).toBe(201);
    expect((await post(t1, body(s3.id, { date: d(-1) }))).status).toBe(400); // backdateDays=0

    // Maktab override global qiymatni bekor qiladi
    await putScoring({ backdateDays: 5 }, 'school', school.id);
    expect((await post(t1, body(s1.id, { date: d(-5) }))).status).toBe(201);
  });

  it("dublikat: bir o'qituvchi bir o'quvchiga kuniga bitta (409); o'chirgach yana mumkin; boshqa kun/boshqa baholovchi mumkin", async () => {
    const first = await post(t1, body(s1.id));
    const dup = await post(t1, body(s1.id, { value: 70 }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    expect((await post(t1, body(s1.id, { date: d(-1) }))).status).toBe(201);
    expect((await post(scorer, body(s1.id))).status).toBe(201); // boshqa baholovchi

    expect(
      (await request(app).delete(`/api/v1/scores/${first.body.data.id}`).set(bearer(t1))).status,
    ).toBe(200);
    expect((await post(t1, body(s1.id, { value: 70 }))).status).toBe(201);
  });

  it("o'qituvchi scoping: begona sinf o'quvchisi 404; admin (scores.create) istalgan sinf; faol/arxiv/yil/o'chirilgan", async () => {
    expect((await post(t1, body(s4.id))).status).toBe(404);
    expect((await post(t1, body('64b64b64b64b64b64b64b64b'))).status).toBe(404);
    expect((await post(t1, body('bad-id'))).status).toBe(400);
    expect((await post(scorer, body(s4.id))).status).toBe(201);

    await Student.updateOne({ _id: s2._id }, { status: 'transferred' });
    const inactive = await post(t1, body(s2.id));
    expect(inactive.status).toBe(400);
    await Student.updateOne({ _id: s3._id }, { isDeleted: true });
    expect((await post(t1, body(s3.id))).status).toBe(404);

    await c5.updateOne({ isArchived: true });
    expect((await post(t1, body(s1.id))).status).toBe(400);
    await c5.updateOne({ isArchived: false });
    const oldYear = await makeYear(school.id, '2025-2026', false);
    await c5.updateOne({ academicYearId: oldYear._id });
    expect((await post(t1, body(s1.id))).status).toBe(400);
  });

  it("tenant: boshqa maktab o'quvchisi 404; superadmin X-School-Id bilan", async () => {
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const foreign = await makeStudent(other.id, oc.id, 'Chet Maktab');
    expect((await post(scorer, body(foreign.id))).status).toBe(404);
    expect((await post(root, body(s1.id))).status).toBe(400); // X-School-Id yo'q
    expect((await post(root, body(foreign.id), { 'X-School-Id': school.id })).status).toBe(404);
    expect((await post(root, body(s1.id), { 'X-School-Id': school.id })).status).toBe(201);
  });

  it("ruxsat: scores.create yo'q admin 403, autentifikatsiyasiz 401", async () => {
    expect((await post(viewer, body(s1.id))).status).toBe(403);
    expect((await post(nope, body(s1.id))).status).toBe(403);
    expect((await request(app).post('/api/v1/scores').send(body(s1.id))).status).toBe(401);
  });
});

describe("Tahrirlash va o'chirish", () => {
  it("o'z bahosi tahrir oynasi ichida: PATCH/DELETE; oyna o'tgach 403; editable flag", async () => {
    const created = (await post(t1, body(s1.id))).body.data;
    const patched = await request(app)
      .patch(`/api/v1/scores/${created.id}`)
      .set(bearer(t1))
      .send({ value: 90, comment: 'tuzatildi' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      value: 90,
      comment: 'tuzatildi',
      editable: true,
      behaviorTypeId: pos.id,
    });
    expect(await AuditLog.countDocuments({ action: 'scores.update' })).toBe(1);

    await ageScore(created.id, 25);
    const late = await request(app)
      .patch(`/api/v1/scores/${created.id}`)
      .set(bearer(t1))
      .send({ value: 50 });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('FORBIDDEN');
    expect((await request(app).delete(`/api/v1/scores/${created.id}`).set(bearer(t1))).status).toBe(
      403,
    );
    const list = await request(app).get('/api/v1/scores').set(bearer(t1));
    expect(list.body.data[0].editable).toBe(false);

    // Oyna kengaytirilsa (maktab override) yana mumkin
    await putScoring({ editWindowHours: 48 }, 'school', school.id);
    expect(
      (await request(app).patch(`/api/v1/scores/${created.id}`).set(bearer(t1)).send({ value: 66 }))
        .status,
    ).toBe(200);
  });

  it("scores.edit: istalgan baho, istalgan vaqtda; scores.edit siz admin faqat o'zinikini; o'qituvchi begonani ko'rmaydi", async () => {
    const mine = (await post(t1, body(s1.id))).body.data;
    await ageScore(mine.id, 100);
    const adminEdit = await request(app)
      .patch(`/api/v1/scores/${mine.id}`)
      .set(bearer(editor))
      .send({ value: 77 });
    expect(adminEdit.status).toBe(200);
    expect(adminEdit.body.data.editable).toBe(true);

    expect(
      (await request(app).patch(`/api/v1/scores/${mine.id}`).set(bearer(scorer)).send({ value: 1 }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).delete(`/api/v1/scores/${mine.id}`).set(bearer(scorer))).status,
    ).toBe(403);
    expect(
      (await request(app).patch(`/api/v1/scores/${mine.id}`).set(bearer(t2)).send({ value: 1 }))
        .status,
    ).toBe(404);
    expect(
      (await request(app).patch(`/api/v1/scores/${mine.id}`).set(bearer(viewer)).send({ value: 1 }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .delete(`/api/v1/scores/${mine.id}`)
          .set(bearer(root))
          .set('X-School-Id', school.id)
      ).status,
    ).toBe(200);
    expect(await Score.countDocuments({ isDeleted: true })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'scores.delete' })).toBe(1);
    expect(
      (await request(app).patch(`/api/v1/scores/${mine.id}`).set(bearer(editor)).send({ value: 5 }))
        .status,
    ).toBe(404);
  });

  it('PATCH validatsiyasi: diapazon, izoh majburiyligi, nofaol tur (eskisi qoladi), izohni tozalash', async () => {
    const created = (await post(t1, body(s1.id, { comment: 'bor' }))).body.data;
    const patch = (b: object) =>
      request(app).patch(`/api/v1/scores/${created.id}`).set(bearer(t1)).send(b);
    expect((await patch({ value: 150 })).status).toBe(400);
    expect((await patch({ behaviorTypeId: off.id })).status).toBe(400);
    expect((await patch({ behaviorTypeId: null })).status).toBe(400); // majburiy
    expect((await patch({ behaviorTypeId: neg.id })).body.data.behaviorType.name).toBe(
      'Darsga kechikish',
    );
    expect((await patch({ comment: null })).body.data.comment).toBeNull();

    await putScoring({ commentRequiredBelow: 60 });
    expect((await patch({ value: 30 })).status).toBe(400);
    expect((await patch({ value: 30, comment: 'sabab' })).status).toBe(200);

    // Eski tur keyinroq nofaol qilinsa, o'zgartirilmagan holda tahrirlash mumkin
    await neg.updateOne({ isActive: false });
    expect((await patch({ value: 31 })).status).toBe(200);
    expect((await patch({ behaviorTypeId: neg.id, value: 32 })).status).toBe(200); // o'zgarmagan tur
    expect((await patch({ behaviorTypeId: pos.id })).status).toBe(200);
    expect((await patch({ behaviorTypeId: neg.id })).status).toBe(400); // endi yangi tanlab bo'lmaydi
  });
});

describe('Bulk baholash', () => {
  const bulk = (t: string, b: object, h: Record<string, string> = {}) =>
    request(app).post('/api/v1/scores/bulk').set(bearer(t)).set(h).send(b);

  it('qisman muvaffaqiyat: create + update + xatolar; audit bitta yozuv', async () => {
    await post(t1, body(s2.id, { value: 50, comment: 'eski' })); // mavjud -> update
    const res = await bulk(t1, {
      classId: c5.id,
      items: [
        { studentId: s1.id, value: 90, behaviorTypeId: pos.id }, // create
        { studentId: s2.id, value: 75, behaviorTypeId: neg.id }, // update
        { studentId: s3.id, value: 120, behaviorTypeId: pos.id }, // xato: diapazon
        { studentId: s4.id, value: 80, behaviorTypeId: pos.id }, // xato: bu sinfda emas
        { studentId: s1.id, value: 10, behaviorTypeId: pos.id }, // xato: takror
        { studentId: s3.id, value: 80 }, // xato: tur majburiy
        { studentId: s3.id, value: 80, behaviorTypeId: off.id }, // xato: nofaol tur (s3 allaqachon ko'rilgan -> takror)
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.updated).toBe(1);
    expect(
      res.body.data.failed.map((f: { studentId: string; code: string }) => [f.studentId, f.code]),
    ).toEqual([
      [s3.id, 'VALIDATION_ERROR'],
      [s4.id, 'NOT_FOUND'],
      [s1.id, 'CONFLICT'],
      [s3.id, 'CONFLICT'],
      [s3.id, 'CONFLICT'],
    ]);
    expect(res.body.data.failed[0].message).toMatch(/Ball/);

    const s2score = await Score.findOne({ studentId: s2.id });
    expect(s2score).toMatchObject({ value: 75 });
    expect(String(s2score!.behaviorTypeId)).toBe(neg.id);
    expect(await Score.countDocuments({ isDeleted: false })).toBe(2);

    const logs = await AuditLog.find({ action: 'scores.bulk' });
    expect(logs).toHaveLength(1);
    expect(logs[0].after).toMatchObject({ created: 1, updated: 1, failed: 5, items: 7 });
  });

  it("tahrir oynasi o'tgan mavjud baho elementi xato (FORBIDDEN), qolganlari o'tadi", async () => {
    const old = (await post(t1, body(s1.id))).body.data;
    await ageScore(old.id, 30);
    const res = await bulk(t1, {
      classId: c5.id,
      items: [
        { studentId: s1.id, value: 60, behaviorTypeId: pos.id },
        { studentId: s2.id, value: 61, behaviorTypeId: pos.id },
      ],
    });
    expect(res.body.data).toMatchObject({ created: 1, updated: 0 });
    expect(res.body.data.failed).toEqual([
      { studentId: s1.id, code: 'FORBIDDEN', message: expect.any(String) },
    ]);
    // scores.edit li admin esa o'zining eski bahosini ham yangilay oladi
    const mine = (await post(editor, body(s1.id))).body.data;
    await ageScore(mine.id, 30);
    const r2 = await bulk(editor, {
      classId: c5.id,
      items: [{ studentId: s1.id, value: 99, behaviorTypeId: pos.id }],
    });
    expect(r2.body.data).toMatchObject({ created: 0, updated: 1, failed: [] });
  });

  it("sinf/sana/hajm tekshiruvlari: begona sinf 404, sana qoidasi 400, 200 dan ko'p 400, bo'sh 400", async () => {
    const items = [{ studentId: s4.id, value: 80, behaviorTypeId: pos.id }];
    expect((await bulk(t1, { classId: c6.id, items })).status).toBe(404);
    expect((await bulk(scorer, { classId: c6.id, items })).body.data.created).toBe(1);
    expect(
      (
        await bulk(t1, {
          classId: c5.id,
          date: d(1),
          items: [{ studentId: s1.id, value: 1, behaviorTypeId: pos.id }],
        })
      ).status,
    ).toBe(400);
    expect((await bulk(t1, { classId: c5.id, items: [] })).status).toBe(400);
    const many = Array.from({ length: 201 }, () => ({
      studentId: s1.id,
      value: 80,
      behaviorTypeId: pos.id,
    }));
    expect((await bulk(t1, { classId: c5.id, items: many })).status).toBe(400);
    expect((await bulk(viewer, { classId: c5.id, items })).status).toBe(403);
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    expect((await bulk(scorer, { classId: oc.id, items })).status).toBe(404);
    await c5.updateOne({ isArchived: true });
    expect(
      (
        await bulk(t1, {
          classId: c5.id,
          items: [{ studentId: s1.id, value: 1, behaviorTypeId: pos.id }],
        })
      ).status,
    ).toBe(400);
  });
});

describe("Baholash varag'i (scoring-sheet)", () => {
  const sheet = (t: string, id: string, q = '', h: Record<string, string> = {}) =>
    request(app).get(`/api/v1/classes/${id}/scoring-sheet${q}`).set(bearer(t)).set(h);

  it("tuzilma, tartib, myScore, dayScore/scoresCount (bir necha o'qituvchi), faqat faol o'quvchilar", async () => {
    await Student.updateOne({ _id: s3._id }, { status: 'transferred' });
    await post(t1, body(s1.id, { value: 80 }));
    await post(scorer, body(s1.id, { value: 91 }));
    await post(scorer, body(s2.id, { value: 70 }));

    const res = await sheet(t1, c5.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ class: { id: c5.id, name: '5-A' }, date: today() });
    expect(data.settings).toMatchObject({ dailyAggregation: 'average', editWindowHours: 24 });
    expect(data.students.map((x: { fullName: string }) => x.fullName)).toEqual([
      'Aliyev Ali',
      'Valiyev Vali',
    ]);
    const [a, b] = data.students;
    expect(a).toMatchObject({
      studentId: s1.id,
      studentCode: null,
      dayScore: 85.5,
      scoresCount: 2,
    });
    expect(a.myScore).toMatchObject({
      value: 80,
      editable: true,
      student: { fullName: 'Aliyev Ali' },
    });
    expect(b).toMatchObject({ dayScore: 70, scoresCount: 1, myScore: null });

    // Agregatsiya sozlamasi
    await putScoring({ dailyAggregation: 'min' });
    expect((await sheet(t1, c5.id)).body.data.students[0].dayScore).toBe(80);
    await putScoring({ dailyAggregation: 'last' });
    expect((await sheet(t1, c5.id)).body.data.students[0].dayScore).toBe(91);
  });

  it("sana parametri, o'qituvchi scoping, ruxsat, tenant", async () => {
    await post(t1, body(s1.id, { date: d(-1), value: 55, comment: 'x' }));
    const yesterday = await sheet(t1, c5.id, `?date=${d(-1)}`);
    expect(yesterday.body.data.date).toBe(d(-1));
    expect(yesterday.body.data.students[0].myScore.value).toBe(55);
    expect((await sheet(t1, c5.id)).body.data.students[0].myScore).toBeNull();
    expect((await sheet(t1, c5.id, '?date=bad')).status).toBe(400);

    expect((await sheet(t1, c6.id)).status).toBe(404);
    expect((await sheet(scorer, c6.id)).status).toBe(200);
    expect((await sheet(viewer, c5.id)).status).toBe(403);
    expect((await sheet(root, c5.id)).status).toBe(400);
    expect((await sheet(root, c5.id, '', { 'X-School-Id': school.id })).status).toBe(200);
    expect((await sheet(root, c5.id, '', { 'X-School-Id': other.id })).status).toBe(404);
  });

  it('"bugun" Asia/Tashkent bo\'yicha (UTC 19:00 dan keyin keyingi kun)', async () => {
    clock.set(() => new Date('2026-10-14T20:30:00Z'));
    const res = await sheet(t1, c5.id);
    expect(res.body.data.date).toBe('2026-10-15');
    clock.set(() => new Date('2026-10-14T18:30:00Z'));
    expect((await sheet(t1, c5.id)).body.data.date).toBe('2026-10-14');

    clock.set(() => new Date('2026-10-14T20:30:00Z'));
    const created = await post(t1, body(s1.id));
    expect(created.status).toBe(201);
    expect(created.body.data.date).toBe('2026-10-15');
    expect((await post(t1, body(s2.id, { date: '2026-10-16' }))).status).toBe(400);
    expect((await post(t1, body(s2.id, { date: '2026-10-12' }))).status).toBe(201);
    expect((await post(t1, body(s3.id, { date: '2026-10-11' }))).status).toBe(400);
  });
});

describe("Baholar ro'yxati va bugungi jarayon", () => {
  it("o'qituvchi faqat o'z baholari (teacherId filtri e'tiborga olinmaydi); admin hammasi + filtrlar, tartib, sahifalash", async () => {
    const mine = (await post(t1, body(s1.id, { date: d(-2), value: 60, comment: 'x' }))).body.data;
    await post(t1, body(s2.id, { date: d(-1) }));
    await post(scorer, body(s1.id, { value: 99 }));
    const t2id = (await request(app).get('/api/v1/auth/me').set(bearer(t2))).body.data.id;
    await post(t2, body(s4.id));
    expect(t2id).toBeTruthy();

    const tl = await request(app).get(`/api/v1/scores?teacherId=${t2id}`).set(bearer(t1));
    expect(tl.body.data).toHaveLength(2);
    expect(
      tl.body.data.every((x: { teacherId: string }) => x.teacherId === tl.body.data[0].teacherId),
    ).toBe(true);
    expect(tl.body.data.map((x: { date: string }) => x.date)).toEqual([d(-1), d(-2)]); // -date default
    expect(tl.body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });

    const admin = (await login('admin')).token;
    expect((await request(app).get('/api/v1/scores').set(bearer(admin))).body.meta.total).toBe(4);
    expect(
      (await request(app).get(`/api/v1/scores?classId=${c6.id}`).set(bearer(admin))).body.data,
    ).toHaveLength(1);
    expect(
      (
        await request(app).get(`/api/v1/scores?studentId=${s1.id}&sort=date`).set(bearer(admin))
      ).body.data.map((x: { date: string }) => x.date),
    ).toEqual([d(-2), today()]);
    expect(
      (
        await request(app)
          .get(`/api/v1/scores?from=${d(-1)}&to=${d(-1)}`)
          .set(bearer(admin))
      ).body.data,
    ).toHaveLength(1);
    expect(
      (await request(app).get(`/api/v1/scores?behaviorTypeId=${neg.id}`).set(bearer(admin))).body
        .data,
    ).toHaveLength(0);
    expect(
      (await request(app).get('/api/v1/scores?limit=2&page=2').set(bearer(admin))).body.data,
    ).toHaveLength(2);
    expect(mine.id).toBeTruthy();

    // Ruxsat: reports.view / scores.edit / students.view yetarli, boshqasi emas
    expect((await request(app).get('/api/v1/scores').set(bearer(editor))).status).toBe(200);
    expect((await request(app).get('/api/v1/scores').set(bearer(viewer))).status).toBe(200);
    expect((await request(app).get('/api/v1/scores').set(bearer(scorer))).status).toBe(403);
    expect((await request(app).get('/api/v1/scores').set(bearer(nope))).status).toBe(403);
    expect((await request(app).get('/api/v1/scores?from=bad').set(bearer(admin))).status).toBe(400);
  });

  it("tenant: boshqa maktab baholari ko'rinmaydi", async () => {
    await post(t1, body(s1.id));
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const os = await makeStudent(other.id, oc.id, 'Chet Maktab');
    const oadmin = await makeUser({
      username: 'oadm',
      role: 'school_admin',
      schoolId: other.id,
      permissions: ['scores.create', 'reports.view'],
    });
    const ot = (await login(oadmin.get('username'))).token;
    expect((await post(ot, body(os.id))).status).toBe(201);
    const l = await request(app).get('/api/v1/scores').set(bearer(ot));
    expect(l.body.data).toHaveLength(1);
    expect(l.body.data[0].student.fullName).toBe('Chet Maktab');
  });

  it("today-progress: o'qituvchi o'z sinflari, admin barcha faol sinflar; scored — shu foydalanuvchi baholaganlar", async () => {
    await post(t1, body(s1.id));
    await post(t1, body(s2.id));
    await post(scorer, body(s1.id));
    await post(scorer, body(s4.id));
    await post(t1, body(s3.id, { date: d(-1) })); // kecha — hisobga olinmaydi

    const tp = await request(app).get('/api/v1/scores/today-progress').set(bearer(t1));
    expect(tp.body.data).toEqual([{ classId: c5.id, className: '5-A', scored: 2, total: 3 }]);
    const sp = await request(app).get('/api/v1/scores/today-progress').set(bearer(scorer));
    expect(sp.body.data).toEqual([
      { classId: c5.id, className: '5-A', scored: 1, total: 3 },
      { classId: c6.id, className: '6-A', scored: 1, total: 1 },
    ]);
    expect(
      (await request(app).get('/api/v1/scores/today-progress').set(bearer(viewer))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/v1/scores/today-progress')
          .set(bearer(root))
          .set('X-School-Id', school.id)
      ).body.data,
    ).toHaveLength(2);
  });

  it("dashboard: scoresToday va unscoredClassesToday (o'qituvchi uchun o'z sinflari)", async () => {
    const adm = (await login('admin')).token;
    const summary = (t: string, h: Record<string, string> = {}) =>
      request(app).get('/api/v1/dashboard/summary').set(bearer(t)).set(h);
    expect((await summary(adm)).body.data).toMatchObject({
      scoresToday: 0,
      unscoredClassesToday: 2,
    });
    await post(t1, body(s1.id));
    await post(t1, body(s2.id));
    await post(t1, body(s3.id, { date: d(-1) }));
    expect((await summary(adm)).body.data).toMatchObject({
      scoresToday: 2,
      unscoredClassesToday: 1,
    });
    expect((await summary(root)).body.data).toMatchObject({
      scoresToday: 2,
      unscoredClassesToday: 1,
    });
    await post(scorer, body(s4.id));
    expect((await summary(adm)).body.data).toMatchObject({
      scoresToday: 3,
      unscoredClassesToday: 0,
    });
  });
});

describe("O'quvchi ball xulosasi (score-summary)", () => {
  const summary = (t: string, id: string, q = '', h: Record<string, string> = {}) =>
    request(app).get(`/api/v1/students/${id}/score-summary${q}`).set(bearer(t)).set(h);

  it('kunlik agregatlar: average, daysCount, trend, byBehaviorType, recent (maks 10)', async () => {
    await post(
      t1,
      body(s1.id, { date: d(-2), value: 60, behaviorTypeId: neg.id, comment: 'kechikdi' }),
    );
    await post(scorer, body(s1.id, { date: d(-2), value: 80, behaviorTypeId: pos.id }));
    await post(t1, body(s1.id, { date: d(-1), value: 90 }));
    await post(t1, body(s1.id, { value: 100 }));

    const res = await summary(t1, s1.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      studentId: s1.id,
      from: d(-29),
      to: today(),
      daysCount: 3,
      scoresCount: 4,
    });
    expect(data.trend).toEqual([
      { date: d(-2), dayScore: 70 },
      { date: d(-1), dayScore: 90 },
      { date: today(), dayScore: 100 },
    ]);
    expect(data.average).toBe(86.67);
    const pos2 = data.byBehaviorType.find(
      (x: { behaviorTypeId: string }) => x.behaviorTypeId === pos.id,
    );
    expect(pos2).toMatchObject({
      name: 'Namunali xulq',
      kind: 'positive',
      color: '#16A34A',
      count: 3,
    });
    expect(
      data.byBehaviorType.find((x: { behaviorTypeId: string }) => x.behaviorTypeId === neg.id)
        .count,
    ).toBe(1);
    expect(data.recent).toHaveLength(4);
    expect(data.recent[0].date).toBe(today());

    const ranged = await summary(t1, s1.id, `?from=${d(-1)}&to=${today()}`);
    expect(ranged.body.data).toMatchObject({ daysCount: 2, average: 95 });
    const empty = await summary(t1, s2.id);
    expect(empty.body.data).toMatchObject({
      average: null,
      daysCount: 0,
      scoresCount: 0,
      trend: [],
      byBehaviorType: [],
      recent: [],
    });
    expect((await summary(t1, s1.id, '?from=2026-10-10&to=2026-10-01')).status).toBe(400);
    expect((await summary(t1, s1.id, '?from=2020-01-01&to=2026-10-01')).status).toBe(400);
  });

  it("izoh maxfiyligi: o'qituvchi faqat o'z izohlarini ko'radi; admin hammasini", async () => {
    await putScoring({ editWindowHours: 24 });
    await post(t1, body(s1.id, { date: d(-1), comment: 'mening izohim' }));
    await post(scorer, body(s1.id, { date: d(-1), comment: 'maxfiy izoh' }));
    const asTeacher = (await summary(t1, s1.id)).body.data.recent;
    expect(asTeacher).toHaveLength(2);
    expect(
      asTeacher.find((x: { comment: string | null }) => x.comment === 'mening izohim'),
    ).toBeTruthy();
    expect(JSON.stringify(asTeacher)).not.toContain('maxfiy izoh');
    expect(asTeacher.filter((x: { comment: unknown }) => x.comment === null)).toHaveLength(1);

    const asAdmin = (await summary(editor, s1.id)).body.data.recent;
    expect(asAdmin.map((x: { comment: string }) => x.comment).sort()).toEqual([
      'maxfiy izoh',
      'mening izohim',
    ]);
    const asRoot = (await summary(root, s1.id, '', { 'X-School-Id': school.id })).body.data.recent;
    expect(asRoot).toHaveLength(2);
  });

  it("scoping/ruxsat/tenant: begona sinf o'quvchisi 404; ruxsatsiz 403; transfer/o'chirishdan keyin eski baholar saqlanadi", async () => {
    await post(scorer, body(s4.id));
    expect((await summary(t1, s4.id)).status).toBe(404);
    expect((await summary(t2, s4.id)).status).toBe(200);
    expect((await summary(nope, s4.id)).status).toBe(403);
    expect((await summary(t1, 'bad')).status).toBe(404);

    await post(t1, body(s1.id));
    await request(app)
      .post(`/api/v1/students/${s1.id}/transfer`)
      .set(bearer((await login('admin')).token))
      .send({ classId: c6.id });
    const afterTransfer = await Score.findOne({ studentId: s1.id });
    expect(String(afterTransfer!.classId)).toBe(c5.id); // snapshot o'zgarmaydi
    expect((await summary(scorer, s1.id)).body.data.scoresCount).toBe(1);

    await Student.updateOne({ _id: s1._id }, { isDeleted: true });
    expect(await Score.countDocuments({ studentId: s1.id, isDeleted: false })).toBe(1);

    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const os = await makeStudent(other.id, oc.id, 'Chet Maktab');
    expect((await summary(scorer, os.id)).status).toBe(404);
  });
});

describe('Indekslar', () => {
  it('score indekslari mavjud', async () => {
    const idx = await Score.collection.indexes();
    const names = idx.map((i) => i.name);
    expect(names).toContain('one_score_per_teacher_student_day');
    const unique = idx.find((i) => i.name === 'one_score_per_teacher_student_day');
    expect(unique).toMatchObject({ unique: true, partialFilterExpression: { isDeleted: false } });
    expect(idx.filter((i) => !i.unique).length).toBeGreaterThanOrEqual(3);
    expect(teacher1.id).toBeTruthy();
  });
});
