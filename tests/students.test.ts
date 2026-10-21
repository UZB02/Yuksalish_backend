import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Student } from '../src/models/Student';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { readXlsx } from './helpers/xlsx';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let token: string;
let teacher: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  await makeUser({
    username: 'adm',
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
  await makeUser({
    username: 'nope',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  await makeUser({
    username: 'adm2',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ADMIN_PERMS,
  });
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [teacher.id]);
  c6 = await makeClass(school.id, year.id, '6-A');
  token = (await login('adm')).token;
});

const post = (t: string, b: object) => request(app).post('/api/v1/students').set(bearer(t)).send(b);

describe("O'quvchilar CRUD", () => {
  it('yaratish: DTO shakli, ism normalizatsiyasi, audit, tarix', async () => {
    const res = await post(token, {
      fullName: '  Aliyev   Vali  ',
      studentCode: 'S-1',
      birthDate: '2013-03-15',
      gender: 'male',
      classId: c5.id,
      parentPhone: '+998901234567',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fullName: 'Aliyev Vali',
      studentCode: 'S-1',
      birthDate: '2013-03-15',
      gender: 'male',
      classId: c5.id,
      class: { id: c5.id, name: '5-A' },
      parentPhone: '+998901234567',
      photoUrl: null,
      status: 'active',
    });
    expect(res.body.data).not.toHaveProperty('isDeleted');
    expect(res.body.data).not.toHaveProperty('classHistory');
    expect(await AuditLog.countDocuments({ action: 'student.create' })).toBe(1);
    const doc = await Student.findById(res.body.data.id);
    expect(doc!.classHistory).toHaveLength(1);
  });

  it("minimal maydonlar, noto'g'ri qiymatlar 400, noma'lum sinf 400", async () => {
    expect((await post(token, { fullName: 'Ali Valiyev', classId: c5.id })).status).toBe(201);
    const bad = await post(token, {
      fullName: 'A',
      classId: c5.id,
      gender: 'x',
      birthDate: '2013-02-31',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'birthDate',
      'fullName',
      'gender',
    ]);
    const noClass = await post(token, {
      fullName: 'Ali Valiyev',
      classId: '64b64b64b64b64b64b64b64b',
    });
    expect(noClass.status).toBe(400);
    expect(noClass.body.error.details[0].path).toBe('classId');
  });

  it("dublikat: ID unique; ID yo'q bo'lsa F.I.Sh.+tug'ilgan sana; o'chirilgach qayta ishlatiladi", async () => {
    const first = await post(token, { fullName: 'Ali Valiyev', studentCode: 'X1', classId: c5.id });
    expect(first.status).toBe(201);
    const dupCode = await post(token, {
      fullName: 'Boshqa Odam',
      studentCode: 'X1',
      classId: c6.id,
    });
    expect(dupCode.status).toBe(409);
    expect(dupCode.body.error.code).toBe('CONFLICT');
    expect(dupCode.body.error.details[0].path).toBe('studentCode');

    expect(
      (await post(token, { fullName: 'Vali Karimov', birthDate: '2013-01-02', classId: c5.id }))
        .status,
    ).toBe(201);
    const dupName = await post(token, {
      fullName: ' vali   KARIMOV',
      birthDate: '2013-01-02',
      classId: c6.id,
    });
    expect(dupName.status).toBe(409);
    expect(dupName.body.error.details[0].path).toBe('fullName');
    // Boshqa tug'ilgan sana — boshqa o'quvchi
    expect(
      (await post(token, { fullName: 'Vali Karimov', birthDate: '2013-01-03', classId: c5.id }))
        .status,
    ).toBe(201);

    await request(app).delete(`/api/v1/students/${first.body.data.id}`).set(bearer(token));
    expect(
      (await post(token, { fullName: 'Yangi Bola', studentCode: 'X1', classId: c5.id })).status,
    ).toBe(201);

    // Boshqa maktabda bir xil ID mumkin
    const o = (await login('adm2')).token;
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    expect(
      (await post(o, { fullName: 'Ali Valiyev', studentCode: 'X1', classId: oc.id })).status,
    ).toBe(201);
  });

  it('PATCH: maydonlarni yangilash, dublikatga tushmaslik, null bilan tozalash', async () => {
    const a = (
      await post(token, {
        fullName: 'Ali Valiyev',
        studentCode: 'A1',
        gender: 'male',
        classId: c5.id,
      })
    ).body.data;
    const b = (await post(token, { fullName: 'Bobur Karimov', studentCode: 'B1', classId: c5.id }))
      .body.data;

    const upd = await request(app).patch(`/api/v1/students/${a.id}`).set(bearer(token)).send({
      fullName: 'Ali  Valiyev Jr',
      status: 'graduated',
      gender: null,
      parentPhone: '+998901112233',
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({
      fullName: 'Ali Valiyev Jr',
      status: 'graduated',
      gender: null,
    });

    const clash = await request(app)
      .patch(`/api/v1/students/${b.id}`)
      .set(bearer(token))
      .send({ studentCode: 'A1' });
    expect(clash.status).toBe(409);
    const clear = await request(app)
      .patch(`/api/v1/students/${a.id}`)
      .set(bearer(token))
      .send({ studentCode: null, parentPhone: null });
    expect(clear.body.data).toMatchObject({ studentCode: null, parentPhone: null });
  });

  it("soft delete: ro'yxat/GET dan yo'qoladi, bazada qoladi", async () => {
    const s = (await post(token, { fullName: 'Ali Valiyev', classId: c5.id })).body.data;
    expect((await request(app).delete(`/api/v1/students/${s.id}`).set(bearer(token))).status).toBe(
      200,
    );
    expect((await request(app).get(`/api/v1/students/${s.id}`).set(bearer(token))).status).toBe(
      404,
    );
    expect((await request(app).get('/api/v1/students').set(bearer(token))).body.data).toHaveLength(
      0,
    );
    expect((await Student.findById(s.id))!.isDeleted).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'student.delete' })).toBe(1);
  });

  it("ro'yxat: filtrlar, qidiruv (regex injection himoyasi), sahifalash", async () => {
    await makeStudent(school.id, c5.id, 'Ali Valiyev', { studentCode: 'K-100' });
    await makeStudent(school.id, c5.id, 'Bobur Karimov', { status: 'transferred' });
    await makeStudent(school.id, c6.id, 'Vali (Test) Aliyev');
    const get = (q: string) => request(app).get(`/api/v1/students${q}`).set(bearer(token));

    expect((await get('')).body.meta).toMatchObject({ total: 3, page: 1, limit: 20 });
    expect((await get(`?classId=${c5.id}`)).body.data).toHaveLength(2);
    expect(
      (await get('?status=transferred')).body.data.map((s: { fullName: string }) => s.fullName),
    ).toEqual(['Bobur Karimov']);
    expect((await get('?search=k-100')).body.data).toHaveLength(1);
    expect((await get('?search=ali')).body.data).toHaveLength(2);
    expect((await get('?search=' + encodeURIComponent('(Test)'))).body.data).toHaveLength(1);
    const evil = await get('?search=' + encodeURIComponent('(((.*['));
    expect(evil.status).toBe(200);
    expect(evil.body.data).toHaveLength(0);
    const page = await get('?limit=2&page=2');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect((await get('?limit=1000')).status).toBe(400);
  });

  it("transfer: sinf almashadi, tarix yoziladi, o'sha sinfga qayta yoki noma'lum sinfga 400", async () => {
    const s = (await post(token, { fullName: 'Ali Valiyev', classId: c5.id })).body.data;
    const tr = await request(app)
      .post(`/api/v1/students/${s.id}/transfer`)
      .set(bearer(token))
      .send({ classId: c6.id });
    expect(tr.status).toBe(200);
    expect(tr.body.data.class).toEqual({ id: c6.id, name: '6-A' });

    const doc = await Student.findById(s.id);
    expect(doc!.classHistory).toHaveLength(2);
    expect(doc!.classHistory[0].to).toBeTruthy();
    expect(doc!.classHistory[1].to).toBeNull();
    expect(String(doc!.classHistory[1].classId)).toBe(c6.id);

    expect(
      (
        await request(app)
          .post(`/api/v1/students/${s.id}/transfer`)
          .set(bearer(token))
          .send({ classId: c6.id })
      ).status,
    ).toBe(400);
    const oy = await makeYear(other.id);
    const foreign = await makeClass(other.id, oy.id, '9-A');
    expect(
      (
        await request(app)
          .post(`/api/v1/students/${s.id}/transfer`)
          .set(bearer(token))
          .send({ classId: foreign.id })
      ).status,
    ).toBe(400);
  });

  it('eksport: xlsx, shablon ustunlari bilan bir xil', async () => {
    await makeStudent(school.id, c5.id, 'Ali Valiyev', {
      studentCode: 'K1',
      gender: 'male',
      birthDate: new Date('2013-03-15'),
    });
    await makeStudent(school.id, c6.id, 'Boshqa Sinf');
    const res = await request(app)
      .get(`/api/v1/students/export?classId=${c5.id}`)
      .set(bearer(token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const rows = await readXlsx(res.body as Buffer);
    expect(rows[0]).toEqual([
      'F.I.Sh.',
      'Sinf',
      "Tug'ilgan sana",
      'Jinsi',
      'ID',
      'Ota-ona telefoni',
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['Ali Valiyev', '5-A', '15.03.2013', 'Erkak', 'K1', '']);
  });
});

describe("O'quvchilar: ruxsat, scoping va tenant", () => {
  it("o'qituvchi faqat o'z sinfi o'quvchilarini ko'radi; boshqa sinf o'quvchisi 404; yoza olmaydi", async () => {
    const mine = await makeStudent(school.id, c5.id, 'Mening Bolam');
    const theirs = await makeStudent(school.id, c6.id, 'Begona Bola');
    const tt = (await login('teacher1')).token;

    const list = await request(app).get('/api/v1/students').set(bearer(tt));
    expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([mine.id]);
    // Begona sinf bo'yicha filtr ham bo'sh
    expect(
      (await request(app).get(`/api/v1/students?classId=${c6.id}`).set(bearer(tt))).body.data,
    ).toHaveLength(0);
    expect((await request(app).get(`/api/v1/students/${mine.id}`).set(bearer(tt))).status).toBe(
      200,
    );
    expect((await request(app).get(`/api/v1/students/${theirs.id}`).set(bearer(tt))).status).toBe(
      404,
    );

    expect((await post(tt, { fullName: 'Yangi Bola', classId: c5.id })).status).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/v1/students/${mine.id}`)
          .set(bearer(tt))
          .send({ fullName: 'Hack Hack' })
      ).status,
    ).toBe(403);
    expect((await request(app).delete(`/api/v1/students/${mine.id}`).set(bearer(tt))).status).toBe(
      403,
    );
    expect(
      (await request(app).get('/api/v1/students/import/template').set(bearer(tt))).status,
    ).toBe(403);

    const exp = await request(app)
      .get('/api/v1/students/export')
      .set(bearer(tt))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect((await readXlsx(exp.body as Buffer)).length).toBe(2); // sarlavha + 1 o'quvchi

    // Biriktirish olib tashlansa ko'rinmaydi
    await request(app)
      .put(`/api/v1/teachers/${teacher.id}/classes`)
      .set(bearer(token))
      .send({ classIds: [] });
    expect((await request(app).get(`/api/v1/students/${mine.id}`).set(bearer(tt))).status).toBe(
      404,
    );
  });

  it("school_admin: students.view bilan faqat o'qiydi; ruxsatsiz 403", async () => {
    const s = await makeStudent(school.id, c5.id, 'Ali Valiyev');
    const v = (await login('viewer')).token;
    expect((await request(app).get('/api/v1/students').set(bearer(v))).body.data).toHaveLength(1);
    expect((await request(app).get(`/api/v1/students/${s.id}`).set(bearer(v))).status).toBe(200);
    expect((await post(v, { fullName: 'Yangi Bola', classId: c5.id })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/students/${s.id}`).set(bearer(v))).status).toBe(403);

    const n = (await login('nope')).token;
    expect((await request(app).get('/api/v1/students').set(bearer(n))).status).toBe(403);
    expect((await request(app).get('/api/v1/students')).status).toBe(401);
  });

  it("tenant: boshqa maktab o'quvchisi barcha amallarda 404; superadmin X-School-Id talab qiladi", async () => {
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const foreign = await makeStudent(other.id, oc.id, 'Chet Maktab');
    for (const [method, path, payload] of [
      ['get', `/api/v1/students/${foreign.id}`, undefined],
      ['patch', `/api/v1/students/${foreign.id}`, { fullName: 'Hack Hack' }],
      ['delete', `/api/v1/students/${foreign.id}`, undefined],
      ['post', `/api/v1/students/${foreign.id}/transfer`, { classId: c5.id }],
    ] as const) {
      const r = await request(app)[method](path).set(bearer(token)).send(payload);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect((await request(app).get('/api/v1/students').set(bearer(token))).body.data).toHaveLength(
      0,
    );

    const root = (await login('root')).token;
    expect((await request(app).get('/api/v1/students').set(bearer(root))).status).toBe(400);
    const r = await request(app)
      .get('/api/v1/students')
      .set(bearer(root))
      .set('X-School-Id', other.id);
    expect(r.body.data).toHaveLength(1);
    // Superadmin A kontekstida B o'quvchisini ko'rmaydi
    expect(
      (
        await request(app)
          .get(`/api/v1/students/${foreign.id}`)
          .set(bearer(root))
          .set('X-School-Id', school.id)
      ).status,
    ).toBe(404);
  });
});
