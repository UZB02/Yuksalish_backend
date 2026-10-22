import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { publicCache } from '../src/modules/public/public.cache';
import { clock } from '../src/utils/clock';
import {
  Score,
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
let school: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc;
let students: Doc[] = [];
let root: string;
let teacher: Doc;
let btype: Doc;

const NOW = '2026-10-14T07:00:00Z';
const put = (key: string, body: object) =>
  request(app).put(`/api/v1/settings/${key}`).set(bearer(root)).send(body);
const pub = (path: string) => request(app).get(`/api/v1/public${path}`);
const enable = (extra: object = {}, id = school.id) =>
  put('public', { scope: 'school', schoolId: id, values: { enabled: true, ...extra } });

async function give(student: Doc, cls: Doc, schoolId: string, yearId: string, values: number[]) {
  await Score.insertMany(
    values.map((v, i) => ({
      schoolId,
      studentId: student._id,
      classId: cls._id,
      teacherId: teacher._id,
      academicYearId: yearId,
      behaviorTypeId: btype._id,
      value: v,
      comment: 'maxfiy izoh matni',
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    })),
  );
}

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('demo-a', { logoUrl: 'https://cdn.example.com/a.png' });
  year = await makeYear(school.id);
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  root = (await login('root')).token;
  btype = await makeBehaviorType('Maxfiy xulq turi nomi');
  c5 = await makeClass(school.id, year.id, '5-A', [teacher.id]);
  c6 = await makeClass(school.id, year.id, '6-A');
  const mk = (cls: Doc, name: string, extra: Record<string, unknown> = {}) =>
    makeStudent(school.id, cls.id, name, {
      studentCode: `SECRET-${name.slice(0, 3)}`,
      parentPhone: '+998901112233',
      birthDate: new Date('2013-03-15'),
      gender: 'male',
      photoUrl: 'https://cdn.example.com/photo.jpg',
      ...extra,
    });
  students = [
    await mk(c5, 'Aliyev Ali'), // 0
    await mk(c5, 'Valiyev Vali'), // 1
    await mk(c5, 'Bekov Bek'), // 2
    await mk(c6, 'Cholpon Chol'), // 3
    await mk(c6, 'Davron Dav'), // 4 — eligible emas
  ];
  await give(students[0], c5, school.id, year.id, [90, 90, 90]); // 90
  await give(students[1], c5, school.id, year.id, [100, 100, 100]); // 100
  await give(students[2], c5, school.id, year.id, [70, 70, 70]); // 70
  await give(students[3], c6, school.id, year.id, [80, 80, 80]); // 80
  await give(students[4], c6, school.id, year.id, [99, 99]); // 2 kun
});

const keys = (o: object) => Object.keys(o).sort();
const NOT_FOUND_BODY = {
  success: false,
  error: { code: 'NOT_FOUND', message: 'Reyting topilmadi' },
};

describe('PUBLIC API: mavjudlik va 404', () => {
  it("public o'chiq / maktab yo'q / nofaol maktab — bir xil 404", async () => {
    const paths = [
      '/demo-a/config',
      '/demo-a/rating/classes',
      '/demo-a/rating/students',
      '/no-such/config',
      '/global/rating',
    ];
    for (const p of paths) {
      const r = await pub(p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).toEqual(NOT_FOUND_BODY);
    }
    await enable();
    expect((await pub('/demo-a/config')).status).toBe(200);
    await school.updateOne({ isActive: false });
    publicCache.clear();
    expect((await pub('/demo-a/config')).body).toEqual(NOT_FOUND_BODY);
  });

  it("/public/schools: faqat yoqilgan maktablar, alifbo bo'yicha, faqat name/slug/logoUrl", async () => {
    const b = await makeSchool('demo-b', { name: 'Alfa maktab' });
    await makeSchool('demo-c'); // yoqilmagan
    await enable();
    await enable({}, b.id);
    const r = await pub('/schools');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([
      { name: 'Alfa maktab', slug: 'demo-b', logoUrl: null },
      { name: 'Maktab demo-a', slug: 'demo-a', logoUrl: 'https://cdn.example.com/a.png' },
    ]);
  });

  it("zaxiralangan slug (global, api, admin) bilan maktab yaratib bo'lmaydi", async () => {
    for (const slug of ['global', 'api', 'admin', 'Global', 'ADMIN']) {
      const r = await request(app)
        .post('/api/v1/schools')
        .set(bearer(root))
        .send({ name: 'Yangi maktab', slug });
      expect(r.status, slug).toBe(400);
      expect(r.body.error.details[0].path).toBe('slug');
    }
    expect(
      (
        await request(app)
          .post('/api/v1/schools')
          .set(bearer(root))
          .send({ name: 'Yangi maktab', slug: 'globalx' })
      ).status,
    ).toBe(201);
  });
});

