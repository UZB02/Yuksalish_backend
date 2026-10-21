import { ObjectId } from 'mongodb';
import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Student } from '../src/models/Student';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
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
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId; updateOne: (u: object) => PromiseLike<unknown> };
const NOW = '2026-10-14T07:00:00Z'; // Toshkent: chorshanba 2026-10-14
const setNow = (iso = NOW) => clock.set(() => new Date(iso));

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc;
let s1: Doc, s2: Doc, s3: Doc, s4: Doc; // s1, s2, s3 — 5-A; s4 — 6-A
let K: Doc, Ke: Doc, S: Doc, Y: Doc, Eski: Doc;
let teacher1: Doc;
let t1: string,
  t2: string,
  t3: string,
  taker: string,
  editor: string,
  viewer: string,
  none: string,
  admin: string,
  root: string;

beforeEach(async () => {
  setNow();
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  teacher1 = await makeUser({
    username: 'teacher1',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  const teacher2 = await makeUser({ username: 'teacher2', role: 'teacher', schoolId: school.id });
  const teacher3 = await makeUser({ username: 'teacher3', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'taker',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['attendance.take'],
  });
  await makeUser({
    username: 'editor',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['attendance.take', 'attendance.edit', 'attendance.view'],
  });
  await makeUser({
    username: 'viewer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['attendance.view'],
  });
  await makeUser({
    username: 'none',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'attendance.take', 'attendance.view'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [teacher1.id, teacher3.id]);
  c6 = await makeClass(school.id, year.id, '6-A', [teacher2.id]);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali', { studentCode: 'A-1' });
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  s4 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  K = await makeStatus('Keldi', 'present', { shortName: 'K', order: 1, isDefault: true });
  Ke = await makeStatus('Kechikdi', 'late', { shortName: 'Ke', order: 2, color: '#EAB308' });
  S = await makeStatus("Sababli yo'q", 'absent_excused', { shortName: 'S', order: 3 });
  Y = await makeStatus("Sababsiz yo'q", 'absent_unexcused', { shortName: 'Y', order: 4 });
  Eski = await makeStatus('Eski holat', 'present', { shortName: 'E', order: 5, isActive: false });
  [t1, t2, t3, taker, editor, viewer, none, admin, root] = await Promise.all(
    ['teacher1', 'teacher2', 'teacher3', 'taker', 'editor', 'viewer', 'none', 'admin', 'root'].map(
      async (u) => (await login(u)).token,
    ),
  );
});

const bulk = (t: string, body: object, h: Record<string, string> = {}) =>
  request(app).post('/api/v1/attendance/bulk').set(bearer(t)).set(h).send(body);
const mark = (t: string, classId: string, items: object[], extra: object = {}) =>
  bulk(t, { classId, items, ...extra });
const it_ = (student: Doc, status: Doc, extra: object = {}) => ({
  studentId: student.id,
  statusId: status.id,
  ...extra,
});
const sheet = (t: string, id: string, q = '', h: Record<string, string> = {}) =>
  request(app).get(`/api/v1/classes/${id}/attendance-sheet${q}`).set(bearer(t)).set(h);
const setAtt = (values: object | null, scope: 'global' | 'school' = 'school') =>
  request(app)
    .put('/api/v1/settings/attendance')
    .set(bearer(root))
    .send({ scope, schoolId: scope === 'school' ? school.id : undefined, values });
const ageRec = (id: string, hours: number) =>
  AttendanceRecord.collection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { createdAt: new Date(new Date(NOW).getTime() - hours * 3_600_000) } },
  );

/** Yozuvni to'g'ridan-to'g'ri yaratadi (kategoriya holatdan) */
const rec = (
  student: Doc,
  cls: Doc,
  date: string,
  status: Doc & { category?: string },
  lessonNo = 0,
  by: Doc = teacher1,
) =>
  AttendanceRecord.create({
    schoolId: school.id,
    studentId: student._id,
    classId: cls._id,
    academicYearId: year._id,
    date,
    lessonNo,
    statusId: status._id,
    category: (status as unknown as { category: AttendanceCategory }).category,
    markedBy: by._id,
    updatedBy: by._id,
  });

describe('Davomat olish (bulk) va varaq', () => {
  it('yaratadi, upsert qiladi; varaq tarkibi, tartib, xulosa, audit', async () => {
    const res = await mark(t1, c5.id, [
      it_(s1, K),
      it_(s2, Ke, { minutesLate: 10, note: "  yo'lda qoldi " }),
      it_(s3, S, { note: 'kasal' }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ created: 3, updated: 0, failed: [] });
    expect(await AuditLog.countDocuments({ action: 'attendance.bulk' })).toBe(1);

    const sh = (await sheet(t1, c5.id)).body.data;
    expect(sh).toMatchObject({
      class: { id: c5.id, name: '5-A' },
      date: '2026-10-14',
      mode: 'daily',
      lessonNo: null,
      lessonsPerDay: 6,
      isWorkingDay: true,
      settings: { mode: 'daily', editWindowHours: 24 },
      summary: { total: 3, marked: 3, present: 1, late: 1, absentExcused: 1, absentUnexcused: 0 },
    });
    expect(sh.statuses.map((x: { name: string }) => x.name)).toEqual([
      'Keldi',
      'Kechikdi',
      "Sababli yo'q",
      "Sababsiz yo'q",
    ]); // nofaol yo'q
    expect(sh.students.map((x: { fullName: string }) => x.fullName)).toEqual([
      'Aliyev Ali',
      'Bekov Bek',
      'Valiyev Vali',
    ]);
    expect(sh.students[0]).toMatchObject({ studentId: s1.id, studentCode: 'A-1' });
    const late = sh.students.find((x: { studentId: string }) => x.studentId === s2.id).record;
    expect(late).toMatchObject({
      studentId: s2.id,
      student: { fullName: 'Valiyev Vali' },
      classId: c5.id,
      class: { name: '5-A' },
      academicYearId: year.id,
      date: '2026-10-14',
      lessonNo: 0,
      statusId: Ke.id,
      status: { name: 'Kechikdi', shortName: 'Ke', color: '#EAB308', category: 'late' },
      minutesLate: 10,
      note: "yo'lda qoldi",
      markedBy: { id: teacher1.id, fullName: 'Test teacher1' },
      updatedBy: { id: teacher1.id },
      editable: true,
    });

    // Upsert: s1 -> Sababsiz yo'q, s3 o'zgarishsiz yangilanadi
    const again = await mark(t1, c5.id, [it_(s1, Y), it_(s3, S, { note: 'boshqa sabab' })]);
    expect(again.body.data).toEqual({ created: 0, updated: 2, failed: [] });
    const rec1 = (await sheet(t1, c5.id)).body.data.students[0].record;
    expect(rec1).toMatchObject({
      status: { category: 'absent_unexcused' },
      id: expect.any(String),
    });
    expect(await AttendanceRecord.countDocuments({ schoolId: school.id, isDeleted: false })).toBe(
      3,
    );
  });

  it("sana va dars raqami qoidalari (butun so'rov 400)", async () => {
    const err = async (extra: object, path: string) => {
      const r = await mark(t1, c5.id, [it_(s1, K)], extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    };
    await err({ date: '2026-10-15' }, 'date'); // kelajak
    await err({ date: '2026-10-10' }, 'date'); // backdateDays=3 dan eski
    await err({ date: '2026-10-11' }, 'date'); // yakshanba — dam olish kuni
    await err({ date: '14.10.2026' }, 'date');
    await err({ lessonNo: 2 }, 'lessonNo'); // kunlik rejimda dars raqami berilmaydi
    expect((await mark(t1, c5.id, [it_(s1, K)], { date: '2026-10-12', lessonNo: 0 })).status).toBe(
      200,
    );

    // Ish kunlari sozlamasi
    await setAtt({ workingWeekdays: [1, 2, 3] });
    await err({ date: '2026-10-15' }, 'date');
    expect((await mark(t1, c5.id, [it_(s2, K)], { date: '2026-10-13' })).status).toBe(200);
    await setAtt({ workingWeekdays: [1, 2, 4, 5, 6, 7] });
    await err({ date: '2026-10-14' }, 'date'); // chorshanba endi dam olish kuni
    expect((await mark(t1, c5.id, [it_(s3, K)], { date: '2026-10-11' })).status).toBe(200); // yakshanba ish kuni

    // backdateDays sozlamasi
    await setAtt({ backdateDays: 0 });
    await err({ date: '2026-10-13' }, 'date');
    await setAtt({ backdateDays: 10 });
    const foreign = await mark(t1, c5.id, [it_(s4, K)], { date: '2026-10-05' });
    expect(foreign.status).toBe(200);
    expect(foreign.body.data.failed[0]).toMatchObject({ studentId: s4.id, code: 'NOT_FOUND' });
  });

  it('dars rejimi: lessonNo majburiy va 1..lessonsPerDay; har dars alohida; sheet lessonNo', async () => {
    await setAtt({ mode: 'lesson', lessonsPerDay: 3 });
    const err = async (extra: object) => {
      const r = await mark(t1, c5.id, [it_(s1, K)], extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body.error.details.map((d: { path: string }) => d.path)).toContain('lessonNo');
    };
    await err({});
    await err({ lessonNo: 0 });
    await err({ lessonNo: 4 });
    expect(
      (await mark(t1, c5.id, [it_(s1, K), it_(s2, Ke)], { lessonNo: 1 })).body.data.created,
    ).toBe(2);
    expect(
      (await mark(t1, c5.id, [it_(s1, S, { note: 'x' })], { lessonNo: 2 })).body.data.created,
    ).toBe(1);

    const l1 = (await sheet(t1, c5.id)).body.data; // lessonNo default 1
    expect(l1).toMatchObject({
      mode: 'lesson',
      lessonNo: 1,
      lessonsPerDay: 3,
      summary: { marked: 2, present: 1, late: 1 },
    });
    const l2 = (await sheet(t1, c5.id, '?lessonNo=2')).body.data;
    expect(l2).toMatchObject({ lessonNo: 2, summary: { marked: 1, absentExcused: 1 } });
    expect((await sheet(t1, c5.id, '?lessonNo=3')).body.data.summary.marked).toBe(0);
    expect((await sheet(t1, c5.id, '?lessonNo=9')).status).toBe(400);
    expect(await AttendanceRecord.countDocuments({ lessonNo: { $gt: 0 } })).toBe(3);
  });

  it("element qoidalari: holat, kechikish daqiqasi, izoh majburiyligi, takror, begona o'quvchi (qisman muvaffaqiyat)", async () => {
    await setAtt({ noteRequiredCategories: ['absent_excused'] });
    const res = await mark(t1, c5.id, [
      it_(s1, K), // yaxshi
      it_(s2, K, { minutesLate: 5 }), // daqiqa faqat late bilan
      it_(s3, Ke, { minutesLate: 0 }), // 1..600
      it_(s3, Ke, { minutesLate: 601 }), // takror (s3 allaqachon ko'rilgan)
      it_(s4, K), // boshqa sinf
      it_(s2, S), // takror emas? s2 oldin ko'rilgan -> CONFLICT
      { studentId: s1.id, statusId: K.id }, // s1 takror
      { studentId: '64b64b64b64b64b64b64b64b', statusId: K.id }, // yo'q o'quvchi
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    const failed = res.body.data.failed.map((f: { studentId: string; code: string }) => [
      f.studentId,
      f.code,
    ]);
    expect(failed).toEqual([
      [s2.id, 'VALIDATION_ERROR'],
      [s3.id, 'VALIDATION_ERROR'],
      [s3.id, 'CONFLICT'],
      [s4.id, 'NOT_FOUND'],
      [s2.id, 'CONFLICT'],
      [s1.id, 'CONFLICT'],
      ['64b64b64b64b64b64b64b64b', 'NOT_FOUND'],
    ]);

    const next = await mark(t1, c5.id, [
      it_(s2, S), // izoh majburiy
      it_(s3, Eski), // nofaol holat
      it_(s3, { id: '64b64b64b64b64b64b64b64b' } as Doc), // noma'lum holat
    ]);
    expect(next.body.data.created).toBe(0);
    expect(next.body.data.failed.map((f: { code: string }) => f.code)).toEqual([
      'VALIDATION_ERROR',
      'VALIDATION_ERROR',
      'CONFLICT',
    ]);
    expect(next.body.data.failed[0].message).toMatch(/izoh/i);
    expect(
      (await mark(t1, c5.id, [it_(s2, S, { note: 'kasal' }), it_(s3, Ke, { minutesLate: 600 })]))
        .body.data.created,
    ).toBe(2);

    // Tuzilma xatolari 400
    expect((await mark(t1, c5.id, [])).status).toBe(400);
    expect((await mark(t1, c5.id, [{ studentId: s1.id }])).status).toBe(400);
    expect((await mark(t1, c5.id, [it_(s1, K, { note: 'x'.repeat(301) })])).status).toBe(400);
    const many = Array.from({ length: 201 }, () => it_(s1, K));
    expect((await mark(t1, c5.id, many)).status).toBe(400);
  });

  it("faol bo'lmagan o'quvchi, arxivlangan sinf va faol bo'lmagan yil", async () => {
    await Student.updateOne({ _id: s3._id }, { status: 'transferred' });
    const r = await mark(t1, c5.id, [it_(s3, K), it_(s1, K)]);
    expect(r.body.data.created).toBe(1);
    expect(r.body.data.failed[0]).toMatchObject({ studentId: s3.id, code: 'VALIDATION_ERROR' });
    expect((await sheet(t1, c5.id)).body.data.students).toHaveLength(2); // faqat faol o'quvchilar

    await c5.updateOne({ isArchived: true });
    expect((await mark(t1, c5.id, [it_(s1, K)])).status).toBe(400);
  });
});

describe('Ruxsatlar, scoping va tenant', () => {
  it("o'qituvchi faqat biriktirilgan sinf (begona 404); admin attendance.take bilan istalgan; ruxsatsiz 403", async () => {
    expect((await mark(t1, c6.id, [it_(s4, K)])).status).toBe(404);
    expect((await mark(t2, c5.id, [it_(s1, K)])).status).toBe(404);
    expect((await mark(taker, c6.id, [it_(s4, K)])).body.data.created).toBe(1);
    expect((await mark(editor, c5.id, [it_(s1, K)])).body.data.created).toBe(1);
    for (const t of [viewer, none]) expect((await mark(t, c5.id, [it_(s2, K)])).status).toBe(403);
    expect((await mark(root, c5.id, [it_(s2, K)])).status).toBe(400); // X-School-Id kerak
    expect(
      (await bulk(root, { classId: c5.id, items: [it_(s2, K)] }, { 'X-School-Id': school.id }))
        .status,
    ).toBe(200);
    expect((await request(app).post('/api/v1/attendance/bulk').send({})).status).toBe(401);
    expect((await mark(t1, 'bad-id', [it_(s1, K)])).status).toBe(400);

    // Varaq
    expect((await sheet(t1, c6.id)).status).toBe(404);
    expect((await sheet(t2, c6.id)).status).toBe(200);
    expect((await sheet(viewer, c5.id)).status).toBe(200); // attendance.view
    expect((await sheet(none, c5.id)).status).toBe(403);
    expect((await sheet(root, c5.id)).status).toBe(400);
    expect((await sheet(root, c5.id, '', { 'X-School-Id': school.id })).status).toBe(200);
    expect((await sheet(t1, c5.id, '?date=bad')).status).toBe(400);
  });

  it("tenant: boshqa maktab sinfi/yozuvi/o'quvchisi barcha amallarda 404", async () => {
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const os = await makeStudent(other.id, oc.id, 'Chet Maktab');
    const ot = await makeUser({ username: 'oteacher', role: 'teacher', schoolId: other.id });
    const orec = await AttendanceRecord.create({
      schoolId: other.id,
      studentId: os._id,
      classId: oc._id,
      academicYearId: oy._id,
      date: '2026-10-14',
      lessonNo: 0,
      statusId: K._id,
      category: 'present',
      markedBy: ot._id,
      updatedBy: ot._id,
    });
    expect((await sheet(taker, oc.id)).status).toBe(404);
    expect((await mark(taker, oc.id, [it_(os, K)])).status).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance/${orec.id}`)
          .set(bearer(editor))
          .send({ statusId: Y.id })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/v1/attendance/${orec.id}`).set(bearer(editor))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/v1/students/${os.id}/attendance-summary`).set(bearer(editor)))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/v1/attendance').set(bearer(editor))).body.data,
    ).toHaveLength(0);
    expect(
      (await request(app).get(`/api/v1/attendance/summary?classId=${oc.id}`).set(bearer(viewer)))
        .status,
    ).toBe(404);
    // Superadmin boshqa maktab kontekstida
    expect((await sheet(root, oc.id, '', { 'X-School-Id': school.id })).status).toBe(404);
    expect((await sheet(root, oc.id, '', { 'X-School-Id': other.id })).status).toBe(200);
  });
});

describe("Tahrirlash, o'chirish va tahrir oynasi", () => {
  it("o'z yozuvi tahrir oynasida; oynadan keyin 403; boshqa o'qituvchi yozuvi faqat attendance.edit bilan", async () => {
    const first = await mark(t1, c5.id, [it_(s1, K)]);
    expect(first.body.data.created).toBe(1);
    const id = (await sheet(t1, c5.id)).body.data.students[0].record.id;

    // Sinfdosh o'qituvchi (teacher3) boshqa yozuvni o'zgartira olmaydi, lekin yo'q o'quvchiga yangi yozuv qo'shadi
    const t3res = await mark(t3, c5.id, [it_(s1, Y), it_(s2, K)]);
    expect(t3res.body.data.created).toBe(1);
    expect(t3res.body.data.failed).toEqual([
      { studentId: s1.id, code: 'FORBIDDEN', message: expect.any(String) },
    ]);
    const forbidden = await request(app)
      .patch(`/api/v1/attendance/${id}`)
      .set(bearer(t3))
      .send({ statusId: Y.id });
    expect(forbidden.status).toBe(403);
    expect((await request(app).delete(`/api/v1/attendance/${id}`).set(bearer(t3))).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance/${id}`)
          .set(bearer(t2))
          .send({ statusId: Y.id })
      ).status,
    ).toBe(404); // begona sinf
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance/${id}`)
          .set(bearer(taker))
          .send({ statusId: Y.id })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance/${id}`)
          .set(bearer(viewer))
          .send({ statusId: Y.id })
      ).status,
    ).toBe(403);
    // t3 ko'rinishida boshqa o'qituvchi yozuvi tahrirlanmaydi
    const t3sheet = (await sheet(t3, c5.id)).body.data.students;
    expect(t3sheet.find((x: { studentId: string }) => x.studentId === s1.id).record.editable).toBe(
      false,
    );
    expect(t3sheet.find((x: { studentId: string }) => x.studentId === s2.id).record.editable).toBe(
      true,
    );

    // O'zi: oynada ruxsat
    const own = await request(app)
      .patch(`/api/v1/attendance/${id}`)
      .set(bearer(t1))
      .send({ statusId: Ke.id, minutesLate: 7 });
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({
      status: { category: 'late' },
      minutesLate: 7,
      updatedBy: { id: teacher1.id },
    });
    expect(await AuditLog.countDocuments({ action: 'attendance.update' })).toBe(1);

    // Oyna o'tdi
    await ageRec(id, 25);
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance/${id}`)
          .set(bearer(t1))
          .send({ statusId: K.id })
      ).status,
    ).toBe(403);
    expect((await request(app).delete(`/api/v1/attendance/${id}`).set(bearer(t1))).status).toBe(
      403,
    );
    const exp = await mark(t1, c5.id, [it_(s1, K), it_(s3, K)]);
    expect(exp.body.data).toMatchObject({ created: 1, updated: 0 });
    expect(exp.body.data.failed).toEqual([
      { studentId: s1.id, code: 'FORBIDDEN', message: expect.any(String) },
    ]);
    expect(
      (await sheet(t1, c5.id)).body.data.students.find(
        (x: { studentId: string }) => x.studentId === s1.id,
      ).record.editable,
    ).toBe(false);

    // attendance.edit: istalgan vaqtda, istalgan yozuv
    const ed = await request(app)
      .patch(`/api/v1/attendance/${id}`)
      .set(bearer(editor))
      .send({ statusId: S.id, note: 'sabab' });
    expect(ed.status).toBe(200);
    expect(ed.body.data).toMatchObject({
      editable: true,
      updatedBy: { fullName: 'Test editor' },
      markedBy: { id: teacher1.id },
    });
    const edBulk = await mark(editor, c5.id, [it_(s1, K)]);
    expect(edBulk.body.data).toMatchObject({ created: 0, updated: 1, failed: [] });

    // Oyna kengaytirilsa yana mumkin
    await ageRec(id, 25);
    await setAtt({ editWindowHours: 48 });
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance/${id}`)
          .set(bearer(t1))
          .send({ statusId: K.id })
      ).status,
    ).toBe(200);
  });

  it('PATCH qoidalari: holat, kechikish daqiqasi, izoh; DELETE soft + qayta yaratish', async () => {
    await mark(t1, c5.id, [it_(s1, Ke, { minutesLate: 12 })]);
    const id = (await AttendanceRecord.findOne({ studentId: s1._id }))!.id as string;
    const patch = (body: object) =>
      request(app).patch(`/api/v1/attendance/${id}`).set(bearer(t1)).send(body);

    expect((await patch({ statusId: Eski.id })).status).toBe(400); // nofaol
    expect((await patch({ statusId: '64b64b64b64b64b64b64b64b' })).status).toBe(400);
    expect((await patch({ minutesLate: 700 })).status).toBe(400);
    expect((await patch({ minutesLate: 20 })).body.data.minutesLate).toBe(20);
    // 'late' dan chiqqanda daqiqa avtomatik tozalanadi
    const toPresent = await patch({ statusId: K.id });
    expect(toPresent.body.data).toMatchObject({
      minutesLate: null,
      status: { category: 'present' },
    });
    expect((await patch({ minutesLate: 5 })).status).toBe(400); // present bilan daqiqa
    expect((await patch({ note: 'izoh' })).body.data.note).toBe('izoh');
    expect((await patch({ note: null })).body.data.note).toBeNull();

    await setAtt({ noteRequiredCategories: ['absent_unexcused'] });
    expect((await patch({ statusId: Y.id })).status).toBe(400);
    expect((await patch({ statusId: Y.id, note: 'sababsiz' })).status).toBe(200);

    expect((await request(app).delete(`/api/v1/attendance/${id}`).set(bearer(t1))).status).toBe(
      200,
    );
    expect(await AttendanceRecord.countDocuments({ _id: id, isDeleted: true })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'attendance.delete' })).toBe(1);
    expect((await patch({ statusId: K.id })).status).toBe(404);
    expect((await sheet(t1, c5.id)).body.data.students[0].record).toBeNull();
    // Soft delete dan keyin shu birlik uchun qayta yozish mumkin
    expect((await mark(t1, c5.id, [it_(s1, K)])).body.data.created).toBe(1);
  });
});

