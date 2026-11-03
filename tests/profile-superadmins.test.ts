import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ensureOwnerSuperadmin } from '../src/config/migrations';
import { AuditLog } from '../src/models/AuditLog';
import { RefreshToken } from '../src/models/RefreshToken';
import { User } from '../src/models/User';
import { app, bearer, login, makeSchool, makeUser, PASSWORD, useTestDb } from './helpers';

useTestDb();

const owner = async (username = 'boss') => {
  const u = await makeUser({ username, role: 'superadmin' });
  await User.updateOne({ _id: u._id }, { isOwner: true });
  return u;
};

describe('PATCH /auth/me', () => {
  it("F.I.Sh. va telefon parolsiz o'zgaradi, audit yoziladi", async () => {
    const school = await makeSchool('a');
    await makeUser({ username: 'teach', role: 'teacher', schoolId: String(school._id) });
    const { token } = await login('teach');
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ fullName: 'Yangi Ism', phone: '+998901234567' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      fullName: 'Yangi Ism',
      phone: '+998901234567',
      username: 'teach',
    });
    const log = await AuditLog.findOne({ action: 'user.profile.update' });
    expect(log?.before).toMatchObject({ fullName: 'Test teach' });
    expect(log?.after).toMatchObject({ fullName: 'Yangi Ism', phone: '+998901234567' });
    expect(JSON.stringify(log)).not.toMatch(/password/i);
  });

  it("bo'sh telefon null bo'ladi; /auth/me bir xil shaklda", async () => {
    await makeUser({ username: 'sa', role: 'superadmin' });
    const { token } = await login('sa');
    await request(app).patch('/api/v1/auth/me').set(bearer(token)).send({ phone: '+998901234567' });
    const res = await request(app).patch('/api/v1/auth/me').set(bearer(token)).send({ phone: '' });
    expect(res.body.data.phone).toBeNull();
    const me = await request(app).get('/api/v1/auth/me').set(bearer(token));
    expect(Object.keys(me.body.data).sort()).toEqual(Object.keys(res.body.data).sort());
  });

  it("login o'zgarishi joriy parolni talab qiladi", async () => {
    const school = await makeSchool('a');
    await makeUser({ username: 'old', role: 'school_admin', schoolId: String(school._id) });
    const { token } = await login('old');

    const none = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ username: 'newname' });
    expect(none.status).toBe(400);
    expect(none.body.error.details[0].path).toBe('currentPassword');

    const wrong = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ username: 'newname', currentPassword: 'Wrong1234' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].path).toBe('currentPassword');
    expect((await User.findOne({ username: 'old' }))!.failedLoginCount).toBe(1);

    const okRes = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ username: ' NewName ', currentPassword: PASSWORD });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.username).toBe('newname');
    // eski token ishlayveradi (sessiya bekor qilinmaydi), yangi login bilan kirsa bo'ladi
    expect((await request(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(200);
    expect((await login('newname')).res.status).toBe(200);
    expect((await login('old')).res.status).toBe(401);
    const log = await AuditLog.findOne({ action: 'user.profile.update' });
    expect(log?.before).toMatchObject({ username: 'old' });
    expect(log?.after).toMatchObject({ username: 'newname' });
  });

  it('band login 409 (path: username), o‘zining logini o‘zgarish emas', async () => {
    await makeUser({ username: 'one', role: 'superadmin' });
    await makeUser({ username: 'two', role: 'superadmin' });
    const { token } = await login('one');
    const taken = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ username: 'TWO', currentPassword: PASSWORD });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details[0]).toMatchObject({
      path: 'username',
      message: 'Bu login band',
    });

    // o'zining logini: parol talab qilinmaydi
    const same = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ username: 'one', fullName: 'Boshqa Ism' });
    expect(same.status).toBe(200);
  });

  it("noto'g'ri formatdagi login va begona maydon (role) rad etiladi", async () => {
    await makeUser({ username: 'one', role: 'teacher' });
    const { token } = await login('one');
    const bad = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ username: 'a b', currentPassword: PASSWORD });
    expect(bad.status).toBe(400);
    const role = await request(app)
      .patch('/api/v1/auth/me')
      .set(bearer(token))
      .send({ role: 'superadmin' });
    expect(role.status).toBe(400);
    expect((await User.findOne({ username: 'one' }))!.role).toBe('teacher');
  });

  it('GET /auth/username-available', async () => {
    await makeUser({ username: 'one', role: 'superadmin' });
    await makeUser({ username: 'two', role: 'superadmin' });
    const { token } = await login('one');
    const get = (u: string) =>
      request(app).get('/api/v1/auth/username-available').query({ username: u }).set(bearer(token));
    expect((await get('two')).body.data.available).toBe(false);
    expect((await get('free.name')).body.data.available).toBe(true);
    expect((await get('ONE')).body.data.available).toBe(true);
    expect((await get('a b')).status).toBe(400);
    const anon = await request(app)
      .get('/api/v1/auth/username-available')
      .query({ username: 'x1' });
    expect(anon.status).toBe(401);
  });
});

