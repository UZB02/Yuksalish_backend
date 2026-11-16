import cookieParser from 'cookie-parser';
import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, TEACHER_BASE_PERMISSIONS } from '../src/constants/permissions';
import { createHttpLogger, httpLogLevel, isExamClientUrl } from '../src/core/http-logger';
import { errorHandler } from '../src/middlewares/errorHandler';
import {
  createExamClientLimiters,
  createRefreshLimiters,
  loginLimiter,
  refreshIpLimiter,
  refreshTokenLimiter,
} from '../src/middlewares/rateLimiters';
import { authRouter } from '../src/modules/auth/auth.routes';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { EXAMS_DEFAULTS } from '../src/modules/settings/exams.settings';
import { AuditLog } from '../src/models/AuditLog';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

const ok = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
};

describe('E0: /auth/refresh alohida limiter', () => {
  type Layer = { route?: { path: string; stack: { handle: unknown }[] } };
  const handlesOf = (path: string) =>
    (authRouter.stack as unknown as Layer[])
      .find((l) => l.route?.path === path)!
      .route!.stack.map((s) => s.handle);

  it("/auth/refresh loginLimiter dan foydalanmaydi, /auth/login esa o'zgarmagan", () => {
    const refresh = handlesOf('/refresh');
    expect(refresh).not.toContain(loginLimiter);
    expect(refresh).toContain(refreshIpLimiter);
    expect(refresh).toContain(refreshTokenLimiter);
    expect(refreshIpLimiter).not.toBe(loginLimiter);
    expect(handlesOf('/login')).toContain(loginLimiter);
  });

  const mini = (opts: Parameters<typeof createRefreshLimiters>[0]) => {
    const a = express();
    a.use(cookieParser());
    const l = createRefreshLimiters({ enabled: () => true, ...opts });
    a.post('/refresh', l.ip, l.token, ok);
    a.use(errorHandler);
    return a;
  };
  const hit = (a: express.Express, token?: string) => {
    const r = request(a).post('/refresh');
    return token ? r.set('Cookie', `refreshToken=${token}`) : r;
  };

  it("bitta refresh token xeshi bo'yicha qattiq chegara, boshqa token (bir IP) ta'sirlanmaydi", async () => {
    const a = mini({ tokenLimit: 2, ipLimit: 100 });
    expect((await hit(a, 'tok-A')).status).toBe(200);
    expect((await hit(a, 'tok-A')).status).toBe(200);
    const blocked = await hit(a, 'tok-A');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // Xuddi shu IP, boshqa foydalanuvchi (NAT): o'tadi
    expect((await hit(a, 'tok-B')).status).toBe(200);
  });

  it("cookie yo'q so'rovlar token chegarasiga tushmaydi (NAT: login sahifasi), faqat IP chegarasi", async () => {
    const a = mini({ tokenLimit: 1, ipLimit: 4 });
    for (let i = 0; i < 4; i++) expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(429); // IP chegarasi
  });

  it('IP chegarasi saxiy: 30 ta emas, yuzlab turli foydalanuvchiga yetadi', async () => {
    const a = mini({ ipLimit: 600 });
    for (let i = 0; i < 40; i++) expect((await hit(a, `u-${i}`)).status).toBe(200);
  });

  it('standart qiymatlar: IP 600/15 daq, token 20/daq', async () => {
    const a = mini({});
    // 20 ta o'tadi, 21-chi to'xtaydi (token), IP esa hali ancha uzoq
    for (let i = 0; i < 20; i++) expect((await hit(a, 'same')).status).toBe(200);
    expect((await hit(a, 'same')).status).toBe(429);
    expect((await hit(a, 'other')).status).toBe(200);
  });
});

