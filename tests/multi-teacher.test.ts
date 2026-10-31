import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/config/migrations';
import { ClassSubject, LEGACY_CLASS_SUBJECT_INDEX } from '../src/models/ClassSubject';
import { LEGACY_OVERRIDE_INDEX, LessonOverride } from '../src/models/LessonOverride';
import { TimetableVersion } from '../src/models/TimetableVersion';
import {
  applyOverrides,
  resolveLessons,
  teacherLessons,
} from '../src/modules/timetable/timetable.resolver';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  AttendanceRecord,
  SubjectGrade,
  app,
  assignSubject,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { readXlsx } from './helpers/xlsx';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z'; // chorshanba (weekday 3)
const WED = '2026-10-14';
const API = '/api/v1';

let school: Doc, year: Doc;
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let s1: Doc, s2: Doc;
let eng: Doc, math: Doc;
let tAl: Doc, tGa: Doc, tMath: Doc, tHome: Doc;
let K: Doc;
let tokAl: string, tokGa: string, tokMath: string, tokAdmin: string, tokSub: string, root: string;

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
  school = await makeSchool('mt');
  year = await makeYear(school.id);
  tAl = await makeUser({ username: 'tal', role: 'teacher', schoolId: school.id });
  tGa = await makeUser({ username: 'tga', role: 'teacher', schoolId: school.id });
  tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tHome = await makeUser({ username: 'thome', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'madmin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [
      ...ADMIN_PERMS,
      'attendance.take',
      'attendance.view',
      'attendance.edit',
      'attendance.settings',
      'grades.create',
      'grades.edit',
      'timetable.view',
      'timetable.manage',
      'timetable.substitute',
      'reports.view',
    ],
  });
  await makeUser({
    username: 'msub',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.view', 'timetable.substitute'],
  });
  await makeUser({ username: 'mroot', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [], { homeroomTeacherId: tHome._id });
  c6 = await makeClass(school.id, year.id, '6-A', []);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  eng = await makeSubject('Ingliz tili');
  math = await makeSubject('Matematika');
  K = await makeStatus('Keldi', 'present', { shortName: 'K', order: 1, isDefault: true });
  // Ingliz tili: ikkita o'qituvchi (har biri alohida kurs)
  await assignSubject(school.id, c5, eng.id, tAl.id);
  await assignSubject(school.id, c5, eng.id, tGa.id);
  await assignSubject(school.id, c5, math.id, tMath.id);
  await TimetableVersion.create({
    schoolId: school.id,
    academicYearId: year.id,
    classId: c5.id,
    status: 'active',
    validFrom: '2026-09-01',
    activatedAt: new Date(),
    entries: [
      // chorshanba: 1-soat ikkala ingliz tili o'qituvchisi parallel, 2-soat matematika, 3-soat faqat Aliyeva
      entry(3, 1, eng.id, tAl.id),
      entry(3, 1, eng.id, tGa.id),
      entry(3, 2, math.id, tMath.id),
      entry(3, 3, eng.id, tAl.id),
    ],
  });
  [tokAl, tokGa, tokMath, , tokAdmin, tokSub, root] = await Promise.all(
    ['tal', 'tga', 'tmath', 'thome', 'madmin', 'msub', 'mroot'].map(
      async (u) => (await login(u)).token,
    ),
  );
  await request(app)
    .put('/api/v1/settings/attendance')
    .set(bearer(root))
    .send({ scope: 'school', schoolId: school.id, values: { mode: 'lesson', lessonsPerDay: 6 } });
});

