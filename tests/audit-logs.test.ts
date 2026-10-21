import { ObjectId } from 'mongodb';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { sanitizeAuditValue } from '../src/modules/audit/audit.sanitize';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

let a: Awaited<ReturnType<typeof makeSchool>>;
let b: Awaited<ReturnType<typeof makeSchool>>;
let adminA: Awaited<ReturnType<typeof makeUser>>;
let adminB: Awaited<ReturnType<typeof makeUser>>;
let rootU: Awaited<ReturnType<typeof makeUser>>;
let tRoot: string, tA: string, tB: string, tNo: string, tTeacher: string;

/** createdAt ni aniq beradigan to'g'ridan-to'g'ri yozuv */
async function entry(e: {
  userId?: unknown;
  schoolId?: unknown;
  action: string;
  entity?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  at: string;
  ip?: string;
}) {
  const res = await AuditLog.collection.insertOne({
    userId: e.userId ?? null,
    schoolId: e.schoolId ?? null,
    action: e.action,
    entity: e.entity ?? 'x',
    entityId: e.entityId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    ip: e.ip ?? null,
    createdAt: new Date(e.at),
  });
  return String(res.insertedId);
}

beforeEach(async () => {
  a = await makeSchool('a');
  b = await makeSchool('b');
  rootU = await makeUser({ username: 'root', role: 'superadmin' });
  adminA = await makeUser({
    username: 'adminA',
    role: 'school_admin',
    schoolId: a.id,
    permissions: ['audit.view'],
  });
  adminB = await makeUser({
    username: 'adminB',
    role: 'school_admin',
    schoolId: b.id,
    permissions: ['audit.view'],
  });
  await makeUser({
    username: 'noaudit',
    role: 'school_admin',
    schoolId: a.id,
    permissions: ['reports.view'],
  });
  await makeUser({ username: 'tch', role: 'teacher', schoolId: a.id, permissions: ['audit.view'] });
  [tRoot, tA, tB, tNo, tTeacher] = await Promise.all(
    ['root', 'adminA', 'adminB', 'noaudit', 'tch'].map(async (u) => (await login(u)).token),
  );
  await AuditLog.deleteMany({}); // login yozuvlarini tozalaymiz — izolyatsiya testlari aniq bo'lsin
});

const get = (t: string, q = '') => request(app).get(`/api/v1/audit-logs${q}`).set(bearer(t));

describe("Audit log o'qish: ruxsat va maktab izolyatsiyasi", () => {
  it("school_admin faqat o'z maktabini ko'radi (boshqa maktab yozuvi va umumiy yozuvlar hech qachon chiqmaydi), superadmin hammasini", async () => {
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'scores.create',
      at: '2026-10-14T05:00:00Z',
    });
    await entry({
      userId: adminB._id,
      schoolId: b._id,
      action: 'scores.create',
      at: '2026-10-14T05:01:00Z',
    });
    await entry({
      userId: rootU._id,
      schoolId: null,
      action: 'auth.login',
      entity: 'user',
      at: '2026-10-14T05:02:00Z',
    });

    const asA = await get(tA);
    expect(asA.status).toBe(200);
    expect(asA.body.data).toHaveLength(1);
    expect(asA.body.data[0]).toMatchObject({
      schoolId: a.id,
      school: { id: a.id, name: 'Maktab a' },
      action: 'scores.create',
    });
    expect(asA.body.meta).toMatchObject({ page: 1, limit: 50, total: 1, totalPages: 1 });
    // schoolId filtri school_admin uchun ishlamaydi
    expect(
      (await get(tA, `?schoolId=${b.id}`)).body.data.map((r: { schoolId: string }) => r.schoolId),
    ).toEqual([a.id]);
    expect((await get(tB)).body.data.map((r: { schoolId: string }) => r.schoolId)).toEqual([b.id]);

    const all = await get(tRoot);
    expect(all.body.meta.total).toBe(3);
    expect(
      (await get(tRoot, `?schoolId=${b.id}`)).body.data.map(
        (r: { schoolId: string }) => r.schoolId,
      ),
    ).toEqual([b.id]);
    // header shart emas
    expect(all.status).toBe(200);
  });

  it("audit.view yo'q admin, o'qituvchi va anonim — 403/401; yozish endpointlari yo'q", async () => {
    expect((await get(tNo)).status).toBe(403);
    expect((await get(tTeacher)).status).toBe(403);
    expect((await get(tNo, '/filters')).status).toBe(403);
    expect((await request(app).get('/api/v1/audit-logs')).status).toBe(401);
    for (const [method, path] of [
      ['post', '/api/v1/audit-logs'],
      ['patch', '/api/v1/audit-logs/abc'],
      ['put', '/api/v1/audit-logs/abc'],
      ['delete', '/api/v1/audit-logs/abc'],
      ['delete', '/api/v1/audit-logs'],
    ] as const) {
      const r = await request(app)[method](path).set(bearer(tRoot)).send({});
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it("haqiqiy amallar audit ga yoziladi va admin ularni ko'radi (login)", async () => {
    await login('adminA');
    const rows = (await get(tA, '?action=auth.')).body.data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      action: 'auth.login',
      user: { username: 'admina', role: 'school_admin', id: adminA.id },
      school: { id: a.id },
    });
    expect(rows[0].ip).toBeTruthy();
  });
});