describe('PUBLIC API: maxfiylik va maydonlar', () => {
  it("config, sinflar, o'quvchilar: ruxsat etilgan maydonlar to'plamidan boshqasi yo'q", async () => {
    await enable({ title: 'Sarlavha', primaryColor: '#112233' });
    const cfg = await pub('/demo-a/config');
    expect(cfg.status).toBe(200);
    expect(keys(cfg.body.data)).toEqual(
      [
        'autoRefreshSeconds',
        'calculatedAt',
        'globalAvailable',
        'period',
        'primaryColor',
        'school',
        'showClasses',
        'showMedals',
        'showPhotos',
        'showScores',
        'showStudents',
        'showTrend',
        'subtitle',
        'title',
        'topStudents',
        'tvSlideSeconds',
      ].sort(),
    );
    expect(keys(cfg.body.data.school)).toEqual(['logoUrl', 'name', 'slug']);
    expect(keys(cfg.body.data.period)).toEqual(['from', 'label', 'to', 'type']);
    expect(cfg.body.data).toMatchObject({
      school: { name: 'Maktab demo-a', slug: 'demo-a', logoUrl: 'https://cdn.example.com/a.png' },
      title: 'Sarlavha',
      primaryColor: '#112233',
      topStudents: 20,
      autoRefreshSeconds: 120,
      tvSlideSeconds: 15,
      globalAvailable: false,
      period: { type: 'month', from: '2026-10-01', to: '2026-10-31', label: '2026-yil oktyabr' },
    });

    const cls = await pub('/demo-a/rating/classes');
    expect(keys(cls.body.data)).toEqual(['calculatedAt', 'items', 'period']);
    expect(keys(cls.body.data.items[0])).toEqual(
      ['className', 'classId', 'grade', 'ratedStudents', 'rank', 'rankChange', 'score'].sort(),
    );
    expect(
      cls.body.data.items.map(
        (c: { className: string; rank: number; score: number; ratedStudents: number }) => [
          c.className,
          c.rank,
          c.score,
          c.ratedStudents,
        ],
      ),
    ).toEqual([
      ['5-A', 1, 86.67, 3],
      ['6-A', 2, 80, 1],
    ]);

    const st = await pub('/demo-a/rating/students');
    expect(st.status).toBe(200);
    expect(keys(st.body.data.items[0])).toEqual(
      ['className', 'fullName', 'rank', 'rankChange', 'score', 'studentKey'].sort(),
    );
    expect(
      st.body.data.items.map((i: { fullName: string; rank: number; score: number }) => [
        i.fullName,
        i.rank,
        i.score,
      ]),
    ).toEqual([
      ['Valiyev Vali', 1, 100],
      ['Aliyev Ali', 2, 90],
      ['Cholpon Chol', 3, 80],
      ['Bekov Bek', 4, 70],
    ]); // eligible bo'lmagan Davron yo'q
    expect(st.body.meta).toMatchObject({ total: 4, page: 1, limit: 50 });

    // Hech qachon chiqmaydigan ma'lumotlar (matn bo'yicha qidiruv)
    const all = JSON.stringify([cfg.body, cls.body, st.body]);
    for (const secret of [
      'SECRET',
      '998901112233',
      'maxfiy',
      'Maxfiy xulq',
      '2013',
      'male',
      'photo.jpg',
      'teacher1',
      'Test teacher',
      school.id,
      ...students.map((s) => s.id),
      'studentCode',
      'parentPhone',
      'birthDate',
      'gender',
      'photoUrl',
      'schoolId',
      'comment',
      'behaviorType',
      'teacherId',
    ]) {
      expect(all, secret).not.toContain(secret);
    }
  });

  it("studentKey: opaque (ichki id emas), barqaror, o'quvchiga xos", async () => {
    await enable();
    const a = (await pub('/demo-a/rating/students')).body.data.items;
    publicCache.clear();
    const b = (await pub('/demo-a/rating/students')).body.data.items;
    expect(a.map((i: { studentKey: string }) => i.studentKey)).toEqual(
      b.map((i: { studentKey: string }) => i.studentKey),
    );
    expect(new Set(a.map((i: { studentKey: string }) => i.studentKey)).size).toBe(a.length);
    for (const i of a) {
      expect(students.map((s) => s.id)).not.toContain(i.studentKey);
      expect(i.studentKey).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    }
  });

  it("showScores=false: score maydoni umuman yo'q; showTrend=false: rankChange yo'q", async () => {
    await enable({ showScores: false, showTrend: false });
    for (const p of ['/demo-a/rating/classes', '/demo-a/rating/students']) {
      const items = (await pub(p)).body.data.items;
      expect(items.length).toBeGreaterThan(0);
      for (const i of items) {
        expect(i).not.toHaveProperty('score');
        expect(i).not.toHaveProperty('rankChange');
        expect(i).toHaveProperty('rank');
      }
    }
    const cfg = (await pub('/demo-a/config')).body.data;
    expect(cfg).toMatchObject({ showScores: false, showTrend: false });
  });

  it('showClasses / showStudents = false -> 404', async () => {
    await enable({ showClasses: false });
    expect((await pub('/demo-a/rating/classes')).body).toEqual(NOT_FOUND_BODY);
    expect((await pub('/demo-a/rating/students')).status).toBe(200);
    await enable({ showClasses: true, showStudents: false });
    expect((await pub('/demo-a/rating/classes')).status).toBe(200);
    expect((await pub('/demo-a/rating/students')).body).toEqual(NOT_FOUND_BODY);
  });

  it('topStudents cheklovi: filtr bilan ham eng yaxshi N ta; qidiruv cheklov ichida; null = hammasi', async () => {
    await enable({ topStudents: 2 });
    const names = async (q = '') =>
      (await pub(`/demo-a/rating/students${q}`)).body.data.items.map(
        (i: { fullName: string; rank: number }) => [i.fullName, i.rank],
      );
    expect(await names()).toEqual([
      ['Valiyev Vali', 1],
      ['Aliyev Ali', 2],
    ]);
    expect((await pub('/demo-a/rating/students')).body.meta.total).toBe(2);
    // 5-sinf filtri: shu filtrdagi eng yaxshi 2 ta (umumiy rank saqlanadi)
    expect(await names(`?classId=${c5.id}`)).toEqual([
      ['Valiyev Vali', 1],
      ['Aliyev Ali', 2],
    ]);
    expect(await names(`?classId=${c6.id}`)).toEqual([['Cholpon Chol', 3]]);
    expect(await names('?grade=6')).toEqual([['Cholpon Chol', 3]]);
    // Qidiruv cheklov doirasida: Bekov (4-o'rin) top-2 dan tashqarida
    expect(await names('?search=bek')).toEqual([]);
    expect(await names('?search=ali')).toEqual(
      [
        ['Valiyev Vali', 1],
        ['Aliyev Ali', 2],
      ]
        .slice(0, 2)
        .filter((x) => /ali/i.test(x[0] as string)),
    );
    expect(await names('?limit=1&page=2')).toEqual([['Aliyev Ali', 2]]);

    await enable({ topStudents: null });
    expect(await names()).toHaveLength(4);
    expect(await names('?search=bek')).toEqual([['Bekov Bek', 4]]);
    expect(await names('?limit=2&page=2')).toEqual([
      ['Cholpon Chol', 3],
      ['Bekov Bek', 4],
    ]);
  });
});

