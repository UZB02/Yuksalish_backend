import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

let schoolA: Awaited<ReturnType<typeof makeSchool>>;
let schoolB: Awaited<ReturnType<typeof makeSchool>>;
let teacherA: Awaited<ReturnType<typeof makeUser>>;
let teacherB: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  schoolA = await makeSchool('a');
  schoolB = await makeSchool('b');
  await makeUser({
    username: 'adminA',
    role: 'school_admin',
    schoolId: schoolA.id,
    permissions: ['teachers.manage'],
  });
  await makeUser({
    username: 'adminB',
    role: 'school_admin',
    schoolId: schoolB.id,
    permissions: ['teachers.manage'],
  });
  teacherA = await makeUser({ username: 'teacher.a', role: 'teacher', schoolId: schoolA.id });
  teacherB = await makeUser({ username: 'teacher.b', role: 'teacher', schoolId: schoolB.id });
  await makeUser({ username: 'root', role: 'superadmin' });
});

describe('Tenant izolyatsiya', () => {
  it("A maktab admini faqat o'z o'qituvchilarini ro'yxatda ko'radi", async () => {
    const { token } = await login('adminA');
    const res = await request(app).get('/api/v1/teachers').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { username: string }) => t.username)).toEqual(['teacher.a']);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it("A maktab admini B maktab o'qituvchisini ko'ra/o'zgartira olmaydi (404)", async () => {
    const { token } = await login('adminA');
    const id = teacherB.id;

    expect((await request(app).get(`/api/v1/teachers/${id}`).set(bearer(token))).status).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/v1/teachers/${id}`)
          .set(bearer(token))
          .send({ fullName: 'Hack' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .put(`/api/v1/teachers/${id}/permissions`)
          .set(bearer(token))
          .send({ permissions: [] })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/v1/teachers/${id}/reset-password`)
          .set(bearer(token))
          .send({ newPassword: 'Hacked123' })
      ).status,
    ).toBe(404);
    // O'z o'qituvchisi ko'rinadi
    expect(
      (await request(app).get(`/api/v1/teachers/${teacherA.id}`).set(bearer(token))).status,
    ).toBe(200);
  });

  it("noto'g'ri formatdagi id ham 404 (mavjudlik oshkor qilinmaydi)", async () => {
    const { token } = await login('adminA');
    expect((await request(app).get('/api/v1/teachers/abc').set(bearer(token))).status).toBe(404);
  });

  it("X-School-Id header maktab admini uchun e'tiborga olinmaydi", async () => {
    const { token } = await login('adminA');
    const res = await request(app)
      .get('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', schoolB.id);
    expect(res.body.data.map((t: { username: string }) => t.username)).toEqual(['teacher.a']);
  });

  it("maktab admini yaratgan o'qituvchi doim o'z maktabiga tegishli", async () => {
    const { token } = await login('adminA');
    const res = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', schoolB.id)
      .send({
        fullName: 'Yangi Ustoz',
        username: 'new.teacher',
        password: 'Passw0rd1',
        schoolId: schoolB.id,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.schoolId).toBe(schoolA.id);
    expect(res.body.data.permissions).toContain('scores.create');
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });

  it("superadmin: X-School-Id majburiy (400), bor bo'lsa shu maktab bo'yicha ishlaydi", async () => {
    const { token } = await login('root');
    const none = await request(app).get('/api/v1/teachers').set(bearer(token));
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');

    const bad = await request(app)
      .get('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', 'xyz');
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .get('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', '64b64b64b64b64b64b64b64b');
    expect(missing.status).toBe(404);

    const a = await request(app)
      .get('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', schoolA.id);
    expect(a.body.data.map((t: { username: string }) => t.username)).toEqual(['teacher.a']);
    const b = await request(app)
      .get('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', schoolB.id);
    expect(b.body.data.map((t: { username: string }) => t.username)).toEqual(['teacher.b']);

    // Superadmin A kontekstida B o'qituvchisini ko'ra olmaydi
    const cross = await request(app)
      .get(`/api/v1/teachers/${teacherB.id}`)
      .set(bearer(token))
      .set('X-School-Id', schoolA.id);
    expect(cross.status).toBe(404);
  });

  it('login yagona (global) — boshqa maktabda ham band', async () => {
    const { token } = await login('adminA');
    const res = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .send({ fullName: 'Dublikat', username: 'Teacher.B', password: 'Passw0rd1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('nofaol maktab foydalanuvchisining mavjud tokeni ishlamay qoladi', async () => {
    const { token } = await login('adminA');
    schoolA.isActive = false;
    await schoolA.save();
    expect((await request(app).get('/api/v1/teachers').set(bearer(token))).status).toBe(401);
  });
});
