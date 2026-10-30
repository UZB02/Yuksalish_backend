import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  AttendanceRecord,
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

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z'; // chorshanba (weekday 3)
const TODAY = '2026-10-14';

let school: Doc;
let year: Doc;
let c5: Doc, c6: Doc;
let s1: Doc, s2: Doc, s3: Doc;
let K: Doc;
let math: Doc, phys: Doc, eng: Doc, art: Doc;
let tMath: Doc, tPhys: Doc, tHome: Doc;
let tokMath: string,
  tokPhys: string,
  tokHome: string,
  tokStranger: string,
  tokAdmin: string,
  root: string;

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
  school = await makeSchool('tt');
  year = await makeYear(school.id);
  tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tPhys = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  tHome = await makeUser({ username: 'thome', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tstr', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'ttadmin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'attendance.take', 'attendance.view', 'attendance.settings'],
  });
  await makeUser({ username: 'ttroot', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [tHome.id, tMath.id], {
    homeroomTeacherId: tHome._id,
  });
  c6 = await makeClass(school.id, year.id, '6-A', [tHome.id]);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  await makeStudent(school.id, c6.id, 'Cholpon Chol');
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  eng = await makeSubject('Ingliz tili');
  art = await makeSubject('Chizmachilik');
  K = await makeStatus('Keldi', 'present', { shortName: 'K', order: 1, isDefault: true });
  await TimetableVersion.create({
    schoolId: school.id,
    academicYearId: year.id,
    classId: c5.id,
    status: 'active',
    validFrom: '2026-09-01',
    activatedAt: new Date(),
    entries: [
      entry(3, 1, math.id, tMath.id),
      entry(3, 2, phys.id, tPhys.id),
      entry(3, 8, eng.id, tMath.id),
    ],
  });
  [tokMath, tokPhys, tokHome, tokStranger, tokAdmin, root] = await Promise.all(
    ['tmath', 'tphys', 'thome', 'tstr', 'ttadmin', 'ttroot'].map(
      async (u) => (await login(u)).token,
    ),
  );
  await setAtt({ mode: 'lesson', lessonsPerDay: 6 });
});

const put = (key: string, values: object | null) =>
  request(app)
    .put(`/api/v1/settings/${key}`)
    .set(bearer(root))
    .send({ scope: 'school', schoolId: school.id, values });
const setAtt = (values: object | null) => put('attendance', values);
const setTt = (values: object | null) => put('timetable', values);
const bulk = (t: string, body: object) =>
  request(app).post('/api/v1/attendance/bulk').set(bearer(t)).send(body);
const items = (...students: Doc[]) => students.map((s) => ({ studentId: s.id, statusId: K.id }));
const sheet = (t: string, cls: Doc, q = '') =>
  request(app).get(`/api/v1/classes/${cls.id}/attendance-sheet${q}`).set(bearer(t));
const today = (t: string) => request(app).get('/api/v1/timetable/me/today').set(bearer(t));

describe('timetable sozlamasi', () => {
  it('standart qiymatlar, tekshiruv va ruxsat', async () => {
    const get = await request(app).get('/api/v1/settings/timetable').set(bearer(tokMath));
    expect(get.status).toBe(200);
    expect(get.body.data.effective).toEqual({
      enforcement: 'suggest',
      homeroomCanTakeAnyLesson: true,
      strictNoTimetable: 'manual',
    });
    expect((await setTt({ enforcement: 'bogus' })).status).toBe(400);
    expect((await setTt({ strictNoTimetable: 'x' })).status).toBe(400);
    expect((await setTt({ enforcement: 'strict', homeroomCanTakeAnyLesson: false })).status).toBe(
      200,
    );
    const after = await request(app).get('/api/v1/settings/timetable').set(bearer(tokMath));
    expect(after.body.data.effective).toMatchObject({
      enforcement: 'strict',
      homeroomCanTakeAnyLesson: false,
    });
    // maktab admini (attendance.settings) o'z maktabi uchun yoza oladi, o'qituvchi yozolmaydi
    const adm = await request(app)
      .put('/api/v1/settings/timetable')
      .set(bearer(tokAdmin))
      .send({ scope: 'school', schoolId: school.id, values: { enforcement: 'off' } });
    expect(adm.status).toBe(200);
    const tch = await request(app)
      .put('/api/v1/settings/timetable')
      .set(bearer(tokMath))
      .send({ scope: 'school', schoolId: school.id, values: { enforcement: 'off' } });
    expect(tch.status).toBe(403);
  });
});