const g = (t: string, path: string) => request(app).get(`${API}${path}`).set(bearer(t));
const post = (t: string, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(bearer(t)).send(body);
const put = (t: string, path: string, body: object = {}) =>
  request(app).put(`${API}${path}`).set(bearer(t)).send(body);
const del = (t: string, path: string) => request(app).delete(`${API}${path}`).set(bearer(t));

describe('migratsiya: sinf+fan unique indeksi va override indeksi', () => {
  it("eski indekslar o'chiriladi, ikki marta ishlaganda ham xatosiz; extra target to'ldiriladi", async () => {
    await ClassSubject.deleteMany({});
    await ClassSubject.collection.dropIndexes();
    await LessonOverride.collection.dropIndexes();
    await ClassSubject.collection.createIndex(
      { classId: 1, subjectId: 1 },
      { unique: true, name: LEGACY_CLASS_SUBJECT_INDEX },
    );
    await LessonOverride.collection.createIndex(
      { schoolId: 1, classId: 1, date: 1, lessonNo: 1, groupKey: 1 },
      { unique: true, name: LEGACY_OVERRIDE_INDEX },
    );
    await LessonOverride.collection.insertOne({
      schoolId: school._id,
      classId: c5._id,
      date: WED,
      lessonNo: 5,
      groupKey: null,
      type: 'extra',
      subjectId: eng._id,
      teacherId: tGa._id,
      room: null,
      moveGroupId: null,
      reason: null,
      createdBy: null,
    });
    await runMigrations();
    await runMigrations(); // idempotent
    const names = async (m: { collection: { indexes: () => Promise<{ name?: string }[]> } }) =>
      (await m.collection.indexes()).map((i) => i.name);
    expect(await names(ClassSubject)).not.toContain(LEGACY_CLASS_SUBJECT_INDEX);
    expect(await names(LessonOverride)).not.toContain(LEGACY_OVERRIDE_INDEX);
    await ClassSubject.createIndexes();
    await LessonOverride.createIndexes();
    // endi bir fanga ikkinchi o'qituvchi biriktiriladi, aynan takror esa yo'q
    const base = {
      schoolId: school.id,
      classId: c5.id,
      academicYearId: year.id,
      subjectId: eng.id,
    };
    await ClassSubject.create({ ...base, teacherId: tAl.id });
    await ClassSubject.create({ ...base, teacherId: tGa.id });
    await expect(ClassSubject.create({ ...base, teacherId: tAl.id })).rejects.toThrow(/E11000/);
    const legacy = await LessonOverride.findOne({ lessonNo: 5 });
    expect(String(legacy?.targetTeacherId)).toBe(tGa.id);
    expect(String(legacy?.targetSubjectId)).toBe(eng.id);
  });
});

describe('biriktirish va sinf DTO', () => {
  it("sinf DTO'sida bir fan ikki o'qituvchi bilan; takror juftlik rad etiladi", async () => {
    const r = await g(tokAdmin, `/classes/${c5.id}`);
    expect(r.status).toBe(200);
    const engRows = r.body.data.subjects.filter(
      (s: { subjectId: string }) => s.subjectId === eng.id,
    );
    expect(engRows.map((s: { teacherId: string }) => s.teacherId).sort()).toEqual(
      [tAl.id, tGa.id].sort(),
    );
    const dup = await put(tokAdmin, `/classes/${c5.id}/subjects`, {
      subjects: [
        { subjectId: eng.id, teacherId: tAl.id },
        { subjectId: eng.id, teacherId: tAl.id },
      ],
    });
    expect(dup.status).toBe(400);
  });
});

describe('dars jadvali: bir katakda bir nechta dars', () => {
  it("resolver: bir slotda ikkita dars; o'qituvchi haftasi va bugungi darslari", async () => {
    const lessons = await resolveLessons(school.id, c5.id, WED);
    expect(
      lessons
        .filter((l) => l.lessonNo === 1)
        .map((l) => l.teacherId)
        .sort(),
    ).toEqual([tAl.id, tGa.id].sort());
    expect(await teacherLessons(school.id, tGa.id, WED)).toHaveLength(1);
    expect(await teacherLessons(school.id, tAl.id, WED)).toHaveLength(2);
    const week = await g(tokGa, `/timetable/teachers/${tGa.id}/week?date=${WED}`);
    expect(week.status).toBe(200);
    expect(week.body.data.weeklyCount).toBe(1);
    const today = await g(tokAl, '/timetable/me/today');
    expect(today.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1, 3]);
    expect(today.body.data.lessons[0].teacherId).toBe(tAl.id);
  });

  it("qoralama: bir katakda ikki o'qituvchi mumkin, bir o'qituvchi ikki marta emas; ogohlantirishlar to'plam bo'yicha", async () => {
    const c = await post(tokAdmin, `/timetable/classes/${c6.id}/versions`, {
      validFrom: '2026-11-02',
    });
    const id = c.body.data.version.id as string;
    await assignSubject(school.id, c6, eng.id, tAl.id);
    const ok = await put(tokAdmin, `/timetable/versions/${id}`, {
      entries: [
        entry(1, 1, eng.id, tAl.id),
        entry(1, 1, eng.id, tGa.id),
        entry(1, 2, math.id, tAl.id),
      ],
    });
    expect(ok.status).toBe(200);
    const w = ok.body.data.warnings as { code: string; teacherId: string; lessonNo: number }[];
    // tAl biriktirilgan (eng), tGa esa 6-A da eng ga biriktirilmagan; matematika tAl ga biriktirilmagan
    const notAssigned = w.filter((x) => x.code === 'teacher_not_assigned');
    expect(notAssigned.map((x) => `${x.lessonNo}:${x.teacherId}`).sort()).toEqual(
      [`1:${tGa.id}`, `2:${tAl.id}`].sort(),
    );
    const bad = await put(tokAdmin, `/timetable/versions/${id}`, {
      entries: [entry(1, 1, eng.id, tAl.id), entry(1, 1, math.id, tAl.id)],
    });
    expect(bad.status).toBe(400);
  });

  it("o'qituvchi to'qnashuvi o'qituvchi bo'yicha: parallel o'qituvchilardan biri boshqa sinfda band", async () => {
    // 6-A: chorshanba 1-soat tGa (5-A da ham band) -> to'qnashuv; tMath esa bo'sh
    const c = await post(tokAdmin, `/timetable/classes/${c6.id}/versions`, {
      validFrom: '2026-11-02',
    });
    const id = c.body.data.version.id as string;
    const r = await put(tokAdmin, `/timetable/versions/${id}`, {
      entries: [entry(3, 1, eng.id, tGa.id), entry(3, 1, math.id, tMath.id)],
    });
    const dbl = r.body.data.warnings.filter(
      (x: { code: string }) => x.code === 'teacher_double_booked',
    );
    expect(dbl).toHaveLength(1);
    expect(dbl[0].teacherId).toBe(tGa.id);
  });

  it('eksport: katakda ikkala dars', async () => {
    const r = await request(app)
      .get(`${API}/timetable/classes/${c5.id}/export?format=xlsx&date=${WED}`)
      .set(bearer(tokAdmin))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    const text = JSON.stringify(await readXlsx(r.body as Buffer));
    // 1-soat katagida ikkita "Ingliz tili" qatori + 3-soatda bittasi
    expect(text.match(/Ingliz tili/g)).toHaveLength(3);
  });
});

