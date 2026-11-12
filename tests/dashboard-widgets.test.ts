import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AttendanceRecord } from '../src/models/AttendanceRecord';
import { Student } from '../src/models/Student';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
import { addDaysStr, clock, todayTashkent } from '../src/utils/clock';
import {
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
const NOW = '2026-10-14T07:00:00Z'; // chorshanba
const today = () => todayTashkent();
const d = (n: number) => addDaysStr(today(), n);

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc, cOther: Doc;
let a1: Doc, a2: Doc, b1: Doc, b2: Doc;
let tA: Doc, tB: Doc, tScorer: Doc;
let neg: Doc;
let statuses: Record<AttendanceCategory, Doc>;
let adm: string, ta: string, tb: string, root: string, noPerm: string, otherAdm: string;

const get = (path: string, t: string, h: Record<string, string> = {}) =>
  request(app).get(`/api/v1/dashboard/${path}`).set(bearer(t)).set(h);

const score = (st: Doc, cls: Doc, date: string, value: number, by: Doc = tA, extra = {}) =>
  Score.create({
    schoolId: school.id,
    studentId: st._id,
    classId: cls._id,
    teacherId: by._id,
    academicYearId: year.id,
    value,
    date,
    ...extra,
  });
const att = (st: Doc, cls: Doc, date: string, category: AttendanceCategory, lessonNo = 0) =>
  AttendanceRecord.create({
    schoolId: school.id,
    studentId: st._id,
    classId: cls._id,
    academicYearId: year._id,
    date,
    lessonNo,
    statusId: statuses[category]._id,
    category,
    markedBy: tA._id,
    updatedBy: tA._id,
  });

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  const otherYear = await makeYear(other.id);
  const perm = ['dashboard.view'];
  tA = await makeUser({ username: 'ta', role: 'teacher', schoolId: school.id, permissions: perm });
  tB = await makeUser({ username: 'tb', role: 'teacher', schoolId: school.id, permissions: perm });
  tScorer = await makeUser({ username: 'ts', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: perm,
  });
  await makeUser({ username: 'noperm', role: 'school_admin', schoolId: school.id });
  await makeUser({
    username: 'otheradm',
    role: 'school_admin',
    schoolId: other.id,
    permissions: perm,
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [tA.id], { homeroomTeacherId: tA.id });
  c6 = await makeClass(school.id, year.id, '6-A', [tB.id]); // sinf rahbarisiz
  cOther = await makeClass(other.id, otherYear.id, '5-A', []);
  a1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  a2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  b1 = await makeStudent(school.id, c6.id, 'Bekov Bek');
  b2 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  await makeStudent(other.id, cOther.id, 'Boshqa Maktab');
  neg = await makeBehaviorType('Salbiy xulq', 'negative');
  statuses = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus("Sababli yo'q", 'absent_excused'),
    absent_unexcused: await makeStatus("Sababsiz yo'q", 'absent_unexcused'),
  };
  [adm, ta, tb, root, noPerm, otherAdm] = await Promise.all(
    ['admin', 'ta', 'tb', 'root', 'noperm', 'otheradm'].map(async (u) => (await login(u)).token),
  );
});

describe.each(['unscored-classes', 'attention-students', 'attendance-trend'])(
  'GET /dashboard/%s: kirish nazorati',
  (path) => {
    it("ruxsat, autentifikatsiya, tenant (superadmin sarlavhasiz 400, noma'lum maktab 404)", async () => {
      expect((await get(path, noPerm)).status).toBe(403);
      expect((await request(app).get(`/api/v1/dashboard/${path}`)).status).toBe(401);
      expect((await get(path, root)).status).toBe(400);
      expect((await get(path, root, { 'X-School-Id': '0'.repeat(24) })).status).toBe(404);
      expect((await get(path, root, { 'X-School-Id': school.id })).status).toBe(200);
    });
  },
);