describe('varaq: lesson, lessons, canTake', () => {
  it("jadvaldagi o'qituvchi uchun dars, ro'yxat va canTake", async () => {
    const r = await sheet(tokMath, c5, '?lessonNo=1');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.lesson).toMatchObject({
      lessonNo: 1,
      subject: { id: math.id, name: 'Matematika' },
      teacher: { id: tMath.id },
      mine: true,
      cancelled: false,
    });
    expect(d.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1, 2, 8]);
    expect(d.lessons[1].mine).toBe(false);
    expect(d.canTake).toBe(true);
    expect(d.maxLessonNo).toBe(8);
    expect(d.timetable).toMatchObject({ enforcement: 'suggest', hasTimetable: true });
    expect(d.canOverrideSubject).toBe(false);
    // bo'sh slot
    const empty = (await sheet(tokMath, c5, '?lessonNo=3')).body.data;
    expect(empty.lesson).toBeNull();
    expect(empty.canTake).toBe(false);
    expect(empty.cannotTakeReason).toContain("jadvalda dars yo'q");
  });

  it("boshqa o'qituvchining darsi: ochiladi, lekin canTake=false; admin va sinf rahbari override qila oladi", async () => {
    const other = (await sheet(tokMath, c5, '?lessonNo=2')).body.data;
    expect(other.canTake).toBe(false);
    const adm = (await sheet(tokAdmin, c5, '?lessonNo=2')).body.data;
    expect(adm.canTake).toBe(true);
    expect(adm.canOverrideSubject).toBe(true);
    const home = (await sheet(tokHome, c5, '?lessonNo=2')).body.data;
    expect(home.canTake).toBe(true);
    expect(home.canOverrideSubject).toBe(true);
  });

  it("jadvaldagi o'qituvchi (teacherIds da yo'q) faqat shu kuni sinfni ochadi", async () => {
    expect((await sheet(tokPhys, c5, '?lessonNo=2')).status).toBe(200);
    expect((await sheet(tokPhys, c5, '?date=2026-10-13&lessonNo=1')).status).toBe(404); // dars yo'q kun
    expect((await sheet(tokPhys, c6)).status).toBe(404); // boshqa sinf
    expect((await sheet(tokStranger, c5)).status).toBe(404);
    // allowedClassIds kengaytirilmagan: tarix sahifasi bo'sh
    const list = await request(app).get(`/api/v1/attendance?classId=${c5.id}`).set(bearer(tokPhys));
    expect(list.body.data).toEqual([]);
  });

  it('enforcement=off: jadval ishlatilmaydi', async () => {
    await setTt({ enforcement: 'off' });
    const d = (await sheet(tokMath, c5, '?lessonNo=3')).body.data;
    expect(d.lessons).toEqual([]);
    expect(d.canTake).toBe(true);
    expect((await sheet(tokPhys, c5)).status).toBe(404);
    expect((await sheet(tokMath, c5, '?lessonNo=8')).status).toBe(400);
  });

  it("kunlik rejimda jadval e'tiborga olinmaydi", async () => {
    await setAtt({ mode: 'daily' });
    const d = (await sheet(tokMath, c5)).body.data;
    expect(d.lessons).toEqual([]);
    expect(d.lesson).toBeNull();
    expect(d.canTake).toBe(true);
    expect((await sheet(tokPhys, c5)).status).toBe(404);
  });
});

