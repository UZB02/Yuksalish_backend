import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Question } from '../src/models/Question';
import { settingsStore } from '../src/modules/settings/settings.store';
import {
  app,
  assignSubject,
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
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let math: Doc;
let admin: string, oadmin: string, tm: string, tm2: string;
let topic: Doc, topic2: Doc;

const api = (m: 'get' | 'post', url: string, t: string, body?: object) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t));
  return body ? r.send(body) : r;
};
const mkTopic = async (t: string, name: string) =>
  (await api('post', `/subjects/${math.id}/topics`, t, { name })).body.data as Doc;
const mkQ = async (t: string, topicId: string, extra: object = {}) =>
  (
    await api('post', '/questions', t, {
      topicId,
      type: 'short',
      content: [{ type: 'text', text: 'Savol' }],
      answer: { acceptedAnswers: ['1'] },
      sharing: { mode: 'subject' },
      ...extra,
    })
  ).body.data.id as string;
const bulk = (t: string, body: object) => api('post', '/questions/bulk-status', t, body);
const statusOf = async (id: string) => (await Question.findById(id).lean())!.status;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  const t1 = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  const t2 = await makeUser({ username: 'tmath2', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['exams.manage'],
  });
  await makeUser({
    username: 'oadmin',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['exams.manage'],
  });
  const c = await makeClass(school.id, year.id, '7-A');
  await assignSubject(school.id, c as never, math.id, t1.id);
  await assignSubject(school.id, c as never, math.id, t2.id);
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  admin = (await login('admin')).token;
  oadmin = (await login('oadmin')).token;
  tm = (await login('tmath')).token;
  tm2 = (await login('tmath2')).token;
  topic = await mkTopic(admin, 'Kasrlar');
  topic2 = await mkTopic(admin, 'Tenglamalar');
});

