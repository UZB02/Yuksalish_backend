import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClassModel } from '../src/models/Class';
import { LessonOverride } from '../src/models/LessonOverride';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  AttendanceRecord,
  SubjectGrade,
  app,
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

useTestDb();

type Doc = { id: string; _id: unknown };
const WED = '2026-10-14'; // chorshanba (3)
const OLD_WED = '2026-10-07';

let school: Doc;
let cls: Doc;
let math: Doc, phys: Doc;
let s1: Doc, s2: Doc;
let K: Doc;
let tOrig: Doc, tSub: Doc, tPhys: Doc;
let tokOrig: string, tokSub: string, tokPhys: string, tokAdm: string, tokSubAdm: string;

const entry = (lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday: 3,
  lessonNo,
  subjectId,
  teacherId,
  groupKey: null,
  room: null,
});
const API = '/api/v1';
const att = (t: string, body: object) =>
  request(app).post(`${API}/attendance/bulk`).set(bearer(t)).send(body);
const sheet = (t: string, q = '') =>
  request(app).get(`${API}/classes/${cls.id}/attendance-sheet${q}`).set(bearer(t));
const grade = (t: string, body: object) =>
  request(app).post(`${API}/grades/bulk`).set(bearer(t)).send(body);
const override = (body: object) =>
  request(app)
    .post(`${API}/timetable/overrides`)
    .set(bearer(tokSubAdm))
    .send({ classId: cls.id, date: WED, ...body });
const items = () => [s1, s2].map((s) => ({ studentId: s.id, statusId: K.id }));
const gradeBody = (extra: object = {}) => ({
  classId: cls.id,
  subjectId: math.id,
  date: WED,
  lessonNo: 1,
  items: [{ studentId: s1.id, value: 5 }],
  ...extra,
});

beforeEach(async () => {
  clock.set(() => new Date('2026-10-14T07:00:00Z'));
  school = await makeSchool('ova');
  const year = await makeYear(school.id);
  // Asl o'qituvchi sinf teacherIds va ClassSubject da YO'Q: huquqi faqat jadvaldan
  tOrig = await makeUser({ username: 'ova_orig', role: 'teacher', schoolId: school.id });
  tSub = await makeUser({ username: 'ova_sub', role: 'teacher', schoolId: school.id });
  tPhys = await makeUser({ username: 'ova_phys', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'ova_adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'grades.create', 'attendance.take', 'attendance.view'],
  });
  await makeUser({
    username: 'ova_subadm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.view', 'timetable.substitute'],
  });
  await makeUser({ username: 'ova_root', role: 'superadmin' });
  cls = await makeClass(school.id, year.id, '8-B');
  s1 = await makeStudent(school.id, cls.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, cls.id, 'Valiyev Vali');
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  K = await makeStatus('Keldi', 'present', { shortName: 'K', order: 1, isDefault: true });
  await TimetableVersion.create({
    schoolId: school.id,
    academicYearId: (year as unknown as { id: string }).id,
    classId: cls.id,
    status: 'active',
    validFrom: '2026-09-01',
    activatedAt: new Date(),
    entries: [entry(1, math.id, tOrig.id), entry(2, phys.id, tPhys.id)],
  });
  [tokOrig, tokSub, tokPhys, tokAdm, tokSubAdm] = await Promise.all(
    ['ova_orig', 'ova_sub', 'ova_phys', 'ova_adm', 'ova_subadm'].map(
      async (u) => (await login(u)).token,
    ),
  );
  const root = (await login('ova_root')).token;
  await request(app)
    .put(`${API}/settings/attendance`)
    .set(bearer(root))
    .send({ scope: 'school', schoolId: school.id, values: { mode: 'lesson', lessonsPerDay: 6 } });
});