describe('Migratsiya: asosiy superadmin', () => {
  it('eng eski faol superadminni owner qiladi va idempotent', async () => {
    const first = await makeUser({ username: 'first', role: 'superadmin' });
    await makeUser({ username: 'second', role: 'superadmin' });
    await makeUser({ username: 'sleeping', role: 'superadmin', isActive: false });
    await User.updateOne({ _id: first._id }, { createdAt: new Date('2020-01-01') });

    expect(await ensureOwnerSuperadmin()).toBe(first.id);
    expect(await ensureOwnerSuperadmin()).toBeNull();
    const owners = await User.find({ isOwner: true });
    expect(owners.map((o) => o.username)).toEqual(['first']);
  });

  it("faol owner bo'lmasa (nofaol owner) yangisi belgilanadi", async () => {
    const dead = await makeUser({ username: 'dead', role: 'superadmin', isActive: false });
    await User.updateOne({ _id: dead._id }, { isOwner: true });
    await makeUser({ username: 'live', role: 'superadmin' });
    await ensureOwnerSuperadmin();
    const owners = await User.find({ isOwner: true });
    expect(owners.map((o) => o.username)).toEqual(['live']);
  });

  it("superadmin yo'q bo'lsa hech narsa qilmaydi; unique indeks ikkinchi ownerni rad etadi", async () => {
    expect(await ensureOwnerSuperadmin()).toBeNull();
    await owner('a');
    const b = await makeUser({ username: 'b', role: 'superadmin' });
    await expect(User.updateOne({ _id: b._id }, { isOwner: true })).rejects.toThrow();
  });

  it('/auth/me isOwner qaytaradi', async () => {
    await owner();
    await makeUser({ username: 'other', role: 'superadmin' });
    const a = await login('boss');
    const b = await login('other');
    expect((await request(app).get('/api/v1/auth/me').set(bearer(a.token))).body.data.isOwner).toBe(
      true,
    );
    expect((await request(app).get('/api/v1/auth/me').set(bearer(b.token))).body.data.isOwner).toBe(
      false,
    );
  });
});

