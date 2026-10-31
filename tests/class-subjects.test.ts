import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ClassModel } from '../src/models/Class';
import { ClassSubject } from '../src/models/ClassSubject';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string };
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let math: Doc, phys: Doc, inactive: Doc, schoolSubj: Doc, foreignSubj: Doc;
let tMath: Doc, tPhys: Doc, tOther: Doc, tOff: Doc;
let cls: Awaited<ReturnType<typeof makeClass>>;
let root: string, admin: string, viewer: string, tm: string;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  inactive = await makeSubject('Eski fan', null, { isActive: false });
  schoolSubj = await makeSubject('Shaxmat', school.id);
  foreignSubj = await makeSubject('Begona', other.id);
  tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tPhys = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  tOther = await makeUser({ username: 'tother', role: 'teacher', schoolId: other.id });
  tOff = await makeUser({
    username: 'toff',
    role: 'teacher',
    schoolId: school.id,
    isActive: false,
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'viewer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  cls = await makeClass(school.id, year.id, '7-A');
  [root, admin, viewer, tm] = await Promise.all(
    ['root', 'admin', 'viewer', 'tmath'].map(async (u) => (await login(u)).token),
  );
});

const putSubjects = (t: string, id: string, subjects: object[], h: Record<string, string> = {}) =>
  request(app).put(`/api/v1/classes/${id}/subjects`).set(bearer(t)).set(h).send({ subjects });
const getClass = (t: string, id: string) =>
  request(app).get(`/api/v1/classes/${id}`).set(bearer(t));