describe('davomat: parallel darslar', () => {
  const bulk = (t: string, body: object) =>
    request(app).post(`${API}/attendance/bulk`).set(bearer(t)).send(body);
  const item = (s: Doc) => ({ studentId: s.id, statusId: K.id });
  const base = (extra: object = {}) => ({ classId: c5.id, date: WED, lessonNo: 1, ...extra });

  it("har bir o'qituvchi o'z darsiga belgilaydi; boshqa o'qituvchi belgilagan o'quvchiga 409", async () => {
    const a = await bulk(tokAl, base({ items: [item(s1)] }));
    expect(a.status).toBe(200);
    const rec = await AttendanceRecord.findOne({ studentId: s1.id });
    expect(String(rec?.teacherId)).toBe(tAl.id);
    expect(String(rec?.subjectId)).toBe(eng.id);
    // Ga ning darsi (parallel): boshqa o'quvchi mumkin
    const b = await bulk(tokGa, base({ items: [item(s2)] }));
    expect(b.status).toBe(200);
    expect(String((await AttendanceRecord.findOne({ studentId: s2.id }))?.teacherId)).toBe(tGa.id);
    // Ga, Al belgilagan o'quvchini almashtira olmaydi
    const c = await bulk(tokGa, base({ items: [item(s1)] }));
    expect(c.status).toBe(409);
    expect(c.body.error.message).toContain('Test tal');
    expect(String((await AttendanceRecord.findOne({ studentId: s1.id }))?.teacherId)).toBe(tAl.id);
    // aralash so'rov: bittasi o'tadi, bittasi failed[] ga tushadi
    const mixed = await bulk(tokAl, base({ items: [item(s1), item(s2)] }));
    expect(mixed.status).toBe(200);
    expect(mixed.body.data.updated).toBe(1);
    expect(mixed.body.data.failed).toEqual([
      expect.objectContaining({ studentId: s2.id, code: 'CONFLICT' }),
    ]);
  });

  it("admin: bir nechta darsda o'qituvchini tanlashi shart, tanlab boshqa o'qituvchi belgisini almashtiradi", async () => {
    await bulk(tokAl, base({ items: [item(s1)] }));
    const amb = await bulk(tokAdmin, base({ items: [item(s1)] }));
    expect(amb.status).toBe(400);
    const r = await bulk(tokAdmin, base({ teacherId: tGa.id, items: [item(s1)] }));
    expect(r.status).toBe(200);
    expect(r.body.data.updated).toBe(1);
    const rec = await AttendanceRecord.findOne({ studentId: s1.id });
    expect(String(rec?.teacherId)).toBe(tGa.id);
    expect(await AttendanceRecord.countDocuments({ studentId: s1.id })).toBe(1);
  });

  it("varaq: o'qituvchi o'z darsini ko'radi, boshqa o'qituvchi belgisi otherLesson bilan; admin uchun tanlov kerak", async () => {
    await bulk(tokGa, base({ items: [item(s2)] }));
    const sh = await g(tokAl, `/classes/${c5.id}/attendance-sheet?date=${WED}&lessonNo=1`);
    expect(sh.status).toBe(200);
    expect(sh.body.data.lesson.teacher.id).toBe(tAl.id);
    expect(sh.body.data.lessons.filter((l: { lessonNo: number }) => l.lessonNo === 1)).toHaveLength(
      2,
    );
    expect(sh.body.data.lessonChoiceRequired).toBe(false);
    const row = sh.body.data.students.find((s: { studentId: string }) => s.studentId === s2.id);
    expect(row.otherLesson.teacher.id).toBe(tGa.id);
    expect(row.otherLesson.subject.name).toBe('Ingliz tili');
    const adm = await g(tokAdmin, `/classes/${c5.id}/attendance-sheet?date=${WED}&lessonNo=1`);
    expect(adm.body.data.lessonChoiceRequired).toBe(true);
    const adm2 = await g(
      tokAdmin,
      `/classes/${c5.id}/attendance-sheet?date=${WED}&lessonNo=1&teacherId=${tGa.id}`,
    );
    expect(adm2.body.data.lessonChoiceRequired).toBe(false);
    expect(adm2.body.data.lesson.teacher.id).toBe(tGa.id);
    expect(
      adm2.body.data.students.every((s: { otherLesson: unknown }) => s.otherLesson === null),
    ).toBe(true);
  });

  it("bugungi darslar: parallel darslarda har bir o'qituvchining holati alohida", async () => {
    await bulk(tokAl, base({ items: [item(s1), item(s2)] }));
    const al = await g(tokAl, '/timetable/me/today');
    expect(al.body.data.lessons[0]).toMatchObject({
      lessonNo: 1,
      status: 'taken',
      markedStudents: 2,
    });
    const ga = await g(tokGa, '/timetable/me/today');
    expect(ga.body.data.lessons[0]).toMatchObject({
      lessonNo: 1,
      status: 'none',
      markedStudents: 0,
    });
  });

  it("bitta darsli slotda eski qoida: boshqa fan uchun olingan dars 409 (o'zgarmagan)", async () => {
    const r = await bulk(tokMath, { classId: c5.id, date: WED, lessonNo: 2, items: [item(s1)] });
    expect(r.status).toBe(200);
    const again = await bulk(tokAdmin, {
      classId: c5.id,
      date: WED,
      lessonNo: 2,
      subjectId: eng.id,
      items: [item(s2)],
    });
    expect(again.status).toBe(409);
  });
});

