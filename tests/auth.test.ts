import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { RefreshToken } from '../src/models/RefreshToken';
import { User } from '../src/models/User';
import { ALL_PERMISSION_KEYS } from '../src/constants/permissions';
import {
  app,
  bearer,
  cookieValue,
  login,
  makeSchool,
  makeUser,
  PASSWORD,
  useTestDb,
} from './helpers';

useTestDb();

describe('Auth: login / refresh / logout', () => {
  it("muvaffaqiyatli login: token, user, httpOnly cookie, passwordHash yo'q", async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const { res, cookies } = await login('root');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user).toMatchObject({
      username: 'root',
      role: 'superadmin',
      schoolId: null,
    });
    expect(res.body.data.user.permissions).toEqual(ALL_PERMISSION_KEYS);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);

    const cookie = cookies.find((c) => c.startsWith('refreshToken='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(await AuditLog.countDocuments({ action: 'auth.login' })).toBe(1);
  });

  it('refresh token DB da xesh sifatida saqlanadi', async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const { cookies } = await login('root');
    const raw = cookieValue(cookies).split('=')[1];
    const doc = await RefreshToken.findOne();
    expect(doc!.tokenHash).not.toBe(raw);
    expect(doc!.tokenHash).toHaveLength(64);
  });

  it('GET /auth/me tokenli ishlaydi, tokensiz 401', async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const { token } = await login('root');
    const ok = await request(app).get('/api/v1/auth/me').set(bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.username).toBe('root');

    const no = await request(app).get('/api/v1/auth/me');
    expect(no.status).toBe(401);
    expect(no.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it("noto'g'ri parol va noma'lum login bir xil 401 xabar beradi", async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const a = await login('root', 'WrongPass1');
    const b = await login('nobody', 'WrongPass1');
    expect(a.res.status).toBe(401);
    expect(b.res.status).toBe(401);
    expect(a.res.body.error.message).toBe(b.res.body.error.message);
  });

  it("5 ta xato urinishdan so'ng bloklanadi (to'g'ri parol bilan ham)", async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    for (let i = 0; i < 5; i++) expect((await login('root', 'WrongPass1')).res.status).toBe(401);

    const locked = await login('root', PASSWORD);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.error.code).toBe('RATE_LIMITED');

    // Blok muddati o'tgach kirish mumkin
    await User.updateOne({ username: 'root' }, { lockUntil: new Date(Date.now() - 1000) });
    expect((await login('root', PASSWORD)).res.status).toBe(200);
  });

  it('nofaol foydalanuvchi va nofaol maktab foydalanuvchisi kira olmaydi', async () => {
    await makeUser({ username: 'off', role: 'superadmin', isActive: false });
    expect((await login('off')).res.status).toBe(403);

    const school = await makeSchool('a');
    await makeUser({ username: 'adm', role: 'school_admin', schoolId: school.id });
    expect((await login('adm')).res.status).toBe(200);
    school.isActive = false;
    await school.save();
    expect((await login('adm')).res.status).toBe(403);
  });

  it('refresh: rotatsiya, eski token qayta ishlatilsa barcha sessiyalar bekor', async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const { cookies } = await login('root');
    const c1 = cookieValue(cookies);

    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', c1);
    expect(r1.status).toBe(200);
    expect(r1.body.data.accessToken).toBeTruthy();
    const c2 = cookieValue(r1.headers['set-cookie'] as unknown as string[]);
    expect(c2).not.toBe(c1);

    // Eski token qayta ishlatilishi (grace oynasidan keyin)
    await RefreshToken.updateMany(
      { rotatedAt: { $ne: null } },
      { rotatedAt: new Date(Date.now() - 60_000) },
    );
    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', c1);
    expect(reuse.status).toBe(401);

    // Yangi token ham bekor qilingan
    const afterReuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', c2);
    expect(afterReuse.status).toBe(401);
    expect(await AuditLog.countDocuments({ action: 'auth.refresh_reuse' })).toBe(1);
  });

  it('refresh cookie siz 401', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('logout: refresh bekor qilinadi, cookie tozalanadi', async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const { cookies } = await login('root');
    const c = cookieValue(cookies);

    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', c);
    expect(out.status).toBe(200);
    expect((out.headers['set-cookie'] as unknown as string[]).join()).toMatch(/refreshToken=;/);

    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', c)).status).toBe(401);
  });

  it('logout-all barcha qurilma sessiyalarini bekor qiladi', async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const d1 = await login('root');
    const d2 = await login('root');

    const out = await request(app).post('/api/v1/auth/logout-all').set(bearer(d1.token));
    expect(out.status).toBe(200);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieValue(d2.cookies)))
        .status,
    ).toBe(401);
  });

  it("ochilgan sessiyadan so'ng foydalanuvchi nofaol qilinsa token ishlamaydi", async () => {
    const u = await makeUser({ username: 'root', role: 'superadmin' });
    const { token } = await login('root');
    await User.updateOne({ _id: u._id }, { isActive: false });
    expect((await request(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describe("Auth: parol o'zgartirish", () => {
  it("to'g'ri o'zgaradi, yangi parol bilan kiradi, boshqa sessiyalar bekor", async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const d1 = await login('root');
    const d2 = await login('root');

    const res = await request(app)
      .patch('/api/v1/auth/password')
      .set(bearer(d1.token))
      .set('Cookie', cookieValue(d1.cookies))
      .send({ currentPassword: PASSWORD, newPassword: 'NewPass123' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();

    expect((await login('root', PASSWORD)).res.status).toBe(401);
    expect((await login('root', 'NewPass123')).res.status).toBe(200);
    // Boshqa qurilma sessiyasi bekor, joriysi saqlanadi
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieValue(d2.cookies)))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieValue(d1.cookies)))
        .status,
    ).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'auth.password_change' })).toBe(1);
  });

  it("zaif parol va noto'g'ri joriy parol rad etiladi (VALIDATION_ERROR + details)", async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const { token } = await login('root');

    const weak = await request(app)
      .patch('/api/v1/auth/password')
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'onlyletters' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect(weak.body.error.details[0].path).toBe('newPassword');

    const short = await request(app)
      .patch('/api/v1/auth/password')
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'a1' });
    expect(short.status).toBe(400);

    const wrong = await request(app)
      .patch('/api/v1/auth/password')
      .set(bearer(token))
      .send({ currentPassword: 'Wrong1234', newPassword: 'NewPass123' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].path).toBe('currentPassword');
  });
});

describe('Umumiy', () => {
  it('health endpoint', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', db: 'connected' });
  });

  it("noma'lum yo'l — NOT_FOUND formati; buzuq JSON — VALIDATION_ERROR", async () => {
    const nf = await request(app).get('/api/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');

    const bad = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("NoSQL injection urinishi login ni aylanib o'tolmaydi", async () => {
    await makeUser({ username: 'root', role: 'superadmin' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(400);
  });

  it('Swagger docs ochiladi', async () => {
    const res = await request(app).get('/api/docs/').redirects(1);
    expect(res.status).toBe(200);
  });
});