describe('POST /exams/questions/bulk-status', () => {
  it('o`qituvchi faqat o`z savollarini faollashtiradi, hamkasbinikini sabab bilan o`tkazib yuboradi; versiya oshmaydi', async () => {
    const mine = [await mkQ(tm, topic.id), await mkQ(tm, topic.id)];
    const theirs = await mkQ(tm2, topic.id);
    const r = await bulk(tm, { ids: [...mine, theirs], toStatus: 'active' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ updated: 2, unchanged: 0 });
    expect(r.body.data.skipped).toEqual([{ id: theirs, reason: expect.stringMatching(/muallif/) }]);
    for (const id of mine) expect(await statusOf(id)).toBe('active');
    expect(await statusOf(theirs)).toBe('draft');
    expect((await Question.findById(mine[0]).lean())!.version).toBe(1);
  });

  it('ma`muriyat hammasini o`zgartiradi (boshqa muallifniki ham); arxivlash va qoralamaga qaytarish', async () => {
    const ids = [await mkQ(tm, topic.id), await mkQ(tm2, topic.id)];
    expect((await bulk(admin, { ids, toStatus: 'active' })).body.data.updated).toBe(2);
    expect((await bulk(admin, { ids, toStatus: 'archived' })).body.data.updated).toBe(2);
    expect(await statusOf(ids[0]!)).toBe('archived');
    expect((await bulk(admin, { ids, toStatus: 'draft' })).body.data.updated).toBe(2);
    // allaqachon shu holatda
    const again = await bulk(admin, { ids, toStatus: 'draft' });
    expect(again.body.data).toMatchObject({ updated: 0, unchanged: 2, skipped: [] });
  });

  it('yaroqsiz savol (kalit yo`q) faollashtirilmaydi, sabab bilan; qoralamaga qaytarish mumkin', async () => {
    const good = await mkQ(tm, topic.id);
    const bad = await mkQ(tm, topic.id);
    await Question.updateOne({ _id: bad }, { $set: { answer: {} } });
    const r = await bulk(tm, { ids: [good, bad], toStatus: 'active' });
    expect(r.body.data.updated).toBe(1);
    expect(r.body.data.skipped).toHaveLength(1);
    expect(r.body.data.skipped[0]).toMatchObject({ id: bad });
    expect(r.body.data.skipped[0].reason).toMatch(/javob/i);
    expect(await statusOf(bad)).toBe('draft');
    expect(await statusOf(good)).toBe('active');
  });

  it('topicId rejimi: fromStatus filtri; boshqa mavzu va faol savollarga tegmaydi', async () => {
    const d1 = await mkQ(tm, topic.id);
    const d2 = await mkQ(tm, topic.id);
    const act = await mkQ(tm, topic.id, { status: 'active' });
    const arch = await mkQ(tm, topic.id);
    await bulk(tm, { ids: [arch], toStatus: 'archived' });
    const elsewhere = await mkQ(tm, topic2.id);
    const r = await bulk(tm, { topicId: topic.id, fromStatus: 'draft', toStatus: 'active' });
    expect(r.body.data).toMatchObject({ updated: 2, unchanged: 0, skipped: [] });
    expect(await statusOf(d1)).toBe('active');
    expect(await statusOf(d2)).toBe('active');
    expect(await statusOf(act)).toBe('active');
    expect(await statusOf(arch)).toBe('archived');
    expect(await statusOf(elsewhere)).toBe('draft');
    // fromStatus siz: arxivdagi ham faollashadi (yaroqli bo'lsa)
    const all = await bulk(tm, { topicId: topic.id, toStatus: 'active' });
    expect(all.body.data.updated).toBe(1);
    expect(await statusOf(arch)).toBe('active');
  });

  it('topicId rejimida hamkasb savollari o`tkazib yuboriladi (o`qituvchi), ma`muriyatda hammasi', async () => {
    const mine = await mkQ(tm, topic.id);
    const theirs = await mkQ(tm2, topic.id);
    const r = await bulk(tm, { topicId: topic.id, fromStatus: 'draft', toStatus: 'active' });
    expect(r.body.data.updated).toBe(1);
    expect(r.body.data.skipped.map((s: { id: string }) => s.id)).toEqual([theirs]);
    expect(await statusOf(mine)).toBe('active');
    const a = await bulk(admin, { topicId: topic.id, fromStatus: 'draft', toStatus: 'active' });
    expect(a.body.data.updated).toBe(1);
    expect(await statusOf(theirs)).toBe('active');
  });

  it('tenant izolyatsiyasi: boshqa maktab savollari o`zgarmaydi', async () => {
    const q = await mkQ(tm, topic.id);
    const byId = await bulk(oadmin, { ids: [q], toStatus: 'active' });
    expect(byId.body.data).toMatchObject({ updated: 0 });
    expect(byId.body.data.skipped).toEqual([{ id: q, reason: 'Savol topilmadi' }]);
    const byTopic = await bulk(oadmin, { topicId: topic.id, toStatus: 'active' });
    expect(byTopic.body.data).toMatchObject({ updated: 0, unchanged: 0, skipped: [] });
    expect(await statusOf(q)).toBe('draft');
  });

  it('validatsiya: ids/topicId yo`q, 500 dan ko`p id, noto`g`ri holat, noma`lum maydon -> 400', async () => {
    const many = Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(24, '0'));
    for (const b of [
      { toStatus: 'active' },
      { ids: many, toStatus: 'active' },
      { ids: [], toStatus: 'active' },
      { topicId: topic.id, toStatus: 'deleted' },
      { topicId: topic.id, toStatus: 'active', x: 1 },
      { topicId: topic.id, fromStatus: 'xxx', toStatus: 'active' },
    ]) {
      expect((await bulk(admin, b)).status, JSON.stringify(b).slice(0, 50)).toBe(400);
    }
  });

  it('audit: bitta yozuv, faqat sonlar (savol matni yo`q)', async () => {
    const ids = [await mkQ(tm, topic.id), await mkQ(tm, topic.id)];
    await bulk(tm, { ids, toStatus: 'active' });
    const logs = await AuditLog.find({ action: 'exam.question.bulk_status' }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.after).toMatchObject({
      toStatus: 'active',
      updated: 2,
      mode: 'ids',
      skipped: 0,
    });
    expect(JSON.stringify(logs[0])).not.toContain('Savol');
  });

  it('imtihon moduli o`chiq bo`lsa 403', async () => {
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: false },
      (await makeUser({ username: 'r2', role: 'superadmin' })).id,
    );
    expect((await bulk(admin, { topicId: topic.id, toStatus: 'active' })).status).toBe(403);
  });
});