describe('Audit log filtrlari, qidiruv, sahifalash', () => {
  beforeEach(async () => {
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'scores.create',
      entity: 'score',
      entityId: 's1',
      at: '2026-10-10T10:00:00Z',
    });
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'scores.bulk',
      entity: 'score',
      at: '2026-10-11T10:00:00Z',
    });
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'settings.update',
      entity: 'settings',
      at: '2026-10-12T10:00:00Z',
    });
    await entry({
      userId: adminB._id,
      schoolId: b._id,
      action: 'student.create',
      entity: 'student',
      at: '2026-10-13T10:00:00Z',
    });
  });

  it('action: aniq qiymat yoki prefiks; entity; userId', async () => {
    const actions = async (q: string) =>
      (await get(tRoot, q)).body.data.map((r: { action: string }) => r.action).sort();
    expect(await actions('?action=scores.create')).toEqual(['scores.create']);
    expect(await actions('?action=scores.')).toEqual(['scores.bulk', 'scores.create']);
    expect(await actions('?action=scores')).toEqual([]); // prefiks faqat nuqta bilan
    expect(await actions('?entity=settings')).toEqual(['settings.update']);
    expect(await actions(`?userId=${adminB.id}`)).toEqual(['student.create']);
    expect(await actions(`?userId=${adminA.id}&entity=score`)).toEqual([
      'scores.bulk',
      'scores.create',
    ]);
    expect((await get(tRoot, '?userId=bad')).status).toBe(400);
  });

  it("sana oralig'i Asia/Tashkent kun chegaralari bo'yicha", async () => {
    // 2026-10-13T19:30Z = Toshkentda 14-oktyabr 00:30; 2026-10-13T18:59:59Z = 13-oktyabr 23:59:59
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'edge.after',
      at: '2026-10-13T19:30:00Z',
    });
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'edge.before',
      at: '2026-10-13T18:59:59Z',
    });
    const names = async (q: string) =>
      (await get(tRoot, `${q}&action=edge.`)).body.data
        .map((r: { action: string }) => r.action)
        .sort();
    expect(await names('?from=2026-10-14')).toEqual(['edge.after']);
    expect(await names('?to=2026-10-13')).toEqual(['edge.before']);
    expect(await names('?from=2026-10-13&to=2026-10-13')).toEqual(['edge.before']);
    expect(await names('?from=2026-10-14&to=2026-10-14')).toEqual(['edge.after']);
    expect(await names('?from=2026-10-13&to=2026-10-14')).toEqual(['edge.after', 'edge.before']);
    const range = await get(tRoot, '?from=2026-10-11&to=2026-10-12');
    expect(range.body.data.map((r: { action: string }) => r.action).sort()).toEqual([
      'scores.bulk',
      'settings.update',
    ]);
    expect((await get(tRoot, '?from=13.10.2026')).status).toBe(400);
  });

  it('search: action, entity, foydalanuvchi ismi/username; regex belgilar xavfsiz', async () => {
    const ids = async (q: string) =>
      (await get(tRoot, q)).body.data.map((r: { action: string }) => r.action).sort();
    expect(await ids('?search=bulk')).toEqual(['scores.bulk']);
    expect(await ids('?search=SETTINGS')).toEqual(['settings.update']);
    expect(await ids('?search=adminb')).toEqual(['student.create']); // username
    expect(await ids('?search=Test%20adminA')).toEqual([
      'scores.bulk',
      'scores.create',
      'settings.update',
    ]); // ism
    expect(await ids('?search=' + encodeURIComponent('(((.*['))).toEqual([]);
    expect(await ids('?search=' + encodeURIComponent('.*'))).toEqual([]); // literal, hamma narsaga mos kelmaydi
    expect((await get(tA, '?search=student')).body.data).toEqual([]); // boshqa maktab yozuvi
  });

  it('sahifalash va tartib (default -createdAt), limit chegarasi', async () => {
    const list = (await get(tRoot)).body.data.map((r: { action: string }) => r.action);
    expect(list).toEqual(['student.create', 'settings.update', 'scores.bulk', 'scores.create']);
    expect(
      (await get(tRoot, '?sort=createdAt')).body.data.map((r: { action: string }) => r.action),
    ).toEqual(['scores.create', 'scores.bulk', 'settings.update', 'student.create']);
    const p2 = await get(tRoot, '?limit=2&page=2');
    expect(p2.body.data.map((r: { action: string }) => r.action)).toEqual([
      'scores.bulk',
      'scores.create',
    ]);
    expect(p2.body.meta).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
    expect((await get(tRoot, '?limit=201')).status).toBe(400);
    expect((await get(tRoot, '?limit=200')).status).toBe(200);
    expect((await get(tRoot, '?sort=action')).status).toBe(400);
    expect((await get(tRoot, '?page=0')).status).toBe(400);
  });

  it('filters: actions/entities/users (maktab doirasida), tartiblangan va takrorsiz', async () => {
    const root = (await get(tRoot, '/filters')).body.data;
    expect(root.actions).toEqual([
      'scores.bulk',
      'scores.create',
      'settings.update',
      'student.create',
    ]);
    expect(root.entities).toEqual(['score', 'settings', 'student']);
    expect(root.users.map((u: { username: string }) => u.username).sort()).toEqual([
      'admina',
      'adminb',
    ]);
    expect(root.users[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        fullName: expect.any(String),
        role: 'school_admin',
      }),
    );

    const a1 = (await get(tA, '/filters')).body.data;
    expect(a1.actions).toEqual(['scores.bulk', 'scores.create', 'settings.update']);
    expect(a1.users.map((u: { username: string }) => u.username)).toEqual(['admina']);
    expect((await get(tA, `/filters?schoolId=${b.id}`)).body.data.actions).toEqual([
      'scores.bulk',
      'scores.create',
      'settings.update',
    ]);
    expect((await get(tRoot, `/filters?schoolId=${b.id}`)).body.data.actions).toEqual([
      'student.create',
    ]);
  });
});