describe('bulk: aniqlangan dars', () => {
  it('subjectId siz: fan, teacherId va source jadvaldan; audit snapshot', async () => {
    const r = await bulk(tokMath, { classId: c5.id, lessonNo: 1, items: items(s1, s2) });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ created: 2 });
    const rec = await AttendanceRecord.findOne({ studentId: s1._id });
    expect(String(rec?.subjectId)).toBe(math.id);
    expect(String(rec?.teacherId)).toBe(tMath.id);
    expect(rec?.source).toBe('timetable');
    const audit = await AuditLog.findOne({ action: 'attendance.bulk' });
    expect(audit?.after).toMatchObject({
      subjectId: math.id,
      teacherId: tMath.id,
      source: 'timetable',
    });
    const sh = (await sheet(tokMath, c5, '?lessonNo=1')).body.data;
    expect(sh.students[0].record).toMatchObject({ teacherId: tMath.id, source: 'timetable' });
    expect(sh.subjectId).toBe(math.id);
    // jadval keyin o'zgarsa ham yozuv o'zgarmaydi
    await TimetableVersion.updateMany({}, { $set: { 'entries.0.teacherId': tPhys._id } });
    expect(String((await AttendanceRecord.findOne({ studentId: s1._id }))?.teacherId)).toBe(
      tMath.id,
    );
  });

  it("o'z fani bilan yuborsa ham qabul qilinadi", async () => {
    const r = await bulk(tokMath, {
      classId: c5.id,
      lessonNo: 1,
      subjectId: math.id,
      items: items(s1),
    });
    expect(r.status).toBe(200);
  });

  it("teacherIds da bo'lmagan, lekin jadvaldagi o'qituvchi shu kuni olishi mumkin", async () => {
    const r = await bulk(tokPhys, { classId: c5.id, lessonNo: 2, items: items(s1) });
    expect(r.status).toBe(200);
    expect(String((await AttendanceRecord.findOne({}))?.subjectId)).toBe(phys.id);
    // boshqa kun: dars yo'q
    const y = await bulk(tokPhys, {
      classId: c5.id,
      date: '2026-10-13',
      lessonNo: 2,
      items: items(s1),
    });
    expect(y.status).toBe(404);
    // o'z yozuvini PATCH qila oladi
    const rec = await AttendanceRecord.findOne({});
    const p = await request(app)
      .patch(`/api/v1/attendance/${rec?.id}`)
      .set(bearer(tokPhys))
      .send({ note: 'izoh' });
    expect(p.status).toBe(200);
  });

  it("boshqa o'qituvchining darsi: 403", async () => {
    const r = await bulk(tokMath, { classId: c5.id, lessonNo: 2, items: items(s1) });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("boshqa o'qituvchiga");
    expect(await AttendanceRecord.countDocuments()).toBe(0);
  });

  it("mos kelmaydigan fan: o'qituvchi 409; admin va sinf rahbari suggest da manual", async () => {
    const t = await bulk(tokMath, {
      classId: c5.id,
      lessonNo: 1,
      subjectId: art.id,
      items: items(s1),
    });
    expect(t.status).toBe(409);
    expect(t.body.error.message).toContain('Matematika');

    const a = await bulk(tokAdmin, {
      classId: c5.id,
      lessonNo: 1,
      subjectId: art.id,
      items: items(s1),
    });
    expect(a.status).toBe(200);
    let rec = await AttendanceRecord.findOne({ studentId: s1._id });
    expect(String(rec?.subjectId)).toBe(art.id);
    expect(rec?.source).toBe('manual');
    expect(rec?.teacherId).toBeNull();

    const h = await bulk(tokHome, {
      classId: c5.id,
      lessonNo: 2,
      subjectId: art.id,
      items: items(s2),
    });
    expect(h.status).toBe(200);
    rec = await AttendanceRecord.findOne({ studentId: s2._id });
    expect(rec?.source).toBe('manual');
    expect(String(rec?.teacherId)).toBe(tHome.id);
  });

  it("strict: fanni o'zgartirib bo'lmaydi (admin ham), bo'sh slot hamma uchun yopiq", async () => {
    await setTt({ enforcement: 'strict' });
    const a = await bulk(tokAdmin, {
      classId: c5.id,
      lessonNo: 1,
      subjectId: art.id,
      items: items(s1),
    });
    expect(a.status).toBe(409);
    const ok = await bulk(tokAdmin, { classId: c5.id, lessonNo: 1, items: items(s1) });
    expect(ok.status).toBe(200);
    const sh = (await sheet(tokAdmin, c5, '?lessonNo=1')).body.data;
    expect(sh.canOverrideSubject).toBe(false);
    const empty = await bulk(tokAdmin, {
      classId: c5.id,
      lessonNo: 3,
      subjectId: art.id,
      items: items(s1),
    });
    expect(empty.status).toBe(403);
    expect(empty.body.error.message).toContain("qo'shimcha dars");
    const hEmpty = await bulk(tokHome, {
      classId: c5.id,
      lessonNo: 3,
      subjectId: art.id,
      items: items(s1),
    });
    expect(hEmpty.status).toBe(403);
  });

  it("bo'sh slot (suggest): o'qituvchi 403, admin/sinf rahbari qo'lda fan bilan", async () => {
    const t = await bulk(tokMath, {
      classId: c5.id,
      lessonNo: 3,
      subjectId: math.id,
      items: items(s1),
    });
    expect(t.status).toBe(403);
    expect(t.body.error.message).toBe("Bu soatda jadvalda dars yo'q");
    const noSubject = await bulk(tokAdmin, { classId: c5.id, lessonNo: 3, items: items(s1) });
    expect(noSubject.status).toBe(400);
    const a = await bulk(tokAdmin, {
      classId: c5.id,
      lessonNo: 3,
      subjectId: art.id,
      items: items(s1),
    });
    expect(a.status).toBe(200);
    const h = await bulk(tokHome, {
      classId: c5.id,
      lessonNo: 4,
      subjectId: art.id,
      items: items(s1),
    });
    expect(h.status).toBe(200);
  });

  it("sinf rahbari bayrog'i o'chiq bo'lsa boshqa o'qituvchi darsiga olmaydi", async () => {
    await setTt({ homeroomCanTakeAnyLesson: false });
    expect((await bulk(tokHome, { classId: c5.id, lessonNo: 2, items: items(s1) })).status).toBe(
      403,
    );
    expect(
      (
        await bulk(tokHome, {
          classId: c5.id,
          lessonNo: 3,
          subjectId: art.id,
          items: items(s1),
        })
      ).status,
    ).toBe(403);
    expect((await sheet(tokHome, c5, '?lessonNo=2')).body.data.canTake).toBe(false);
    await setTt({ homeroomCanTakeAnyLesson: true });
    expect((await bulk(tokHome, { classId: c5.id, lessonNo: 2, items: items(s1) })).status).toBe(
      200,
    );
  });

  it("jadvalsiz sinf: qo'lda oqim o'zgarmaydi; strict+block da yopiladi", async () => {
    const st6 = await makeStudent(school.id, c6.id, 'Yangi Talaba');
    const miss = await bulk(tokHome, { classId: c6.id, lessonNo: 1, items: items(st6) });
    expect(miss.status).toBe(400); // fan majburiy
    const stu = (await sheet(tokHome, c6)).body.data;
    expect(stu.lessons).toEqual([]);
    expect(stu.canTake).toBe(true);
    expect(stu.timetable.hasTimetable).toBe(false);

    await setTt({ enforcement: 'strict' });
    expect((await sheet(tokHome, c6)).body.data.canTake).toBe(true); // strictNoTimetable=manual
    await setTt({ enforcement: 'strict', strictNoTimetable: 'block' });
    expect((await sheet(tokAdmin, c6)).body.data.canTake).toBe(false);
    const b = await bulk(tokAdmin, {
      classId: c6.id,
      lessonNo: 1,
      subjectId: math.id,
      items: items(st6),
    });
    expect(b.status).toBe(403);
    await setTt({ enforcement: 'suggest' });
    const ok = await bulk(tokAdmin, {
      classId: c6.id,
      lessonNo: 1,
      subjectId: math.id,
      items: items(st6),
    });
    expect(ok.status).toBe(200);
    const rec = await AttendanceRecord.findOne({ studentId: st6._id });
    expect(rec?.source).toBe('manual');
  });

  it('bir dars = bir fan saqlanadi', async () => {
    await bulk(tokAdmin, { classId: c5.id, lessonNo: 1, subjectId: art.id, items: items(s1) });
    const r = await bulk(tokMath, { classId: c5.id, lessonNo: 1, items: items(s2) });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('Chizmachilik');
  });
});