describe("Tarix, statistika va o'quvchi profili", () => {
  async function seed() {
    await rec(s1, c5, '2026-10-12', K);
    await rec(s1, c5, '2026-10-13', Ke);
    await rec(s1, c5, '2026-10-14', Y);
    await rec(s2, c5, '2026-10-12', K);
    await rec(s2, c5, '2026-10-13', K);
    await rec(s4, c6, '2026-10-13', S);
  }

  it("GET /attendance: tarix, filtrlar, tartib, sahifalash; o'qituvchi o'z sinflari (barcha yozuvlar); ruxsatlar", async () => {
    await seed();
    await rec(s3, c5, '2026-10-13', K, 0, teacher1);
    const get = (t: string, q = '') => request(app).get(`/api/v1/attendance${q}`).set(bearer(t));

    const tl = await get(t1);
    expect(tl.status).toBe(200);
    expect(tl.body.meta).toMatchObject({ total: 6, page: 1, limit: 20 });
    expect(tl.body.data[0]).toMatchObject({
      date: '2026-10-14',
      markedBy: { fullName: 'Test teacher1' },
      status: { category: 'absent_unexcused' },
    });
    expect(tl.body.data.some((r: { classId: string }) => r.classId === c6.id)).toBe(false); // boshqa sinf ko'rinmaydi
    expect((await get(t1, `?classId=${c6.id}`)).body.data).toEqual([]);
    expect((await get(t2)).body.data).toHaveLength(1);

    expect((await get(viewer)).body.meta.total).toBe(7);
    expect(
      (await get(viewer, `?classId=${c5.id}&category=late`)).body.data.map(
        (r: { date: string }) => r.date,
      ),
    ).toEqual(['2026-10-13']);
    expect(
      (await get(viewer, `?studentId=${s1.id}&sort=date`)).body.data.map(
        (r: { date: string }) => r.date,
      ),
    ).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect((await get(viewer, '?from=2026-10-14&to=2026-10-14')).body.data).toHaveLength(1);
    expect((await get(viewer, `?statusId=${K.id}`)).body.meta.total).toBe(4);
    expect((await get(viewer, '?limit=2&page=2')).body.data).toHaveLength(2);
    expect((await get(viewer, '?lessonNo=1')).body.data).toHaveLength(0);
    expect((await get(taker)).status).toBe(200);
    expect((await get(editor)).status).toBe(200);
    expect((await get(none)).status).toBe(403);
    expect((await get(viewer, '?category=x')).status).toBe(400);
    expect((await get(root)).status).toBe(400);
    expect((await get(root, '')).status).toBe(400);
  });

  it('GET /attendance/summary: kategoriyalar, rate, birlik; ruxsatlar', async () => {
    await seed();
    const get = (t: string, q: string) =>
      request(app).get(`/api/v1/attendance/summary${q}`).set(bearer(t));
    const r = await get(viewer, `?classId=${c5.id}&from=2026-10-12&to=2026-10-14`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-14',
      unit: 'day',
      class: { present: 3, late: 1, absentExcused: 0, absentUnexcused: 1, total: 5, rate: 80 },
    });
    expect(r.body.data.students).toEqual([
      {
        studentId: s1.id,
        fullName: 'Aliyev Ali',
        present: 1,
        late: 1,
        absentExcused: 0,
        absentUnexcused: 1,
        total: 3,
        rate: 66.67,
      },
      {
        studentId: s3.id,
        fullName: 'Bekov Bek',
        present: 0,
        late: 0,
        absentExcused: 0,
        absentUnexcused: 0,
        total: 0,
        rate: null,
      },
      {
        studentId: s2.id,
        fullName: 'Valiyev Vali',
        present: 2,
        late: 0,
        absentExcused: 0,
        absentUnexcused: 0,
        total: 2,
        rate: 100,
      },
    ]);
    // O'qituvchi attendance.view siz ham o'z sinfi uchun
    expect((await get(t1, `?classId=${c5.id}&from=2026-10-12&to=2026-10-14`)).status).toBe(200);
    expect((await get(t1, `?classId=${c6.id}`)).status).toBe(404);
    expect((await get(t1, '?from=2026-10-12&to=2026-10-14')).body.data.students).toHaveLength(3);
    expect((await get(t1, '')).body.data.class).toBeUndefined();
    // Admin: attendance.view kerak
    expect((await get(taker, `?classId=${c5.id}`)).status).toBe(403);
    expect((await get(none, '')).status).toBe(403);
    expect((await get(viewer, '')).body.data.students).toHaveLength(4);
    expect((await get(viewer, '?from=2025-01-01&to=2026-10-14')).status).toBe(400);
    expect((await get(viewer, '?from=2026-10-14&to=2026-10-01')).status).toBe(400);
    // Birlik: dars yozuvlari qo'shilsa mixed
    await rec(s2, c5, '2026-10-14', K, 2);
    expect(
      (await get(viewer, `?classId=${c5.id}&from=2026-10-12&to=2026-10-14`)).body.data.unit,
    ).toBe('mixed');
    expect(
      (await get(viewer, `?classId=${c5.id}&from=2026-10-14&to=2026-10-14`)).body.data.unit,
    ).toBe('mixed');
    expect(
      (await get(viewer, `?classId=${c5.id}&from=2026-10-01&to=2026-10-02`)).body.data.unit,
    ).toBe('day'); // yozuvsiz: joriy rejim
  });

  it('GET /students/:id/attendance-summary: dars rejimida kunning yakuniy kategoriyasi, byStatus, recent', async () => {
    await setAtt({ mode: 'lesson', lessonsPerDay: 4 });
    await rec(s1, c5, '2026-10-13', K, 1);
    await rec(s1, c5, '2026-10-13', Ke, 2);
    await rec(s1, c5, '2026-10-13', S, 3);
    await rec(s1, c5, '2026-10-14', K, 1);
    await rec(s1, c5, '2026-10-14', K, 2);
    await rec(s1, c5, '2026-10-12', Ke, 1);
    for (let i = 1; i <= 10; i++) await rec(s1, c5, '2026-09-' + String(i).padStart(2, '0'), K, 1);

    const get = (t: string, id: string, q = '') =>
      request(app).get(`/api/v1/students/${id}/attendance-summary${q}`).set(bearer(t));
    const r = await get(t1, s1.id, '?from=2026-10-01&to=2026-10-14');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({
      studentId: s1.id,
      from: '2026-10-01',
      to: '2026-10-14',
      total: 6,
      present: 3,
      late: 2,
      absentExcused: 1,
      absentUnexcused: 0,
      rate: 83.33,
    });
    expect(
      d.days.map((x: { date: string; category: string; lessons: number }) => [
        x.date,
        x.category,
        x.lessons,
      ]),
    ).toEqual([
      ['2026-10-12', 'late', 1],
      ['2026-10-13', 'absent_excused', 3], // eng og'ir
      ['2026-10-14', 'present', 2],
    ]);
    expect(d.days[1].records).toEqual([
      { lessonNo: 1, statusId: K.id, category: 'present' },
      { lessonNo: 2, statusId: Ke.id, category: 'late' },
      { lessonNo: 3, statusId: S.id, category: 'absent_excused' },
    ]);
    expect(d.byStatus.find((x: { statusId: string }) => x.statusId === K.id)).toMatchObject({
      name: 'Keldi',
      category: 'present',
      count: 3,
    });
    expect(d.recent).toHaveLength(6);
    expect(d.recent[0]).toMatchObject({ date: '2026-10-14', lessonNo: 2 });

    // Default davr: oxirgi 30 kun (sentyabr yozuvlari 10-14 dan 30 kun ichida emas -> faqat 09-15 dan)
    const def = (await get(t1, s1.id)).body.data;
    expect(def).toMatchObject({ from: '2026-09-15', to: '2026-10-14', total: 6 });
    const wide = (await get(viewer, s1.id, '?from=2026-09-01&to=2026-10-14')).body.data;
    expect(wide.total).toBe(16);
    expect(wide.recent).toHaveLength(10);
    expect((await get(t1, s1.id, '?from=2024-01-01&to=2026-10-14')).status).toBe(400);
    expect((await get(t1, s4.id)).status).toBe(404); // begona sinf o'quvchisi
    expect((await get(t2, s1.id)).status).toBe(404);
    expect((await get(none, s1.id)).status).toBe(403);
    expect((await get(viewer, s4.id)).status).toBe(200);
    expect((await get(t1, 'bad')).status).toBe(404);
    expect((await get(t1, s2.id)).body.data).toMatchObject({
      total: 0,
      rate: null,
      days: [],
      recent: [],
      byStatus: [],
    });
  });
});

