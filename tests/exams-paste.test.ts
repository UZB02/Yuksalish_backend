import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExamSession } from '../src/models/ExamSession';
import { ExamTopic } from '../src/models/ExamTopic';
import { Question } from '../src/models/Question';
import { settingsStore } from '../src/modules/settings/settings.store';
import { clock } from '../src/utils/clock';
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
let math: Doc, lang: Doc;
let admin: string, oadmin: string, tmath: string, tlang: string, tfree: string, tfake: string;
let tmathId: string, tlangId: string, rootId: string;
let c7a: Doc;

const call = (
  m: 'get' | 'post' | 'patch' | 'delete' | 'put',
  url: string,
  t: string,
  body?: object,
  schoolId = school.id,
) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', schoolId);
  return body ? r.send(body) : r;
};
const my = (m: 'get' | 'post' | 'delete', url: string, t: string, body?: object) =>
  call(m, `/my-blocks${url}`, t, body);

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  lang = await makeSubject('Ona tili');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  rootId = rootU.id;
  const tm = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  const tl = await makeUser({ username: 'tlang', role: 'teacher', schoolId: school.id });
  const tf = await makeUser({ username: 'tfree', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tfake', role: 'teacher', schoolId: other.id });
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
  tmathId = tm.id;
  tlangId = tl.id;
  c7a = (await makeClass(school.id, year.id, '7-A')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, tm.id);
  await assignSubject(school.id, c7a as never, lang.id, tl.id);
  const c8 = (await makeClass(school.id, year.id, '8-A')) as unknown as Doc;
  await assignSubject(school.id, c8 as never, math.id, tf.id);
  for (const s of [school, other]) {
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  }
  admin = (await login('admin')).token;
  oadmin = (await login('oadmin')).token;
  tmath = (await login('tmath')).token;
  tlang = (await login('tlang')).token;
  tfree = (await login('tfree')).token;
  tfake = (await login('tfake')).token;
});

