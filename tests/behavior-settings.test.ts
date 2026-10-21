import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { BehaviorType } from '../src/models/BehaviorType';
import { ensureDefaultBehaviorTypes } from '../src/modules/behavior-types/behavior-types.defaults';
import { ADMIN_PERMS, app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

let a: Awaited<ReturnType<typeof makeSchool>>;
let b: Awaited<ReturnType<typeof makeSchool>>;
let root: string;
let admin: string;
let teacher: string;

beforeEach(async () => {
  a = await makeSchool('a');
  b = await makeSchool('b');
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: a.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({ username: 'tch', role: 'teacher', schoolId: a.id });
  root = (await login('root')).token;
  admin = (await login('adm')).token;
  teacher = (await login('tch')).token;
});

const post = (t: string, body: object) =>
  request(app).post('/api/v1/behavior-types').set(bearer(t)).send(body);

describe('Xulq turlari', () => {
  it('standart global turlar idempotent yaratiladi', async () => {
    expect(await ensureDefaultBehaviorTypes()).toBe(8);
    expect(await ensureDefaultBehaviorTypes()).toBe(0);
    expect(await BehaviorType.countDocuments({ schoolId: null })).toBe(8);
    const list = await request(app).get('/api/v1/behavior-types').set(bearer(teacher));
    expect(list.body.data[0]).toMatchObject({
      name: 'Namunali xulq',
      kind: 'positive',
      schoolId: null,
      isActive: true,
    });
    expect(
      list.body.data.map((x: { kind: string }) => x.kind).filter((k: string) => k === 'negative'),
    ).toHaveLength(4);
  });

  it("faqat superadmin yaratadi/o'zgartiradi (admin va o'qituvchi 403)", async () => {
    const body = { name: 'Yangi tur', kind: 'positive', color: '#aabbcc' };
    expect((await post(admin, body)).status).toBe(403);
    expect((await post(teacher, body)).status).toBe(403);
    expect((await request(app).post('/api/v1/behavior-types').send(body)).status).toBe(401);

    const res = await post(root, { ...body, minScore: 80, maxScore: 100 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      schoolId: null,
      color: '#AABBCC',
      order: 1,
      minScore: 80,
      maxScore: 100,
      isActive: true,
    });
    const id = res.body.data.id;
    for (const t of [admin, teacher]) {
      expect(
        (
          await request(app)
            .patch(`/api/v1/behavior-types/${id}`)
            .set(bearer(t))
            .send({ name: 'x' })
        ).status,
      ).toBe(403);
      expect(
        (await request(app).post(`/api/v1/behavior-types/${id}/deactivate`).set(bearer(t))).status,
      ).toBe(403);
    }
    expect(
      (await request(app).delete(`/api/v1/behavior-types/${id}`).set(bearer(root))).status,
    ).toBe(404); // o'chirish yo'q
    expect(await AuditLog.countDocuments({ action: 'behavior_type.create' })).toBe(1);
  });

  it("validatsiya: rang, nom unique (normalizatsiya, scope ichida), ball oralig'i", async () => {
    expect((await post(root, { name: 'Tur', kind: 'positive', color: 'red' })).status).toBe(400);
    expect((await post(root, { name: 'Tur', kind: 'x', color: '#112233' })).status).toBe(400);
    expect(
      (
        await post(root, {
          name: 'Tur',
          kind: 'positive',
          color: '#112233',
          minScore: 90,
          maxScore: 10,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(root, { name: 'Namunali  Xulq', kind: 'positive', color: '#112233' })).status,
    ).toBe(201);
    expect(
      (await post(root, { name: 'namunali xulq', kind: 'positive', color: '#112233' })).status,
    ).toBe(409);
    // Boshqa scope (maktab) da bir xil nom mumkin
    expect(
      (
        await post(root, {
          schoolId: a.id,
          name: 'Namunali xulq',
          kind: 'positive',
          color: '#112233',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post(root, {
          schoolId: '64b64b64b64b64b64b64b64b',
          name: 'X1',
          kind: 'neutral',
          color: '#112233',
        })
      ).status,
    ).toBe(400);
  });

  it("ro'yxat: maktab foydalanuvchisi global + o'z maktabini ko'radi, tenant izolyatsiya, scope/isActive filtrlari", async () => {
    const g = (await post(root, { name: 'Global 1', kind: 'positive', color: '#111111', order: 2 }))
      .body.data;
    const sa = (
      await post(root, {
        schoolId: a.id,
        name: 'A maktab turi',
        kind: 'neutral',
        color: '#222222',
        order: 1,
      })
    ).body.data;
    await post(root, { schoolId: b.id, name: 'B maktab turi', kind: 'neutral', color: '#333333' });

    const names = async (t: string, q = '', h: Record<string, string> = {}) =>
      (await request(app).get(`/api/v1/behavior-types${q}`).set(bearer(t)).set(h)).body.data.map(
        (x: { name: string }) => x.name,
      );
    expect(await names(admin)).toEqual(['A maktab turi', 'Global 1']); // order bo'yicha
    expect(await names(teacher)).toEqual(['A maktab turi', 'Global 1']);
    expect(await names(admin, '?scope=global')).toEqual(['Global 1']);
    expect(await names(admin, '?scope=school')).toEqual(['A maktab turi']);

    // Superadmin: headersiz hammasi, header bilan shu maktab
    expect(await names(root)).toHaveLength(3);
    expect(await names(root, '?scope=school')).toHaveLength(2);
    expect(await names(root, '', { 'X-School-Id': a.id })).toEqual(['A maktab turi', 'Global 1']);

    await request(app).post(`/api/v1/behavior-types/${g.id}/deactivate`).set(bearer(root));
    expect(await names(admin, '?isActive=true')).toEqual(['A maktab turi']);
    expect(await names(admin, '?isActive=false')).toEqual(['Global 1']);
    expect(
      (await request(app).post(`/api/v1/behavior-types/${g.id}/activate`).set(bearer(root))).body
        .data.isActive,
    ).toBe(true);
    expect(
      await AuditLog.countDocuments({
        action: { $in: ['behavior_type.deactivate', 'behavior_type.activate'] },
      }),
    ).toBe(2);
    expect(sa.id).toBeTruthy();
  });

  it("PATCH: nom/rang/tartib/oraliq; nomi band bo'lsa 409", async () => {
    const t1 = (await post(root, { name: 'Bir', kind: 'positive', color: '#111111' })).body.data;
    await post(root, { name: 'Ikki', kind: 'positive', color: '#111111' });
    const ok = await request(app)
      .patch(`/api/v1/behavior-types/${t1.id}`)
      .set(bearer(root))
      .send({ name: 'Bir (yangi)', kind: 'negative', color: '#ff0000', order: 9, minScore: null });
    expect(ok.body.data).toMatchObject({
      name: 'Bir (yangi)',
      kind: 'negative',
      color: '#FF0000',
      order: 9,
      minScore: null,
    });
    expect(
      (
        await request(app)
          .patch(`/api/v1/behavior-types/${t1.id}`)
          .set(bearer(root))
          .send({ name: 'ikki' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch('/api/v1/behavior-types/bad')
          .set(bearer(root))
          .send({ name: 'xx' })
      ).status,
    ).toBe(404);
  });
});

describe('Baholash sozlamalari', () => {
  const get = (t: string, h: Record<string, string> = {}) =>
    request(app).get('/api/v1/settings/scoring').set(bearer(t)).set(h);
  const put = (body: object) =>
    request(app).put('/api/v1/settings/scoring').set(bearer(root)).send(body);

  it('standart qiymatlar', async () => {
    const res = await get(teacher);
    expect(res.status).toBe(200);
    expect(res.body.data.effective).toEqual({
      minScore: 0,
      maxScore: 100,
      requireBehaviorType: true,
      commentRequiredBelow: null,
      editWindowHours: 24,
      backdateDays: 3,
      dailyAggregation: 'average',
    });
    expect(res.body.data.override).toBeNull();
  });

  it("global + maktab override = effective; override faqat superadmin ko'radi; olib tashlash", async () => {
    expect(
      (await put({ scope: 'global', values: { editWindowHours: 48, commentRequiredBelow: 60 } }))
        .status,
    ).toBe(200);
    const ov = await put({
      scope: 'school',
      schoolId: a.id,
      values: { editWindowHours: 2, dailyAggregation: 'min' },
    });
    expect(ov.status).toBe(200);
    expect(ov.body.data.override).toEqual({ editWindowHours: 2, dailyAggregation: 'min' });

    const asAdmin = await get(admin);
    expect(asAdmin.body.data.effective).toMatchObject({
      editWindowHours: 2,
      dailyAggregation: 'min',
      commentRequiredBelow: 60,
      backdateDays: 3,
    });
    expect(asAdmin.body.data.global).toMatchObject({
      editWindowHours: 48,
      dailyAggregation: 'average',
    });
    expect(asAdmin.body.data.override).toBeNull(); // maktab roli override ni ko'rmaydi

    const asRoot = await get(root, { 'X-School-Id': a.id });
    expect(asRoot.body.data.override).toEqual({ editWindowHours: 2, dailyAggregation: 'min' });
    const rootB = await get(root, { 'X-School-Id': b.id });
    expect(rootB.body.data.effective).toMatchObject({
      editWindowHours: 48,
      dailyAggregation: 'average',
    });
    expect(rootB.body.data.override).toBeNull();
    expect((await get(root)).body.data.effective.editWindowHours).toBe(48); // headersiz — global

    const removed = await put({ scope: 'school', schoolId: a.id, values: null });
    expect(removed.body.data.override).toBeNull();
    expect((await get(admin)).body.data.effective.editWindowHours).toBe(48);

    expect(await AuditLog.countDocuments({ action: 'settings.update' })).toBe(3);
    const log = await AuditLog.findOne({ action: 'settings.update', schoolId: a.id }).sort({
      createdAt: 1,
    });
    expect(log!.before).toMatchObject({ scope: 'school', values: null });
    expect(log!.after).toMatchObject({ values: { editWindowHours: 2 } });
  });

  it("faqat superadmin yozadi (admin/o'qituvchi 403)", async () => {
    for (const t of [admin, teacher]) {
      const r = await request(app)
        .put('/api/v1/settings/scoring')
        .set(bearer(t))
        .send({ scope: 'global', values: {} });
      expect(r.status).toBe(403);
    }
  });

  it('validatsiya: min<max, diapazonlar, turlar, scope=school uchun schoolId', async () => {
    const bad = async (body: object) => expect((await put(body)).status).toBe(400);
    await bad({ scope: 'global', values: { minScore: 50, maxScore: 50 } });
    await bad({ scope: 'global', values: { minScore: -1 } });
    await bad({ scope: 'global', values: { maxScore: 101 } });
    await bad({ scope: 'global', values: { maxScore: 10.5 } });
    await bad({ scope: 'global', values: { editWindowHours: 721 } });
    await bad({ scope: 'global', values: { backdateDays: 31 } });
    await bad({ scope: 'global', values: { dailyAggregation: 'median' } });
    await bad({ scope: 'global', values: { requireBehaviorType: 'yes' } });
    await bad({ scope: 'school', values: { backdateDays: 1 } });
    await bad({ scope: 'school', schoolId: a.id, values: { minScore: 100 } }); // 100 >= max(100)
    expect(
      (await put({ scope: 'school', schoolId: '64b64b64b64b64b64b64b64b', values: {} })).status,
    ).toBe(404);
    // Global o'zgarish mavjud override bilan ziddiyatga tushsa rad etiladi
    await put({ scope: 'school', schoolId: a.id, values: { minScore: 40 } });
    await bad({ scope: 'global', values: { maxScore: 30 } });
    expect((await put({ scope: 'global', values: { minScore: 10, maxScore: 50 } })).status).toBe(
      200,
    );
    expect((await put({ scope: 'global', values: null })).body.data.global.maxScore).toBe(100);
  });
});
