import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../src/config/db';
import { LEGACY_GRADE_INDEX } from '../src/models/SubjectGrade';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { loadGradeStats } from '../src/modules/reports/reports.data';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  SubjectGrade,
  app,
  assignSubject,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: mongoose.Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z'; // chorshanba (3)
const WED = '2026-10-14';
const THU = '2026-10-15';

let school: Doc, year: Doc;
type CDoc = Awaited<ReturnType<typeof makeClass>>;
let c8: CDoc, c9: CDoc;
let eng: Doc, math: Doc, phys: Doc;
let a1: Doc, a2: Doc, b1: Doc;
let tEng: Doc, tMath: Doc, tPhys: Doc;
let tokEng: string, tokMath: string, tokPhys: string, tokHome: string, tokOther: string;
let tokAdmin: string;

const entry = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  groupKey: null,
  room: null,
});

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('gl');
  year = await makeYear(school.id);
  tEng = await makeUser({ username: 'teng', role: 'teacher', schoolId: school.id });
  tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tPhys = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  const home = await makeUser({ username: 'home', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tother', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'gadmin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'grades.create', 'grades.edit'],
  });
  eng = await makeSubject('Ingliz tili');
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  // Ingliz tili o'qituvchisi sinf teacherIds da ham, ClassSubject da ham YO'Q — faqat jadvalda
  c8 = await makeClass(school.id, year.id, '8-B', [], { homeroomTeacherId: home._id });
  c9 = await makeClass(school.id, year.id, '9-A');
  await assignSubject(school.id, c8, math.id, tMath.id);
  await assignSubject(school.id, c8, phys.id, tPhys.id);
  await assignSubject(school.id, c9, math.id, tMath.id);
  a1 = await makeStudent(school.id, c8.id, 'Aliyev Ali');
  a2 = await makeStudent(school.id, c8.id, 'Valiyev Vali');
  b1 = await makeStudent(school.id, c9.id, 'Bekov Bek');
  await TimetableVersion.create({
    schoolId: school.id,
    academicYearId: year.id,
    classId: c8.id,
    status: 'active',
    validFrom: '2026-09-01',
    activatedAt: new Date(),
    entries: [
      entry(3, 1, eng.id, tEng.id),
      entry(3, 2, math.id, tMath.id),
      entry(3, 3, eng.id, tEng.id),
      entry(3, 4, phys.id, tPhys.id),
      entry(4, 1, math.id, tMath.id),
    ],
  });
  [tokEng, tokMath, tokPhys, tokHome, tokOther, tokAdmin] = await Promise.all(
    ['teng', 'tmath', 'tphys', 'home', 'tother', 'gadmin'].map(async (u) => (await login(u)).token),
  );
});

const sheet = (t: string, q: Record<string, string | number>) =>
  request(app).get('/api/v1/grades/sheet').query(q).set(bearer(t));
const bulk = (t: string, body: object) =>
  request(app).post('/api/v1/grades/bulk').set(bearer(t)).send(body);
const create = (t: string, body: object) =>
  request(app).post('/api/v1/grades').set(bearer(t)).send(body);
const items = (...ids: string[]) => ids.map((studentId) => ({ studentId, value: 5 }));