async function draft(o: { deadline?: Date | null; mathTarget?: number } = {}) {
  const r = await call('post', '/sessions', admin, {
    title: 'DTM sinov',
    type: 'quarter',
    classIds: [c7a.id],
    blocks: [
      {
        subjectId: math.id,
        targetCount: o.mathTarget ?? 5,
        coefficient: 1,
        durationMin: 30,
        contributorIds: [tmathId],
        items: [],
      },
      {
        subjectId: lang.id,
        targetCount: 2,
        coefficient: 1,
        durationMin: 20,
        contributorIds: [tlangId],
        items: [],
      },
    ],
    scoringMode: 'coefficient',
    timingMode: 'per_block',
    scheduledStart: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    contribDeadline:
      o.deadline === undefined
        ? new Date(Date.now() + 3_600_000).toISOString()
        : o.deadline?.toISOString(),
    resultsMode: 'score_answers',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    id: r.body.data.id as string,
    bm: r.body.data.blocks[0].id as string,
    bl: r.body.data.blocks[1].id as string,
  };
}

const TEXT = `1. 7 + 5 nechiga teng?
A) 11
B) 12
C) 13
Javob: B

2. Burchaklar yig'indisi?
A) 90 B) 180 C) 270
Javob: B

3. $x^2=9$ ning musbat ildizi?
A) 2
B) 3

4. Oxirgi savol
A) bir
B) ikki
Javob: A`;
// 3-savolda javob yo'q

describe('Matnni joylash: jonli ko`rish (vazifa)', () => {
  it('biriktirilgan o`qituvchi va tuzuvchi ko`radi; bazaga hech narsa yozilmaydi; javob kaliti bilan', async () => {
    const { id, bm } = await draft();
    const before = await Question.countDocuments({});
    const topicsBefore = await ExamTopic.countDocuments({});
    const r = await my('post', `/${id}/${bm}/paste/preview`, tmath, { text: TEXT });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.stats.total).toBe(4);
    expect(d.items[0]).toMatchObject({ idx: 1, number: 1, correct: ['B'], type: 'single' });
    expect(d.items[0].options.map((o: { id: string }) => o.id)).toEqual(['A', 'B', 'C']);
    // 3-savolda javob yo'q: tanlash mumkin
    expect(d.items[2]).toMatchObject({ idx: 3, pickable: true, correct: [] });
    expect(d.items[2].warnings[0]).toMatchObject({ code: 'noAnswer', blocking: true });
    expect(d.stats.problems).toBe(1);
    expect(d.limits).toEqual({ maxQuestions: 200, maxBytes: 70000 });
    expect(await Question.countDocuments({})).toBe(before);
    expect(await ExamTopic.countDocuments({})).toBe(topicsBefore);
    const c = await my('post', `/${id}/${bm}/paste/preview`, admin, { text: TEXT });
    expect(c.status).toBe(200);
  });

  it('ruxsat: biriktirilmagan o`qituvchi, boshqa fan, boshqa maktab, tokensiz', async () => {
    const { id, bm, bl } = await draft();
    const url = `/${id}/${bm}/paste/preview`;
    expect((await my('post', url, tfree, { text: TEXT })).status).toBe(404);
    expect((await my('post', url, tlang, { text: TEXT })).status).toBe(404);
    expect((await my('post', `/${id}/${bl}/paste/preview`, tmath, { text: TEXT })).status).toBe(
      404,
    );
    // boshqa maktab o'qituvchisi (X-School-Id begona): kirish yo'q
    const x = await my('post', url, tfake, { text: TEXT });
    expect([403, 404]).toContain(x.status);
    const ox = await call('post', `/my-blocks${url}`, oadmin, { text: TEXT }, other.id);
    expect(ox.status).toBe(404);
    const anon = await request(app)
      .post(`/api/v1/exams/my-blocks${url}`)
      .set('X-School-Id', school.id)
      .send({ text: TEXT });
    expect(anon.status).toBe(401);
    // yo'q blok
    expect(
      (await my('post', `/${id}/${'a'.repeat(24)}/paste/preview`, tmath, { text: TEXT })).status,
    ).toBe(404);
  });

  it('qulf: tuzuvchi "tayyor" qo`ygan, muddat o`tgan yoki rejalashtirilgan imtihonda ko`rish ham yopiq', async () => {
    const { id, bm } = await draft();
    const url = `/${id}/${bm}/paste/preview`;
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true });
    expect((await my('post', url, tmath, { text: TEXT })).status).toBe(403);
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: false });
    expect((await my('post', url, tmath, { text: TEXT })).status).toBe(200);
    clock.set(() => new Date(Date.now() + 2 * 3_600_000));
    expect((await my('post', url, tmath, { text: TEXT })).status).toBe(403);
    clock.reset();
  });

  it('chegaralar: bayt hajmi, savollar soni, bo`sh matn, noto`g`ri tana', async () => {
    const { id, bm } = await draft();
    const url = `/${id}/${bm}/paste/preview`;
    const big = await my('post', url, tmath, { text: 'a'.repeat(70_001) });
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.body)).toContain('70 KB');
    const many = Array.from({ length: 201 }, (_, i) => `${i + 1}. s\nA) 1\nB) 2\nJavob: A`).join(
      '\n',
    );
    expect(Buffer.byteLength(many)).toBeLessThan(70_000);
    const m = await my('post', url, tmath, { text: many });
    expect(m.status).toBe(400);
    expect(JSON.stringify(m.body)).toContain('201 ta savol');
    const ok200 = Array.from({ length: 200 }, (_, i) => `${i + 1}. s\nA) 1\nB) 2\nJavob: A`).join(
      '\n',
    );
    expect((await my('post', url, tmath, { text: ok200 })).body.data.stats.total).toBe(200);
    // kirill (2 bayt) bilan bayt hisobi
    const cyr = await my('post', url, tmath, { text: 'я'.repeat(36_000) });
    expect(cyr.status).toBe(400);
    expect((await my('post', url, tmath, { text: '' })).body.data.stats.total).toBe(0);
    expect((await my('post', url, tmath, {})).status).toBe(400);
    expect((await my('post', url, tmath, { text: 'x', extra: 1 })).status).toBe(400);
    expect((await my('post', url, tmath, { text: 5 })).status).toBe(400);
  });
});