describe('/superadmins', () => {
  const body = {
    fullName: 'Yangi Admin',
    username: 'newsa',
    password: 'Newpass123',
    currentPassword: PASSWORD,
  };

  it("ro'yxat: har qanday superadmin ko'radi, boshqa rol 403", async () => {
    await owner();
    await makeUser({ username: 'other', role: 'superadmin' });
    const school = await makeSchool('a');
    await makeUser({ username: 'sch', role: 'school_admin', schoolId: String(school._id) });
    const o = await login('other');
    const res = await request(app).get('/api/v1/superadmins').set(bearer(o.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: { username: string }) => x.username)).toEqual(['boss', 'other']);
    expect(res.body.data[0]).toMatchObject({ isOwner: true, isActive: true });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    const s = await login('sch');
    expect((await request(app).get('/api/v1/superadmins').set(bearer(s.token))).status).toBe(403);
  });

  it('yaratish: owner parol bilan; nofaol parol/owner bo‘lmaganlar rad', async () => {
    await owner();
    await makeUser({ username: 'other', role: 'superadmin' });
    const { token } = await login('boss');
    const wrong = await request(app)
      .post('/api/v1/superadmins')
      .set(bearer(token))
      .send({ ...body, currentPassword: 'Wrong1234' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].path).toBe('currentPassword');
    expect(await User.countDocuments({ username: 'newsa' })).toBe(0);

    const okRes = await request(app).post('/api/v1/superadmins').set(bearer(token)).send(body);
    expect(okRes.status).toBe(201);
    expect(okRes.body.data).toMatchObject({ username: 'newsa', isOwner: false, isActive: true });
    const u = await User.findOne({ username: 'newsa' });
    expect(u).toMatchObject({ role: 'superadmin', schoolId: null, isOwner: false });
    expect((await login('newsa', 'Newpass123')).res.status).toBe(200);
    const log = await AuditLog.findOne({ action: 'superadmin.create' });
    expect(JSON.stringify(log)).not.toMatch(/Newpass123|passwordHash/);

    const dup = await request(app).post('/api/v1/superadmins').set(bearer(token)).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].path).toBe('username');

    const o = await login('other');
    const forb = await request(app)
      .post('/api/v1/superadmins')
      .set(bearer(o.token))
      .send({ ...body, username: 'another' });
    expect(forb.status).toBe(403);
    expect(forb.body.error.message).toBe('Bu amal faqat asosiy superadmin uchun');
  });

  it("nofaol qilish sessiyalarni bekor qiladi, faollashtirish, o'zini/ownerni o'zgartirib bo'lmaydi", async () => {
    const ow = await owner();
    const other = await makeUser({ username: 'other', role: 'superadmin' });
    const { token } = await login('boss');
    const victim = await login('other');
    expect(await RefreshToken.countDocuments({ userId: other._id, revokedAt: null })).toBe(1);

    const off = await request(app)
      .patch(`/api/v1/superadmins/${other.id}`)
      .set(bearer(token))
      .send({ isActive: false, currentPassword: PASSWORD });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    expect(await RefreshToken.countDocuments({ userId: other._id, revokedAt: null })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(victim.token))).status).toBe(401);
    expect(await AuditLog.countDocuments({ action: 'superadmin.update' })).toBe(1);

    const on = await request(app)
      .patch(`/api/v1/superadmins/${other.id}`)
      .set(bearer(token))
      .send({ isActive: true, currentPassword: PASSWORD });
    expect(on.body.data.isActive).toBe(true);

    for (const patch of [{ isActive: false }, { fullName: 'Boshqa Ism' }]) {
      const self = await request(app)
        .patch(`/api/v1/superadmins/${ow.id}`)
        .set(bearer(token))
        .send({ ...patch, currentPassword: PASSWORD });
      expect(self.status).toBe(403);
    }
    expect((await User.findById(ow.id))!.isActive).toBe(true);

    const empty = await request(app)
      .patch(`/api/v1/superadmins/${other.id}`)
      .set(bearer(token))
      .send({ currentPassword: PASSWORD });
    expect(empty.status).toBe(400);
    const missing = await request(app)
      .patch('/api/v1/superadmins/64b000000000000000000000')
      .set(bearer(token))
      .send({ isActive: false, currentPassword: PASSWORD });
    expect(missing.status).toBe(404);
  });

  it('parolni tiklash: yangi parol ishlaydi, eski sessiya bekor, non-owner 403', async () => {
    await owner();
    const other = await makeUser({ username: 'other', role: 'superadmin' });
    const third = await makeUser({ username: 'third', role: 'superadmin' });
    const { token } = await login('boss');
    const victim = await login('other');

    const res = await request(app)
      .patch(`/api/v1/superadmins/${other.id}`)
      .set(bearer(token))
      .send({ password: 'Reset12345', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect((await login('other')).res.status).toBe(401);
    expect((await login('other', 'Reset12345')).res.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(victim.token))).status).toBe(401);
    const log = await AuditLog.findOne({ action: 'superadmin.update' });
    expect(JSON.stringify(log)).not.toMatch(/Reset12345|passwordHash/);

    const o = await login('other', 'Reset12345');
    const forb = await request(app)
      .patch(`/api/v1/superadmins/${third.id}`)
      .set(bearer(o.token))
      .send({ isActive: false, currentPassword: 'Reset12345' });
    expect(forb.status).toBe(403);
    expect((await User.findById(third.id))!.isActive).toBe(true);
  });

  it('asosiylikni topshirish: aniq bitta owner, yangi owner ishlaydi', async () => {
    const ow = await owner();
    const other = await makeUser({ username: 'other', role: 'superadmin' });
    const off = await makeUser({ username: 'off', role: 'superadmin', isActive: false });
    const { token } = await login('boss');

    const wrong = await request(app)
      .post(`/api/v1/superadmins/${other.id}/transfer-ownership`)
      .set(bearer(token))
      .send({ currentPassword: 'Wrong1234' });
    expect(wrong.status).toBe(400);
    expect(await User.countDocuments({ isOwner: true })).toBe(1);
    expect((await User.findById(ow.id))!.isOwner).toBe(true);

    const inactive = await request(app)
      .post(`/api/v1/superadmins/${off.id}/transfer-ownership`)
      .set(bearer(token))
      .send({ currentPassword: PASSWORD });
    expect(inactive.status).toBe(400);
    const self = await request(app)
      .post(`/api/v1/superadmins/${ow.id}/transfer-ownership`)
      .set(bearer(token))
      .send({ currentPassword: PASSWORD });
    expect(self.status).toBe(400);
    expect((await User.findById(ow.id))!.isOwner).toBe(true);

    const res = await request(app)
      .post(`/api/v1/superadmins/${other.id}/transfer-ownership`)
      .set(bearer(token))
      .send({ currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    const owners = await User.find({ isOwner: true });
    expect(owners.map((o) => o.username)).toEqual(['other']);
    expect(await AuditLog.countDocuments({ action: 'superadmin.transfer' })).toBe(1);

    // eski owner endi 403, yangisi boshqara oladi
    const old = await request(app)
      .post('/api/v1/superadmins')
      .set(bearer(token))
      .send({
        fullName: 'Kimdir Kim',
        username: 'x1x',
        password: 'Newpass123',
        currentPassword: PASSWORD,
      });
    expect(old.status).toBe(403);
    const n = await login('other');
    const created = await request(app)
      .post('/api/v1/superadmins')
      .set(bearer(n.token))
      .send({
        fullName: 'Kimdir Kim',
        username: 'x1x',
        password: 'Newpass123',
        currentPassword: PASSWORD,
      });
    expect(created.status).toBe(201);
  });

  it('transfer: nishon yozilmasa owner o‘zida qoladi (rollback)', async () => {
    const ow = await owner();
    const other = await makeUser({ username: 'other', role: 'superadmin' });
    const { token } = await login('boss');
    const orig = User.updateOne.bind(User);
    // nishonga yozish urinishi muvaffaqiyatsiz bo'lsin
    const spy = (await import('vitest')).vi.spyOn(User, 'updateOne').mockImplementation(((
      filter: { _id?: unknown },
      update: unknown,
      ...rest: unknown[]
    ) => {
      if (String(filter._id) === other.id) return Promise.reject(new Error('boom'));
      return (orig as (...a: unknown[]) => unknown)(filter, update, ...rest);
    }) as never);
    try {
      const res = await request(app)
        .post(`/api/v1/superadmins/${other.id}/transfer-ownership`)
        .set(bearer(token))
        .send({ currentPassword: PASSWORD });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const owners = await User.find({ isOwner: true });
    expect(owners.map((o) => o.id)).toEqual([ow.id]);
  });

  it("umumiy marshrutlar orqali superadminni o'zgartirib/yaratib bo'lmaydi", async () => {
    const ow = await owner();
    const other = await makeUser({ username: 'other', role: 'superadmin' });
    const school = await makeSchool('a');
    const { token } = await login('boss');

    for (const id of [ow.id, other.id]) {
      for (const [method, path, data] of [
        ['patch', `/api/v1/school-admins/${id}`, { isActive: false }],
        ['post', `/api/v1/school-admins/${id}/reset-password`, { newPassword: 'Hacked1234' }],
        ['put', `/api/v1/school-admins/${id}/permissions`, { permissions: [] }],
        ['patch', `/api/v1/teachers/${id}`, { isActive: false }],
      ] as const) {
        const res = await request(app)[method](path).set(bearer(token)).send(data);
        expect([400, 404]).toContain(res.status);
      }
    }
    const create = await request(app)
      .post('/api/v1/school-admins')
      .set(bearer(token))
      .send({
        schoolId: String(school._id),
        fullName: 'Yangi Admin',
        username: 'evil1',
        password: 'Newpass123',
        role: 'superadmin',
      });
    expect(create.status).toBe(201);
    expect((await User.findOne({ username: 'evil1' }))!.role).toBe('school_admin');
    expect((await User.findById(other.id))!.isActive).toBe(true);
    expect((await User.findById(ow.id))!.isActive).toBe(true);
  });
});
