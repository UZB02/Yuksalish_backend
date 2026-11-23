import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { settingsStore } from '../src/modules/settings/settings.store';
import {
  app,
  bearer,
  login,
  makeSchool,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

/**
 * Avtomatik avtorizatsiya matritsasi (E7 xavfsizlik ko'rigi): exam admin API va exam-client'ning HAR BIR marshruti
 * manba fayllaridan topiladi (yangi marshrut qo'shilsa avtomatik tekshiriladi):
 *  - admin /exams/*: tokensiz 401; modul o'chiq maktabda 403; boshqa maktab/oddiy ruxsatsiz foydalanuvchi HECH QACHON 2xx olmaydi;
 *  - exam-client: kirish (join*) dan boshqa hammasi tokensiz 401.
 */
const SRC = path.join(__dirname, '..', 'src', 'modules');
const ID = 'a'.repeat(24);

function routesOf(file: string, routerName: string) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const re = new RegExp(`${routerName}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g');
  const out: { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string }[] = [];
  for (const m of text.matchAll(re)) out.push({ method: m[1] as never, path: m[2]! });
  return out;
}
const fill = (p: string) =>
  p
    .replace(/:(key)\b/g, 'ABCDEFGHJ')
    .replace(/:([A-Za-z]*[iI]d)\b/g, ID)
    .replace(/:[A-Za-z]+/g, ID);

const adminRoutes = [
  ...routesOf('exams/exams.routes.ts', 'examsRouter'),
  ...routesOf('exams/sessions/sessions.routes.ts', 'sessionsRouter'),
  ...routesOf('exams/blocks/blocks.routes.ts', 'blocksRouter'),
];
const clientRoutes = routesOf('exam-client/exam-client.routes.ts', 'examClientRouter');

let school: Awaited<ReturnType<typeof makeSchool>>;
let off: Awaited<ReturnType<typeof makeSchool>>;
let tOut = '';
let adminOff = '';
let adminOther = '';

const call = (m: string, url: string, token?: string, schoolId?: string) => {
  let r = (request(app) as never as Record<string, (u: string) => request.Test>)[m]!(
    `/api/v1/exams${url}`,
  );
  if (token) r = r.set(bearer(token));
  if (schoolId) r = r.set('X-School-Id', schoolId);
  return r.send(m === 'get' || m === 'delete' ? undefined : {});
};

beforeEach(async () => {
  school = await makeSchool('a');
  off = await makeSchool('b');
  await makeYear(school.id);
  await makeYear(off.id);
  const root = await makeUser({ username: 'root', role: 'superadmin' });
  await settingsStore.set('school', school.id, 'exams', { enabled: true }, root.id);
  await makeUser({ username: 'tout', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'adminoff',
    role: 'school_admin',
    schoolId: off.id,
    permissions: ['exams.manage'],
  });
  await makeUser({
    username: 'adminother',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  tOut = (await login('tout')).token;
  adminOff = (await login('adminoff')).token;
  adminOther = (await login('adminother')).token;
});

describe('Exam admin API: marshrutlar ro`yxati topildi', () => {
  it('kamida 60 ta admin va 10 ta exam-client marshruti (qoplama pasayib ketmasin)', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(60);
    expect(clientRoutes.length).toBeGreaterThanOrEqual(10);
  });
});

describe('Exam admin API: avtorizatsiya matritsasi', () => {
  it('tokensiz: hamma marshrut 401', async () => {
    const bad: string[] = [];
    for (const r of adminRoutes) {
      const res = await call(r.method, fill(r.path));
      if (res.status !== 401) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('modul o`chiq maktabda (admin exams.manage bilan ham): hamma marshrut 403', async () => {
    const bad: string[] = [];
    for (const r of adminRoutes) {
      const res = await call(r.method, fill(r.path), adminOff, off.id);
      if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('imtihon ruxsati yo`q admin: hech bir marshrut 2xx bermaydi (403)', async () => {
    const bad: string[] = [];
    for (const r of adminRoutes) {
      const res = await call(r.method, fill(r.path), adminOther, school.id);
      if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('begona o`qituvchi (hech narsaga bog`lanmagan): mavjud bo`lmagan/begona resurslar uchun hech qachon 2xx emas', async () => {
    const bad: string[] = [];
    for (const r of adminRoutes) {
      // ro'yxat/meta (GET) endpointlari o'qituvchi uchun ochiq bo'lishi mumkin; faqat :id li resurs marshrutlari
      if (!/:/.test(r.path)) continue;
      const res = await call(r.method, fill(r.path), tOut, school.id);
      if (res.status >= 200 && res.status < 300) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('Exam-client: token talabi', () => {
  it('kirish (join*) dan boshqa HAR BIR marshrut tokensiz 401; yaroqsiz token ham 401', async () => {
    const open = new Set(['/join', '/join-code', '/join-confirm']);
    const bad: string[] = [];
    for (const r of clientRoutes) {
      if (open.has(r.path)) continue;
      for (const token of [undefined, 'x'.repeat(43)]) {
        let q = (request(app) as never as Record<string, (u: string) => request.Test>)[r.method]!(
          `/api/v1/exam-client${fill(r.path)}`,
        );
        if (token) q = q.set('Authorization', `Bearer ${token}`);
        const res = await q.send(r.method === 'get' ? undefined : {});
        if (res.status !== 401) bad.push(`${r.method} ${r.path} (${token ? 'token' : 'yo`q'}) -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('admin JWT exam-client uchun yaroqsiz (token turlari aralashmaydi)', async () => {
    const res = await request(app)
      .get('/api/v1/exam-client/state')
      .set('Authorization', `Bearer ${adminOff}`);
    expect(res.status).toBe(401);
  });
});
