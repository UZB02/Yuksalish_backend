import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;

beforeEach(async () => {
  school = await makeSchool('a');
  await makeUser({ username: 'root', role: 'superadmin' });
});

const newTeacher = (extra: Record<string, unknown> = {}) => ({
  fullName: 'Ustoz Ustozov',
  username: 'ustoz1',
  password: 'Passw0rd1',
  ...extra,
});

describe('Ruxsatlar (permissions)', () => {
  it("teachers.manage ruxsati yo'q maktab admini 403 oladi", async () => {
    await makeUser({
      username: 'adm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['dashboard.view'],
    });
    const { token } = await login('adm');
    const res = await request(app).get('/api/v1/teachers').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(
      (await request(app).post('/api/v1/teachers').set(bearer(token)).send(newTeacher())).status,
    ).toBe(403);
  });

  it("o'qituvchi (teacher roli) o'qituvchilar bo'limiga kira olmaydi", async () => {
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    const { token } = await login('tch');
    expect((await request(app).get('/api/v1/teachers').set(bearer(token))).status).toBe(403);
  });

  it("maktab admini va o'qituvchi /schools va /school-admins ga kira olmaydi", async () => {
    await makeUser({
      username: 'adm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['teachers.manage'],
    });
    const { token } = await login('adm');
    for (const path of ['/api/v1/schools', '/api/v1/school-admins']) {
      expect((await request(app).get(path).set(bearer(token))).status).toBe(403);
    }
  });

  it("autentifikatsiyasiz barcha himoyalangan yo'llar 401", async () => {
    for (const path of [
      '/api/v1/schools',
      '/api/v1/school-admins',
      '/api/v1/teachers',
      '/api/v1/meta/permissions',
    ]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it("ruxsat ko'tarilishi taqiqlanadi: admin o'zida yo'q ruxsatni bera olmaydi (yaratishda)", async () => {
    await makeUser({
      username: 'adm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['teachers.manage', 'dashboard.view'],
    });
    const { token } = await login('adm');

    const denied = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .send(newTeacher({ permissions: ['dashboard.view', 'reports.export'] }));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const allowed = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .send(newTeacher({ permissions: ['dashboard.view'] }));
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.permissions).toEqual(
      expect.arrayContaining(['scores.create', 'dashboard.view']),
    );
  });

  it("ruxsat ko'tarilishi taqiqlanadi (PUT permissions), lekin o'zidagilarni berish va olib tashlash mumkin", async () => {
    await makeUser({
      username: 'adm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['teachers.manage', 'dashboard.view'],
    });
    const { token } = await login('adm');
    const created = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .send(newTeacher());
    const id = created.body.data.id;

    const esc = await request(app)
      .put(`/api/v1/teachers/${id}/permissions`)
      .set(bearer(token))
      .send({ permissions: ['reports.view'] });
    expect(esc.status).toBe(403);

    const good = await request(app)
      .put(`/api/v1/teachers/${id}/permissions`)
      .set(bearer(token))
      .send({ permissions: ['dashboard.view'] });
    expect(good.status).toBe(200);
    expect(good.body.data.permissions).toContain('dashboard.view');

    const cleared = await request(app)
      .put(`/api/v1/teachers/${id}/permissions`)
      .set(bearer(token))
      .send({ permissions: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.permissions).toEqual(['scores.create', 'attendance.take']);
    expect(await AuditLog.countDocuments({ action: 'teacher.permissions' })).toBe(2);
  });

  it("superadmin tomonidan berilgan, adminda yo'q ruxsatni admin saqlab qolishi mumkin (ko'tarilish emas)", async () => {
    await makeUser({
      username: 'adm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['teachers.manage'],
    });
    const t = await request(app)
      .post('/api/v1/teachers')
      .set(bearer((await login('root')).token))
      .set('X-School-Id', school.id)
      .send(newTeacher({ permissions: ['reports.view'] }));
    expect(t.status).toBe(201);

    const { token } = await login('adm');
    const res = await request(app)
      .put(`/api/v1/teachers/${t.body.data.id}/permissions`)
      .set(bearer(token))
      .send({ permissions: ['reports.view'] });
    expect(res.status).toBe(200);
  });

  it("o'qituvchiga faqat o'qituvchi katalogidagi ruxsatlar beriladi (400)", async () => {
    const { token } = await login('root');
    const res = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', school.id)
      .send(newTeacher({ permissions: ['teachers.manage'] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const unknown = await request(app)
      .post('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', school.id)
      .send(newTeacher({ permissions: ['no.such'] }));
    expect(unknown.status).toBe(400);
  });

  it("superadmin permission tekshiruvidan o'tadi (ruxsati saqlanmagan bo'lsa ham)", async () => {
    const { token, res } = await login('root');
    expect(res.body.data.user.permissions).toContain('teachers.manage');
    const list = await request(app)
      .get('/api/v1/teachers')
      .set(bearer(token))
      .set('X-School-Id', school.id);
    expect(list.status).toBe(200);
  });

  it('GET /meta/permissions katalogni qaytaradi', async () => {
    const { token } = await login('root');
    const res = await request(app).get('/api/v1/meta/permissions').set(bearer(token));
    expect(res.status).toBe(200);
    const keys = res.body.data.map((p: { key: string }) => p.key);
    expect(keys).toEqual([
      'dashboard.view',
      'classes.manage',
      'students.view',
      'students.manage',
      'teachers.manage',
      'scores.create',
      'scores.edit',
      'reports.view',
      'reports.export',
      'audit.view',
      'attendance.take',
      'attendance.edit',
      'attendance.view',
      'attendance.settings',
    ]);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        group: expect.any(String),
        label: expect.any(String),
        roles: expect.any(Array),
      }),
    );
  });

  it("o'qituvchi login javobida scores.create doim bor", async () => {
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    const { res } = await login('tch');
    expect(res.body.data.user.permissions).toEqual(['scores.create', 'attendance.take']);
  });
});

describe('Maktablar va maktab adminlari (superadmin)', () => {
  it('maktab CRUD, slug unique va format, nofaol qilish', async () => {
    const { token } = await login('root');
    const create = await request(app)
      .post('/api/v1/schools')
      .set(bearer(token))
      .send({ name: '1-maktab', slug: 'maktab-1', address: 'Toshkent' });
    expect(create.status).toBe(201);
    expect(create.body.data).toMatchObject({ slug: 'maktab-1', isActive: true, logoUrl: null });

    expect(
      (
        await request(app)
          .post('/api/v1/schools')
          .set(bearer(token))
          .send({ name: 'Xx', slug: 'maktab-1' })
      ).status,
    ).toBe(409);
    const badSlug = await request(app)
      .post('/api/v1/schools')
      .set(bearer(token))
      .send({ name: 'Xx', slug: 'Bad Slug!' });
    expect(badSlug.status).toBe(400);
    expect(badSlug.body.error.details[0].path).toBe('slug');

    const patched = await request(app)
      .patch(`/api/v1/schools/${create.body.data.id}`)
      .set(bearer(token))
      .send({ isActive: false });
    expect(patched.body.data.isActive).toBe(false);

    const list = await request(app)
      .get('/api/v1/schools?search=maktab&isActive=false')
      .set(bearer(token));
    expect(list.body.data).toHaveLength(1);
    expect(await AuditLog.countDocuments({ entity: 'school' })).toBe(2);
  });

  it('maktab admini yaratish, ruxsat berish, parol tiklash', async () => {
    const { token } = await login('root');
    const created = await request(app)
      .post('/api/v1/school-admins')
      .set(bearer(token))
      .send({
        schoolId: school.id,
        fullName: 'Admin Adminov',
        username: 'admin1',
        password: 'Passw0rd1',
        permissions: ['teachers.manage'],
      });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['teachers.manage'],
    });
    const id = created.body.data.id;

    // school_admin katalogida bo'lmagan kalit — ham emas (masalan noma'lum)
    expect(
      (
        await request(app)
          .put(`/api/v1/school-admins/${id}/permissions`)
          .set(bearer(token))
          .send({ permissions: ['x.y'] })
      ).status,
    ).toBe(400);
    const perms = await request(app)
      .put(`/api/v1/school-admins/${id}/permissions`)
      .set(bearer(token))
      .send({ permissions: ['audit.view', 'audit.view'] });
    expect(perms.body.data.permissions).toEqual(['audit.view']);

    expect(
      (
        await request(app)
          .post(`/api/v1/school-admins/${id}/reset-password`)
          .set(bearer(token))
          .send({ newPassword: 'short' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/v1/school-admins/${id}/reset-password`)
          .set(bearer(token))
          .send({ newPassword: 'Brand3New' })
      ).status,
    ).toBe(200);
    expect((await login('admin1', 'Brand3New')).res.status).toBe(200);

    const list = await request(app)
      .get(`/api/v1/school-admins?schoolId=${school.id}`)
      .set(bearer(token));
    expect(list.body.data).toHaveLength(1);

    const noSchool = await request(app).post('/api/v1/school-admins').set(bearer(token)).send({
      schoolId: '64b64b64b64b64b64b64b64b',
      fullName: 'Admin Adminov',
      username: 'admin2',
      password: 'Passw0rd1',
    });
    expect(noSchool.status).toBe(400);
  });

  it("parol tiklanganda eski sessiya va tokenlar bekor bo'ladi", async () => {
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    const t = await login('tch');
    const root = await login('root');
    const teacherId = (await request(app).get('/api/v1/auth/me').set(bearer(t.token))).body.data.id;

    const reset = await request(app)
      .post(`/api/v1/teachers/${teacherId}/reset-password`)
      .set(bearer(root.token))
      .set('X-School-Id', school.id)
      .send({ newPassword: 'Brand3New' });
    expect(reset.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(t.token))).status).toBe(401);
  });
});