describe('Baholash varag`i: dars aniqlash', () => {
  it('bir nechta dars: lessons[] qaytadi, lessonNo null; tanlansa o`sha dars varag`i', async () => {
    const r = await sheet(tokAdmin, { classId: c8.id, subjectId: eng.id, date: WED });
    expect(r.status).toBe(200);
    expect(r.body.data.lessonNo).toBeNull();
    expect(r.body.data.hasTimetable).toBe(true);
    expect(r.body.data.lessons).toHaveLength(2);
    expect(r.body.data.lessons[0]).toMatchObject({
      lessonNo: 1,
      cancelled: false,
      mine: false,
      teacher: { id: tEng.id },
    });
    expect(r.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1, 3]);
    expect(r.body.data.students.every((s: { grade: unknown }) => s.grade === null)).toBe(true);

    await bulk(tokAdmin, {
      classId: c8.id,
      subjectId: eng.id,
      date: WED,
      lessonNo: 3,
      items: items(a1.id),
    });
    const r3 = await sheet(tokAdmin, { classId: c8.id, subjectId: eng.id, date: WED, lessonNo: 3 });
    expect(r3.body.data.lessonNo).toBe(3);
    expect(
      r3.body.data.students.find((s: { studentId: string }) => s.studentId === a1.id),
    ).toMatchObject({ alreadyGraded: true, grade: { lessonNo: 3, value: 5 } });
    const r1 = await sheet(tokAdmin, { classId: c8.id, subjectId: eng.id, date: WED, lessonNo: 1 });
    expect(
      r1.body.data.students.find((s: { studentId: string }) => s.studentId === a1.id),
    ).toMatchObject({ alreadyGraded: false });
  });

  it('bitta dars: sukut bo`yicha shu dars; mine bayrog`i', async () => {
    const r = await sheet(tokMath, { classId: c8.id, subjectId: math.id, date: WED });
    expect(r.status).toBe(200);
    expect(r.body.data.lessonNo).toBe(2);
    expect(r.body.data.lessons).toHaveLength(1);
    expect(r.body.data.lessons[0]).toMatchObject({ lessonNo: 2, mine: true });
  });

  it('dars yo`q (fan shu kuni jadvalda emas) va jadvalsiz sinf: lessonNo = 0', async () => {
    const thu = await sheet(tokAdmin, { classId: c8.id, subjectId: phys.id, date: THU });
    expect(thu.body.data).toMatchObject({ lessonNo: 0, hasTimetable: true, lessons: [] });
    const none = await sheet(tokMath, { classId: c9.id, subjectId: math.id, date: WED });
    expect(none.body.data).toMatchObject({ lessonNo: 0, hasTimetable: false, lessons: [] });
  });

  it('noto`g`ri lessonNo so`ralsa 400', async () => {
    const r = await sheet(tokAdmin, { classId: c8.id, subjectId: eng.id, date: WED, lessonNo: 2 });
    expect(r.status).toBe(400);
  });
});

describe('Ommaviy baholash: lessonNo', () => {
  const body = (extra: Record<string, unknown>) => ({
    classId: c8.id,
    subjectId: eng.id,
    date: WED,
    items: items(a1.id, a2.id),
    ...extra,
  });

  it('bir kunda 1- va 3-darsga alohida baho; xuddi shu darsga qayta yuborish yangilaydi', async () => {
    const r1 = await bulk(tokAdmin, body({ lessonNo: 1 }));
    expect(r1.status).toBe(200);
    expect(r1.body.data).toMatchObject({ created: 2, updated: 0, failed: [] });
    const r3 = await bulk(tokAdmin, body({ lessonNo: 3 }));
    expect(r3.body.data).toMatchObject({ created: 2, updated: 0, failed: [] });
    expect(await SubjectGrade.countDocuments({ studentId: a1.id, isDeleted: false })).toBe(2);
    const again = await bulk(tokAdmin, {
      ...body({ lessonNo: 1 }),
      items: [{ studentId: a1.id, value: 3 }],
    });
    expect(again.body.data).toMatchObject({ created: 0, updated: 1, failed: [] });
    const g = await SubjectGrade.findOne({ studentId: a1.id, lessonNo: 1 });
    expect(g?.value).toBe(3);
    expect(await SubjectGrade.countDocuments({ studentId: a1.id, isDeleted: false })).toBe(2);
  });

  it('noto`g`ri lessonNo: boshqa fan darsi, bir nechta darsda tanlanmagan, 0, dars yo`q kuni -> 400', async () => {
    expect((await bulk(tokAdmin, body({ lessonNo: 2 }))).status).toBe(400); // 2-dars matematika
    expect((await bulk(tokAdmin, body({}))).status).toBe(400); // tanlanmagan
    expect((await bulk(tokAdmin, body({ lessonNo: 0 }))).status).toBe(400);
    expect((await bulk(tokAdmin, body({ lessonNo: 5 }))).status).toBe(400);
    const thu = await bulk(tokAdmin, body({ date: '2026-10-13', lessonNo: 1 })); // seshanba: jadvalda yo'q
    expect(thu.status).toBe(400);
    expect(thu.body.error.details?.[0]?.path).toBe('lessonNo');
    expect(await SubjectGrade.countDocuments({})).toBe(0);
  });

  it('bitta dars bo`lsa lessonNo yuborilmasa ham sukut bo`yicha shu dars', async () => {
    const r = await bulk(tokMath, {
      classId: c8.id,
      subjectId: math.id,
      date: WED,
      items: items(a1.id),
    });
    expect(r.status).toBe(200);
    expect((await SubjectGrade.findOne({ studentId: a1.id }))?.lessonNo).toBe(2);
  });

  it('jadvalsiz sinf: lessonNo = 0 (eski xatti-harakat), kuniga bitta; lessonNo > 0 -> 400', async () => {
    const ok = await bulk(tokMath, {
      classId: c9.id,
      subjectId: math.id,
      date: WED,
      items: items(b1.id),
    });
    expect(ok.body.data).toMatchObject({ created: 1, updated: 0, failed: [] });
    expect((await SubjectGrade.findOne({ studentId: b1.id }))?.lessonNo).toBe(0);
    const again = await bulk(tokMath, {
      classId: c9.id,
      subjectId: math.id,
      date: WED,
      lessonNo: 0,
      items: items(b1.id),
    });
    expect(again.body.data).toMatchObject({ created: 0, updated: 1 });
    const bad = await bulk(tokMath, {
      classId: c9.id,
      subjectId: math.id,
      date: WED,
      lessonNo: 2,
      items: items(b1.id),
    });
    expect(bad.status).toBe(400);
  });
});

