import { ObjectId } from 'mongodb';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Subject } from '../src/models/Subject';
import { addDaysStr, todayTashkent } from '../src/utils/clock';
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

type Doc = { id: string; _id: unknown };
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, phys: Doc, art: Doc, off: Doc;
let s1: Doc, s2: Doc, s3: Doc, sOther: Doc;
let tm: string, tp: string, tx: string, tNoAssign: string;
let gAdmin: string, gCreator: string, noperm: string, viewer: string, otherAdmin: string;
let root: string;
let tMathUser: Doc, tPhysUser: Doc;
const today = () => todayTashkent();
const d = (n: number) => addDaysStr(today(), n);

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  const oy = await makeYear(other.id);
  tMathUser = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tPhysUser = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tx', role: 'teacher', schoolId: other.id });
  await makeUser({ username: 'tnone', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'gadmin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'grades.create', 'grades.edit'],
  });
  await makeUser({
    username: 'gcreator',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['grades.create'],
  });
  await makeUser({
    username: 'noperm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  await makeUser({
    username: 'viewer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  await makeUser({
    username: 'oadmin',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['grades.create', 'grades.edit', 'students.view'],
  });

  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  art = await makeSubject("Tasviriy san'at", school.id);
  off = await makeSubject('Eski fan', null, { isActive: false });

  c5 = await makeClass(school.id, year.id, '5-A', [tMathUser.id, tPhysUser.id]);
  c6 = await makeClass(school.id, year.id, '6-A');
  await assignSubject(school.id, c5, math.id, tMathUser.id);
  await assignSubject(school.id, c5, phys.id, tPhysUser.id);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  const oc = await makeClass(other.id, oy.id, '5-A');
  sOther = await makeStudent(other.id, oc.id, 'Begona Bola');

  [tm, tp, tx, tNoAssign, gAdmin, gCreator, noperm, viewer, otherAdmin, root] = await Promise.all(
    [
      'tmath',
      'tphys',
      'tx',
      'tnone',
      'gadmin',
      'gcreator',
      'noperm',
      'viewer',
      'oadmin',
      'root',
    ].map(async (u) => (await login(u)).token),
  );
});

const post = (t: string, body: object, h: Record<string, string> = {}) =>
  request(app).post('/api/v1/grades').set(bearer(t)).set(h).send(body);
const gbody = (studentId: string, extra: Record<string, unknown> = {}) => ({
  studentId,
  subjectId: math.id,
  value: 5,
  ...extra,
});
const ageGrade = (id: string, hours: number) =>
  SubjectGrade.collection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { createdAt: new Date(Date.now() - hours * 3_600_000) } },
  );