describe('E0: exam-client limiter skeleti', () => {
  const mini = (opts: Parameters<typeof createExamClientLimiters>[0]) => {
    const a = express();
    a.use(express.json());
    const l = createExamClientLimiters({ enabled: () => true, ...opts });
    a.use('/x', l.ip, l.main, ok);
    a.use(errorHandler);
    return a;
  };

  it('kalit: urinish tokeni xeshi; bir IP dagi boshqa token alohida chelak', async () => {
    const a = mini({ tokenLimit: 2, joinLimit: 100 });
    const call = (t: string) => request(a).post('/x').set('Authorization', `Bearer ${t}`).send({});
    expect((await call('att-1')).status).toBe(200);
    expect((await call('att-1')).status).toBe(200);
    expect((await call('att-1')).status).toBe(429);
    expect((await call('att-2')).status).toBe(200);
  });

  it("tokensiz (kirish): IP + kod bo'yicha saxiy chegara, boshqa kod alohida", async () => {
    const a = mini({ joinLimit: 3, tokenLimit: 1 });
    const join = (code: string) => request(a).post('/x').send({ code });
    for (let i = 0; i < 3; i++) expect((await join('abc123')).status).toBe(200);
    expect((await join('ABC123')).status).toBe(429); // kod normallashadi (katta harf)
    expect((await join('zzz999')).status).toBe(200);
  });

  it("IP bo'yicha xavfsizlik to'ri juda baland chegarada ishlaydi", async () => {
    const a = mini({ ipLimit: 3, tokenLimit: 100, joinLimit: 100 });
    for (let i = 0; i < 3; i++) {
      expect(
        (await request(a).post('/x').set('Authorization', `Bearer t${i}`).send({})).status,
      ).toBe(200);
    }
    expect((await request(a).post('/x').set('Authorization', 'Bearer t9').send({})).status).toBe(
      429,
    );
  });

  it("haqiqiy app: /api/v1/exam-client/* noma'lum yo'llar 404, kirish validatsiyasi 400; CORS sarlavhasi yo'q", async () => {
    const origin = 'http://localhost:5173';
    for (const [method, path] of [
      ['get', '/api/v1/exam-client'],
      ['get', '/api/v1/exam-client/join'],
      ['post', '/api/v1/exam-client/attempts/abc/answers'],
    ] as const) {
      const res = await request(app)[method](path).set('Origin', origin).send({ code: '123456' });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    // E4: /join haqiqiy endpoint (noto'g'ri tana: 400), lekin CORS sarlavhasi baribir yo'q, javob no-store
    const join = await request(app)
      .post('/api/v1/exam-client/join')
      .set('Origin', origin)
      .send({ code: '123456' });
    expect(join.status).toBe(400);
    expect(join.headers['access-control-allow-origin']).toBeUndefined();
    expect(join.headers['cache-control']).toBe('no-store');
    // Taqqoslash: oddiy admin API CORS beradi
    const health = await request(app).get('/api/v1/health').set('Origin', origin);
    expect(health.headers['access-control-allow-origin']).toBe(origin);
  });
});

describe('E0: exam-client loglari', () => {
  it('isExamClientUrl faqat shu prefiksga mos', () => {
    expect(isExamClientUrl('/api/v1/exam-client/answers?x=1')).toBe(true);
    expect(isExamClientUrl('/api/v1/exam-client')).toBe(true);
    expect(isExamClientUrl('/api/v1/exam-clientele')).toBe(false);
    expect(isExamClientUrl('/api/v1/exams/questions')).toBe(false);
    expect(isExamClientUrl(undefined)).toBe(false);
  });

  it("autosave (2xx/4xx) yozilmaydi, xato (5xx) yoziladi; boshqa yo'llar odatdagidek", async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
    const a = express();
    a.use(createHttpLogger(logger));
    a.get('/api/v1/exam-client/save', ok);
    a.get('/api/v1/exam-client/bad', (_req, res) => void res.status(400).json({}));
    a.get('/api/v1/exam-client/boom', (_req, res) => void res.status(500).json({}));
    a.get('/api/v1/other', ok);
    for (const p of ['save', 'bad', 'boom']) await request(a).get(`/api/v1/exam-client/${p}`);
    await request(a).get('/api/v1/other');
    const logged = lines.map(
      (l) => JSON.parse(l) as { req: { url: string }; res: { statusCode: number } },
    );
    const urls = logged.map((l) => `${l.res.statusCode} ${l.req.url}`);
    expect(urls).toEqual(['500 /api/v1/exam-client/boom', '200 /api/v1/other']);
  });

  it('httpLogLevel: xato bo`lsa har doim error', () => {
    const req = { url: '/api/v1/exam-client/x' } as never;
    expect(httpLogLevel(req, { statusCode: 200 } as never, new Error('x'))).toBe('error');
    expect(httpLogLevel(req, { statusCode: 200 } as never)).toBe('silent');
  });
});