describe('Bitta baho (POST /grades): lessonNo', () => {
  const body = (extra: Record<string, unknown>) => ({
    studentId: a1.id,
    subjectId: eng.id,
    date: WED,
    value: 4,
    ...extra,
  });

  it('bir kunda ikki dars -> ikki baho; shu darsga takror -> 409', async () => {
    expect((await create(tokAdmin, body({ lessonNo: 1 }))).status).toBe(201);
    const second = await create(tokAdmin, body({ lessonNo: 3 }));
    expect(second.status).toBe(201);
    expect(second.body.data.lessonNo).toBe(3);
    expect((await create(tokAdmin, body({ lessonNo: 3 }))).status).toBe(409);
    expect((await create(tokAdmin, body({}))).status).toBe(400);
    expect((await create(tokAdmin, body({ lessonNo: 2 }))).status).toBe(400);
  });
});

describe('Kim baholay oladi', () => {
  it('jadvaldagi o`qituvchi (ClassSubject/teacherIds da yo`q) faqat o`z dars kunida baholaydi', async () => {
    const ok = await bulk(tokEng, {
      classId: c8.id,
      subjectId: eng.id,
      date: WED,
      lessonNo: 1,
      items: items(a1.id),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.created).toBe(1);
    expect((await sheet(tokEng, { classId: c8.id, subjectId: eng.id, date: WED })).status).toBe(
      200,
    );
    // boshqa sana — u kuni shu sinfda darsi yo'q
    const thu = await bulk(tokEng, {
      classId: c8.id,
      subjectId: eng.id,
      date: THU,
      items: items(a1.id),
    });
    expect(thu.status).toBe(403);
    expect((await sheet(tokEng, { classId: c8.id, subjectId: eng.id, date: THU })).status).toBe(
      403,
    );
    expect(
      (await create(tokEng, { studentId: a2.id, subjectId: eng.id, date: THU, value: 5 })).status,
    ).toBe(403);
    // boshqa fanga (matematika) huquqi yo'q
    const other = await bulk(tokEng, {
      classId: c8.id,
      subjectId: math.id,
      date: WED,
      items: items(a1.id),
    });
    expect(other.status).toBe(403);
  });

  it('boshqa o`qituvchi, fan o`qituvchisi bo`lmagan sinf rahbari 403; biriktirilgan o`qituvchi avvalgidek', async () => {
    const q = { classId: c8.id, subjectId: eng.id, date: WED };
    expect((await sheet(tokOther, q)).status).toBe(403);
    expect((await sheet(tokHome, q)).status).toBe(403); // sinf rahbari fan baholash huquqini olmaydi
    expect((await bulk(tokHome, { ...q, lessonNo: 1, items: items(a1.id) })).status).toBe(403);
    expect((await bulk(tokPhys, { ...q, lessonNo: 1, items: items(a1.id) })).status).toBe(403);
    // ClassSubject orqali biriktirilgan o'qituvchi (jadvalsiz sinfda) avvalgidek
    expect(
      (await bulk(tokMath, { classId: c9.id, subjectId: math.id, items: items(b1.id) })).status,
    ).toBe(200);
    expect(
      (await bulk(tokPhys, { classId: c9.id, subjectId: math.id, items: items(b1.id) })).status,
    ).toBe(403);
  });
});

describe('Indeks migratsiyasi (P3)', () => {
  it('eski indeks bo`lsa ishga tushishda o`chiriladi; bir kunda ikki dars bahosi o`tadi, takror rad etiladi', async () => {
    const col = SubjectGrade.collection;
    await SubjectGrade.init();
    // production holatini qayta tiklaymiz: eski unique indeks bor, yangisi yo'q
    await col.createIndex(
      { schoolId: 1, studentId: 1, subjectId: 1, date: 1 },
      {
        unique: true,
        partialFilterExpression: { isDeleted: false },
        name: LEGACY_GRADE_INDEX,
      },
    );
    await col.dropIndex('one_grade_per_student_subject_day_lesson');
    // eski hujjat: lessonNo maydoni yo'q
    await col.insertOne({
      schoolId: school._id,
      studentId: a1._id,
      classId: c8._id,
      subjectId: eng._id,
      teacherId: tEng._id,
      academicYearId: year._id,
      value: 4,
      comment: null,
      date: '2026-10-01',
      isDeleted: false,
    });
    let names = (await col.indexes()).map((i) => i.name);
    expect(names).toContain(LEGACY_GRADE_INDEX);

    await ensureIndexes();
    await ensureIndexes(); // idempotent
    names = (await col.indexes()).map((i) => i.name);
    expect(names).not.toContain(LEGACY_GRADE_INDEX);
    expect(names).toContain('one_grade_per_student_subject_day_lesson');
    expect((await col.findOne({ date: '2026-10-01' }))?.lessonNo).toBe(0); // backfill

    const base = {
      schoolId: school._id,
      studentId: a2._id,
      classId: c8._id,
      subjectId: eng._id,
      teacherId: tEng._id,
      academicYearId: year._id,
      value: 5,
      date: WED,
    };
    await SubjectGrade.create({ ...base, lessonNo: 1 });
    await SubjectGrade.create({ ...base, lessonNo: 3 });
    await expect(SubjectGrade.create({ ...base, lessonNo: 3 })).rejects.toMatchObject({
      code: 11000,
    });
    // eski hujjat (lessonNo 0 ga o'tkazilgan) bilan lessonNo 0 to'qnashadi
    await expect(
      SubjectGrade.create({ ...base, studentId: a1._id, date: '2026-10-01', lessonNo: 0 }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('Reyting va hisobotlar: kuniga bir nechta baho', () => {
  it('o`rtacha barcha baholar bo`yicha; reytingda baholar soni oshadi', async () => {
    const base = {
      schoolId: school._id,
      classId: c8._id,
      subjectId: eng._id,
      teacherId: tEng._id,
      academicYearId: year._id,
      date: WED,
    };
    await SubjectGrade.create({ ...base, studentId: a1._id, lessonNo: 1, value: 5 });
    await SubjectGrade.create({ ...base, studentId: a1._id, lessonNo: 3, value: 3 });
    await SubjectGrade.create({ ...base, studentId: a2._id, lessonNo: 1, value: 4 });

    const stats = await loadGradeStats({
      schoolId: school.id,
      from: '2026-10-01',
      to: '2026-10-31',
    } as never);
    expect(stats.get(a1.id)).toMatchObject({ count: 2, average: 4 });
    expect(stats.get(a1.id)?.bySubject[0]).toMatchObject({ count: 2, average: 4 });

    await makeUser({
      username: 'rep',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['reports.view'],
    });
    const rep = (await login('rep')).token;
    const list = await request(app)
      .get('/api/v1/ratings/students?includeIneligible=true&from=2026-10-01&to=2026-10-31')
      .set(bearer(rep));
    const row = list.body.data.items.find((i: { studentId: string }) => i.studentId === a1.id);
    // fan komponenti: (5+3)/2 * 20 = 80; faol kun 1, ball soni 2
    expect(row).toMatchObject({ score: 80, daysCount: 1, scoresCount: 2 });

    const sum = await request(app)
      .get(`/api/v1/students/${a1.id}/grade-summary?from=2026-10-01&to=2026-10-31`)
      .set(bearer(tokAdmin));
    expect(sum.body.data).toMatchObject({ gradesCount: 2, average: 4 });
    expect(sum.body.data.recent.map((g: { lessonNo: number }) => g.lessonNo).sort()).toEqual([
      1, 3,
    ]);
  });
});

describe('Mening baholash doiram', () => {
  it('bugun jadvalda darsi bor, lekin ClassSubject da yo`q juftlik ham ro`yxatda', async () => {
    const r = await request(app).get('/api/v1/grades/my-assignments').set(bearer(tokEng));
    expect(r.status).toBe(200);
    expect(r.body.data.assignments).toEqual([
      expect.objectContaining({ className: '8-B', subjectName: 'Ingliz tili' }),
    ]);
    const m = await request(app).get('/api/v1/grades/my-assignments').set(bearer(tokMath));
    expect(m.body.data.assignments.map((a: { className: string }) => a.className)).toEqual([
      '8-B',
      '9-A',
    ]);
  });
});