describe('PUBLIC API: umumiy (global) reyting', () => {
  async function setupSchools() {
    const b = await makeSchool('demo-b', { name: 'Beta maktab' });
    const by = await makeYear(b.id);
    const bc = await makeClass(b.id, by.id, '5-A');
    const bs = await makeStudent(b.id, bc.id, 'Beta Talaba', { studentCode: 'SECRET-B' });
    await give(bs, bc, b.id, by.id, [95, 95, 95]);
    const c = await makeSchool('demo-c', { name: 'Gamma maktab' }); // public o'chiq, lekin eng yuqori ball
    const cy = await makeYear(c.id);
    const cc = await makeClass(c.id, cy.id, '5-A');
    const cs = await makeStudent(c.id, cc.id, 'Gamma Talaba');
    await give(cs, cc, c.id, cy.id, [100, 100, 100]);
    await enable();
    await enable({}, b.id);
    return { b };
  }

  it("platforma globalRatingEnabled=false bo'lsa 404; yoqilsa faqat enabled+includeInGlobal maktablar, qayta raqamlangan", async () => {
    const { b } = await setupSchools();
    expect((await pub('/global/rating')).body).toEqual(NOT_FOUND_BODY);
    expect((await pub('/demo-a/config')).body.data.globalAvailable).toBe(false);

    await put('public', { scope: 'global', values: { globalRatingEnabled: true } });
    await ratingEvents.flushAll();
    const r = await pub('/global/rating');
    expect(r.status).toBe(200);
    expect(keys(r.body.data)).toEqual(['calculatedAt', 'items', 'period']);
    expect(keys(r.body.data.items[0])).toEqual(
      ['logoUrl', 'ratedStudents', 'rank', 'rankChange', 'schoolName', 'score', 'slug'].sort(),
    );
    expect(
      r.body.data.items.map((i: { slug: string; rank: number; score: number }) => [
        i.slug,
        i.rank,
        i.score,
      ]),
    ).toEqual([
      ['demo-b', 1, 95],
      ['demo-a', 2, 85],
    ]); // Gamma (public o'chiq) ko'rinmaydi, o'rinlar qayta raqamlanadi
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET|Talaba|schoolId|studentCode/);

    // includeInGlobal=false
    await enable({ includeInGlobal: false }, b.id);
    expect(
      (await pub('/global/rating')).body.data.items.map((i: { slug: string; rank: number }) => [
        i.slug,
        i.rank,
      ]),
    ).toEqual([['demo-a', 1]]);

    // globalAvailable: showScope=global && globalRatingEnabled
    expect((await pub('/demo-a/config')).body.data.globalAvailable).toBe(false);
    await enable({ showScope: 'global' });
    expect((await pub('/demo-a/config')).body.data.globalAvailable).toBe(true);

    // showScores / showTrend global sozlamadan
    await put('public', {
      scope: 'global',
      values: { globalRatingEnabled: true, showScores: false, showTrend: false },
    });
    const item = (await pub('/global/rating')).body.data.items[0];
    expect(item).not.toHaveProperty('score');
    expect(item).not.toHaveProperty('rankChange');
  });
});