describe('Audit log: maxfiy maydonlar va hajm', () => {
  it('before/after dan passwordHash, tokenHash, refreshToken, jwt, parol kalitlari olib tashlanadi (eski yozuvlarda ham)', async () => {
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'user.update',
      before: {
        fullName: 'Eski',
        passwordHash: '$2b$10$xxx',
        nested: { tokenHash: 'abc', keep: 1 },
      },
      after: {
        fullName: 'Yangi',
        refreshToken: 'r',
        accessJwt: 'j',
        password: 'p',
        newPassword: 'n',
        list: [{ secret: 's', ok: true }],
        apiKey: 'k',
        Authorization: 'Bearer x',
        phone: '+998901234567',
      },
      at: '2026-10-14T05:00:00Z',
    });
    const r = (await get(tA)).body.data[0];
    expect(r.before).toEqual({ fullName: 'Eski', nested: { keep: 1 } });
    expect(r.after).toEqual({ fullName: 'Yangi', list: [{ ok: true }], phone: '+998901234567' });
    expect(r.truncated).toBe(false);
    const text = JSON.stringify(r);
    for (const bad of [
      'passwordHash',
      '$2b$',
      'tokenHash',
      'refreshToken',
      'Bearer',
      'newPassword',
      'apiKey',
    ])
      expect(text).not.toContain(bad);
  });

  it('juda chuqur/katta obyektlar kesiladi va truncated:true', async () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'deep',
      before: deep,
      after: { items: Array.from({ length: 80 }, (_, i) => i), long: 'x'.repeat(2000) },
      at: '2026-10-14T05:00:00Z',
    });
    await entry({
      userId: adminA._id,
      schoolId: a._id,
      action: 'huge',
      after: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, 'v'.repeat(40)])),
      at: '2026-10-14T05:01:00Z',
    });
    const rows = (await get(tA)).body.data;
    const deepRow = rows.find((r: { action: string }) => r.action === 'deep');
    expect(deepRow.truncated).toBe(true);
    expect(deepRow.after.items).toHaveLength(50);
    expect(deepRow.after.long.length).toBeLessThanOrEqual(501);
    expect(JSON.stringify(deepRow.before)).toContain('[…]');
    const hugeRow = rows.find((r: { action: string }) => r.action === 'huge');
    expect(hugeRow.truncated).toBe(true);
    expect(hugeRow.after).toMatchObject({ truncated: true });
    expect(JSON.stringify(hugeRow.after).length).toBeLessThan(1500);
  });

  it('sanitizeAuditValue: null/primitive/Date/massiv va indekslar', async () => {
    expect(sanitizeAuditValue(null)).toEqual({ value: null, truncated: false });
    expect(sanitizeAuditValue(5)).toEqual({ value: 5, truncated: false });
    expect(sanitizeAuditValue({ at: new Date('2026-10-14T00:00:00Z'), ok: [1, 2] }).value).toEqual({
      at: '2026-10-14T00:00:00.000Z',
      ok: [1, 2],
    });
    const names = (await AuditLog.collection.indexes()).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'schoolId_1_createdAt_-1',
        'action_1_createdAt_-1',
        'userId_1_createdAt_-1',
      ]),
    );
    expect(names).not.toContain('audit_retention_ttl'); // AUDIT_RETENTION_DAYS berilmagan
    expect(new ObjectId()).toBeTruthy();
  });
});