describe('dars raqami chegarasi', () => {
  it("jadvalda 8-dars bor: lessonsPerDay=6 bo'lsa ham ishlaydi; jadvalda yo'q 7 rad etiladi", async () => {
    const r8 = await bulk(tokMath, { classId: c5.id, lessonNo: 8, items: items(s1) });
    expect(r8.status).toBe(200);
    expect(String((await AttendanceRecord.findOne({ lessonNo: 8 }))?.subjectId)).toBe(eng.id);
    const r7 = await bulk(tokAdmin, {
      classId: c5.id,
      lessonNo: 9,
      subjectId: art.id,
      items: items(s1),
    });
    expect(r7.status).toBe(400);
    expect(r7.body.error.details[0].message).toContain('1 dan 8 gacha');
    // jadvalsiz sinfda lessonsPerDay chegarasi
    const st6 = await makeStudent(school.id, c6.id, 'Yangi Talaba');
    const r6 = await bulk(tokAdmin, {
      classId: c6.id,
      lessonNo: 7,
      subjectId: art.id,
      items: items(st6),
    });
    expect(r6.status).toBe(400);
  });

  it('bugungi progress 8 ta birlikni hisoblaydi; tarix filtri 8-darsni topadi', async () => {
    await bulk(tokMath, { classId: c5.id, lessonNo: 8, items: items(s1, s2, s3) });
    const p = await request(app).get('/api/v1/attendance/today-progress').set(bearer(tokAdmin));
    const row = p.body.data.find((x: { classId: string }) => x.classId === c5.id);
    expect(row).toMatchObject({ totalUnits: 8, markedUnits: 1 });
    const row6 = p.body.data.find((x: { classId: string }) => x.classId === c6.id);
    expect(row6.totalUnits).toBe(6);
    const list = await request(app).get('/api/v1/attendance?lessonNo=8').set(bearer(tokAdmin));
    expect(list.body.data).toHaveLength(3);
  });
});