describe("baholar: har bir o'qituvchi o'z kursida", () => {
  const sheet = (t: string, q: Record<string, string | number>) =>
    request(app).get(`${API}/grades/sheet`).query(q).set(bearer(t));
  const bulk = (t: string, body: object) =>
    request(app).post(`${API}/grades/bulk`).set(bearer(t)).send(body);
  const create = (t: string, body: object) =>
    request(app).post(`${API}/grades`).set(bearer(t)).send(body);
  const gb = (extra: object = {}) => ({
    classId: c5.id,
    subjectId: eng.id,
    date: WED,
    ...extra,
  });

  it("varaq o'qituvchi darslari bilan cheklanadi; admin teacherId bilan tanlaydi", async () => {
    const ga = await sheet(tokGa, { classId: c5.id, subjectId: eng.id, date: WED });
    expect(ga.status).toBe(200);
    // Ga faqat 1-soatda dars beradi -> bitta dars, sukut bo'yicha tanlanadi
    expect(ga.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1]);
    expect(ga.body.data.lessonNo).toBe(1);
    const al = await sheet(tokAl, { classId: c5.id, subjectId: eng.id, date: WED });
    expect(al.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1, 3]);
    const adm = await sheet(tokAdmin, {
      classId: c5.id,
      subjectId: eng.id,
      date: WED,
      teacherId: tGa.id,
    });
    expect(adm.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1]);
  });

  it("boshqa o'qituvchi qo'ygan bahoni o'qituvchi almashtira olmaydi (409), admin grades.edit bilan mumkin", async () => {
    const a = await bulk(tokAl, gb({ lessonNo: 1, items: [{ studentId: s1.id, value: 5 }] }));
    expect(a.body.data.created).toBe(1);
    const row = await SubjectGrade.findOne({ studentId: s1.id });
    expect(String(row?.teacherId)).toBe(tAl.id);
    const c = await create(tokGa, {
      studentId: s1.id,
      subjectId: eng.id,
      date: WED,
      lessonNo: 1,
      value: 3,
    });
    expect(c.status).toBe(409);
    expect(c.body.error.message).toContain('Test tal');
    const b = await bulk(tokGa, gb({ items: [{ studentId: s1.id, value: 3 }] }));
    expect(b.status).toBe(409);
    expect((await SubjectGrade.findById(row?.id))?.value).toBe(5);
    // aralash so'rov: s2 yaratiladi, s1 CONFLICT
    const mixed = await bulk(
      tokGa,
      gb({
        items: [
          { studentId: s1.id, value: 3 },
          { studentId: s2.id, value: 4 },
        ],
      }),
    );
    expect(mixed.status).toBe(200);
    expect(mixed.body.data.created).toBe(1);
    expect(mixed.body.data.failed[0]).toMatchObject({ studentId: s1.id, code: 'CONFLICT' });
    const adm = await bulk(tokAdmin, gb({ lessonNo: 1, items: [{ studentId: s1.id, value: 4 }] }));
    expect(adm.body.data.updated).toBe(1);
  });
});