describe('E0: exams sozlamalari va ruxsatlar', () => {
  it('standart qiymatlar: enabled=false, teachersCanCreateQuizzes=true, candidateRetentionDays=365', async () => {
    expect(EXAMS_DEFAULTS).toEqual({
      enabled: false,
      teachersCanCreateQuizzes: true,
      teacherQuizNeedsApproval: false,
      candidateRetentionDays: 365,
    });
    const school = await makeSchool('a');
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    const { token } = await login('tch');
    const res = await request(app).get('/api/v1/settings/exams').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.effective).toEqual(EXAMS_DEFAULTS);
    expect(res.body.data.override).toBeNull();
  });

  it("katalogga 4 ta kalit qo'shilgan, o'qituvchida faqat exams.questions doim bor", () => {
    const keys = PERMISSION_CATALOG.map((p) => p.key);
    for (const k of ['exams.questions', 'exams.manage', 'exams.grade', 'exams.results']) {
      expect(keys).toContain(k);
    }
    expect(TEACHER_BASE_PERMISSIONS).toContain('exams.questions');
    for (const k of ['exams.manage', 'exams.grade', 'exams.results']) {
      expect(TEACHER_BASE_PERMISSIONS).not.toContain(k);
    }
    expect(PERMISSION_CATALOG.find((p) => p.key === 'exams.manage')!.roles).toEqual([
      'school_admin',
    ]);
  });

  async function setup() {
    const school = await makeSchool('a');
    const other = await makeSchool('b');
    await makeUser({ username: 'root', role: 'superadmin' });
    await makeUser({
      username: 'adm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['exams.manage'],
    });
    await makeUser({
      username: 'plain',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['students.view'],
    });
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    return {
      school,
      other,
      root: (await login('root')).token,
      adm: (await login('adm')).token,
      plain: (await login('plain')).token,
      tch: (await login('tch')).token,
    };
  }
  const put = (token: string, body: unknown) =>
    request(app)
      .put('/api/v1/settings/exams')
      .set(bearer(token))
      .send(body as object);

  it('superadmin enabled ni yoqadi/o`chiradi (maktab bo`yicha) va audit yoziladi', async () => {
    const s = await setup();
    const res = await put(s.root, {
      scope: 'school',
      schoolId: s.school.id,
      values: { enabled: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.effective.enabled).toBe(true);
    const other = await request(app)
      .get('/api/v1/settings/exams')
      .set({ ...bearer(s.root), 'X-School-Id': s.other.id });
    expect(other.body.data.effective.enabled).toBe(false); // boshqa maktab: o'chiq
    expect(await AuditLog.countDocuments({ action: 'settings.update', entityId: 'exams' })).toBe(1);
  });

  it("maktab admini (exams.manage) enabled dan boshqasini yozadi; enabled yuborsa 403; superadmin qo'ygan enabled saqlanadi", async () => {
    const s = await setup();
    await put(s.root, { scope: 'school', schoolId: s.school.id, values: { enabled: true } });

    const bad = await put(s.adm, { scope: 'school', values: { enabled: false } });
    expect(bad.status).toBe(403);

    const res = await put(s.adm, {
      scope: 'school',
      values: { teachersCanCreateQuizzes: false, candidateRetentionDays: 90 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.effective).toEqual({
      enabled: true, // superadmin qiymati yo'qolmagan
      teachersCanCreateQuizzes: false,
      teacherQuizNeedsApproval: false,
      candidateRetentionDays: 90,
    });
    expect(res.body.data.override.enabled).toBe(true);

    // "Standartga qaytarish" ham enabled ni o'chirib yubormaydi
    const reset = await put(s.adm, { scope: 'school', values: null });
    expect(reset.status).toBe(200);
    expect(reset.body.data.effective).toEqual({ ...EXAMS_DEFAULTS, enabled: true });
  });

  it("maktab admini: global scope, boshqa maktab, ruxsatsiz admin va o'qituvchi 403", async () => {
    const s = await setup();
    expect(
      (await put(s.adm, { scope: 'global', values: { candidateRetentionDays: 30 } })).status,
    ).toBe(403);
    expect(
      (
        await put(s.adm, {
          scope: 'school',
          schoolId: s.other.id,
          values: { candidateRetentionDays: 30 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await put(s.plain, { scope: 'school', values: { candidateRetentionDays: 30 } })).status,
    ).toBe(403);
    expect(
      (await put(s.tch, { scope: 'school', values: { candidateRetentionDays: 30 } })).status,
    ).toBe(403);
    // O'qiy oladi (effective), lekin tafsilot (global/override) faqat exams.manage/superadmin ga
    const g = await request(app).get('/api/v1/settings/exams').set(bearer(s.tch));
    expect(g.status).toBe(200);
    expect(g.body.data.global).toBeNull();
  });

  it('saqlash muddati 1..3650, butun son', async () => {
    const s = await setup();
    for (const v of [0, -1, 3651, 1.5, '30']) {
      const r = await put(s.root, {
        scope: 'school',
        schoolId: s.school.id,
        values: { candidateRetentionDays: v },
      });
      expect(r.status, String(v)).toBe(400);
    }
    for (const v of [1, 3650]) {
      const r = await put(s.root, {
        scope: 'school',
        schoolId: s.school.id,
        values: { candidateRetentionDays: v },
      });
      expect(r.status, String(v)).toBe(200);
    }
  });

  it("exams sozlamasi o'zgarishi reytingni qayta hisoblashni ishga tushirmaydi", async () => {
    const s = await setup();
    await ratingEvents.flushAll();
    expect(ratingEvents.pending).toEqual([]);
    await put(s.root, { scope: 'school', schoolId: s.school.id, values: { enabled: true } });
    await put(s.root, { scope: 'global', values: { candidateRetentionDays: 200 } });
    expect(ratingEvents.pending).toEqual([]);
  });
});