describe('unscored-classes', () => {
  it('admin: faqat tugallanmagan sinflar, eng past progress birinchi, sinf rahbari nomi/null', async () => {
    await score(a1, c5, today(), 90);
    const res = await get('unscored-classes', adm);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ workingDay: true, scope: 'school', totalClasses: 2 });
    expect(res.body.data.classes).toEqual([
      { classId: c6.id, className: '6-A', homeroomTeacher: null, graded: 0, total: 2 },
      {
        classId: c5.id,
        className: '5-A',
        homeroomTeacher: { id: tA.id, fullName: 'Test ta' },
        graded: 1,
        total: 2,
      },
    ]);
  });

  it("boshqa o'qituvchi bergan baho ham hisoblanadi; hammasi baholansa ro'yxat bo'sh", async () => {
    for (const [st, cls] of [
      [a1, c5],
      [a2, c5],
      [b1, c6],
      [b2, c6],
    ] as const) {
      await score(st, cls, today(), 80, tScorer);
    }
    await score(a1, c5, d(-1), 50); // kecha — hisobga kirmaydi
    const res = await get('unscored-classes', adm);
    expect(res.body.data.classes).toEqual([]);
    expect(res.body.data.workingDay).toBe(true);
    expect(res.body.data.totalClasses).toBe(2);
  });

  it("o'chirilgan baho va nofaol o'quvchi hisobga kirmaydi", async () => {
    const del = await score(a1, c5, today(), 90);
    await del.updateOne({ isDeleted: true });
    await Student.updateOne({ _id: b2._id }, { status: 'left' });
    const rows = (await get('unscored-classes', adm)).body.data.classes;
    expect(rows.find((r: { classId: string }) => r.classId === c5.id)).toMatchObject({
      graded: 0,
      total: 2,
    });
    expect(rows.find((r: { classId: string }) => r.classId === c6.id)).toMatchObject({
      total: 1,
    });
  });

  it("o'qituvchi: faqat o'z sinf rahbarligi (tugaganlari ham), boshqalarga bo'sh", async () => {
    await score(a1, c5, today(), 90);
    await score(a2, c5, today(), 90, tScorer);
    const mine = (await get('unscored-classes', ta)).body.data;
    expect(mine.scope).toBe('homeroom');
    expect(mine.classes).toEqual([
      {
        classId: c5.id,
        className: '5-A',
        homeroomTeacher: { id: tA.id, fullName: 'Test ta' },
        graded: 2,
        total: 2,
      },
    ]);
    expect((await get('unscored-classes', tb)).body.data.classes).toEqual([]); // sinf rahbari emas
  });

  it('dam olish kuni: workingDay=false, sinflar yo`q', async () => {
    clock.set(() => new Date('2026-10-18T07:00:00Z')); // yakshanba
    const res = await get('unscored-classes', adm);
    expect(res.body.data).toMatchObject({ workingDay: false, classes: [] });
  });

  it("boshqa maktab ma'lumoti ko'rinmaydi", async () => {
    const res = await get('unscored-classes', otherAdm);
    expect(res.body.data.classes.map((c: { className: string }) => c.className)).toEqual(['5-A']);
    expect(res.body.data.classes[0].classId).toBe(cOther.id);
    expect(res.body.data.classes[0].total).toBe(1);
  });
});