describe('PUBLIC API: kesh, sarlavhalar, CORS, rate limit', () => {
  it("Cache-Control, ETag va 304; sozlama o'zgarganda kesh bekor qilinadi", async () => {
    await enable({ title: 'Eski' });
    const r1 = await pub('/demo-a/config');
    expect(r1.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');
    expect(r1.headers.etag).toMatch(/^"/);
    expect(r1.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const again = await pub('/demo-a/config').set('If-None-Match', r1.headers.etag);
    expect(again.status).toBe(304);
    expect(publicCache.size).toBeGreaterThan(0);

    await put('public', {
      scope: 'school',
      schoolId: school.id,
      values: { enabled: true, title: 'Yangi' },
    });
    expect(publicCache.size).toBe(0); // bekor qilindi
    const r2 = await pub('/demo-a/config');
    expect(r2.body.data.title).toBe('Yangi');
    expect(r2.headers.etag).not.toBe(r1.headers.etag);
    expect((await pub('/demo-a/config').set('If-None-Match', r1.headers.etag)).status).toBe(200);
  });

  it('snapshot yangilanganda (qayta hisoblash) kesh bekor qilinadi', async () => {
    await enable();
    const before = (await pub('/demo-a/rating/students')).body.data.items.map(
      (i: { fullName: string }) => i.fullName,
    );
    expect(before).toHaveLength(4);
    expect(publicCache.size).toBe(1);
    await Score.create({
      schoolId: school.id,
      studentId: students[4]._id,
      classId: c6._id,
      teacherId: teacher._id,
      academicYearId: year.id,
      behaviorTypeId: btype._id,
      value: 99,
      date: '2026-10-03',
    });
    await request(app)
      .post('/api/v1/ratings/recalculate')
      .set(bearer(root))
      .set('X-School-Id', school.id);
    expect(publicCache.size).toBe(0);
    const after = (await pub('/demo-a/rating/students')).body.data.items.map(
      (i: { fullName: string }) => i.fullName,
    );
    expect(after).toContain('Davron Dav');
  });

  it('CORS: public originlar uchun, credentials siz', async () => {
    await enable();
    const ok = await pub('/demo-a/config').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const no = await pub('/demo-a/config').set('Origin', 'http://evil.example');
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
    // Admin API esa credentials bilan
    const admin = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(admin.headers['access-control-allow-credentials']).toBe('true');
  });

  it('public API autentifikatsiyasiz, faqat GET', async () => {
    await enable();
    expect((await pub('/demo-a/config')).status).toBe(200);
    expect((await request(app).post('/api/v1/public/demo-a/config').send({})).status).toBe(404);
    expect((await request(app).delete('/api/v1/public/demo-a/config')).status).toBe(404);
  });
});

describe('PUBLIC API: rate limit', () => {
  const original = env.RATE_LIMIT_ENABLED;
  afterAll(() => {
    env.RATE_LIMIT_ENABLED = original;
  });

  it('alohida limit (testda 5/daq) yoqilganda 429 RATE_LIMITED', async () => {
    await enable();
    env.RATE_LIMIT_ENABLED = true;
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await pub('/demo-a/config')).status);
      expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      const limited = await pub('/demo-a/config');
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    } finally {
      env.RATE_LIMIT_ENABLED = false;
    }
  });
});
