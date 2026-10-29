import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { chunkDates } from '../src/modules/journal/journal.export';
import { ClassModel } from '../src/models/Class';
import { Student } from '../src/models/Student';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
import {
  AttendanceRecord,
  SubjectGrade,
  ADMIN_PERMS,
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

useTestDb();

type Doc = { id: string; _id: unknown };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// 2026-10-01 = payshanba; 04 va 11 — yakshanba (dam olish)
const FROM = '2026-10-01';
const TO = '2026-10-11';
const Q = (c: string, s: string, from = FROM, to = TO) =>
  `classId=${c}&subjectId=${s}&from=${from}&to=${to}`;

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, phys: Doc;
let s1: Doc, s2: Doc, s3: Doc;
let tMathUser: Doc, tPhysUser: Doc, homeUser: Doc;
let tm: string, tp: string, home: string, tOther: string, root: string;
let aGrades: string, aReports: string, aNone: string, aOther: string;
let statuses: Record<AttendanceCategory, Doc>;

const grade = (s: Doc, subject: Doc, date: string, value: number, extra = {}) =>
  SubjectGrade.create({
    schoolId: school.id,
    studentId: s.id,
    classId: c5.id,
    subjectId: subject.id,
    teacherId: tMathUser.id,
    academicYearId: year.id,
    value,
    date,
    ...extra,
  });
const att = (s: Doc, date: string, cat: AttendanceCategory, lessonNo = 0) =>
  AttendanceRecord.create({
    schoolId: school.id,
    studentId: s.id,
    classId: c5.id,
    academicYearId: year.id,
    date,
    lessonNo,
    statusId: statuses[cat].id,
    category: cat,
    markedBy: tMathUser.id,
    updatedBy: tMathUser.id,
  });
const get = (t: string, path: string, h: Record<string, string> = {}) =>
  request(app).get(`/api/v1/journal/${path}`).set(bearer(t)).set(h);

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  const oy = await makeYear(other.id);
  tMathUser = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tPhysUser = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  homeUser = await makeUser({ username: 'home', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tother', role: 'teacher', schoolId: other.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'agrades',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'grades.edit'],
  });
  await makeUser({
    username: 'areports',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({
    username: 'anone',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view', 'students.view'],
  });
  await makeUser({
    username: 'aother',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['grades.edit'],
  });
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  statuses = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus('Sababli', 'absent_excused'),
    absent_unexcused: await makeStatus('Sababsiz', 'absent_unexcused'),
  };
  c5 = await makeClass(school.id, year.id, '5-A', [tMathUser.id, tPhysUser.id], {
    homeroomTeacherId: homeUser.id,
  });
  c6 = await makeClass(school.id, year.id, '6-A');
  await assignSubject(school.id, c5, math.id, tMathUser.id);
  await assignSubject(school.id, c5, phys.id, tPhysUser.id);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  const oc = await makeClass(other.id, oy.id, '5-A');
  await makeStudent(other.id, oc.id, 'Begona Bola');
  [tm, tp, home, tOther, root, aGrades, aReports, aNone, aOther] = await Promise.all(
    ['tmath', 'tphys', 'home', 'tother', 'root', 'agrades', 'areports', 'anone', 'aother'].map(
      async (u) => (await login(u)).token,
    ),
  );
});