describe("Fan bahosini qo'yish (POST /grades)", () => {
  it('biriktirilgan o`qituvchi baholaydi: DTO, snapshot, editable, audit', async () => {
    const res = await post(tm, gbody(s1.id, { comment: '  zo`r  ' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      schoolId: school.id,
      studentId: s1.id,
      student: { id: s1.id, fullName: 'Aliyev Ali' },
      classId: c5.id,
      class: { id: c5.id, name: '5-A' },
      subjectId: math.id,
      subject: { id: math.id, name: 'Matematika' },
      teacherId: tMathUser.id,
      academicYearId: year.id,
      value: 5,
      comment: 'zo`r',
      date: today(),
      editable: true,
    });
    expect(await SubjectGrade.countDocuments({})).toBe(1);
    const audit = await AuditLog.findOne({ action: 'grades.create' });
    expect(audit?.entity).toBe('subject_grade');
    expect(audit?.entityId).toBe(res.body.data.id);
  });

  it("boshqa fan o'qituvchisi, biriktirilmagan o'qituvchi va biriktirilmagan sinf — 403", async () => {
    // fizika o'qituvchisi matematikadan baholay olmaydi
    expect((await post(tp, gbody(s1.id))).status).toBe(403);
    // sinfga umuman biriktirilmagan o'qituvchi
    expect((await post(tNoAssign, gbody(s1.id))).status).toBe(403);
    // matematika o'qituvchisi biriktirilmagan sinf o'quvchisini (6-A) baholay olmaydi
    expect((await post(tm, gbody(s3.id))).status).toBe(403);
    // o'z fani bo'yicha esa mumkin
    expect((await post(tp, gbody(s1.id, { subjectId: phys.id }))).status).toBe(201);
    expect(await SubjectGrade.countDocuments({})).toBe(1);
  });

  it("begona maktab: boshqa maktab o'qituvchisi/admini 404; superadmin boshqa maktab headeri bilan 404", async () => {
    expect((await post(tx, gbody(s1.id))).status).toBe(404);
    expect((await post(otherAdmin, gbody(s1.id))).status).toBe(404);
    expect((await post(root, gbody(s1.id), { 'X-School-Id': other.id })).status).toBe(404);
    // O'z maktabi o'quvchisi uchun begona maktab fani 404
    const foreign = await makeSubject('Begona fan', other.id);
    expect((await post(gAdmin, gbody(s1.id, { subjectId: foreign.id }))).status).toBe(404);
    // begona maktab o'quvchisi
    expect((await post(gAdmin, gbody(sOther.id))).status).toBe(404);
    expect(await SubjectGrade.countDocuments({})).toBe(0);
  });

  it('admin: grades.create bilan istalgan sinf/fan; ruxsatsiz admin va ruxsatsiz rol 403', async () => {
    // 6-A da hech qanday biriktirish yo'q, lekin admin baholay oladi
    const ok = await post(gCreator, gbody(s3.id, { subjectId: art.id }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.teacherId).not.toBe(tMathUser.id);
    expect((await post(gAdmin, gbody(s1.id))).status).toBe(201);
    expect((await post(root, gbody(s2.id), { 'X-School-Id': school.id })).status).toBe(201);
    expect((await post(noperm, gbody(s1.id))).status).toBe(403);
    expect((await post(viewer, gbody(s1.id))).status).toBe(403);
    expect((await request(app).post('/api/v1/grades').send(gbody(s1.id))).status).toBe(401);
  });

  it('qoidalar: 2–5 butun son, sana (kelajak / backdateDays), nofaol va mavjud bo`lmagan fan', async () => {
    const bad = async (extra: Record<string, unknown>, status = 400, t = tm) => {
      const r = await post(t, gbody(s1.id, extra));
      expect(r.status, JSON.stringify(extra)).toBe(status);
      return r;
    };
    await bad({ value: 1 });
    await bad({ value: 6 });
    await bad({ value: 3.5 });
    await bad({ value: 0 });
    await bad({ value: '5' });
    await bad({ date: d(1) }); // kelajak
    await bad({ date: d(-4) }); // backdateDays=3 dan eski
    await bad({ date: '2026-13-45' });
    await bad({ comment: 'x'.repeat(501) });
    await bad({ subjectId: '0'.repeat(24) }, 404, gAdmin);
    await bad({ subjectId: off.id }, 400, gAdmin); // nofaol fan
    expect((await post(tm, gbody(s1.id, { date: d(-3), value: 2 }))).status).toBe(201);
    expect((await post(tm, gbody('nope'))).status).toBe(400);
    expect((await post(tm, gbody('0'.repeat(24)))).status).toBe(404);
  });

  it('backdateDays sozlamasi (maktab override) hisobga olinadi', async () => {
    const put = await request(app)
      .put('/api/v1/settings/scoring')
      .set(bearer(root))
      .send({ scope: 'school', schoolId: school.id, values: { backdateDays: 10 } });
    expect(put.status).toBe(200);
    expect((await post(tm, gbody(s1.id, { date: d(-10) }))).status).toBe(201);
    expect((await post(tm, gbody(s2.id, { date: d(-11) }))).status).toBe(400);
  });

  it("bir o'quvchiga bir fandan kuniga bitta baho: 409; o'chirgach, boshqa kun yoki boshqa fan mumkin", async () => {
    const first = await post(tm, gbody(s1.id));
    expect(first.status).toBe(201);
    const dup = await post(tm, gbody(s1.id));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    // admin ham xuddi shu o'quvchi/fan/kunga qo'sha olmaydi
    expect((await post(gAdmin, gbody(s1.id))).status).toBe(409);
    // boshqa kun / boshqa fan / boshqa o'quvchi
    expect((await post(tm, gbody(s1.id, { date: d(-1) }))).status).toBe(201);
    expect((await post(gAdmin, gbody(s1.id, { subjectId: phys.id }))).status).toBe(201);
    expect((await post(tm, gbody(s2.id))).status).toBe(201);
    // o'chirgach yana mumkin
    const del = await request(app).delete(`/api/v1/grades/${first.body.data.id}`).set(bearer(tm));
    expect(del.status).toBe(200);
    expect((await post(tm, gbody(s1.id))).status).toBe(201);
    // DB darajasidagi unique indeks (partial) ham bor
    await SubjectGrade.init();
    const idx = await SubjectGrade.collection.indexes();
    expect(idx.find((i) => i.name === 'one_grade_per_student_subject_day_lesson')?.unique).toBe(
      true,
    );
  });
});

describe('Tahrirlash va o`chirish', () => {
  it("o'z bahosi tahrir oynasi ichida: PATCH/DELETE; oyna o'tgach 403; editable flag", async () => {
    const g = (await post(tm, gbody(s1.id, { value: 3 }))).body.data;
    const patch = await request(app)
      .patch(`/api/v1/grades/${g.id}`)
      .set(bearer(tm))
      .send({ value: 4, comment: 'yaxshilandi' });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ value: 4, comment: 'yaxshilandi' });
    expect(await AuditLog.countDocuments({ action: 'grades.update' })).toBe(1);
    expect(
      (await request(app).patch(`/api/v1/grades/${g.id}`).set(bearer(tm)).send({ value: 6 }))
        .status,
    ).toBe(400);

    await ageGrade(g.id, 25); // editWindowHours=24
    const late = await request(app)
      .patch(`/api/v1/grades/${g.id}`)
      .set(bearer(tm))
      .send({ value: 5 });
    expect(late.status).toBe(403);
    expect((await request(app).delete(`/api/v1/grades/${g.id}`).set(bearer(tm))).status).toBe(403);
    const list = await request(app).get('/api/v1/grades').set(bearer(tm));
    expect(list.body.data[0].editable).toBe(false);
  });

  it("grades.edit: istalgan baho, istalgan vaqtda; grades.edit siz admin va boshqa o'qituvchi — mumkin emas", async () => {
    const g = (await post(tm, gbody(s1.id, { value: 3 }))).body.data;
    await ageGrade(g.id, 100);
    const patch = (t: string) =>
      request(app).patch(`/api/v1/grades/${g.id}`).set(bearer(t)).send({ value: 4 });
    // boshqa o'qituvchi bahoni ko'rmaydi
    expect((await patch(tp)).status).toBe(404);
    // grades.edit siz admin: 403
    expect((await patch(gCreator)).status).toBe(403);
    expect((await request(app).delete(`/api/v1/grades/${g.id}`).set(bearer(gCreator))).status).toBe(
      403,
    );
    // begona maktab admini — 404
    expect((await patch(otherAdmin)).status).toBe(404);
    // grades.edit li admin — ruxsat
    expect((await patch(gAdmin)).status).toBe(200);
    expect((await request(app).delete(`/api/v1/grades/${g.id}`).set(bearer(gAdmin))).status).toBe(
      200,
    );
    expect(await SubjectGrade.countDocuments({ isDeleted: false })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'grades.delete' })).toBe(1);
    expect((await patch(gAdmin)).status).toBe(404); // o'chirilgan
  });
});