describe('attention-students', () => {
  const dropFor = async (st: Doc, cls: Doc, prevVal: number, curVal: number) => {
    // oldingi oyna: d(-13)..d(-7); joriy: d(-6)..d(0)
    await score(st, cls, d(-10), prevVal);
    await score(st, cls, d(-9), prevVal);
    await score(st, cls, d(-3), curVal);
    await score(st, cls, d(-2), curVal);
  };

  it('a) aniq shakl: Ball 92 -> 71 (-21)', async () => {
    await dropFor(a1, c5, 92, 71);
    await dropFor(a2, c5, 90, 76);
    const res = await get('attention-students', adm);
    expect(res.body.data.current).toEqual({ from: d(-6), to: d(0) });
    expect(res.body.data.previous).toEqual({ from: d(-13), to: d(-7) });
    expect(res.body.data.students).toEqual([
      {
        studentId: a1.id,
        fullName: 'Aliyev Ali',
        classId: c5.id,
        className: '5-A',
        reasons: [{ type: 'drop', from: 92, to: 71, delta: -21 }],
      },
    ]);
  });

  it('a) har oynada kamida 2 ballangan kun kerak', async () => {
    await score(a1, c5, d(-9), 95); // oldingi oynada 1 kun
    await score(a1, c5, d(-3), 40);
    await score(a1, c5, d(-2), 40);
    expect((await get('attention-students', adm)).body.data.students).toEqual([]);
  });

  it('b) 3 ta salbiy xulq (2 ta emas); musbat turlar sanalmaydi', async () => {
    for (const day of [-1, -2, -3])
      await score(a1, c5, d(day), 80, tA, { behaviorTypeId: neg._id });
    for (const day of [-1, -2]) await score(a2, c5, d(day), 80, tA, { behaviorTypeId: neg._id });
    await score(a2, c5, d(-3), 80, tA, {}); // turi yo'q
    await score(a1, c5, d(-9), 80, tA, { behaviorTypeId: neg._id }); // oynadan tashqari
    const res = await get('attention-students', adm);
    expect(res.body.data.students).toHaveLength(1);
    expect(res.body.data.students[0]).toMatchObject({
      studentId: a1.id,
      reasons: [{ type: 'negative', count: 3 }],
    });
  });

  it("c) 2 KUN sababsiz yo'q (kuniga bir marta; dars rejimida bir kunda ko'p yozuv 1 kun)", async () => {
    await att(a1, c5, d(-1), 'absent_unexcused', 1);
    await att(a1, c5, d(-1), 'absent_unexcused', 2);
    await att(a1, c5, d(-1), 'absent_unexcused', 3); // bir kun
    await att(a2, c5, d(-1), 'absent_unexcused');
    await att(a2, c5, d(-2), 'absent_unexcused');
    await att(b1, c6, d(-1), 'absent_excused');
    await att(b1, c6, d(-2), 'absent_excused'); // sababli — hisobga kirmaydi
    const res = await get('attention-students', adm);
    expect(res.body.data.students).toHaveLength(1);
    expect(res.body.data.students[0]).toMatchObject({
      studentId: a2.id,
      reasons: [{ type: 'unexcused', days: 2 }],
    });
  });

  it("saralash: sabablar soni, so'ng pasayish kattaligi; max 10; total to'liq son", async () => {
    await dropFor(a1, c5, 92, 71); // drop 21 + 3 salbiy
    for (const day of [-1, -2, -3])
      await score(a1, c5, d(day), 71, tScorer, { behaviorTypeId: neg._id });
    await dropFor(a2, c5, 90, 60); // faqat drop 30
    await dropFor(b1, c6, 90, 70); // faqat drop 20
    const res = await get('attention-students', adm);
    expect(res.body.data.students.map((s: { studentId: string }) => s.studentId)).toEqual([
      a1.id,
      a2.id,
      b1.id,
    ]);
    expect(res.body.data.students[0].reasons.map((r: { type: string }) => r.type)).toEqual([
      'drop',
      'negative',
    ]);
    expect(res.body.data.total).toBe(3);
  });

  it('limit 10', async () => {
    for (let i = 0; i < 12; i++) {
      const s = await makeStudent(school.id, c5.id, `Talaba${String.fromCharCode(65 + i)} Test`);
      await att(s, c5, d(-1), 'absent_unexcused');
      await att(s, c5, d(-2), 'absent_unexcused');
    }
    const res = await get('attention-students', adm);
    expect(res.body.data.students).toHaveLength(10);
    expect(res.body.data.total).toBe(12);
  });

  it("o'qituvchi faqat o'z sinflari; boshqa maktab ko'rinmaydi", async () => {
    await att(a1, c5, d(-1), 'absent_unexcused');
    await att(a1, c5, d(-2), 'absent_unexcused');
    await att(b1, c6, d(-1), 'absent_unexcused');
    await att(b1, c6, d(-2), 'absent_unexcused');
    const ids = (r: { body: { data: { students: { studentId: string }[] } } }) =>
      r.body.data.students.map((s) => s.studentId).sort();
    expect(ids(await get('attention-students', adm))).toEqual([a1.id, b1.id].sort());
    expect(ids(await get('attention-students', ta))).toEqual([a1.id]);
    expect(ids(await get('attention-students', tb))).toEqual([b1.id]);
    expect(ids(await get('attention-students', otherAdm))).toEqual([]);
  });

  it("nofaol o'quvchi belgilanmaydi", async () => {
    await att(a1, c5, d(-1), 'absent_unexcused');
    await att(a1, c5, d(-2), 'absent_unexcused');
    await Student.updateOne({ _id: a1._id }, { status: 'left' });
    expect((await get('attention-students', adm)).body.data.students).toEqual([]);
  });
});

