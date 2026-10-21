import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcademicYear } from '../src/models/AcademicYear';
import { AuditLog } from '../src/models/AuditLog';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let token: string;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'adm2',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'viewer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  token = (await login('adm')).token;
});

const body = (extra: Record<string, unknown> = {}) => ({
  name: '2026-2027',
  startDate: '2026-09-01',
  endDate: '2027-06-01',
  periods: [
    { name: '1-chorak', startDate: '2026-09-01', endDate: '2026-10-31' },
    { name: '2-chorak', startDate: '2026-11-03', endDate: '2026-12-30' },
  ],
  ...extra,
});

describe("O'quv yillari", () => {
  it("yaratish, DTO shakli va o'qish (o'qituvchi ham o'qiy oladi, yoza olmaydi)", async () => {
    const res = await request(app).post('/api/v1/academic-years').set(bearer(token)).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: '2026-2027',
      startDate: '2026-09-01',
      endDate: '2027-06-01',
      isActive: false,
    });
    expect(res.body.data.periods).toHaveLength(2);
    expect(res.body.data.periods[0]).toMatchObject({ name: '1-chorak', startDate: '2026-09-01' });
    expect(res.body.data.periods[0].id).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'academic_year.create' })).toBe(1);

    const t = (await login('tch')).token;
    expect(
      (await request(app).get('/api/v1/academic-years').set(bearer(t))).body.data,
    ).toHaveLength(1);
    expect(
      (await request(app).post('/api/v1/academic-years').set(bearer(t)).send(body())).status,
    ).toBe(403);
    const v = (await login('viewer')).token;
    expect(
      (await request(app).post('/api/v1/academic-years').set(bearer(v)).send(body())).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/academic-years').set(bearer(v))).status).toBe(200);
  });

  it('validatsiya: sanalar tartibi, davrlar yil ichida va kesishmaydi', async () => {
    const post = (b: object) =>
      request(app).post('/api/v1/academic-years').set(bearer(token)).send(b);
    const bad = await post(body({ startDate: '2027-06-01', endDate: '2026-09-01', periods: [] }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('endDate');

    const outside = await post(
      body({ periods: [{ name: 'x', startDate: '2026-08-01', endDate: '2026-10-01' }] }),
    );
    expect(outside.status).toBe(400);
    expect(outside.body.error.details[0].path).toBe('periods.0');

    const overlap = await post(
      body({
        periods: [
          { name: 'a', startDate: '2026-09-01', endDate: '2026-11-10' },
          { name: 'b', startDate: '2026-11-01', endDate: '2026-12-30' },
        ],
      }),
    );
    expect(overlap.status).toBe(400);

    expect((await post(body({ startDate: '2026-13-45' }))).status).toBe(400);
  });

  it('nom maktab ichida unique, boshqa maktabda ruxsat', async () => {
    expect(
      (await request(app).post('/api/v1/academic-years').set(bearer(token)).send(body())).status,
    ).toBe(201);
    const dup = await request(app).post('/api/v1/academic-years').set(bearer(token)).send(body());
    expect(dup.status).toBe(409);
    const t2 = (await login('adm2')).token;
    expect(
      (await request(app).post('/api/v1/academic-years').set(bearer(t2)).send(body())).status,
    ).toBe(201);
  });

  it('faqat bitta faol yil: activate boshqalarini nofaol qiladi', async () => {
    const a = (await request(app).post('/api/v1/academic-years').set(bearer(token)).send(body()))
      .body.data;
    const b = (
      await request(app)
        .post('/api/v1/academic-years')
        .set(bearer(token))
        .send(
          body({ name: '2027-2028', startDate: '2027-09-01', endDate: '2028-06-01', periods: [] }),
        )
    ).body.data;

    expect(
      (await request(app).post(`/api/v1/academic-years/${a.id}/activate`).set(bearer(token))).body
        .data.isActive,
    ).toBe(true);
    expect(
      (await request(app).post(`/api/v1/academic-years/${b.id}/activate`).set(bearer(token))).body
        .data.isActive,
    ).toBe(true);
    // Qayta activate idempotent
    expect(
      (await request(app).post(`/api/v1/academic-years/${b.id}/activate`).set(bearer(token)))
        .status,
    ).toBe(200);

    const list = (await request(app).get('/api/v1/academic-years').set(bearer(token))).body.data;
    expect(
      list.filter((y: { isActive: boolean }) => y.isActive).map((y: { id: string }) => y.id),
    ).toEqual([b.id]);
    expect(await AcademicYear.countDocuments({ schoolId: school.id, isActive: true })).toBe(1);

    // Boshqa maktabning faol yiliga ta'sir qilmaydi
    await makeYear(other.id, '2026-2027', true);
    await request(app).post(`/api/v1/academic-years/${a.id}/activate`).set(bearer(token));
    expect(await AcademicYear.countDocuments({ schoolId: other.id, isActive: true })).toBe(1);
  });

  it('PATCH: nom/sana/davrlarni yangilash va qayta validatsiya', async () => {
    const y = (await request(app).post('/api/v1/academic-years').set(bearer(token)).send(body()))
      .body.data;
    const ok = await request(app)
      .patch(`/api/v1/academic-years/${y.id}`)
      .set(bearer(token))
      .send({ name: '2026/27' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe('2026/27');
    expect(ok.body.data.periods).toHaveLength(2);

    const bad = await request(app)
      .patch(`/api/v1/academic-years/${y.id}`)
      .set(bearer(token))
      .send({ endDate: '2026-10-01' });
    expect(bad.status).toBe(400);
  });

  it("DELETE: sinflari bo'lsa 409, bo'lmasa o'chadi", async () => {
    const y = await makeYear(school.id);
    await makeClass(school.id, y.id, '7-A');
    expect(
      (await request(app).delete(`/api/v1/academic-years/${y.id}`).set(bearer(token))).status,
    ).toBe(409);

    const y2 = await makeYear(school.id, '2027-2028', false);
    expect(
      (await request(app).delete(`/api/v1/academic-years/${y2.id}`).set(bearer(token))).status,
    ).toBe(200);
    expect(await AcademicYear.countDocuments({ _id: y2._id })).toBe(0);
  });

  it("tenant: boshqa maktab yilini ko'rmaydi/o'zgartirmaydi (404); superadmin X-School-Id talab qiladi", async () => {
    const foreign = await makeYear(other.id);
    expect(
      (
        await request(app)
          .patch(`/api/v1/academic-years/${foreign.id}`)
          .set(bearer(token))
          .send({ name: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/v1/academic-years/${foreign.id}/activate`).set(bearer(token)))
        .status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/v1/academic-years/${foreign.id}`).set(bearer(token))).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/v1/academic-years').set(bearer(token))).body.data,
    ).toHaveLength(0);

    const root = (await login('root')).token;
    expect((await request(app).get('/api/v1/academic-years').set(bearer(root))).status).toBe(400);
    const r = await request(app)
      .get('/api/v1/academic-years')
      .set(bearer(root))
      .set('X-School-Id', other.id);
    expect(r.body.data).toHaveLength(1);
  });
});