describe('Ommaviy baholash (POST /grades/bulk)', () => {
  const bulk = (t: string, body: object, h: Record<string, string> = {}) =>
    request(app).post('/api/v1/grades/bulk').set(bearer(t)).set(h).send(body);

  it('create + update + xatolar bitta so`rovda; audit bitta yozuv', async () => {
    const existing = (await post(tm, gbody(s1.id, { value: 3 }))).body.data;
    const res = await bulk(tm, {
      classId: c5.id,
      subjectId: math.id,
      items: [
        { studentId: s1.id, value: 4 }, // update (o'z bahosi)
        { studentId: s2.id, value: 5, comment: 'a`lo' }, // create
        { studentId: s3.id, value: 5 }, // boshqa sinf o'quvchisi
        { studentId: s2.id, value: 2 }, // takror
        { studentId: sOther.id, value: 5 }, // begona maktab
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.updated).toBe(1);
    expect(
      res.body.data.failed.map((f: { studentId: string; code: string }) => [f.studentId, f.code]),
    ).toEqual([
      [s3.id, 'NOT_FOUND'],
      [s2.id, 'CONFLICT'],
      [sOther.id, 'NOT_FOUND'],
    ]);
    expect((await SubjectGrade.findById(existing.id))?.value).toBe(4);
    expect(await AuditLog.countDocuments({ action: 'grades.bulk' })).toBe(1);
  });

  it("tahrir oynasi o'tgan yoki boshqa o'qituvchining bahosi elementi FORBIDDEN; qolganlari o'tadi", async () => {
    const g = (await post(tm, gbody(s1.id, { value: 3 }))).body.data;
    await ageGrade(g.id, 30);
    const res = await bulk(tm, {
      classId: c5.id,
      subjectId: math.id,
      items: [
        { studentId: s1.id, value: 5 },
        { studentId: s2.id, value: 4 },
      ],
    });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toEqual([
      expect.objectContaining({ studentId: s1.id, code: 'FORBIDDEN' }),
    ]);
    // grades.edit siz admin o'qituvchining bahosini bulk bilan o'zgartira olmaydi
    const r2 = await bulk(gCreator, {
      classId: c5.id,
      subjectId: math.id,
      items: [{ studentId: s2.id, value: 2 }],
    });
    expect(r2.body.data.failed[0].code).toBe('FORBIDDEN');
    // grades.edit li admin o'zgartiradi
    const r3 = await bulk(gAdmin, {
      classId: c5.id,
      subjectId: math.id,
      items: [{ studentId: s2.id, value: 2 }],
    });
    expect(r3.body.data.updated).toBe(1);
  });

  it('huquq, sinf, sana va hajm tekshiruvlari', async () => {
    const base = { classId: c5.id, subjectId: math.id, items: [{ studentId: s1.id, value: 5 }] };
    expect((await bulk(tp, base)).status).toBe(403); // boshqa fan o'qituvchisi
    expect((await bulk(tNoAssign, base)).status).toBe(403);
    expect((await bulk(tx, base)).status).toBe(404); // begona maktab sinfi
    expect((await bulk(noperm, base)).status).toBe(403);
    expect((await bulk(gAdmin, { ...base, classId: '0'.repeat(24) })).status).toBe(404);
    expect((await bulk(gAdmin, { ...base, subjectId: off.id })).status).toBe(400);
    expect((await bulk(tm, { ...base, date: d(1) })).status).toBe(400);
    expect((await bulk(tm, { ...base, items: [] })).status).toBe(400);
    expect((await bulk(tm, { ...base, items: [{ studentId: s1.id, value: 7 }] })).status).toBe(400);
    expect(
      (
        await bulk(tm, {
          ...base,
          items: Array.from({ length: 201 }, () => ({ studentId: s1.id, value: 5 })),
        })
      ).status,
    ).toBe(400);
    expect((await bulk(root, base, { 'X-School-Id': school.id })).status).toBe(200);
  });
});

describe("Ro'yxat, varaq va xulosa", () => {
  it("GET /grades: o'qituvchi faqat o'z baholari; admin hammasi + filtrlar; ruxsat", async () => {
    await post(tm, gbody(s1.id));
    await post(tm, gbody(s2.id, { date: d(-1) }));
    await post(tp, gbody(s1.id, { subjectId: phys.id, value: 3 }));
    const list = (t: string, q = '') => request(app).get(`/api/v1/grades${q}`).set(bearer(t));

    const mine = await list(tm);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(2);
    expect(mine.body.meta.total).toBe(2);
    expect(mine.body.data[0].date).toBe(today()); // -date tartibi
    // teacherId filtri o'qituvchi uchun e'tiborga olinmaydi
    expect((await list(tm, `?teacherId=${tPhysUser.id}`)).body.data).toHaveLength(2);

    expect((await list(gAdmin)).body.data).toHaveLength(3);
    expect((await list(gAdmin, `?subjectId=${phys.id}`)).body.data).toHaveLength(1);
    expect((await list(gAdmin, `?studentId=${s1.id}`)).body.data).toHaveLength(2);
    expect((await list(gAdmin, `?teacherId=${tPhysUser.id}`)).body.data).toHaveLength(1);
    expect(
      (await list(gAdmin, `?classId=${c5.id}&from=${d(-1)}&to=${d(-1)}`)).body.data,
    ).toHaveLength(1);
    expect((await list(gAdmin, '?limit=2&page=2')).body.data).toHaveLength(1);
    expect((await list(viewer)).status).toBe(200);
    expect((await list(noperm)).status).toBe(403);
    expect((await list(otherAdmin)).body.data).toHaveLength(0); // begona maktab: izolyatsiya
    expect((await list(root)).status).toBe(400); // header yo'q
  });

  it('GET /grades/sheet: o`quvchilar, "allaqachon baholangan" belgisi, ruxsatlar', async () => {
    await post(tm, gbody(s1.id, { value: 4 }));
    const sheet = (t: string, q: string) =>
      request(app).get(`/api/v1/grades/sheet?${q}`).set(bearer(t));
    const res = await sheet(tm, `classId=${c5.id}&subjectId=${math.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      class: { id: c5.id, name: '5-A' },
      subject: { id: math.id, name: 'Matematika' },
      date: today(),
    });
    const by = (id: string) =>
      res.body.data.students.find((s: { studentId: string }) => s.studentId === id);
    expect(res.body.data.students).toHaveLength(2);
    expect(by(s1.id)).toMatchObject({ alreadyGraded: true, grade: { value: 4 } });
    expect(by(s2.id)).toMatchObject({ alreadyGraded: false, grade: null });
    // boshqa sana: hech kim baholanmagan
    const other_day = await sheet(tm, `classId=${c5.id}&subjectId=${math.id}&date=${d(-1)}`);
    expect(
      other_day.body.data.students.every((s: { alreadyGraded: boolean }) => !s.alreadyGraded),
    ).toBe(true);
    expect((await sheet(tp, `classId=${c5.id}&subjectId=${math.id}`)).status).toBe(403);
    expect((await sheet(tx, `classId=${c5.id}&subjectId=${math.id}`)).status).toBe(404);
    expect((await sheet(gAdmin, `classId=${c6.id}&subjectId=${art.id}`)).status).toBe(200);
    expect((await sheet(noperm, `classId=${c5.id}&subjectId=${math.id}`)).status).toBe(403);
    expect((await sheet(tm, `classId=${c5.id}`)).status).toBe(400);
  });

  it("GET /grades/my-assignments: o'qituvchining biriktirilgan juftliklari; admin uchun mode=all", async () => {
    // nofaol fan va arxivlangan sinf chiqarib tashlanadi
    const arch = await makeClass(school.id, year.id, '9-A', [tMathUser.id], { isArchived: true });
    await assignSubject(school.id, arch, math.id, tMathUser.id);
    await Subject.updateOne({ _id: phys.id }, { isActive: false });
    const res = await request(app).get('/api/v1/grades/my-assignments').set(bearer(tm));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      mode: 'assigned',
      assignments: [
        {
          classId: c5.id,
          className: '5-A',
          grade: 5,
          subjectId: math.id,
          subjectName: 'Matematika',
        },
      ],
    });
    const tpRes = await request(app).get('/api/v1/grades/my-assignments').set(bearer(tp));
    expect(tpRes.body.data.assignments).toEqual([]); // fizika nofaol
    const none = await request(app).get('/api/v1/grades/my-assignments').set(bearer(tNoAssign));
    expect(none.body.data.assignments).toEqual([]);
    const adm = await request(app).get('/api/v1/grades/my-assignments').set(bearer(gAdmin));
    expect(adm.body.data).toEqual({ mode: 'all', assignments: [] });
  });

  it("GET /students/:id/grade-summary: fanlar bo'yicha o'rtacha, ×20 shkala, so'nggi baholar, scoping", async () => {
    await post(tm, gbody(s1.id, { value: 5, date: d(-2) }));
    await post(tm, gbody(s1.id, { value: 4, date: d(-1) }));
    await post(tp, gbody(s1.id, { subjectId: phys.id, value: 3, comment: 'fizika izohi' }));
    const sum = (t: string, id: string, h: Record<string, string> = {}) =>
      request(app).get(`/api/v1/students/${id}/grade-summary`).set(bearer(t)).set(h);

    const res = await sum(gAdmin, s1.id);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ studentId: s1.id, gradesCount: 3, average: 4, average100: 80 });
    expect(data.bySubject).toEqual([
      expect.objectContaining({ name: 'Fizika', average: 3, count: 1, lastValue: 3 }),
      expect.objectContaining({ name: 'Matematika', average: 4.5, count: 2, lastValue: 4 }),
    ]);
    expect(data.recent).toHaveLength(3);
    // o'qituvchi boshqa o'qituvchining izohini ko'rmaydi
    const t = await sum(tm, s1.id);
    expect(t.status).toBe(200);
    expect(
      t.body.data.recent.find((r: { subject: { name: string } }) => r.subject.name === 'Fizika')
        .comment,
    ).toBeNull();
    // admin izohni ko'radi
    expect(
      data.recent.find((r: { subject: { name: string } }) => r.subject.name === 'Fizika').comment,
    ).toBe('fizika izohi');
    // scoping: o'z sinfi bo'lmagan o'qituvchi 404; begona maktab 404; ruxsatsiz 403
    expect((await sum(tm, s3.id)).status).toBe(404);
    expect((await sum(tx, s1.id)).status).toBe(404);
    expect((await sum(noperm, s1.id)).status).toBe(403);
    expect((await sum(root, s1.id, { 'X-School-Id': school.id })).status).toBe(200);
    // bo'sh davr
    const empty = await request(app)
      .get(`/api/v1/students/${s2.id}/grade-summary?from=2020-01-01&to=2020-01-31`)
      .set(bearer(gAdmin));
    expect(empty.body.data).toMatchObject({
      average: null,
      average100: null,
      gradesCount: 0,
      bySubject: [],
    });
    expect(
      (
        await request(app)
          .get(`/api/v1/students/${s2.id}/grade-summary?from=2026-02-01&to=2026-01-01`)
          .set(bearer(gAdmin))
      ).status,
    ).toBe(400);
  });
});