describe("o'rinbosar: davomat va baholash faqat shu sana/dars uchun", () => {
  it('override dan oldin: asl o`qituvchi oladi, o`rinbosar olmaydi', async () => {
    expect((await sheet(tokSub, '?lessonNo=1')).status).toBe(404);
    expect((await att(tokOrig, { classId: cls.id, lessonNo: 1, items: items() })).status).toBe(200);
    expect((await grade(tokOrig, gradeBody())).status).toBe(200);
  });

  it("o'rinbosar davomat oladi (source=override), baho qo'yadi; boshqa dars/sana yopiq", async () => {
    expect((await override({ lessonNo: 1, type: 'substitute', teacherId: tSub.id })).status).toBe(
      201,
    );
    // sinfni shu kuni ko'radi, boshqa sanada ko'rmaydi
    const sh = await sheet(tokSub, '?lessonNo=1');
    expect(sh.status).toBe(200);
    expect(sh.body.data.canTake).toBe(true);
    expect(sh.body.data.lesson).toMatchObject({ mine: true, teacher: { id: tSub.id } });
    expect((await sheet(tokSub, `?date=${OLD_WED}&lessonNo=1`)).status).toBe(404);
    // boshqa dars (fizika) uning emas
    expect((await att(tokSub, { classId: cls.id, lessonNo: 2, items: items() })).status).toBe(403);
    // davomat
    const r = await att(tokSub, { classId: cls.id, lessonNo: 1, items: items() });
    expect(r.status).toBe(200);
    const rec = await AttendanceRecord.findOne({ studentId: s1._id as never });
    expect(rec?.source).toBe('override');
    expect(String(rec?.teacherId)).toBe(tSub.id);
    expect(String(rec?.subjectId)).toBe(math.id);
    // baho: shu dars; boshqa dars raqami / boshqa sana / boshqa fan yopiq
    expect((await grade(tokSub, gradeBody())).status).toBe(200);
    expect(await SubjectGrade.countDocuments({ subjectId: math._id as never })).toBe(1);
    expect((await grade(tokSub, gradeBody({ lessonNo: 2 }))).status).toBeGreaterThanOrEqual(400);
    expect((await grade(tokSub, gradeBody({ date: OLD_WED, lessonNo: 0 }))).status).toBe(403);
    expect((await grade(tokSub, gradeBody({ subjectId: phys.id, lessonNo: 2 }))).status).toBe(403);
  });

  it("o'rinbosarda asl o'qituvchi shu darsga davomat/baho ololmaydi", async () => {
    await override({ lessonNo: 1, type: 'substitute', teacherId: tSub.id });
    expect((await att(tokOrig, { classId: cls.id, lessonNo: 1, items: items() })).status).toBe(404);
    expect((await sheet(tokOrig, '?lessonNo=1')).status).toBe(404);
    expect((await grade(tokOrig, gradeBody())).status).toBe(403);
    expect(await AttendanceRecord.countDocuments({})).toBe(0);
  });

  it('asl o`qituvchi sinf o`qituvchisi bo`lsa, davomatga kirishi saqlanadi, lekin dars o`rinbosarniki', async () => {
    await ClassModel.updateOne({ _id: cls._id as never }, { $addToSet: { teacherIds: tOrig._id } });
    await override({ lessonNo: 1, type: 'substitute', teacherId: tSub.id });
    // sinfga kirish bor, lekin dars boshqa o'qituvchiga biriktirilgan
    expect((await sheet(tokOrig, '?lessonNo=1')).body.data.canTake).toBe(false);
    expect((await att(tokOrig, { classId: cls.id, lessonNo: 1, items: items() })).status).toBe(403);
  });

  it('bekor qilingan dars: davomat 409 (admin), asl o`qituvchi sinfga kira olmaydi; baho olinmaydi', async () => {
    await override({ lessonNo: 1, type: 'cancel' });
    expect((await att(tokOrig, { classId: cls.id, lessonNo: 1, items: items() })).status).toBe(404);
    expect((await att(tokAdm, { classId: cls.id, lessonNo: 1, items: items() })).status).toBe(409);
    expect((await grade(tokAdm, gradeBody())).status).toBe(400);
    const sh = (await sheet(tokAdm, '?lessonNo=1')).body.data;
    expect(sh.lesson).toMatchObject({ cancelled: true });
    expect(sh.canTake).toBe(false);
  });

  it("qo'shimcha (extra) dars: tayinlangan o'qituvchi davomat oladi", async () => {
    expect(
      (await override({ lessonNo: 5, type: 'extra', subjectId: phys.id, teacherId: tSub.id }))
        .status,
    ).toBe(201);
    const r = await att(tokSub, { classId: cls.id, lessonNo: 5, items: items() });
    expect(r.status).toBe(200);
    const rec = await AttendanceRecord.findOne({ studentId: s1._id as never });
    expect(rec?.source).toBe('override');
    expect(String(rec?.subjectId)).toBe(phys.id);
    // fizika o'qituvchisi sinfga kira oladi (2-dars), lekin 5-dars uniki emas
    expect((await att(tokPhys, { classId: cls.id, lessonNo: 5, items: items() })).status).toBe(403);
  });

  it("o'rinbosar jurnalni (fan bo'yicha) ko'rmaydi", async () => {
    await override({ lessonNo: 1, type: 'substitute', teacherId: tSub.id });
    const q = `classId=${cls.id}&subjectId=${math.id}&from=2026-10-12&to=2026-10-17`;
    const r = await request(app).get(`${API}/journal/subject?${q}`).set(bearer(tokSub));
    expect(r.status).toBeGreaterThanOrEqual(403);
  });
});

describe('jurnal: bekor qilingan dars ustuni (haqiqiy override)', () => {
  it('cancel override -> ustun cancelled=true; replace -> yangi fan ustuni', async () => {
    await override({ lessonNo: 1, type: 'cancel' });
    const q = (subjectId: string) =>
      `classId=${cls.id}&subjectId=${subjectId}&from=2026-10-12&to=2026-10-17`;
    const r = await request(app)
      .get(`${API}/journal/subject?${q(math.id)}`)
      .set(bearer(tokAdm));
    expect(r.status).toBe(200);
    expect(
      r.body.data.columns.map((c: { key: string; cancelled: boolean }) => [c.key, c.cancelled]),
    ).toEqual([['2026-10-14#1', true]]);
    // 2-dars fizika -> matematikaga almashtiriladi: matematika jurnalida yangi ustun
    await override({
      lessonNo: 2,
      type: 'replace',
      subjectId: math.id,
      teacherId: tOrig.id,
    });
    const r2 = await request(app)
      .get(`${API}/journal/subject?${q(math.id)}`)
      .set(bearer(tokAdm));
    expect(r2.body.data.columns.map((c: { key: string }) => c.key)).toEqual([
      '2026-10-14#1',
      '2026-10-14#2',
    ]);
    const rp = await request(app)
      .get(`${API}/journal/subject?${q(phys.id)}`)
      .set(bearer(tokAdm));
    expect(rp.body.data.columns).toEqual([]);
    expect(await LessonOverride.countDocuments({})).toBe(2);
  });
});