describe('jurnal: (fan, o‘qituvchi) juftligi', () => {
  const journal = (t: string, q: string) =>
    g(t, `/journal/subject?classId=${c5.id}&subjectId=${eng.id}&from=${WED}&to=${WED}${q}`);

  beforeEach(async () => {
    await SubjectGrade.create({
      schoolId: school.id,
      studentId: s1.id,
      classId: c5.id,
      subjectId: eng.id,
      teacherId: tAl.id,
      academicYearId: year.id,
      value: 5,
      date: WED,
      lessonNo: 3,
    });
    await SubjectGrade.create({
      schoolId: school.id,
      studentId: s2.id,
      classId: c5.id,
      subjectId: eng.id,
      teacherId: tGa.id,
      academicYearId: year.id,
      value: 3,
      date: WED,
      lessonNo: 1,
    });
  });

  it("o'qituvchi sukut bo'yicha o'z juftligini ko'radi: ustunlar va baholar faqat o'zining", async () => {
    const al = await journal(tokAl, '');
    expect(al.status).toBe(200);
    expect(al.body.data.teacher.id).toBe(tAl.id);
    expect(al.body.data.teachers.map((t: { id: string }) => t.id).sort()).toEqual(
      [tAl.id, tGa.id].sort(),
    );
    expect(al.body.data.columns.map((c: { key: string }) => c.key)).toEqual([
      `${WED}#1`,
      `${WED}#3`,
    ]);
    expect(al.body.data.cells[s1.id][`${WED}#3`].grade).toBe(5);
    expect(al.body.data.cells[s2.id]?.[`${WED}#1`]?.grade).toBeUndefined();
    const ga = await journal(tokGa, '');
    expect(ga.body.data.teacher.id).toBe(tGa.id);
    expect(ga.body.data.columns.map((c: { key: string }) => c.key)).toEqual([`${WED}#1`]);
    expect(ga.body.data.cells[s2.id][`${WED}#1`].grade).toBe(3);
    expect(ga.body.data.cells[s1.id]?.[`${WED}#3`]).toBeUndefined();
    // o'qituvchi boshqa o'qituvchining jurnalini so'rasa 403
    expect((await journal(tokGa, `&teacherId=${tAl.id}`)).status).toBe(403);
  });

  it("admin: teacherId bilan juftlik, tanlamasa — ikkala o'qituvchi birga; export nomida o'qituvchi", async () => {
    const adm = await journal(tokAdmin, `&teacherId=${tGa.id}`);
    expect(adm.body.data.teacher.id).toBe(tGa.id);
    expect(adm.body.data.columns).toHaveLength(1);
    const all = await journal(tokAdmin, '');
    expect(all.body.data.teacher).toBeNull();
    expect(all.body.data.columns.map((c: { key: string }) => c.key)).toEqual([
      `${WED}#1`,
      `${WED}#3`,
    ]);
    const bad = await journal(tokAdmin, `&teacherId=${tMath.id}`);
    expect(bad.status).toBe(400);
    const ex = await request(app)
      .get(
        `${API}/journal/subject/export.xlsx?classId=${c5.id}&subjectId=${eng.id}&from=${WED}&to=${WED}&teacherId=${tGa.id}`,
      )
      .set(bearer(tokAdmin));
    expect(ex.status).toBe(200);
    expect(decodeURIComponent(String(ex.headers['content-disposition']))).toContain('Test-tga');
  });

  it("options: har bir fan uchun o'qituvchilar ro'yxati; o'qituvchi faqat o'zini ko'radi", async () => {
    const adm = await g(tokAdmin, '/journal/options');
    const cls = adm.body.data.classes.find((c: { id: string }) => c.id === c5.id);
    const engOpt = cls.subjects.filter((s: { id: string }) => s.id === eng.id);
    expect(engOpt).toHaveLength(1);
    expect(engOpt[0].teachers).toHaveLength(2);
    const ga = await g(tokGa, '/journal/options');
    const gaEng = ga.body.data.classes[0].subjects.find((s: { id: string }) => s.id === eng.id);
    expect(gaEng.teachers.map((t: { id: string }) => t.id)).toEqual([tGa.id]);
  });
});