describe('GET /timetable/me/today', () => {
  it('darslar tartibi va davomat holati', async () => {
    await bulk(tokMath, { classId: c5.id, lessonNo: 1, items: items(s1, s2, s3) });
    await bulk(tokMath, { classId: c5.id, lessonNo: 8, items: items(s1) });
    const r = await today(tokMath);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ date: TODAY, working: true, hasTimetable: true });
    const l = r.body.data.lessons;
    expect(l.map((x: { lessonNo: number }) => x.lessonNo)).toEqual([1, 8]);
    expect(l[0]).toMatchObject({
      class: { id: c5.id, name: '5-A' },
      subject: { name: 'Matematika' },
      status: 'taken',
      substitute: false,
      markedStudents: 3,
      totalStudents: 3,
    });
    expect(l[1]).toMatchObject({ status: 'partial', markedStudents: 1 });
    const p = await today(tokPhys);
    expect(p.body.data.lessons).toHaveLength(1);
    expect(p.body.data.lessons[0]).toMatchObject({ lessonNo: 2, status: 'none' });
  });

  it("darsi bo'lmagan va jadvalsiz o'qituvchi, dam olish kuni", async () => {
    const r = await today(tokStranger);
    expect(r.body.data).toMatchObject({ hasTimetable: false, lessons: [] });
    await setAtt({ mode: 'lesson', lessonsPerDay: 6, workingWeekdays: [1, 2, 4, 5, 6] });
    const off = await today(tokMath);
    expect(off.body.data).toMatchObject({ working: false, lessons: [] });
  });
});