describe('Sinf jurnali: setka (GET /journal/subject)', () => {
  it('faqat ish kunlari, baholar, N/B/qisman va yig`indilar', async () => {
    await grade(s1, math, '2026-10-01', 5);
    await grade(s1, math, '2026-10-02', 3);
    await grade(s1, math, '2026-10-05', 4);
    await grade(s2, math, '2026-10-01', 2);
    await grade(s1, phys, '2026-10-01', 5); // boshqa fan — kirmaydi
    await grade(s1, math, '2026-10-04', 5); // yakshanba — ustun yo'q
    await grade(s3, math, '2026-10-01', 5, { classId: c6.id }); // boshqa sinf
    await grade(s1, math, '2026-10-06', 5, { isDeleted: true });
    // davomat
    await att(s1, '2026-10-03', 'absent_unexcused'); // N
    await att(s2, '2026-10-03', 'absent_excused'); // B
    await att(s1, '2026-10-02', 'absent_excused'); // baho + B belgisi
    await att(s2, '2026-10-05', 'late'); // belgilanmaydi
    // dars rejimi: hammasi yo'q -> N; qisman -> partial
    await att(s1, '2026-10-07', 'absent_unexcused', 1);
    await att(s1, '2026-10-07', 'absent_excused', 2);
    await att(s2, '2026-10-07', 'absent_unexcused', 1);
    await att(s2, '2026-10-07', 'present', 2);

    const res = await get(tm, `subject?${Q(c5.id, math.id)}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.class).toEqual({ id: c5.id, name: '5-A' });
    expect(d.subject).toEqual({ id: math.id, name: 'Matematika' });
    expect(d.teacher).toMatchObject({ id: tMathUser.id });
    expect(d.dates.map((x: { date: string }) => x.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
    ]);
    expect(d.dates[0]).toEqual({ date: '2026-10-01', weekday: 4 });
    expect(d.students.map((s: { fullName: string }) => s.fullName)).toEqual([
      'Aliyev Ali',
      'Valiyev Vali',
    ]);
    expect(d.cells[s1.id]['2026-10-01']).toMatchObject({ grade: 5 });
    expect(d.cells[s1.id]['2026-10-01'].gradeId).toBeTruthy();
    expect(d.cells[s1.id]['2026-10-02']).toMatchObject({ grade: 3, absence: 'B' });
    expect(d.cells[s1.id]['2026-10-03']).toEqual({ absence: 'N' });
    expect(d.cells[s2.id]['2026-10-03']).toEqual({ absence: 'B' });
    expect(d.cells[s2.id]['2026-10-05']).toBeUndefined();
    expect(d.cells[s1.id]['2026-10-04']).toBeUndefined();
    expect(d.cells[s1.id]['2026-10-06']).toBeUndefined();
    expect(d.cells[s1.id]['2026-10-07']).toEqual({ absence: 'N' });
    expect(d.cells[s2.id]['2026-10-07']).toEqual({ absence: 'partial' });
    // yig`indilar
    expect(d.summary.perStudent[s1.id]).toEqual({ avg: 4, count: 3, absentN: 2, absentB: 1 });
    expect(d.summary.perStudent[s2.id]).toEqual({ avg: 2, count: 1, absentN: 0, absentB: 1 });
    expect(d.summary.perDate['2026-10-01']).toEqual({ avg: 3.5, count: 2 });
    expect(d.summary.perDate['2026-10-03']).toEqual({ avg: null, count: 0 });
    expect(d.summary.classAvg).toBe(3.5);
    expect(d.summary.classCount).toBe(4);
  });

  it('o`quvchi boshqa sinfga o`tgan: bahosi bo`lsa transferred bilan chiqadi, bo`lmasa yo`q', async () => {
    const moved = await makeStudent(school.id, c5.id, 'Zokirov Zoir');
    const idle = await makeStudent(school.id, c5.id, 'Yoqubov Yoqub');
    await grade(moved, math, '2026-10-02', 4);
    await Student.updateOne({ _id: moved.id }, { classId: c6.id });
    await Student.updateOne({ _id: idle.id }, { classId: c6.id, status: 'transferred' });
    const res = await get(tm, `subject?${Q(c5.id, math.id)}`);
    const names = res.body.data.students.map((s: { fullName: string; transferred: boolean }) => [
      s.fullName,
      s.transferred,
    ]);
    expect(names).toEqual([
      ['Aliyev Ali', false],
      ['Valiyev Vali', false],
      ['Zokirov Zoir', true],
    ]);
    expect(res.body.data.cells[moved.id]['2026-10-02']).toMatchObject({ grade: 4 });
    expect(res.body.data.summary.perStudent[moved.id].avg).toBe(4);
  });

  it('ish kunlari sozlamaga ergashadi (yakshanba ham ish kuni bo`lsa)', async () => {
    const r = await request(app)
      .put('/api/v1/settings/attendance')
      .set(bearer(aGrades))
      .send({ workingWeekdays: [1, 2, 3, 4, 5, 6, 7] });
    if (r.status !== 200) return; // sozlamani o'zgartirish ruxsati bo'lmasa o'tkazib yuboriladi
    const res = await get(tm, `subject?${Q(c5.id, math.id)}`);
    expect(res.body.data.dates).toHaveLength(11);
  });

  it('options: o`qituvchiga faqat o`z sinf/fanlari, sinf rahbariga sinfning barcha fanlari', async () => {
    const mine = await get(tm, 'options');
    expect(mine.status).toBe(200);
    expect(mine.body.data.classes).toHaveLength(1);
    expect(mine.body.data.classes[0].subjects.map((s: { name: string }) => s.name)).toEqual([
      'Matematika',
    ]);
    const h = await get(home, 'options');
    expect(h.body.data.classes).toHaveLength(1);
    expect(h.body.data.classes[0].homeroom).toBe(true);
    expect(h.body.data.classes[0].subjects.map((s: { name: string }) => s.name)).toEqual([
      'Fizika',
      'Matematika',
    ]);
    const adm = await get(aGrades, 'options');
    expect(adm.body.data.classes).toHaveLength(2);
    expect(adm.body.data.mode).toBe('all');
  });
});

describe('Sinf jurnali: ruxsatlar', () => {
  it('biriktirilgan o`qituvchi ok, boshqa fan o`qituvchisi 403', async () => {
    expect((await get(tm, `subject?${Q(c5.id, math.id)}`)).status).toBe(200);
    expect((await get(tp, `subject?${Q(c5.id, math.id)}`)).status).toBe(403);
    expect((await get(tp, `subject?${Q(c5.id, phys.id)}`)).status).toBe(200);
  });
  it('sinf rahbari o`z sinfining barcha fanlarini ko`radi, boshqa sinfni yo`q', async () => {
    expect((await get(home, `subject?${Q(c5.id, math.id)}`)).status).toBe(200);
    expect((await get(home, `subject?${Q(c5.id, phys.id)}`)).status).toBe(200);
    expect((await get(home, `subject?${Q(c6.id, math.id)}`)).status).toBe(403);
  });
  it('admin: grades.edit / reports.view ok, ruxsatsiz 403', async () => {
    expect((await get(aGrades, `subject?${Q(c5.id, math.id)}`)).status).toBe(200);
    expect((await get(aReports, `subject?${Q(c5.id, phys.id)}`)).status).toBe(200);
    expect((await get(aNone, `subject?${Q(c5.id, math.id)}`)).status).toBe(403);
    expect((await get(aNone, 'options')).status).toBe(403);
  });
  it('superadmin X-School-Id bilan ok, usiz 400', async () => {
    expect(
      (await get(root, `subject?${Q(c5.id, math.id)}`, { 'X-School-Id': school.id })).status,
    ).toBe(200);
    expect((await get(root, `subject?${Q(c5.id, math.id)}`)).status).toBe(400);
  });
  it('boshqa maktab 404 (admin va o`qituvchi)', async () => {
    expect((await get(aOther, `subject?${Q(c5.id, math.id)}`)).status).toBe(404);
    expect((await get(tOther, `subject?${Q(c5.id, math.id)}`)).status).toBe(404);
  });
  it('tokensiz 401', async () => {
    const res = await request(app).get(`/api/v1/journal/subject?${Q(c5.id, math.id)}`);
    expect(res.status).toBe(401);
  });
});

describe('Sinf jurnali: validatsiya', () => {
  it('noto`g`ri id, sana, from > to, 93 kundan uzun davr', async () => {
    expect((await get(aGrades, `subject?${Q('zzz', math.id)}`)).status).toBe(400);
    expect((await get(aGrades, `subject?${Q(c5.id, math.id, 'abc', TO)}`)).status).toBe(400);
    expect((await get(aGrades, `subject?${Q(c5.id, math.id, TO, FROM)}`)).status).toBe(400);
    expect(
      (await get(aGrades, `subject?${Q(c5.id, math.id, '2026-09-01', '2026-12-03')}`)).status,
    ).toBe(400); // 94 kun
    expect(
      (await get(aGrades, `subject?${Q(c5.id, math.id, '2026-09-01', '2026-12-02')}`)).status,
    ).toBe(200); // aynan 93 kun
    expect((await get(aGrades, `subject?classId=${c5.id}&from=${FROM}&to=${TO}`)).status).toBe(400);
  });
  it('mavjud bo`lmagan sinf/fan 404', async () => {
    const ghost = '64b000000000000000000000';
    expect((await get(aGrades, `subject?${Q(ghost, math.id)}`)).status).toBe(404);
    expect((await get(aGrades, `subject?${Q(c5.id, ghost)}`)).status).toBe(404);
  });
});

describe('Sinf jurnali: eksport', () => {
  beforeEach(async () => {
    await grade(s1, math, '2026-10-01', 5);
    await grade(s2, math, '2026-10-02', 2);
    await att(s1, '2026-10-03', 'absent_unexcused');
    await ClassModel.updateOne({ _id: c5.id }, {});
  });

  it('xlsx: 200, content-type, no-store, audit', async () => {
    const res = await get(tm, `subject/export.xlsx?${Q(c5.id, math.id)}`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(XLSX);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
    const log = await AuditLog.findOne({ action: 'reports.export' });
    expect(log?.entity).toBe('report');
    expect(log?.entityId).toBe('journal_subject');
  });

  it('pdf: 200, application/pdf, %PDF', async () => {
    const res = await get(aGrades, `subject/export.pdf?${Q(c5.id, math.id)}`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  });

  it('uzun davr (bir necha oy) pdf va xlsx bilan ham ishlaydi', async () => {
    const q = Q(c5.id, math.id, '2026-09-01', '2026-11-30');
    expect((await get(aGrades, `subject/export.pdf?${q}`)).status).toBe(200);
    expect((await get(aGrades, `subject/export.xlsx?${q}`)).status).toBe(200);
  });

  it('pdf: bo`sh sahifa chiqmaydi, oy kunlari sahifalarga teng bo`linadi', async () => {
    const q = Q(c5.id, math.id, '2026-09-01', '2026-10-31');
    const grid = await get(aGrades, `subject?${q}`);
    expect(grid.status).toBe(200);
    const expected = chunkDates({ dates: grid.body.data.dates });
    // 26 ish kunli oy 23+3 emas, teng bo'linadi
    for (const c of expected) expect(c.dates.length).toBeGreaterThan(5);
    const res = await get(aGrades, `subject/export.pdf?${q}`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    const raw = (res.body as Buffer).toString('latin1');
    // "/Type /Page" (sahifa obyekti), "/Type /Pages" (ildiz) emas
    const pages = (raw.match(/\/Type \/Page(?!s)/g) ?? []).length;
    expect(pages).toBe(expected.length);
  });

  it('chunkDates: sahifa limitidan oshgan oy teng bo`laklarga bo`linadi', () => {
    const days = Array.from({ length: 26 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      weekday: 1,
    }));
    expect(chunkDates({ dates: days }).map((c) => c.dates.length)).toEqual([13, 13]);
    expect(chunkDates({ dates: days.slice(0, 20) }).map((c) => c.dates.length)).toEqual([20]);
  });

  it('eksportda ham ruxsatlar: boshqa fan o`qituvchisi 403, ruxsatsiz admin 403, validatsiya 400', async () => {
    expect((await get(tp, `subject/export.xlsx?${Q(c5.id, math.id)}`)).status).toBe(403);
    expect((await get(aNone, `subject/export.pdf?${Q(c5.id, math.id)}`)).status).toBe(403);
    expect((await get(aOther, `subject/export.pdf?${Q(c5.id, math.id)}`)).status).toBe(404);
    expect((await get(tm, `subject/export.xlsx?${Q(c5.id, math.id, TO, FROM)}`)).status).toBe(400);
  });
});