describe('almashtirishlar: slotdagi aniq darsga', () => {
  const make = (body: object, t = tokSub) => post(t, '/timetable/overrides', body);
  const base = (extra: object = {}) => ({ classId: c5.id, date: WED, lessonNo: 1, ...extra });

  it("bir nechta dars bor slotda target shart; bekor qilish faqat tanlangan darsga ta'sir qiladi", async () => {
    const amb = await make(base({ type: 'cancel' }));
    expect(amb.status).toBe(400);
    const r = await make(base({ type: 'cancel', targetTeacherId: tGa.id }));
    expect(r.status).toBe(201);
    expect(r.body.data.targetTeacherId).toBe(tGa.id);
    expect(r.body.data.originalTeacher.id).toBe(tGa.id);
    const lessons = (await resolveLessons(school.id, c5.id, WED)).filter((l) => l.lessonNo === 1);
    expect(lessons.find((l) => l.teacherId === tGa.id)?.cancelled).toBe(true);
    expect(lessons.find((l) => l.teacherId === tAl.id)?.cancelled).toBe(false);
    // shu darsga ikkinchi o'zgartirish rad etiladi, ikkinchi darsga esa mumkin
    expect((await make(base({ type: 'cancel', targetTeacherId: tGa.id }))).status).toBe(409);
    const sub = await make(
      base({ type: 'substitute', targetTeacherId: tAl.id, teacherId: tMath.id }),
    );
    expect(sub.status).toBe(201);
    const after = (await resolveLessons(school.id, c5.id, WED)).filter((l) => l.lessonNo === 1);
    expect(after.find((l) => l.originalTeacherId === tAl.id)?.teacherId).toBe(tMath.id);
    // noto'g'ri target
    expect((await make(base({ type: 'cancel', targetTeacherId: tHome.id }))).status).toBe(409);
    // o'chirish faqat o'sha darsni tiklaydi
    expect((await del(tokSub, `/timetable/overrides/${r.body.data.id}`)).status).toBe(204);
    const restored = (await resolveLessons(school.id, c5.id, WED)).filter((l) => l.lessonNo === 1);
    expect(restored.every((l) => !l.cancelled)).toBe(true);
    expect(restored.find((l) => l.originalTeacherId === tAl.id)?.teacherId).toBe(tMath.id);
  });

  it("o'rinbosar slotda boshqa darsda band o'qituvchi bo'lolmaydi (parallel dars hisobga olinadi)", async () => {
    const r = await make(base({ type: 'substitute', targetTeacherId: tAl.id, teacherId: tGa.id }));
    expect(r.status).toBe(409);
  });

  it('teacher-day: ikkala dars alohida qator, targetTeacherId bilan', async () => {
    await make(base({ type: 'cancel', targetTeacherId: tAl.id }));
    const r = await g(tokSub, `/timetable/teacher-day?date=${WED}`);
    expect(r.status).toBe(200);
    const slot1 = r.body.data.lessons.filter((l: { lessonNo: number }) => l.lessonNo === 1);
    expect(slot1).toHaveLength(2);
    expect(
      slot1
        .map((l: { targetTeacherId: string; cancelled: boolean }) => [
          l.targetTeacherId,
          l.cancelled,
        ])
        .sort(),
    ).toEqual(
      [
        [tAl.id, true],
        [tGa.id, false],
      ].sort(),
    );
    // o'qituvchi filtri
    const only = await g(tokSub, `/timetable/teacher-day?date=${WED}&teacherId=${tGa.id}`);
    expect(only.body.data.lessons).toHaveLength(1);
  });

  it("ko'chirish: tanlangan dars bo'sh soatga; qo'shimcha dars bir soatda bir nechta", async () => {
    const mv = await post(tokSub, '/timetable/overrides/move', {
      classId: c5.id,
      from: { date: WED, lessonNo: 1, targetTeacherId: tGa.id },
      to: { date: WED, lessonNo: 5 },
      teacherId: null,
    });
    expect(mv.status).toBe(201);
    const lessons = await resolveLessons(school.id, c5.id, WED);
    expect(lessons.find((l) => l.lessonNo === 1 && l.teacherId === tGa.id)?.cancelled).toBe(true);
    expect(lessons.find((l) => l.lessonNo === 1 && l.teacherId === tAl.id)?.cancelled).toBe(false);
    expect(lessons.find((l) => l.lessonNo === 5)?.teacherId).toBe(tGa.id);
    // 5-soatga ikkinchi qo'shimcha dars (boshqa o'qituvchi) — parallel
    const ex = await make(
      base({ lessonNo: 5, type: 'extra', subjectId: math.id, teacherId: tMath.id }),
    );
    expect(ex.status).toBe(201);
    expect(
      (await resolveLessons(school.id, c5.id, WED)).filter((l) => l.lessonNo === 5),
    ).toHaveLength(2);
    // bir xil o'qituvchiga ikkinchi extra rad etiladi (band)
    expect(
      (await make(base({ lessonNo: 5, type: 'extra', subjectId: math.id, teacherId: tMath.id })))
        .status,
    ).toBe(409);
  });

  it("eski (targetsiz) almashtirish slotdagi birinchi darsga qo'llanadi", () => {
    const lessons = [
      {
        classId: 'c',
        date: WED,
        weekday: 3,
        lessonNo: 1,
        groupKey: null,
        subjectId: 's',
        teacherId: 'b',
        room: null,
        source: 'timetable' as const,
        cancelled: false,
        versionId: 'v',
      },
      {
        classId: 'c',
        date: WED,
        weekday: 3,
        lessonNo: 1,
        groupKey: null,
        subjectId: 's',
        teacherId: 'a',
        room: null,
        source: 'timetable' as const,
        cancelled: false,
        versionId: 'v',
      },
    ];
    const out = applyOverrides(lessons, [
      { id: 'o1', classId: 'c', date: WED, lessonNo: 1, groupKey: null, type: 'cancel' },
    ]);
    // slot ichida tartib o'qituvchi bo'yicha; targetsiz yozuv kirishdagi birinchi darsga ('b') tushadi
    expect(out.map((l) => [l.teacherId, l.cancelled])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });
});