describe('Matnni joylash: saqlash (vazifa)', () => {
  it('bankka FAOL, muallif = o`qituvchi, yopiq; blokka qo`shiladi; javobsiz savol tanlov bilan; chiqarib tashlash', async () => {
    const { id, bm } = await draft();
    const url = `/${id}/${bm}/paste/commit`;
    // javob tanlanmasa 3-savol o'tkazib yuboriladi
    const a = await my('post', url, tmath, { text: TEXT, difficulty: 3, points: 2 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.data).toMatchObject({
      created: 3,
      addedToBlock: 3,
      count: 3,
      target: 5,
      total: 4,
    });
    expect(a.body.data.skipped).toEqual([{ idx: 3, reasons: ["To'g'ri javob ko'rsatilmagan"] }]);
    const qs = await Question.find({ _id: { $in: a.body.data.ids } }).lean();
    expect(qs).toHaveLength(3);
    for (const q of qs) {
      expect(q).toMatchObject({
        status: 'active',
        scope: 'school',
        difficulty: 3,
        points: 2,
        type: 'single',
      });
      expect(String(q.authorId)).toBe(tmathId);
      expect(String(q.schoolId)).toBe(school.id);
      expect(String(q.subjectId)).toBe(math.id);
      expect(q.sharing?.mode).toBe('private');
    }
    const topic = await ExamTopic.findById(qs[0]!.topicId).lean();
    expect(topic?.name).toBe('Imtihon: DTM sinov');
    expect(qs[0]!.answer?.optionId).toBe('B');
    // blokdagi ro'yxat
    const mine = await my('get', `/${id}/${bm}`, tmath);
    expect(mine.body.data.questions).toHaveLength(3);
    // 3-savolga javob tanlab (A), 1-savolni chiqarib tashlab qayta saqlash
    const b = await my('post', url, tmath, {
      text: TEXT,
      picks: [{ idx: 3, answer: ['B'] }],
      exclude: [1, 2, 4],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.data).toMatchObject({ created: 1, addedToBlock: 1, count: 4, excluded: 3 });
    const q3 = await Question.findById(b.body.data.ids[0]).lean();
    expect(q3?.answer?.optionId).toBe('B');
    expect(q3?.content).toEqual([
      expect.objectContaining({ type: 'math', tex: 'x^2=9' }),
      expect.objectContaining({ type: 'text' }),
    ]);
  });

  it('ko`p javobli savol (multi), qiyinlik/ball standarti, yaroqsiz tuzatishlar e`tiborsiz', async () => {
    const { id, bm } = await draft();
    const r = await my('post', `/${id}/${bm}/paste/commit`, tmath, {
      text: '1. Tub sonlar?\nA) 2\nB) 4\nC) 5\nJavob: A, C\n2. Tanla\nA) x\nB) y',
      picks: [{ idx: 2, answer: ['F'] }],
    });
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(1);
    expect(r.body.data.skipped).toHaveLength(1);
    const q = await Question.findById(r.body.data.ids[0]).lean();
    expect(q).toMatchObject({ type: 'multi', difficulty: 2, points: 1 });
    expect(q?.answer?.optionIds).toEqual(['A', 'C']);
  });

  it('tanlangan mavzu: shu fanniki bo`lsa o`tadi; boshqa fan, begona maktab mavzusi va yo`q mavzu = 404', async () => {
    const { id, bm } = await draft();
    const t1 = (await call('post', `/subjects/${math.id}/topics`, tmath, { name: 'Algebra' })).body
      .data;
    const tl = (await call('post', `/subjects/${lang.id}/topics`, tlang, { name: 'Imlo' })).body
      .data;
    const ot = (
      await call('post', `/subjects/${math.id}/topics`, oadmin, { name: 'Boshqa' }, other.id)
    ).body.data;
    const url = `/${id}/${bm}/paste/commit`;
    const body = (topicId: string) => ({
      text: '1. S\nA) 1\nB) 2\nJavob: A',
      topicId,
    });
    expect((await my('post', url, tmath, body(tl.id))).status).toBe(404);
    expect((await my('post', url, tmath, body(ot.id))).status).toBe(404);
    expect((await my('post', url, tmath, body('a'.repeat(24)))).status).toBe(404);
    const ok = await my('post', url, tmath, body(t1.id));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const q = await Question.findById(ok.body.data.ids[0]).lean();
    expect(String(q?.topicId)).toBe(t1.id);
  });

  it('ruxsat va izolyatsiya: biriktirilmagan, boshqa fan, boshqa maktab = 404; bankka hech narsa yozilmaydi', async () => {
    const { id, bm, bl } = await draft();
    const before = await Question.countDocuments({});
    const b = { text: '1. S\nA) 1\nB) 2\nJavob: A' };
    expect((await my('post', `/${id}/${bm}/paste/commit`, tfree, b)).status).toBe(404);
    expect((await my('post', `/${id}/${bm}/paste/commit`, tlang, b)).status).toBe(404);
    expect((await my('post', `/${id}/${bl}/paste/commit`, tmath, b)).status).toBe(404);
    expect(
      (await call('post', `/my-blocks/${id}/${bm}/paste/commit`, oadmin, b, other.id)).status,
    ).toBe(404);
    expect(await Question.countDocuments({})).toBe(before);
  });

  it('qulf: tuzuvchi "tayyor"i, muddat o`tishi, rejalashtirilgan holat: 403 va bankka yozilmaydi; tuzuvchining o`zi qo`sha oladi', async () => {
    const { id, bm } = await draft();
    const url = `/${id}/${bm}/paste/commit`;
    const b = { text: '1. S\nA) 1\nB) 2\nJavob: A' };
    const before = await Question.countDocuments({});
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true });
    expect((await my('post', url, tmath, b)).status).toBe(403);
    // tuzuvchi o'zi tayyor belgisi bilan ham qo'sha oladi (draft holatda)
    const c = await my('post', url, admin, b);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: false });
    expect(await Question.countDocuments({})).toBe(before + 1);
    clock.set(() => new Date(Date.now() + 2 * 3_600_000));
    expect((await my('post', url, tmath, b)).status).toBe(403);
    clock.reset();
    expect(await Question.countDocuments({})).toBe(before + 1);
    // o'qituvchi "tayyor" qo'ysa ham tahrir ochiq (readyBy=contributor)
    expect((await my('post', `/${id}/${bm}/ready`, tmath, { ready: true })).status).toBe(200);
    expect((await my('post', url, tmath, b)).status).toBe(201);
    // imtihon qoralamadan chiqqach
    await ExamSession.updateOne({ _id: id }, { $set: { status: 'scheduled' } });
    expect((await my('post', url, tmath, b)).status).toBe(403);
  });

  it('chegaralar: 200 dan ko`p savol va hajm 400; blokka sig`maydigan hajm bankka yozishdan OLDIN rad etiladi', async () => {
    const { id, bm } = await draft();
    const url = `/${id}/${bm}/paste/commit`;
    const before = await Question.countDocuments({});
    const many = Array.from({ length: 201 }, (_, i) => `${i + 1}. s\nA) 1\nB) 2\nJavob: A`).join(
      '\n',
    );
    expect((await my('post', url, tmath, { text: many })).status).toBe(400);
    expect((await my('post', url, tmath, { text: 'a'.repeat(70_001) })).status).toBe(400);
    expect(await Question.countDocuments({})).toBe(before);
    // blokni 499 taga to'ldiramiz (MAX_POOL = 500): 2 ta qo'shish = 501 -> rad
    const fill = Array.from({ length: 499 }, (_, i) => ({
      questionId: new Types.ObjectId(),
      addedBy: tmathId,
      addedAt: new Date(),
      i,
    }));
    await ExamSession.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { 'blocks.0.contribQuestions': fill.map(({ i: _i, ...x }) => x) } },
    );
    const r = await my('post', url, tmath, {
      text: '1. S\nA) 1\nB) 2\nJavob: A\n2. S\nA) 1\nB) 2\nJavob: A',
    });
    expect(r.status).toBe(400);
    expect(await Question.countDocuments({})).toBe(before);
  });

  it('tana tekshiruvi: noma`lum maydon, qiyinlik/ball chegarasi, noto`g`ri tanlov', async () => {
    const { id, bm } = await draft();
    const url = `/${id}/${bm}/paste/commit`;
    const t = '1. S\nA) 1\nB) 2\nJavob: A';
    expect((await my('post', url, tmath, { text: t, extra: 1 })).status).toBe(400);
    expect((await my('post', url, tmath, { text: t, difficulty: 4 })).status).toBe(400);
    expect((await my('post', url, tmath, { text: t, points: 0 })).status).toBe(400);
    expect((await my('post', url, tmath, { text: t, points: 101 })).status).toBe(400);
    expect(
      (await my('post', url, tmath, { text: t, picks: [{ idx: 1, answer: ['Z'] }] })).status,
    ).toBe(400);
    expect(
      (await my('post', url, tmath, { text: t, picks: [{ idx: 1, answer: [] }] })).status,
    ).toBe(400);
  });
});