describe('attendance-trend', () => {
  it("kunlik foiz dayStatus bilan: keldi/kechikdi/qisman/sababli/sababsiz, davomatsiz kun yo'q", async () => {
    // d(-1): a1 keldi, a2 kechikdi, b1 sababsiz, b2 sababli -> (1+1)/4 = 50%
    await att(a1, c5, d(-1), 'present');
    await att(a2, c5, d(-1), 'late');
    await att(b1, c6, d(-1), 'absent_unexcused');
    await att(b2, c6, d(-1), 'absent_excused');
    // d(0): dars rejimi: a1 qisman (1 ta dars yo'q, 1 ta bor), a2 keldi -> 1/2 = 50%
    await att(a1, c5, d(0), 'present', 1);
    await att(a1, c5, d(0), 'absent_excused', 2);
    await att(a2, c5, d(0), 'present', 1);
    await att(a2, c5, d(0), 'present', 2);
    // d(-2): hammasi keldi, lekin 2026-10-11 yakshanba emas; d(-3) = yakshanba (2026-10-11)
    await att(a1, c5, d(-3), 'present');
    const res = await get('attendance-trend', adm);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.from).toBe(d(-29));
    expect(data.to).toBe(today());
    expect(data.days).toEqual([
      {
        date: d(-1),
        rate: 50,
        present: 1,
        late: 1,
        partial: 0,
        absentExcused: 1,
        absentUnexcused: 1,
        total: 4,
      },
      {
        date: d(0),
        rate: 50,
        present: 1,
        late: 0,
        partial: 1,
        absentExcused: 0,
        absentUnexcused: 0,
        total: 2,
      },
    ]); // d(-3) yakshanba (dam olish kuni) — bar yo'q
    expect(data.average).toBe(50);
  });

  it("davomat yo'q: bo'sh va average null; 30 kundan eski kunlar kirmaydi", async () => {
    await att(a1, c5, d(-35), 'present');
    const res = await get('attendance-trend', adm);
    expect(res.body.data.days).toEqual([]);
    expect(res.body.data.average).toBeNull();
  });

  it("o'qituvchi faqat o'z sinflari; boshqa maktab ko'rinmaydi", async () => {
    await att(a1, c5, d(-1), 'present');
    await att(b1, c6, d(-1), 'absent_unexcused');
    expect((await get('attendance-trend', adm)).body.data.days[0]).toMatchObject({
      total: 2,
      rate: 50,
    });
    expect((await get('attendance-trend', ta)).body.data.days[0]).toMatchObject({
      total: 1,
      rate: 100,
    });
    expect((await get('attendance-trend', tb)).body.data.days[0]).toMatchObject({
      total: 1,
      rate: 0,
    });
    expect((await get('attendance-trend', otherAdm)).body.data.days).toEqual([]);
  });
});