describe("Sinfga fan + o'qituvchi biriktirish", () => {
  it("bir fanga bir nechta o'qituvchi: ikkalasi saqlanadi, DTO'da ikkala juftlik, o'qituvchi almashtirilganda faqat o'sha juftlik o'zgaradi", async () => {
    const res = await putSubjects(admin, cls.id, [
      { subjectId: math.id, teacherId: tMath.id },
      { subjectId: math.id, teacherId: tPhys.id },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.subjects).toHaveLength(2);
    expect(res.body.data.subjects.map((s: { teacherId: string }) => s.teacherId).sort()).toEqual(
      [tMath.id, tPhys.id].sort(),
    );
    expect(await ClassSubject.countDocuments({ classId: cls.id })).toBe(2);
    const c = await ClassModel.findById(cls.id);
    expect(c?.teacherIds.map(String)).toEqual(expect.arrayContaining([tMath.id, tPhys.id]));
    // bitta juftlikni olib tashlash ikkinchisiga tegmaydi
    const r2 = await putSubjects(admin, cls.id, [{ subjectId: math.id, teacherId: tPhys.id }]);
    expect(r2.status).toBe(200);
    const rows = await ClassSubject.find({ classId: cls.id });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].teacherId)).toBe(tPhys.id);
  });

  it("unique indeks: (sinf, fan, o'qituvchi) takrorlanmaydi, lekin (sinf, fan) takrorlanishi mumkin", async () => {
    await ClassSubject.syncIndexes();
    const base = {
      schoolId: school.id,
      classId: cls.id,
      academicYearId: year.id,
      subjectId: math.id,
    };
    await ClassSubject.create({ ...base, teacherId: tMath.id });
    await ClassSubject.create({ ...base, teacherId: tPhys.id });
    await expect(ClassSubject.create({ ...base, teacherId: tMath.id })).rejects.toThrow(/E11000/);
  });

  it("biriktiradi: DTO'da subjects, o'qituvchilar sinf teacherIds ga avtomatik qo'shiladi, audit", async () => {
    const res = await putSubjects(admin, cls.id, [
      { subjectId: math.id, teacherId: tMath.id },
      { subjectId: phys.id, teacherId: tPhys.id },
      { subjectId: schoolSubj.id, teacherId: tMath.id },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.subjects).toHaveLength(3);
    expect(res.body.data.subjects).toEqual(
      expect.arrayContaining([
        {
          subjectId: math.id,
          subject: { id: math.id, name: 'Matematika' },
          teacherId: tMath.id,
          teacher: { id: tMath.id, fullName: 'Test tmath' },
        },
      ]),
    );
    expect(res.body.data.teacherIds.sort()).toEqual([tMath.id, tPhys.id].sort());
    const saved = await ClassModel.findById(cls.id);
    expect(saved?.teacherIds.map(String).sort()).toEqual([tMath.id, tPhys.id].sort());
    expect(await ClassSubject.countDocuments({ classId: cls.id })).toBe(3);
    expect(await AuditLog.countDocuments({ action: 'class.subjects' })).toBe(1);

    // O'qituvchi biriktirilgan sinfni ko'radi (teacherIds orqali kirish huquqi)
    const own = await getClass(tm, cls.id);
    expect(own.status).toBe(200);
    expect(own.body.data.subjects).toHaveLength(3);
  });

  it("to'liq almashtiradi: olib tashlangan biriktirish o'chadi, o'qituvchi almashadi; o'zgarmasa audit yozilmaydi", async () => {
    await putSubjects(admin, cls.id, [
      { subjectId: math.id, teacherId: tMath.id },
      { subjectId: phys.id, teacherId: tPhys.id },
    ]);
    const r = await putSubjects(admin, cls.id, [{ subjectId: math.id, teacherId: tPhys.id }]);
    expect(r.status).toBe(200);
    const rows = await ClassSubject.find({ classId: cls.id });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].teacherId)).toBe(tPhys.id);
    const auditBefore = await AuditLog.countDocuments({ action: 'class.subjects' });
    await putSubjects(admin, cls.id, [{ subjectId: math.id, teacherId: tPhys.id }]);
    expect(await AuditLog.countDocuments({ action: 'class.subjects' })).toBe(auditBefore);
    expect((await putSubjects(admin, cls.id, [])).body.data.subjects).toEqual([]);
    expect(await ClassSubject.countDocuments({ classId: cls.id })).toBe(0);
  });

  it("validatsiya: takroriy (fan, o'qituvchi) juftligi, boshqa maktab o'qituvchisi/fani, nofaol fan va o'qituvchi, noto'g'ri id", async () => {
    const bad = async (subjects: object[]) => {
      const r = await putSubjects(admin, cls.id, subjects);
      expect(r.status, JSON.stringify(subjects)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    };
    // Aynan bir xil juftlik rad etiladi (bir fanga boshqa o'qituvchi esa mumkin: ko'p o'qituvchi)
    await bad([
      { subjectId: math.id, teacherId: tMath.id },
      { subjectId: math.id, teacherId: tMath.id },
    ]);
    await bad([{ subjectId: math.id, teacherId: tOther.id }]); // boshqa maktab o'qituvchisi
    await bad([{ subjectId: foreignSubj.id, teacherId: tMath.id }]); // boshqa maktab fani
    await bad([{ subjectId: inactive.id, teacherId: tMath.id }]); // nofaol fan
    await bad([{ subjectId: math.id, teacherId: tOff.id }]); // nofaol o'qituvchi
    await bad([{ subjectId: '0'.repeat(24), teacherId: tMath.id }]); // mavjud emas
    await bad([{ subjectId: 'x', teacherId: tMath.id }]);
    expect(await ClassSubject.countDocuments({})).toBe(0);
    // maktab admini o'zining maktab fanini biriktira oladi
    expect(
      (await putSubjects(admin, cls.id, [{ subjectId: schoolSubj.id, teacherId: tMath.id }]))
        .status,
    ).toBe(200);
  });

  it('huquq va tenant: classes.manage kerak; begona maktab sinfi 404; superadmin X-School-Id bilan', async () => {
    const items = [{ subjectId: math.id, teacherId: tMath.id }];
    expect((await putSubjects(viewer, cls.id, items)).status).toBe(403);
    expect((await putSubjects(tm, cls.id, items)).status).toBe(403);
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '7-A');
    expect((await putSubjects(admin, oc.id, items)).status).toBe(404);
    expect((await putSubjects(root, cls.id, items)).status).toBe(400); // header yo'q
    expect((await putSubjects(root, cls.id, items, { 'X-School-Id': school.id })).status).toBe(200);
  });

  it("sinf yaratish/yangilash bilan birga fanlar beriladi; teacherIds dan chiqarilgan o'qituvchining biriktirishlari o'chadi", async () => {
    const create = await request(app)
      .post('/api/v1/classes')
      .set(bearer(admin))
      .send({
        name: '8-B',
        grade: 8,
        subjects: [{ subjectId: math.id, teacherId: tMath.id }],
      });
    expect(create.status).toBe(201);
    expect(create.body.data.subjects).toHaveLength(1);
    expect(create.body.data.teacherIds).toEqual([tMath.id]);
    const id = create.body.data.id as string;

    const upd = await request(app)
      .patch(`/api/v1/classes/${id}`)
      .set(bearer(admin))
      .send({
        subjects: [
          { subjectId: math.id, teacherId: tMath.id },
          { subjectId: phys.id, teacherId: tPhys.id },
        ],
      });
    expect(upd.status).toBe(200);
    expect(upd.body.data.subjects).toHaveLength(2);

    // tPhys sinfdan chiqariladi -> uning fan biriktirishi ham o'chadi
    const rm = await request(app)
      .patch(`/api/v1/classes/${id}`)
      .set(bearer(admin))
      .send({ teacherIds: [tMath.id] });
    expect(rm.status).toBe(200);
    expect(rm.body.data.subjects.map((s: { subjectId: string }) => s.subjectId)).toEqual([math.id]);

    // PUT /:id/teachers va teacher.classes orqali ham
    await putSubjects(admin, id, [{ subjectId: phys.id, teacherId: tPhys.id }]);
    const t = await request(app)
      .put(`/api/v1/classes/${id}/teachers`)
      .set(bearer(admin))
      .send({ teacherIds: [tMath.id], homeroomTeacherId: null });
    expect(t.status).toBe(200);
    expect(await ClassSubject.countDocuments({ classId: id })).toBe(0);

    await putSubjects(admin, id, [{ subjectId: math.id, teacherId: tMath.id }]);
    const tc = await request(app)
      .put(`/api/v1/teachers/${tMath.id}/classes`)
      .set(bearer(admin))
      .send({ classIds: [] });
    expect(tc.status).toBe(200);
    expect(await ClassSubject.countDocuments({ classId: id })).toBe(0);
  });

  it("o'qituvchilar ro'yxati: subjectAssignments va homeroomClasses", async () => {
    await ClassModel.updateOne({ _id: cls.id }, { homeroomTeacherId: tMath.id });
    await putSubjects(admin, cls.id, [
      { subjectId: math.id, teacherId: tMath.id },
      { subjectId: phys.id, teacherId: tMath.id },
    ]);
    const res = await request(app).get(`/api/v1/teachers/${tMath.id}`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.subjectAssignments).toEqual([
      { classId: cls.id, className: '7-A', subjectId: phys.id, subjectName: 'Fizika' },
      { classId: cls.id, className: '7-A', subjectId: math.id, subjectName: 'Matematika' },
    ]);
    expect(res.body.data.homeroomClasses).toEqual([{ id: cls.id, name: '7-A' }]);
    const list = await request(app).get('/api/v1/teachers').set(bearer(admin));
    const phy = list.body.data.find((t: { id: string }) => t.id === tPhys.id);
    expect(phy.subjectAssignments).toEqual([]);
    expect(phy.homeroomClasses).toEqual([]);
  });
});