describe('Matnni joylash: savollar banki', () => {
  it('o`qituvchi o`z fani mavzusiga qoralama sifatida saqlaydi; faol qilish ixtiyoriy', async () => {
    const t1 = (await call('post', `/subjects/${math.id}/topics`, tmath, { name: 'Algebra' })).body
      .data;
    const pre = await call('post', '/questions/paste/preview', tmath, { text: TEXT });
    expect(pre.status).toBe(200);
    expect(pre.body.data.stats.total).toBe(4);
    const r = await call('post', '/questions/paste/commit', tmath, {
      text: TEXT,
      topicId: t1.id,
      picks: [{ idx: 3, answer: ['A'] }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ created: 4, skipped: [], failed: [] });
    const qs = await Question.find({ _id: { $in: r.body.data.ids } }).lean();
    expect(qs.every((q) => q.status === 'draft' && String(q.authorId) === tmathId)).toBe(true);
    const a = await call('post', '/questions/paste/commit', tmath, {
      text: '1. S\nA) 1\nB) 2\nJavob: A',
      topicId: t1.id,
      status: 'active',
    });
    expect((await Question.findById(a.body.data.ids[0]).lean())?.status).toBe('active');
  });

  it('mavzu majburiy; begona fan/maktab mavzusi 404; blokka bog`lanmaydi', async () => {
    const tl = (await call('post', `/subjects/${lang.id}/topics`, admin, { name: 'Imlo' })).body
      .data;
    const ot = (
      await call('post', `/subjects/${math.id}/topics`, oadmin, { name: 'Boshqa' }, other.id)
    ).body.data;
    const body = { text: '1. S\nA) 1\nB) 2\nJavob: A' };
    expect((await call('post', '/questions/paste/commit', tmath, body)).status).toBe(400);
    // tmath ona tili o'qitmaydi: mavzu ko'rinmaydi
    expect(
      (await call('post', '/questions/paste/commit', tmath, { ...body, topicId: tl.id })).status,
    ).toBe(404);
    expect(
      (await call('post', '/questions/paste/commit', tmath, { ...body, topicId: ot.id })).status,
    ).toBe(404);
    expect(
      (await call('post', '/questions/paste/commit', admin, { ...body, topicId: ot.id })).status,
    ).toBe(404);
    // admin ixtiyoriy mavzuga yozadi
    const ok = await call('post', '/questions/paste/commit', admin, { ...body, topicId: tl.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.ids).toHaveLength(1);
  });

  it('tokensiz 401; imtihon moduli o`chiq maktabda 403', async () => {
    const anon = await request(app)
      .post('/api/v1/exams/questions/paste/preview')
      .set('X-School-Id', school.id)
      .send({ text: TEXT });
    expect(anon.status).toBe(401);
    await settingsStore.set('school', school.id, 'exams', { enabled: false }, rootId);
    const off = await call('post', '/questions/paste/preview', admin, { text: TEXT });
    expect(off.status).toBe(403);
  });
});
