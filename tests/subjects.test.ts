import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Subject } from '../src/models/Subject';
import { DEFAULT_SUBJECTS, ensureDefaultSubjects } from '../src/modules/subjects/subjects.defaults';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  assignSubject,
  SubjectGrade,
  useTestDb,
} from './helpers';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let root: string, mgr: string, noperm: string, otherMgr: string, teacher: string;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'mgr',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['subjects.manage'],
  });
  await makeUser({
    username: 'noperm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'omgr',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['subjects.manage'],
  });
  await makeUser({ username: 'teacher', role: 'teacher', schoolId: school.id });
  [root, mgr, noperm, otherMgr, teacher] = await Promise.all(
    ['root', 'mgr', 'noperm', 'omgr', 'teacher'].map(async (u) => (await login(u)).token),
  );
});

const post = (t: string, body: object) =>
  request(app).post('/api/v1/subjects').set(bearer(t)).send(body);
const list = (t: string, q = '', h: Record<string, string> = {}) =>
  request(app).get(`/api/v1/subjects${q}`).set(bearer(t)).set(h);

describe('Fanlar (subjects)', () => {
  it('seed: standart global fanlar idempotent yaratiladi', async () => {
    expect(await ensureDefaultSubjects()).toBe(DEFAULT_SUBJECTS.length);
    expect(await ensureDefaultSubjects()).toBe(0);
    expect(await Subject.countDocuments({ schoolId: null })).toBe(DEFAULT_SUBJECTS.length);
    expect(DEFAULT_SUBJECTS).toContain('Matematika');
    expect(DEFAULT_SUBJECTS).toContain("Tasviriy san'at");
  });

  it('superadmin global fan yaratadi (schoolId yo`q) va maktab fani (schoolId bilan)', async () => {
    const g = await post(root, { name: '  Astronomiya ' });
    expect(g.status).toBe(201);
    expect(g.body.data).toMatchObject({ name: 'Astronomiya', schoolId: null, isActive: true });
    const s = await post(root, { name: 'Shaxmat', schoolId: school.id });
    expect(s.status).toBe(201);
    expect(s.body.data.schoolId).toBe(school.id);
    expect((await post(root, { name: 'Zzz', schoolId: '0'.repeat(24) })).status).toBe(400);
    expect(await AuditLog.countDocuments({ action: 'subject.create' })).toBe(2);
  });

  it("school_admin (subjects.manage) faqat o'z maktabiga fan qo'shadi; ruxsatsiz 403", async () => {
    const res = await post(mgr, { name: 'Shaxmat' });
    expect(res.status).toBe(201);
    expect(res.body.data.schoolId).toBe(school.id);
    // boshqa maktab uchun yoki global fan yaratib bo'lmaydi
    expect((await post(mgr, { name: 'Boshqa', schoolId: other.id })).status).toBe(403);
    expect((await post(noperm, { name: 'Ruxsatsiz' })).status).toBe(403);
    expect((await post(teacher, { name: 'Ruxsatsiz' })).status).toBe(403);
  });

  it('nom unique: scope ichida va maktab fani global nomni takrorlay olmaydi', async () => {
    await makeSubject('Matematika');
    expect((await post(root, { name: 'matematika' })).status).toBe(409);
    expect((await post(mgr, { name: 'MATEMATIKA' })).status).toBe(409); // global bor
    expect((await post(mgr, { name: 'Shaxmat' })).status).toBe(201);
    expect((await post(mgr, { name: 'shaxmat' })).status).toBe(409);
    // boshqa maktabda bir xil nom mumkin
    expect((await post(otherMgr, { name: 'Shaxmat' })).status).toBe(201);
  });

  it("ro'yxat: global + o'z maktabi; boshqa maktab fani ko'rinmaydi; scope va isActive filtri", async () => {
    await makeSubject('Matematika');
    await makeSubject('Shaxmat', school.id);
    await makeSubject('Boshqa maktab fani', other.id);
    await makeSubject('Eski', null, { isActive: false });

    const names = (r: request.Response) => r.body.data.map((s: { name: string }) => s.name).sort();
    expect(names(await list(teacher))).toEqual(['Eski', 'Matematika', 'Shaxmat']);
    expect(names(await list(teacher, '?isActive=true'))).toEqual(['Matematika', 'Shaxmat']);
    expect(names(await list(mgr, '?scope=global&isActive=true'))).toEqual(['Matematika']);
    expect(names(await list(mgr, '?scope=school'))).toEqual(['Shaxmat']);
    // superadmin headersiz hammasini ko'radi, header bilan faqat shu maktab doirasida
    expect((await list(root)).body.data).toHaveLength(4);
    expect(names(await list(root, '', { 'X-School-Id': school.id }))).toEqual([
      'Eski',
      'Matematika',
      'Shaxmat',
    ]);
    expect((await request(app).get('/api/v1/subjects')).status).toBe(401);
  });

  it("tahrirlash/nofaol qilish: global fanni faqat superadmin; boshqa maktab fani 404; o'z fanini admin", async () => {
    const g = await makeSubject('Matematika');
    const own = await makeSubject('Shaxmat', school.id);
    const foreign = await makeSubject('Begona', other.id);
    const patch = (t: string, id: string, body: object) =>
      request(app).patch(`/api/v1/subjects/${id}`).set(bearer(t)).send(body);
    const act = (t: string, id: string, a: string) =>
      request(app).post(`/api/v1/subjects/${id}/${a}`).set(bearer(t));

    expect((await patch(mgr, g.id, { name: 'XX' })).status).toBe(403);
    expect((await act(mgr, g.id, 'deactivate')).status).toBe(403);
    expect((await patch(mgr, foreign.id, { name: 'XX' })).status).toBe(404);
    expect((await act(mgr, foreign.id, 'deactivate')).status).toBe(404);

    const r = await patch(mgr, own.id, { name: 'Shaxmat 2', order: 7 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Shaxmat 2', order: 7 });
    expect((await act(mgr, own.id, 'deactivate')).body.data.isActive).toBe(false);
    expect((await act(mgr, own.id, 'activate')).body.data.isActive).toBe(true);
    expect((await patch(root, g.id, { name: 'Matematika 2' })).body.data.name).toBe('Matematika 2');
    expect((await patch(mgr, own.id, { name: 'matematika 2' })).status).toBe(409);
    expect((await patch(root, 'nope', { name: 'XX' })).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'subject.update' })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'subject.deactivate' })).toBe(1);
  });

  it("o'chirish: foydalanilmagan fan o'chadi, sinfga biriktirilgan yoki baholangan fan 409 (nofaol qilish kerak)", async () => {
    const del = (t: string, id: string) =>
      request(app).delete(`/api/v1/subjects/${id}`).set(bearer(t));
    const free = await makeSubject('Bo`sh', school.id);
    expect((await del(mgr, free.id)).status).toBe(200);
    expect(await Subject.countDocuments({ _id: free.id })).toBe(0);

    const year = await makeYear(school.id);
    const t = await makeUser({ username: 't1', role: 'teacher', schoolId: school.id });
    const cls = await makeClass(school.id, year.id, '5-A');
    const used = await makeSubject('Ishlatilgan', school.id);
    await assignSubject(school.id, cls, used.id, t.id);
    const r = await del(mgr, used.id);
    expect(r.status).toBe(409);

    const graded = await makeSubject('Baholangan', school.id);
    const st = await makeStudent(school.id, cls.id, 'Aliyev Ali');
    await SubjectGrade.create({
      schoolId: school.id,
      studentId: st.id,
      classId: cls.id,
      subjectId: graded.id,
      teacherId: t.id,
      academicYearId: year.id,
      value: 5,
      date: '2026-10-01',
    });
    expect((await del(mgr, graded.id)).status).toBe(409);
    expect((await del(noperm, graded.id)).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'subject.delete' })).toBe(1);
  });

  it('validatsiya: nom uzunligi, order', async () => {
    expect((await post(root, { name: 'A' })).status).toBe(400);
    expect((await post(root, { name: 'Valid', order: -1 })).status).toBe(400);
    expect((await post(root, {})).status).toBe(400);
  });
});