describe('Bugungi jarayon va dashboard', () => {
  it("today-progress: kunlik rejim (hamma o'quvchiga yozuv bo'lsa olingan); admin barcha sinflar", async () => {
    await mark(t1, c5.id, [it_(s1, K), it_(s2, K)]);
    const p1 = (await request(app).get('/api/v1/attendance/today-progress').set(bearer(t1))).body
      .data;
    expect(p1).toEqual([
      {
        classId: c5.id,
        className: '5-A',
        markedUnits: 0,
        totalUnits: 1,
        markedStudents: 2,
        totalStudents: 3,
      },
    ]);
    await mark(t1, c5.id, [it_(s3, S, { note: 'x' })]);
    expect(
      (await request(app).get('/api/v1/attendance/today-progress').set(bearer(t1))).body.data[0],
    ).toMatchObject({ markedUnits: 1, markedStudents: 3 });
    const adm = (await request(app).get('/api/v1/attendance/today-progress').set(bearer(taker)))
      .body.data;
    expect(
      adm.map((c: { className: string; markedUnits: number }) => [c.className, c.markedUnits]),
    ).toEqual([
      ['5-A', 1],
      ['6-A', 0],
    ]);
    expect(
      (await request(app).get('/api/v1/attendance/today-progress').set(bearer(none))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/v1/attendance/today-progress')
          .set(bearer(root))
          .set('X-School-Id', school.id)
      ).body.data,
    ).toHaveLength(2);

    // Dam olish kuni: bo'sh
    setNow('2026-10-11T07:00:00Z');
    expect(
      (await request(app).get('/api/v1/attendance/today-progress').set(bearer(t1))).body.data,
    ).toEqual([]);
  });

  it('today-progress: dars rejimida har dars alohida birlik', async () => {
    await setAtt({ mode: 'lesson', lessonsPerDay: 3 });
    await mark(t1, c5.id, [it_(s1, K), it_(s2, K), it_(s3, K)], { lessonNo: 1 });
    await mark(t1, c5.id, [it_(s1, K), it_(s2, K)], { lessonNo: 2 });
    const p = (await request(app).get('/api/v1/attendance/today-progress').set(bearer(t1))).body
      .data;
    expect(p).toEqual([
      {
        classId: c5.id,
        className: '5-A',
        markedUnits: 1,
        totalUnits: 3,
        markedStudents: 3,
        totalStudents: 3,
      },
    ]);
    await mark(t1, c5.id, [it_(s3, K)], { lessonNo: 2 });
    expect(
      (await request(app).get('/api/v1/attendance/today-progress').set(bearer(t1))).body.data[0]
        .markedUnits,
    ).toBe(2);
  });

  it("dashboard attendanceToday: eng og'ir kategoriya bo'yicha o'quvchi hisobi, olinmagan sinflar, doira", async () => {
    const summary = (t: string, h: Record<string, string> = {}) =>
      request(app).get('/api/v1/dashboard/summary').set(bearer(t)).set(h);
    expect((await summary(admin)).body.data.attendanceToday).toEqual({
      present: 0,
      late: 0,
      absent: 0,
      total: 4,
      unmarkedClasses: 2,
    });

    await mark(t1, c5.id, [it_(s1, K), it_(s2, Ke), it_(s3, S, { note: 'x' })]);
    expect((await summary(admin)).body.data.attendanceToday).toEqual({
      present: 1,
      late: 1,
      absent: 1,
      total: 4,
      unmarkedClasses: 1,
    });
    expect((await summary(t1)).body.data.attendanceToday).toEqual({
      present: 1,
      late: 1,
      absent: 1,
      total: 3,
      unmarkedClasses: 0,
    });
    expect((await summary(root)).body.data.attendanceToday).toEqual({
      present: 1,
      late: 1,
      absent: 1,
      total: 4,
      unmarkedClasses: 1,
    });
    expect(
      (await summary(root, { 'X-School-Id': school.id })).body.data.attendanceToday.total,
    ).toBe(4);

    // Dars rejimi: o'quvchi bugungi barcha yozuvlaridagi eng og'iri
    await setAtt({ mode: 'lesson', lessonsPerDay: 2 });
    await mark(t1, c5.id, [it_(s1, Y)], { lessonNo: 1 });
    expect((await summary(admin)).body.data.attendanceToday).toMatchObject({
      present: 0,
      late: 1,
      absent: 2,
    });

    // Dam olish kuni — hisob 0, olinmagan sinf yo'q
    setNow('2026-10-11T07:00:00Z');
    expect((await summary(admin)).body.data.attendanceToday).toEqual({
      present: 0,
      late: 0,
      absent: 0,
      total: 4,
      unmarkedClasses: 0,
    });
  });
});
