import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/config/migrations';
import { AuditLog } from '../src/models/AuditLog';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { rechain, rechainAllClasses } from '../src/modules/timetable/timetable.chain';
import { clock } from '../src/utils/clock';
import {
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string };
const API = '/api/v1/timetable';
// bugun 2026-10-30 (juma); 2026-11-06 = juma
let school: Doc;
let c1: Awaited<ReturnType<typeof makeClass>>;
let c2: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, eng: Doc;
let t1: Doc, t2: Doc;
let admin: string;

const e = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
});
const entry = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  ...e(weekday, lessonNo, subjectId, teacherId),
  groupKey: null,
  room: null,
});
const g = (path: string) => request(app).get(`${API}${path}`).set(bearer(admin));
const p = (path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(bearer(admin)).send(body);
const put = (path: string, body: object) =>
  request(app).put(`${API}${path}`).set(bearer(admin)).send(body);
const del = (path: string) => request(app).delete(`${API}${path}`).set(bearer(admin));

async function draft(classId: string, entries: object[], validFrom: string) {
  const c = await p(`/classes/${classId}/versions`, { validFrom });
  expect(c.status).toBe(201);
  const id = c.body.data.version.id as string;
  expect((await put(`/versions/${id}`, { entries })).status).toBe(200);
  return id;
}
const activate = (id: string, validFrom: string, extra: object = {}) =>
  p(`/versions/${id}/activate`, { validFrom, ...extra });
const get = (id: string) => TimetableVersion.findById(id).lean();

/** activatedAt har chaqiruvda 1 soniya keyin bo'lgan xom hujjat (eski ma'lumotni taqlid qiladi) */
let tick = 0;
async function raw(classId: string, validFrom: string, teacherId = t1.id, subjectId = math.id) {
  return (
    await TimetableVersion.create({
      schoolId: school.id,
      academicYearId: new Types.ObjectId(),
      classId,
      status: 'active',
      validFrom,
      entries: [entry(1, 1, subjectId, teacherId)],
      activatedAt: new Date(Date.UTC(2026, 9, 30, 6, 0, tick++)),
    })
  ).id as string;
}

beforeEach(async () => {
  tick = 0;
  clock.set(() => new Date('2026-10-30T07:00:00Z'));
  school = await makeSchool('rp1');
  const year = await makeYear(school.id);
  t1 = await makeUser({ username: 'rp_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'rp_t2', role: 'teacher', schoolId: school.id });
  c1 = await makeClass(school.id, year.id, '1-B', [t1.id]);
  c2 = await makeClass(school.id, year.id, '1-A', [t1.id]);
  math = await makeSubject('Matematika');
  eng = await makeSubject('Ingliz tili');
  await makeUser({
    username: 'rp_admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.manage', 'timetable.view'],
  });
  admin = (await login('rp_admin')).token;
});

describe('rechain: oxirgi faollashtirilgan versiya yutadi', () => {
  it('activatedAt tartibi: keyin faollashtirilgan versiya o`zidan keyin boshlanganlarni almashtiradi; idempotent', async () => {
    const a = await raw(c1.id, '2026-11-01');
    const b = await raw(c1.id, '2026-11-10', t2.id, eng.id);
    const c = await raw(c1.id, '2026-11-05'); // b dan keyin faollashtirilgan, b dan oldin boshlanadi
    expect(await rechain(c1.id)).toBeGreaterThan(0);
    expect((await get(b))?.status).toBe('replaced');
    expect(String((await get(b))?.replacedBy)).toBe(c);
    expect((await get(b))?.replacedAt).toBeInstanceOf(Date);
    expect((await get(b))?.validTo).toBeNull();
    expect(await get(a)).toMatchObject({ status: 'superseded', validTo: '2026-11-04' });
    expect(await get(c)).toMatchObject({ status: 'active', validTo: null });
    expect(await rechain(c1.id)).toBe(0);
    expect(await rechain(c1.id)).toBe(0);
  });

  it('bitta keyingi versiya bir nechta oldingisini almashtiradi', async () => {
    const x = await raw(c1.id, '2026-11-10');
    const y = await raw(c1.id, '2026-11-20');
    const z = await raw(c1.id, '2026-11-05');
    await rechain(c1.id);
    expect((await get(x))?.status).toBe('replaced');
    expect((await get(y))?.status).toBe('replaced');
    expect(String((await get(y))?.replacedBy)).toBe(z);
    expect((await get(z))?.status).toBe('active');
  });

  it('almashtiruvchi (kelajak versiya) o`chirilsa almashtirilganlar tiklanadi', async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-11-10');
    await activate(a, '2026-11-10');
    const b = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-11-03');
    await activate(b, '2026-11-03');
    expect((await get(a))?.status).toBe('replaced');
    expect((await del(`/versions/${b}`)).status).toBe(200);
    expect(await get(a)).toMatchObject({ status: 'active', validTo: null, replacedBy: null });
  });
});

describe('1-B holati', () => {
  it('C (31.10) oldin, B (30.10) keyin faollashtirilsa: B ochiq, juma darslari 06.11 da ko`rinadi', async () => {
    const A = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-10-26');
    expect((await activate(A, '2026-10-26', { confirmPast: true })).status).toBe(200);
    const C = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-10-31');
    expect((await activate(C, '2026-10-31')).status).toBe(200);
    const B = await draft(c1.id, [e(1, 1, math.id, t1.id), e(5, 1, eng.id, t1.id)], '2026-10-30');

    const prev = await g(`/versions/${B}?validFrom=2026-10-30`);
    expect(prev.body.data.willReplace).toEqual([{ id: C, validFrom: '2026-10-31', validTo: null }]);

    expect((await activate(B, '2026-10-30')).status).toBe(200);
    expect(await get(A)).toMatchObject({ status: 'superseded', validTo: '2026-10-29' });
    expect(await get(B)).toMatchObject({ status: 'active', validTo: null });
    expect(await get(C)).toMatchObject({ status: 'replaced', validTo: null });
    expect(String((await get(C))?.replacedBy)).toBe(B);

    const week = await g(`/teachers/${t1.id}/week?date=2026-11-06`);
    const fri = week.body.data.days.find((d: { date: string }) => d.date === '2026-11-06');
    expect(fri.lessons).toHaveLength(1);

    const audit = await AuditLog.findOne({
      action: 'timetable.version_activate',
      entityId: B,
    }).lean();
    expect((audit?.after as { replaced: string[] }).replaced).toEqual([C]);

    const list = await g(`/classes/${c1.id}/versions`);
    const lc = list.body.data.versions.find((v: { id: string }) => v.id === C);
    expect(lc).toMatchObject({ status: 'replaced', phase: 'replaced', replacedBy: B });
  });

  it('teskarisi: C keyin faollashtirilsa C yutadi, B 30.10 – 30.10 bo`ladi', async () => {
    const B = await draft(c1.id, [e(1, 1, math.id, t1.id), e(5, 1, eng.id, t1.id)], '2026-10-30');
    await activate(B, '2026-10-30');
    const C = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-10-31');
    expect((await activate(C, '2026-10-31')).status).toBe(200);
    expect(await get(B)).toMatchObject({ status: 'superseded', validTo: '2026-10-30' });
    expect(await get(C)).toMatchObject({ status: 'active', validTo: null });
  });

  it('migratsiya mavjud ma`lumotni tuzatadi va idempotent', async () => {
    const C = await raw(c1.id, '2026-10-31');
    const B = await raw(c1.id, '2026-10-30');
    await TimetableVersion.updateMany({}, { status: 'superseded', validTo: '2026-10-30' });
    await runMigrations();
    expect((await get(C))?.status).toBe('replaced');
    expect(await get(B)).toMatchObject({ status: 'active', validTo: null });
    expect(await rechainAllClasses()).toEqual({ classes: 1, replaced: 0 });
    await runMigrations();
    expect((await get(C))?.status).toBe('replaced');
    expect(await get(B)).toMatchObject({ status: 'active', validTo: null });
  });
});

describe('faollashtirish yo`llari', () => {
  it('teng sanada boshqa faol versiya bo`lsa 409 (mavjud xatti-harakat saqlanadi)', async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-11-10');
    await activate(a, '2026-11-10');
    const b = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-11-10');
    expect((await activate(b, '2026-11-10')).status).toBe(409);
    expect((await get(a))?.status).toBe('active');
  });

  it('o`tmish sanadan faollashtirish keyingi (joriy) versiyani almashtiradi', async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-10-28');
    await activate(a, '2026-10-28', { confirmPast: true });
    const b = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-10-20');
    expect((await activate(b, '2026-10-20')).status).toBe(400);
    expect((await activate(b, '2026-10-20', { confirmPast: true })).status).toBe(200);
    expect((await get(a))?.status).toBe('replaced');
    expect(await get(b)).toMatchObject({ status: 'active', validTo: null });
  });

  it('ommaviy faollashtirish: preview willReplace; faollashtirgach almashtiriladi', async () => {
    const o1 = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-11-12');
    await activate(o1, '2026-11-12');
    const d1 = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-11-03');
    const d2 = await draft(c2.id, [e(2, 1, eng.id, t2.id)], '2026-11-03');
    const pv = await p('/activate-bulk/preview', { versionIds: [d1, d2], validFrom: '2026-11-03' });
    expect(pv.status).toBe(200);
    expect(pv.body.data.willReplace).toEqual([
      { id: o1, validFrom: '2026-11-12', validTo: null, classId: c1.id, className: '1-B' },
    ]);
    expect(Array.isArray(pv.body.data.warnings)).toBe(true);
    const r = await p('/activate-bulk', { versionIds: [d1, d2], validFrom: '2026-11-03' });
    expect(r.status).toBe(200);
    expect((await get(o1))?.status).toBe('replaced');
    expect((await get(d1))?.status).toBe('active');
  });

  it('almashtirilgan versiya tuzatilmaydi/o`chirilmaydi, nusxalanadi; to`qnashuvda hisobga olinmaydi', async () => {
    const x = await draft(c1.id, [e(3, 3, math.id, t1.id)], '2026-11-10');
    await activate(x, '2026-11-10');
    const y = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-11-03');
    await activate(y, '2026-11-03');
    expect((await get(x))?.status).toBe('replaced');
    expect((await p(`/versions/${x}/correct`, { entries: [e(3, 3, math.id, t1.id)] })).status).toBe(
      409,
    );
    expect((await del(`/versions/${x}`)).status).toBe(409);
    expect((await put(`/versions/${x}`, { entries: [] })).status).toBe(409);
    const copy = await p(`/classes/${c1.id}/versions`, { copyFrom: x, validFrom: '2026-12-01' });
    expect(copy.status).toBe(201);
    expect(copy.body.data.version.entries).toHaveLength(1);

    // c2 qoralamasi t1 ni 3-kun 3-darsga qo'yadi: x almashtirilgani uchun to'qnashuv yo'q
    const d = await draft(c2.id, [e(3, 3, math.id, t1.id)], '2026-11-10');
    const w = await g(`/versions/${d}`);
    expect(
      w.body.data.warnings.filter((x2: { code: string }) => x2.code === 'teacher_double_booked'),
    ).toHaveLength(0);
  });

  it('joriy sinf eksporti almashtirilgan versiyani ko`rmaydi', async () => {
    const x = await draft(c1.id, [e(3, 3, math.id, t1.id)], '2026-11-10');
    await activate(x, '2026-11-10');
    const y = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-11-03');
    await activate(y, '2026-11-03');
    expect((await g(`/classes/${c1.id}/export?format=xlsx&date=2026-11-11`)).status).toBe(200);
  });
});
