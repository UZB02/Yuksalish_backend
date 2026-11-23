/* eslint-disable @typescript-eslint/no-unused-vars -- umumiy sarlavhadan keladigan yordamchilar */
import { Types } from 'mongoose';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExamAttempt } from '../src/models/ExamAttempt';
import { ExamSession } from '../src/models/ExamSession';
import { ExamTopic } from '../src/models/ExamTopic';
import { Question } from '../src/models/Question';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import {
  blockQuestionCount,
  normalizeBlocks,
  scoringOf,
  sumBlockDurations,
} from '../src/modules/exams/blocks/blocks.core';
import { gradeAttempt } from '../src/modules/exam-client/grading';
import {
  CODE_IP_BLOCK_MS,
  CODE_IP_MAX_FAILS,
} from '../src/modules/exam-client/exam-client.service';
import { runExamSweeper } from '../src/modules/exam-client/exam-client.sweeper';
import { selectQuestions } from '../src/modules/exam-client/selection';
import { decryptPin } from '../src/modules/exams/sessions/pin';
import {
  advanceExpired,
  extendCurrentBlock,
  finishCurrentBlock,
  initBlockState,
  projectedDeadline,
} from '../src/modules/exams/sessions/timing';
import { settingsStore } from '../src/modules/settings/settings.store';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { notifyBlockAssignments, runBlockReminders } from '../src/modules/telegram/telegram.exams';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { clock } from '../src/utils/clock';
import {
  app,
  assignSubject,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

type Doc = { id: string };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let math: Doc, lang: Doc;
let rootId: string;
let admin: string, oadmin: string, tmath: string, tlang: string, tfree: string, tfake: string;
let tmathId: string, tlangId: string, tfreeId: string, adminId: string;
let mathTopic: Doc, langTopic: Doc;
let c7a: Doc;
const DEV = 'device-aaaaaaaa';

const call = (
  m: 'get' | 'post' | 'patch' | 'delete' | 'put',
  url: string,
  t: string,
  body?: object,
) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', school.id);
  return body ? r.send(body) : r;
};
const ec = (m: 'get' | 'post' | 'put', url: string, token: string | null, body?: object) => {
  let r = request(app)[m](`/api/v1/exam-client${url}`).set('X-Forwarded-For', '10.0.0.7');
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const text = (t: string) => [{ type: 'text', text: t }];
const ids = { m1: '', m2: '', l1: '', l2: '' };

async function mkQ(t: string, topicId: string, extra: Record<string, unknown>) {
  const r = await call('post', '/questions', t, {
    topicId,
    status: 'active',
    sharing: { mode: 'subject' },
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}
const single = (label: string, correct = 'a', points = 2) => ({
  type: 'single',
  content: text(label),
  options: [
    { id: 'a', content: text('A') },
    { id: 'b', content: text('B') },
  ],
  answer: { optionId: correct },
  points,
});

const at = (d: Date) => clock.set(() => d);
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

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
  const ad = await makeUser({
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
  tfreeId = tf.id;
  adminId = ad.id;
  c7a = (await makeClass(school.id, year.id, '7-A')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, tm.id);
  await assignSubject(school.id, c7a as never, lang.id, tl.id);
  // tfree ham matematikani o'qitadi (boshqa sinfda), lekin blokka biriktirilmaydi
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
  mathTopic = (await call('post', `/subjects/${math.id}/topics`, admin, { name: 'Algebra' })).body
    .data;
  langTopic = (await call('post', `/subjects/${lang.id}/topics`, admin, { name: 'Imlo' })).body
    .data;
  ids.m1 = await mkQ(admin, mathTopic.id, single('Math 1', 'a', 2));
  ids.m2 = await mkQ(admin, mathTopic.id, {
    type: 'multi',
    content: text('Math 2'),
    options: [
      { id: 'a', content: text('A') },
      { id: 'b', content: text('B') },
      { id: 'c', content: text('C') },
    ],
    answer: { optionIds: ['a', 'b'], partialCredit: true },
    points: 4,
  });
  ids.l1 = await mkQ(admin, langTopic.id, single('Lang 1', 'b', 1));
  ids.l2 = await mkQ(admin, langTopic.id, {
    type: 'essay',
    content: text('Lang esse'),
    answer: { rubric: 'mezon' },
    points: 5,
  });
});

interface BlockOpts {
  contribDeadline?: Date | null;
  scoringMode?: 'points' | 'coefficient';
  timingMode?: 'common' | 'per_block';
  mathContrib?: string[];
  langContrib?: string[];
  mathItems?: unknown[];
  langItems?: unknown[];
  mathTarget?: number;
  langTarget?: number;
}
const startAt = () => new Date(Date.now() + 3 * 3_600_000);

function blocksBody(o: BlockOpts = {}) {
  return [
    {
      subjectId: math.id,
      targetCount: o.mathTarget ?? 2,
      coefficient: 3.1,
      durationMin: 30,
      contributorIds: o.mathContrib ?? [],
      items: o.mathItems ?? [{ kind: 'manual', questionIds: [ids.m1, ids.m2] }],
    },
    {
      subjectId: lang.id,
      targetCount: o.langTarget ?? 2,
      coefficient: 2.1,
      durationMin: 20,
      contributorIds: o.langContrib ?? [],
      items: o.langItems ?? [{ kind: 'manual', questionIds: [ids.l1, ids.l2] }],
    },
  ];
}

async function mkSession(o: BlockOpts = {}, extra: object = {}) {
  const r = await call('post', '/sessions', admin, {
    title: 'DTM sinov',
    type: 'quarter',
    classIds: [c7a.id],
    blocks: blocksBody(o),
    scoringMode: o.scoringMode ?? 'coefficient',
    timingMode: o.timingMode ?? 'per_block',
    scheduledStart: startAt().toISOString(),
    contribDeadline: o.contribDeadline === undefined ? null : o.contribDeadline?.toISOString(),
    resultsMode: 'score_answers',
    shuffleQuestions: false,
    shuffleOptions: false,
    ...extra,
  });
  return r;
}

/** Imtihonni yaratadi, ishtirokchi qo'shadi, rejalashtiradi */
async function scheduled(o: BlockOpts = {}, extra: object = {}) {
  await makeStudent(school.id, c7a.id, 'Oquvchi 1');
  await makeStudent(school.id, c7a.id, 'Oquvchi 2');
  const created = await mkSession(o, extra);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  expect(
    (await call('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] })).status,
  ).toBe(201);
  // Fan bo'yicha tasdiq: o'qituvchisi bor fanlar rejalashtirishdan oldin tasdiqlanadi
  for (const b of created.body.data.blocks ?? []) {
    await call('post', `/sessions/${id}/blocks/${b.id}/ready`, admin, { ready: true });
  }
  const sub = await call('post', `/sessions/${id}/submit`, admin, { confirmShort: true });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const doc = (await ExamSession.findById(id))!;
  const pins: Record<string, { pin: string; key: string }> = {};
  for (const p of doc.participants)
    pins[p.fullName] = { pin: decryptPin(p.pinEnc, id)!, key: p.key };
  return { id, code: doc.code!, start: doc.scheduledStart, pins, doc };
}

async function joinStart(s: Awaited<ReturnType<typeof scheduled>>, name = 'Oquvchi 1') {
  const j = await ec('post', '/join', null, {
    code: s.code,
    pin: s.pins[name]!.pin,
    deviceId: DEV,
  });
  expect(j.status, JSON.stringify(j.body)).toBe(200);
  const token = j.body.data.token as string;
  const st = await ec('post', '/start', token);
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return { token, join: j.body.data, start: st.body.data };
}

// ---------------------------------------------------------------------------------------------
import { ClassModel } from '../src/models/Class';
import { Subject } from '../src/models/Subject';
import { notifyAllBlocksReady } from '../src/modules/telegram/telegram.exams';

const my = (m: 'get' | 'post' | 'delete', url: string, t: string, body?: object) =>
  call(m, `/my-blocks${url}`, t, body);
const draftWithContrib = async (o: BlockOpts = {}) => {
  const s = await mkSession({
    mathContrib: [tmathId],
    mathItems: [],
    mathTarget: 2,
    langContrib: [tlangId],
    langItems: [],
    langTarget: 1,
    contribDeadline: new Date(Date.now() + 3_600_000),
    ...o,
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return {
    id: s.body.data.id as string,
    bm: s.body.data.blocks[0].id as string,
    bl: s.body.data.blocks[1].id as string,
  };
};

describe('O`qituvchi taklifi (sinf + fan)', () => {
  it('shu sinflarda shu fanni o`qitadigan faol o`qituvchilar; boshqa sinf/fan/nofaol chiqmaydi; faqat ma`muriyat', async () => {
    const c8 = (await ClassModel.findOne({ name: '8-A' }))!;
    const q = (subj: string, classes: string[], t = admin) =>
      call('get', `/sessions/suggest-teachers?subjectId=${subj}&classIds=${classes.join(',')}`, t);
    expect((await q(math.id, [c7a.id])).body.data.teacherIds).toEqual([tmathId]);
    expect((await q(math.id, [String(c8._id)])).body.data.teacherIds).toEqual([tfreeId]);
    expect((await q(math.id, [c7a.id, String(c8._id)])).body.data.teacherIds.sort()).toEqual(
      [tmathId, tfreeId].sort(),
    );
    expect((await q(lang.id, [c7a.id])).body.data.teacherIds).toEqual([tlangId]);
    expect((await q(lang.id, [String(c8._id)])).body.data.teacherIds).toEqual([]);
    expect((await q(math.id, [])).body.data.teacherIds).toEqual([]);
    expect((await q(math.id, [c7a.id], tmath)).status).toBe(403);
    await User.updateOne({ _id: tmathId }, { isActive: false });
    expect((await q(math.id, [c7a.id])).body.data.teacherIds).toEqual([]);
    const o = await request(app)
      .get(`/api/v1/exams/sessions/suggest-teachers?subjectId=${math.id}&classIds=${c7a.id}`)
      .set(bearer(oadmin));
    expect(o.body.data.teacherIds).toEqual([]);
  });
});

describe('"Tayyor" belgisi: o`qituvchi va tuzuvchi', () => {
  it('o`qituvchi belgilaydi va qaytaradi; belgi tahrirni qulflamaydi (readyBy=contributor)', async () => {
    const { id, bm } = await draftWithContrib();
    const url = `/${id}/${bm}`;
    const r = await my('post', `${url}/ready`, tmath, { ready: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doc = (await ExamSession.findById(id))!;
    expect(doc.blocks[0]).toMatchObject({ status: 'ready', readyBy: 'contributor' });
    const det = await my('get', url, tmath);
    expect(det.body.data.block).toMatchObject({
      locked: false,
      status: 'ready',
      readyBy: 'contributor',
      canMarkReady: true,
    });
    expect(det.body.data.role).toBe('contributor');
    expect(
      (await my('post', `${url}/questions/new`, tmath, single('Tayyor bo`lsa ham'))).status,
    ).toBe(201);
    const back = await my('post', `${url}/ready`, tmath, { ready: false });
    expect(back.body.data.status).toBe('open');
    expect((await ExamSession.findById(id))!.blocks[0]!.readyBy ?? null).toBeNull();
    expect((await call('get', `/sessions/${id}`, admin)).body.data.blocks[0]).toMatchObject({
      status: 'open',
      readyBy: null,
    });
  });

  it('tuzuvchi belgisi o`qituvchini qulflaydi va o`qituvchi qaytara olmaydi; tuzuvchi qaytaradi; eski tayyor ma`lumot (readyBy yo`q) tuzuvchinikidek', async () => {
    const { id, bm } = await draftWithContrib();
    const url = `/${id}/${bm}`;
    expect(
      (await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true })).status,
    ).toBe(200);
    expect((await ExamSession.findById(id))!.blocks[0]!.readyBy).toBe('composer');
    expect((await my('post', `${url}/ready`, tmath, { ready: false })).status).toBe(403);
    expect((await my('post', `${url}/questions/new`, tmath, single('x'))).status).toBe(403);
    expect((await my('get', url, tmath)).body.data.block).toMatchObject({
      locked: true,
      lockReason: 'ready',
      canMarkReady: false,
    });
    // tuzuvchi o'qituvchi belgisini ustiga yozadi va qaytaradi
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: false });
    expect((await my('post', `${url}/ready`, tmath, { ready: true })).status).toBe(200);
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true });
    expect((await ExamSession.findById(id))!.blocks[0]!.readyBy).toBe('composer');
    // eski ma'lumot: status=ready, readyBy yo'q
    await ExamSession.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $unset: { 'blocks.0.readyBy': '' } },
    );
    expect((await my('post', `${url}/ready`, tmath, { ready: false })).status).toBe(403);
    expect((await my('get', url, tmath)).body.data.block.locked).toBe(true);
    expect((await call('get', `/sessions/${id}`, admin)).body.data.blocks[0].readyBy).toBe(
      'composer',
    );
    expect(
      (await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: false })).status,
    ).toBe(200);
  });

  it('muddat o`tgach, imtihon rejalashtirilgach, boshqa fan o`qituvchisi va boshqa maktab: belgilab bo`lmaydi', async () => {
    const dl = new Date(Date.now() + 3_600_000);
    const { id, bm, bl } = await draftWithContrib({ contribDeadline: dl });
    const url = `/${id}/${bm}`;
    expect((await my('post', `/${id}/${bl}/ready`, tmath, { ready: true })).status).toBe(404);
    expect((await my('post', `${url}/ready`, tfree, { ready: true })).status).toBe(404);
    expect((await my('post', `${url}/ready`, tfake, { ready: true })).status).toBe(404);
    expect((await my('post', `${url}/ready`, tmath, { ready: true })).status).toBe(200);
    at(mins(dl, 5));
    expect((await my('post', `${url}/ready`, tmath, { ready: false })).status).toBe(403);
    clock.reset();
    // rejalashtirilgan imtihon
    const s = await scheduled({ mathContrib: [tmathId] });
    const bid = (await ExamSession.findById(s.id))!.blocks[0]!.blockId;
    expect((await my('post', `/${s.id}/${bid}/ready`, tmath, { ready: true })).status).toBe(403);
  });

  it('tuzuvchi o`qituvchisiz ham har qanday fanga savol qo`shadi (bankdan, yangi yozib, import), istalgan savolni olib tashlaydi; tuzuvchi bo`lmagan va biriktirilmagan 404', async () => {
    const { id, bm } = await draftWithContrib();
    const url = `/${id}/${bm}`;
    const own = await mkQ(tmath, mathTopic.id, single('O`qituvchi savoli'));
    expect(
      (await my('post', `${url}/questions`, tmath, { questionIds: [own] })).body.data.added,
    ).toBe(1);
    // tuzuvchi bankdan qo'shadi (ids.m1 admin yaratgan)
    const a = await my('post', `${url}/questions`, admin, { questionIds: [ids.m1] });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toMatchObject({ added: 1, count: 2 });
    // tuzuvchi yangi yozadi: bankka "Imtihon: ..." mavzusiga
    const n = await my('post', `${url}/questions/new`, admin, single('Tuzuvchi yozgan'));
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    expect(n.body.data.count).toBe(3);
    const q = (await Question.findById(n.body.data.question.id))!;
    expect((await ExamTopic.findById(q.topicId))!.name).toBe('Imtihon: DTM sinov');
    // boshqa fan savoli rad
    expect((await my('post', `${url}/questions`, admin, { questionIds: [ids.l1] })).status).toBe(
      400,
    );
    // tuzuvchi page: role, hammasini olib tashlay oladi
    const det = await my('get', url, admin);
    expect(det.body.data.role).toBe('composer');
    expect(det.body.data.questions.every((x: { canRemove: boolean }) => x.canRemove)).toBe(true);
    expect((await my('delete', `${url}/questions/${own}`, admin)).body.data.count).toBe(2);
    // tuzuvchi belgisi tuzuvchini qulflamaydi
    await my('post', `${url}/ready`, admin, { ready: true });
    expect(
      (await my('post', `${url}/questions/new`, admin, single('Tayyordan keyin'))).status,
    ).toBe(201);
    // rejalashtirilgandan keyin tuzuvchi ham qo'sha olmaydi
    const sc = await scheduled();
    const bid = (await ExamSession.findById(sc.id))!.blocks[0]!.blockId;
    expect((await my('post', `/${sc.id}/${bid}/questions/new`, admin, single('Kech'))).status).toBe(
      403,
    );
    // boshqa maktab tuzuvchisi
    const o = await request(app).get(`/api/v1/exams/my-blocks${url}`).set(bearer(oadmin));
    expect(o.status).toBe(404);
  });
});

describe('Yon menyu nishoni (summary)', () => {
  it('ochiq vazifalar: qulflanmagan va "tugatdim" belgisi qo`yilmaganlar soni', async () => {
    const dl = new Date(Date.now() + 3_600_000);
    const { id, bm } = await draftWithContrib({ contribDeadline: dl });
    const sum = (t: string) => my('get', '/summary', t);
    expect((await sum(tmath)).body.data).toEqual({ pending: 1, total: 1 });
    expect((await sum(tlang)).body.data).toEqual({ pending: 1, total: 1 });
    expect((await sum(tfree)).body.data).toEqual({ pending: 0, total: 0 });
    // maqsad to'ldi, lekin tayyor emas: hali kutilmoqda
    const q1 = await mkQ(tmath, mathTopic.id, single('A'));
    const q2 = await mkQ(tmath, mathTopic.id, single('B'));
    await my('post', `/${id}/${bm}/questions`, tmath, { questionIds: [q1, q2] });
    expect((await sum(tmath)).body.data.pending).toBe(1);
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: true });
    expect((await sum(tmath)).body.data).toEqual({ pending: 0, total: 1 });
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: false });
    // maqsadga yetmasa ham "tugatdim" desa, vazifa ochiq hisoblanmaydi
    await ExamSession.updateOne({ _id: id }, { $set: { 'blocks.0.contribQuestions': [] } });
    expect((await sum(tmath)).body.data.pending).toBe(1);
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: true });
    expect((await sum(tmath)).body.data).toEqual({ pending: 0, total: 1 });
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: false });
    // muddat o'tgach qulflangan: hisobga olinmaydi
    at(mins(dl, 5));
    expect((await sum(tmath)).body.data).toEqual({ pending: 0, total: 1 });
    expect((await sum(tlang)).body.data.pending).toBe(0);
    clock.reset();
    const o = await request(app).get('/api/v1/exams/my-blocks/summary').set(bearer(oadmin));
    expect(o.body.data).toEqual({ pending: 0, total: 0 });
  });
});

describe('Telegram: barcha fanlar tayyor', () => {
  it('tuzuvchiga bir marta; hammasi tayyor bo`lmaguncha yo`q; tugma o`chiq bo`lsa yo`q', async () => {
    const fake = new FakeTelegram();
    fake.install();
    await TelegramBotConfig.create({
      key: 'platform',
      tokenEnc: encryptToken(VALID_TOKEN),
      tokenLast4: VALID_TOKEN.slice(-4),
      botUsername: 'b_bot',
      enabled: true,
    });
    await telegramManager.reload();
    await User.updateOne(
      { _id: adminId },
      { 'telegram.chatId': 111, 'telegram.linkedAt': new Date() },
    );
    const { id, bm, bl } = await draftWithContrib();
    const out = () =>
      TelegramOutbox.find({ dedupeKey: new RegExp(`^exam:${id}:allready:`) }).lean();
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: true });
    await new Promise((x) => setTimeout(x, 200));
    expect(await out()).toHaveLength(0);
    await my('post', `/${id}/${bl}/ready`, tlang, { ready: true });
    await new Promise((x) => setTimeout(x, 300));
    const rows = await out();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.userId)).toBe(adminId);
    expect(rows[0]!.text).toContain('«DTM sinov»');
    // qayta belgilash: dedupe
    await my('post', `/${id}/${bl}/ready`, tlang, { ready: false });
    await my('post', `/${id}/${bl}/ready`, tlang, { ready: true });
    await new Promise((x) => setTimeout(x, 300));
    expect(await out()).toHaveLength(1);
    // tugma o'chiq
    await TelegramOutbox.deleteMany({});
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examReminders: false } },
      rootId,
    );
    expect(await notifyAllBlocksReady(id)).toBe(0);
    uninstallTelegram();
  });
});

describe('Imtihon ochishdagi tushunarsiz validatsiya xatolari (prod hisobot tekshiruvi)', () => {
  it('nofaol fan tanlansa sababi aniq aytiladi; nazoratchi o`qituvchi + xodim bir xil ismli bo`lsa ham saqlanadi; maqsadsiz va savolsiz bloklar qoralamaga saqlanadi', async () => {
    const dead = await makeSubject('Nofaol fan', null, { isActive: false });
    const bad = await call('post', '/sessions', admin, {
      title: 'Nofaol',
      type: 'quarter',
      classIds: [c7a.id],
      blocks: [
        { subjectId: dead.id, targetCount: 5, coefficient: 1, contributorIds: [], items: [] },
      ],
      scheduledStart: startAt().toISOString(),
      durationMin: 30,
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/Fan faol emas: Nofaol fan/);
    // bir xil to'liq ismli ikkita nazoratchi (o'qituvchi va maktab xodimi)
    await User.updateOne({ _id: tfreeId }, { fullName: 'Bir Xil Ism' });
    const staff = await makeUser({ username: 'staff2', role: 'school_admin', schoolId: school.id });
    await User.updateOne({ _id: staff.id }, { fullName: 'Bir Xil Ism' });
    const ok = await call('post', '/sessions', admin, {
      title: 'Nazoratchilar',
      type: 'quarter',
      classIds: [c7a.id],
      blocks: [
        {
          subjectId: math.id,
          targetCount: 5,
          coefficient: 3.1,
          contributorIds: [tmathId],
          items: [],
        },
        { subjectId: lang.id, targetCount: 5, coefficient: 2.1, contributorIds: [], items: [] },
      ],
      scoringMode: 'coefficient',
      timingMode: 'common',
      durationMin: 40,
      supervisorIds: [tfreeId, staff.id],
      scheduledStart: startAt().toISOString(),
      contribDeadline: new Date(Date.now() + 3_600_000).toISOString(),
      resultsMode: 'score',
      passPercent: null,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.supervisors).toHaveLength(3); // tanlangan 2 ta + yaratuvchi
    // superadmin ham xuddi shunday yarata oladi (X-School-Id bilan)
    const rootTok = (await login('root')).token;
    const sa = await request(app)
      .post('/api/v1/exams/sessions')
      .set(bearer(rootTok))
      .set('X-School-Id', school.id)
      .send({
        title: 'Superadmin',
        type: 'quarter',
        classIds: [c7a.id],
        blocks: [
          {
            subjectId: math.id,
            targetCount: 3,
            coefficient: 1,
            contributorIds: [tmathId],
            items: [],
          },
        ],
        scoringMode: 'points',
        timingMode: 'common',
        durationMin: 40,
        supervisorIds: [tfreeId, staff.id],
        scheduledStart: startAt().toISOString(),
        resultsMode: 'score',
      });
    expect(sa.status, JSON.stringify(sa.body)).toBe(201);
    const up = await request(app)
      .patch(`/api/v1/exams/sessions/${sa.body.data.id}`)
      .set(bearer(rootTok))
      .set('X-School-Id', school.id)
      .send({ supervisorIds: [tfreeId, staff.id], durationMin: 50 });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Fan bo'yicha tasdiq va "Eslatma" (§16 2-bosqich)
describe('Fan bo`yicha tasdiq: rejalashtirish sharti', () => {
  const submit = (id: string, body: object = {}) =>
    call('post', `/sessions/${id}/submit`, admin, body);
  const approve = (id: string, bid: string, ready = true) =>
    call('post', `/sessions/${id}/blocks/${bid}/ready`, admin, { ready });

  async function fullDraft(o: BlockOpts = {}) {
    await makeStudent(school.id, c7a.id, 'Oquvchi 1');
    const s = await mkSession({ contribDeadline: new Date(Date.now() + 3_600_000), ...o });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const id = s.body.data.id as string;
    await call('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] });
    return { id, bm: s.body.data.blocks[0].id as string, bl: s.body.data.blocks[1].id as string };
  }

  it('tasdiqlanmagan fan bor: 409 (path=approval, fanlar ro`yxati); o`qituvchi "tugatdim"i tasdiq emas; hammasi tasdiqlansa o`tadi', async () => {
    const { id, bm, bl } = await fullDraft({ mathContrib: [tmathId], langContrib: [tlangId] });
    let r = await submit(id, { confirmShort: true });
    expect(r.status).toBe(409);
    expect(r.body.error.details.map((d: { path: string }) => d.path)).toEqual([
      'approval',
      'approval',
    ]);
    // o'qituvchi tugatdim: hali tasdiq emas
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: true });
    r = await submit(id, { confirmShort: true });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toHaveLength(2);
    // bitta fan tasdiqlandi: faqat ikkinchisi qoldi
    expect((await approve(id, bm)).status).toBe(200);
    r = await submit(id, { confirmShort: true });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toHaveLength(1);
    expect(r.body.error.details[0].message).toContain('Ona tili');
    // tasdiq bekor qilinsa yana to'sqinlik
    await approve(id, bm, false);
    expect((await submit(id, { confirmShort: true })).body.error.details).toHaveLength(2);
    await approve(id, bm);
    await approve(id, bl);
    expect((await submit(id, { confirmShort: true })).status).toBe(200);
    expect((await ExamSession.findById(id))!.status).toBe('scheduled');
  });

  it('tasdiq confirmShort bilan aylanib o`tilmaydi; o`qituvchisiz fanlar tasdiqni talab qilmaydi', async () => {
    const a = await fullDraft({ mathContrib: [tmathId] });
    // faqat matematikada o'qituvchi bor; ona tili o'qituvchisiz (tuzuvchi o'zi to'ldiradi)
    const r = await submit(a.id, { confirmShort: true });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toHaveLength(1);
    await approve(a.id, a.bm);
    expect((await submit(a.id, { confirmShort: true })).status).toBe(200);
    const b = await fullDraft({});
    expect((await submit(b.id, { confirmShort: true })).status).toBe(200);
  });

  it('ro`yxat va tafsilot: blocksProgress (jami, tugatgan, tasdiqlangan; o`qituvchisiz fan tasdiqlangan hisoblanadi)', async () => {
    const { id, bm } = await fullDraft({ mathContrib: [tmathId] });
    const prog = async () =>
      (await call('get', '/sessions', admin)).body.data.find((x: { id: string }) => x.id === id)
        .blocksProgress;
    // matematika o'qituvchili, ona tili o'qituvchisiz
    expect(await prog()).toEqual({ total: 2, done: 1, approved: 1 });
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: true });
    expect(await prog()).toEqual({ total: 2, done: 2, approved: 1 });
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true });
    expect(await prog()).toEqual({ total: 2, done: 2, approved: 2 });
    expect((await call('get', `/sessions/${id}`, admin)).body.data.blocksProgress.approved).toBe(2);
  });

  it('tasdiq: faqat tuzuvchi; tasdiqlangan fan o`qituvchi uchun yopiq; tasdiqni bekor qilish tahrirni qaytaradi; rejalashtirilgach bekor qilib bo`lmaydi', async () => {
    const { id, bm, bl } = await fullDraft({ mathContrib: [tmathId], langContrib: [tlangId] });
    const asTeacher = await call('post', `/sessions/${id}/blocks/${bm}/ready`, tmath, {
      ready: true,
    });
    expect(asTeacher.status).toBeGreaterThanOrEqual(403);
    const asOther = await call('post', `/sessions/${id}/blocks/${bm}/ready`, oadmin, {
      ready: true,
    });
    expect(asOther.status).toBeGreaterThanOrEqual(403);
    await approve(id, bm);
    expect((await my('post', `/${id}/${bm}/questions/new`, tmath, single('x'))).status).toBe(403);
    expect((await my('get', `/${id}/${bm}`, tmath)).body.data.block).toMatchObject({
      locked: true,
      lockReason: 'ready',
    });
    await approve(id, bm, false);
    expect((await my('post', `/${id}/${bm}/questions/new`, tmath, single('x'))).status).toBe(201);
    await approve(id, bm);
    await approve(id, bl);
    expect((await submit(id, { confirmShort: true })).status).toBe(200);
    expect((await approve(id, bm, false)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('"Eslatma": tugallanmagan fan o`qituvchilariga Telegram', () => {
  async function setup() {
    const fake = new FakeTelegram();
    fake.install();
    await TelegramBotConfig.create({
      key: 'platform',
      tokenEnc: encryptToken(VALID_TOKEN),
      tokenLast4: VALID_TOKEN.slice(-4),
      botUsername: 'b_bot',
      enabled: true,
    });
    await telegramManager.reload();
    for (const [uid, chat] of [
      [tmathId, 222],
      [tlangId, 333],
    ] as const) {
      await User.updateOne(
        { _id: uid },
        { 'telegram.chatId': chat, 'telegram.linkedAt': new Date() },
      );
    }
    const s = await mkSession(
      {
        mathContrib: [tmathId],
        mathItems: [],
        langContrib: [tlangId],
        langItems: [],
        contribDeadline: new Date(Date.now() + 2 * 3_600_000),
      },
      { title: 'DTM <b>sinov</b> & "x"' },
    );
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const id = s.body.data.id as string;
    return { id, bm: s.body.data.blocks[0].id as string, bl: s.body.data.blocks[1].id as string };
  }
  const remind = (id: string, t = admin) => call('post', `/sessions/${id}/remind`, t);
  const rows = (id: string) =>
    TelegramOutbox.find({ dedupeKey: new RegExp(`^exam:${id}:contrib:.*:remind:`) }).lean();
  const wait = () => new Promise((x) => setTimeout(x, 300));

  it('faqat tugallanmagan fanlar o`qituvchilariga; HTML escape; soatiga bir marta; soatdan keyin qayta', async () => {
    const { id, bm, bl } = await setup();
    // matematik tugatdi: faqat ona tili o'qituvchisiga
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: true });
    let r = await remind(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ disabled: false, notConnected: false, sent: 1 });
    expect(r.body.data.blocks).toEqual([
      expect.objectContaining({ blockId: bl, subjectName: 'Ona tili', state: 'sent' }),
    ]);
    await wait();
    const out = await rows(id);
    expect(out).toHaveLength(1);
    expect(String(out[0]!.userId)).toBe(tlangId);
    expect(out[0]!.text).toContain('DTM &lt;b&gt;sinov&lt;/b&gt; &amp; "x"');
    expect(out[0]!.text).not.toContain('<b>sinov</b>');
    expect(out[0]!.text).toContain('0/2');
    // darhol qayta bosish: cheklangan
    r = await remind(id);
    expect(r.body.data.sent).toBe(0);
    expect(r.body.data.blocks).toEqual([expect.objectContaining({ blockId: bl, state: 'recent' })]);
    expect(await rows(id)).toHaveLength(1);
    expect((await ExamSession.findById(id))!.blocks[1]!.remindedAt).toBeTruthy();
    // 61 daqiqadan keyin yana
    at(new Date(Date.now() + 61 * 60_000));
    r = await remind(id);
    clock.reset();
    expect(r.body.data.sent).toBe(1);
    await wait();
    expect(await rows(id)).toHaveLength(2);
    // matematik "tugatdim"ini qaytardi: endi u ham eslatma oladi
    await my('post', `/${id}/${bm}/ready`, tmath, { ready: false });
    r = await remind(id);
    expect(r.body.data.blocks.map((b: { state: string }) => b.state).sort()).toEqual([
      'recent',
      'sent',
    ]);
    uninstallTelegram();
  });

  it('tasdiqlangan fanga yuborilmaydi; ikkita parallel bosish bitta xabar; tugma o`chiq va bot ulanmagan holatlari band qilmaydi', async () => {
    const { id, bm, bl } = await setup();
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true });
    const [a, b] = await Promise.all([remind(id), remind(id)]);
    expect(a.body.data.sent + b.body.data.sent).toBe(1);
    await wait();
    const out = await rows(id);
    expect(out).toHaveLength(1);
    expect(out[0]!.dedupeKey).toContain(bl);
    // tugma o'chiq
    await TelegramOutbox.deleteMany({});
    await ExamSession.updateOne({ _id: id }, { $set: { 'blocks.1.remindedAt': null } });
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examReminders: false } },
      rootId,
    );
    let r = await remind(id);
    expect(r.body.data).toMatchObject({ disabled: true, sent: 0, blocks: [] });
    expect((await ExamSession.findById(id))!.blocks[1]!.remindedAt ?? null).toBeNull();
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examReminders: true } },
      rootId,
    );
    // bot ulanmagan
    uninstallTelegram();
    await telegramManager.reload();
    r = await remind(id);
    expect(r.body.data).toMatchObject({ notConnected: true, sent: 0 });
    expect((await ExamSession.findById(id))!.blocks[1]!.remindedAt ?? null).toBeNull();
  });

  it('ruxsat va holat: o`qituvchi 403, boshqa maktab adminiga yopiq, rejalashtirilgan imtihon 409, tokensiz 401', async () => {
    const { id } = await setup();
    expect((await remind(id, tmath)).status).toBe(403);
    expect((await remind(id, oadmin)).status).toBeGreaterThanOrEqual(403);
    expect((await request(app).post(`/api/v1/exams/sessions/${id}/remind`)).status).toBe(401);
    await ExamSession.updateOne({ _id: id }, { $set: { status: 'scheduled' } });
    expect((await remind(id)).status).toBe(409);
    uninstallTelegram();
  });
});

// ---------------------------------------------------------------------------------------------
// §16 3-bosqich: shaxsiy kirish kodi
import { ExamEntryCode } from '../src/models/ExamEntryCode';
import { ExamJoinGuard } from '../src/models/ExamJoinGuard';
import {
  decryptEntryCode,
  encryptEntryCode,
  formatEntryCode,
  hashEntryCode,
  isWellFormedEntryCode,
  normalizeEntryCode,
  randomEntryCode,
  signConfirm,
  verifyConfirm,
} from '../src/modules/exams/sessions/entryCode';
import { PIN_ALPHABET } from '../src/modules/exams/sessions/pin';
import { renderPinSheet } from '../src/modules/exams/sessions/sessions.pdf';

describe('Shaxsiy kod: yaratish, normallashtirish, xeshlash', () => {
  it('format, alifbo, uzunlik va entropiya (>= 44 bit); 5000 kodda takror yo`q', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const c = randomEntryCode();
      expect(c).toHaveLength(9);
      expect(isWellFormedEntryCode(c)).toBe(true);
      for (const ch of c) expect(PIN_ALPHABET).toContain(ch);
      seen.add(c);
    }
    expect(seen.size).toBe(5000);
    expect(PIN_ALPHABET).not.toMatch(/[01OIL]/);
    expect(Math.log2(PIN_ALPHABET.length ** 9)).toBeGreaterThanOrEqual(44);
    expect(formatEntryCode('7K492MQXA')).toBe('7K4-92M-QXA');
  });

  it('normallashtirish: katta-kichik harf, bo`sh joy, chiziqcha, nuqta, kirill o`xshash harflar', () => {
    expect(normalizeEntryCode(' 7k4-92m qxa. ')).toBe('7K492MQXA');
    expect(normalizeEntryCode('7К4-92М-QХА')).toBe('7K492MQXA'); // К М Х А kirillcha
    expect(normalizeEntryCode('7к4 92м qха')).toBe('7K492MQXA');
    expect(normalizeEntryCode('')).toBe('');
    expect(isWellFormedEntryCode('7K492MQX')).toBe(false); // qisqa
    expect(isWellFormedEntryCode('7K492MQX0')).toBe(false); // 0 alifboda yo'q
    // xeshlash normallashgan kod bo'yicha: yozilish shakli ahamiyatsiz
    expect(hashEntryCode('7k4-92m-qxa')).toBe(hashEntryCode('7К4 92М QХА'));
    expect(hashEntryCode('7K492MQXA')).not.toBe(hashEntryCode('7K492MQXB'));
    expect(hashEntryCode('7K492MQXA')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shifrlash: ochiq matn yo`q, sessiya id bog`langan; tasdiqlash tokeni: imzo, muddat va qurilma', () => {
    const enc = encryptEntryCode('7K4-92M-QXA', 'sess1');
    expect(enc).not.toContain('7K492MQXA');
    expect(decryptEntryCode(enc, 'sess1')).toBe('7K492MQXA');
    expect(decryptEntryCode(enc, 'sess2')).toBeNull();
    expect(decryptEntryCode('xato', 'sess1')).toBeNull();
    const now = new Date();
    const tok = signConfirm(
      { sessionId: 's', participantKey: 'k', deviceId: 'device-aaaaaaaa' },
      now,
    );
    expect(verifyConfirm(tok, 'device-aaaaaaaa', now)).toEqual({
      sessionId: 's',
      participantKey: 'k',
    });
    expect(verifyConfirm(tok, 'device-bbbbbbbb', now)).toBeNull();
    expect(verifyConfirm(tok, 'device-aaaaaaaa', new Date(now.getTime() + 6 * 60_000))).toBeNull();
    expect(verifyConfirm(`${tok}x`, 'device-aaaaaaaa', now)).toBeNull();
    expect(verifyConfirm(tok.replace(/^./, 'A'), 'device-aaaaaaaa', now)).toBeNull();
    expect(verifyConfirm('xato', 'device-aaaaaaaa', now)).toBeNull();
  });
});

describe('Shaxsiy kod: saqlash va ko`rsatish', () => {
  const codeOf = async (id: string, key: string, t = admin) =>
    (await call('get', `/sessions/${id}/participants/${key}/code`, t)).body.data?.code as
      string | null;

  it('har ishtirokchiga bitta; bazada faqat xesh va shifrlangan nusxa; ro`yxat DTO sida kod yo`q; faqat tuzuvchi ko`radi', async () => {
    const s = await scheduled();
    const doc = (await ExamSession.findById(s.id))!;
    expect(doc.participants).toHaveLength(2);
    const entries = await ExamEntryCode.find({ sessionId: s.id }).lean();
    expect(entries).toHaveLength(2);
    const codes: string[] = [];
    for (const p of doc.participants) {
      const c = (await codeOf(s.id, p.key))!;
      expect(c).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
      codes.push(c);
      expect(
        entries.some((e) => e.participantKey === p.key && e.codeHash === hashEntryCode(c)),
      ).toBe(true);
      // ochiq kod hech qayerda saqlanmaydi (hujjat, kirish yozuvi)
      const plain = normalizeEntryCode(c);
      expect(JSON.stringify(doc.toObject())).not.toContain(plain);
      expect(JSON.stringify(entries)).not.toContain(plain);
    }
    expect(new Set(codes).size).toBe(2);
    const dto = (await call('get', `/sessions/${s.id}`, admin)).body.data;
    expect(dto.participants.every((p: { hasCode: boolean }) => p.hasCode)).toBe(true);
    expect(JSON.stringify(dto)).not.toMatch(/[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}/);
    expect(doc.participants[0]!.codeEnc).toBeTruthy();
    // ruxsat: o'qituvchi va boshqa maktab ko'ra olmaydi
    const key = doc.participants[0]!.key;
    expect(
      (await call('get', `/sessions/${s.id}/participants/${key}/code`, tmath)).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (await call('get', `/sessions/${s.id}/participants/${key}/code`, oadmin)).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('PIN varaqasi ma`lumotida shaxsiy kod; PDF yaratiladi', async () => {
    const s = await scheduled();
    const sheet = await call('get', `/sessions/${s.id}/pin-sheet`, admin);
    expect(sheet.status).toBe(200);
    expect(String(sheet.headers['content-type'])).toContain('application/pdf');
    const buf = await renderPinSheet({
      schoolName: 'Maktab',
      title: 'DTM',
      code: '123456',
      examUrl: 'https://imtihon.example.uz',
      start: new Date(),
      durationMin: 50,
      list: [
        { fullName: 'Ali Valiyev', className: '7-A', pin: 'ABC234', code: '7K4-92M-QXA' },
        { fullName: 'Eski Oquvchi', className: '7-A', pin: 'ABC234', code: null },
      ],
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('Shaxsiy kod bilan kirish: tasdiqlash oqimi', () => {
  const jc = (code: string, device = DEV, ip = '10.0.0.7') =>
    request(app)
      .post('/api/v1/exam-client/join-code')
      .set('X-Forwarded-For', ip)
      .send({ code, deviceId: device });
  const confirm = (confirmToken: string, device = DEV) =>
    request(app)
      .post('/api/v1/exam-client/join-confirm')
      .set('X-Forwarded-For', '10.0.0.7')
      .send({ confirmToken, deviceId: device });
  async function codes(id: string) {
    const doc = (await ExamSession.findById(id))!;
    const out: Record<string, string> = {};
    for (const p of doc.participants) {
      out[p.fullName] = (await call('get', `/sessions/${id}/participants/${p.key}/code`, admin))
        .body.data.code as string;
    }
    return out;
  }
  const open = (id: string) => call('post', `/sessions/${id}/open`, admin);

  it('kod (kichik harf, bo`sh joy, kirill) -> "Bu sizmisiz?" ma`lumoti, urinish yaratilmaydi; tasdiqlash -> token va imtihon boshlanadi', async () => {
    const s = await scheduled();
    await ExamSession.updateOne(
      { _id: s.id },
      { $set: { scheduledStart: new Date(Date.now() - 60_000) } },
    );
    const c = (await codes(s.id))['Oquvchi 1']!;
    const typed = c.toLowerCase().replace(/-/g, ' ').replace('k', 'к');
    const r = await jc(typed);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      participant: { fullName: 'Oquvchi 1', className: '7-A' },
      exam: {
        title: 'DTM sinov',
        subjectsCount: 2,
        durationMin: expect.any(Number),
        phase: 'running',
      },
      attemptStatus: null,
    });
    expect(r.body.data.token).toBeUndefined();
    expect(await ExamAttempt.countDocuments({ sessionId: s.id })).toBe(0);
    // "Men emasman": hech narsa yozilmaydi; qaytadan kiritish mumkin
    expect((await jc(c)).status).toBe(200);
    expect(await ExamAttempt.countDocuments({ sessionId: s.id })).toBe(0);
    const ok = await confirm(r.body.data.confirmToken);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.token).toBeTruthy();
    expect(ok.body.data.participant.fullName).toBe('Oquvchi 1');
    expect(await ExamAttempt.countDocuments({ sessionId: s.id })).toBe(1);
    const st = await ec('post', '/start', ok.body.data.token);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(JSON.stringify(st.body)).not.toContain('"answer"');
    // tasdiqlash tokeni boshqa qurilmada ishlamaydi
    expect((await confirm(r.body.data.confirmToken, 'device-zzzzzzzz')).status).toBe(400);
    // boshqa ishtirokchi kodi boshqa odamni ko'rsatadi
    const c2 = (await codes(s.id))['Oquvchi 2']!;
    expect((await jc(c2, 'device-bbbbbbbb')).body.data.participant.fullName).toBe('Oquvchi 2');
  });

  it('imtihon hali boshlanmagan: tasdiq ekrani "upcoming" ko`rsatadi, tasdiqlash 409 (generic emas)', async () => {
    const s = await scheduled();
    const c = (await codes(s.id))['Oquvchi 1']!;
    const r = await jc(c);
    expect(r.body.data.exam.phase).toBe('upcoming');
    const x = await confirm(r.body.data.confirmToken);
    expect(x.status).toBe(409);
    expect(x.body.error.message).toContain('boshlanmagan');
  });

  it('noto`g`ri/shakli yaroqsiz/yopilgan/o`chirilgan/boshqa maktab kodi: bir xil umumiy xato (401)', async () => {
    const s = await scheduled();
    const c = (await codes(s.id))['Oquvchi 1']!;
    const msgs = new Set<string>();
    for (const bad of ['', 'ABC', '0000-0000-0', 'AAA-AAA-AAA', 'ZZZ-ZZZ-ZZZ'.replace(/Z/g, '2')]) {
      const r = await jc(bad || 'x', `device-${Math.random().toString(36).slice(2, 12)}`);
      expect(r.status).toBe(401);
      msgs.add(r.body.error.message);
    }
    // yopilgan imtihon
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'closed' } });
    const closed = await jc(c, 'device-closedxx');
    expect(closed.status).toBe(401);
    msgs.add(closed.body.error.message);
    // qayta ochilgan, keyin o'chirilgan
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'scheduled', isDeleted: true } });
    const del = await jc(c, 'device-deletedx');
    expect(del.status).toBe(401);
    msgs.add(del.body.error.message);
    await ExamSession.updateOne({ _id: s.id }, { $set: { isDeleted: false, codeActive: false } });
    const inactive = await jc(c, 'device-inactivex');
    msgs.add(inactive.body.error.message);
    expect(inactive.status).toBe(401);
    expect(msgs.size).toBe(1);
    expect([...msgs][0]).toBe("Kod noto'g'ri yoki muddati tugagan");
    // modul o'chirilgan maktab
    await ExamSession.updateOne({ _id: s.id }, { $set: { codeActive: true } });
    await settingsStore.set('school', school.id, 'exams', { enabled: false }, rootId);
    expect((await jc(c, 'device-disabledx')).status).toBe(401);
  });

  it('qo`pol kuch himoyasi: qurilma 5 xatodan keyin bloklanadi (to`g`ri kodda ham 429); boshqa qurilma o`tadi', async () => {
    const s = await scheduled();
    const c = (await codes(s.id))['Oquvchi 1']!;
    for (let i = 0; i < 5; i++)
      expect((await jc('AAA-AAA-AAA', 'device-bruteforce')).status).toBe(401);
    const blocked = await jc(c, 'device-bruteforce');
    expect(blocked.status).toBe(429);
    expect(blocked.status).not.toBe(401);
    expect(JSON.stringify(blocked.body)).not.toContain(c);
    expect((await jc(c, 'device-otherdevice')).status).toBe(200);
    expect(await ExamJoinGuard.countDocuments({ key: 'cdev:device-bruteforce' })).toBe(1);
  }, 60_000);

  it('maktab NAT i (E7): bitta IP dan yuzlab noto`g`ri urinish (har xil qurilma) yaroqli kirishni BLOKLAMAYDI; IP chegarasi (500) oshsa 5 daqiqaga bloklanadi', async () => {
    const s = await scheduled();
    const c = (await codes(s.id))['Oquvchi 1']!;
    for (let i = 0; i < 150; i++) {
      expect(
        (await jc('AAA-AAA-AAA', `device-nat-${String(i).padStart(4, '0')}x`, '10.9.9.9')).status,
      ).toBe(401);
    }
    // eski chegara (100) oshdi, lekin maktab hali ishlaydi
    expect((await jc(c, 'device-fresh-aaaa', '10.9.9.9')).status).toBe(200);
    // chegaraga yaqinlashtiramiz (hisoblagichni to'g'ridan-to'g'ri qo'yamiz) va bitta xato blok qo'yadi
    const g = (await ExamJoinGuard.findOne({ key: /^cip:/ }))!;
    await ExamJoinGuard.updateOne({ _id: g._id }, { $set: { count: CODE_IP_MAX_FAILS - 1 } });
    expect((await jc('AAA-AAA-AAA', 'device-trip-aaaaa', '10.9.9.9')).status).toBe(401);
    const blocked = await jc(c, 'device-fresh-bbbb', '10.9.9.9');
    expect(blocked.status).toBe(429);
    expect(JSON.stringify(blocked.body)).not.toContain(c);
    // blok 5 daqiqa: shundan keyin yana ishlaydi
    const blockedUntil = (await ExamJoinGuard.findOne({ key: g.key }))!.blockedUntil!;
    expect(blockedUntil.getTime() - Date.now()).toBeLessThanOrEqual(CODE_IP_BLOCK_MS + 1000);
    expect(blockedUntil.getTime() - Date.now()).toBeGreaterThan(CODE_IP_BLOCK_MS - 60_000);
  }, 120_000);

  it('qoralamaga qaytarilsa: eski kod yaroqsiz, yangi kod bor; qayta rejalashtirilgach yangi kod ishlaydi', async () => {
    const s = await scheduled();
    const before = (await codes(s.id))['Oquvchi 1']!;
    expect((await call('post', `/sessions/${s.id}/return-to-draft`, admin)).status).toBe(200);
    expect((await jc(before, 'device-afterret1')).status).toBe(401);
    const after = (await codes(s.id))['Oquvchi 1']!;
    expect(after).not.toBe(before);
    expect(await ExamEntryCode.countDocuments({ sessionId: s.id })).toBe(2);
    const sub = await call('post', `/sessions/${s.id}/submit`, admin, { confirmShort: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect((await jc(after, 'device-afterret2')).status).toBe(200);
    expect((await jc(before, 'device-afterret3')).status).toBe(401);
  });

  it('PIN qayta yaratilsa shaxsiy kod ham yangilanadi; ishtirokchi olib tashlansa kodi yo`qoladi', async () => {
    const s = await scheduled();
    const doc = (await ExamSession.findById(s.id))!;
    const p1 = doc.participants.find((p) => p.fullName === 'Oquvchi 1')!;
    const old = (await codes(s.id))['Oquvchi 1']!;
    expect(
      (await call('post', `/sessions/${s.id}/participants/${p1.key}/regenerate-pin`, admin)).status,
    ).toBe(200);
    expect((await jc(old, 'device-regen-001')).status).toBe(401);
    const fresh = (await codes(s.id))['Oquvchi 1']!;
    expect(fresh).not.toBe(old);
    expect((await jc(fresh, 'device-regen-002')).status).toBe(200);
    expect((await call('delete', `/sessions/${s.id}/participants/${p1.key}`, admin)).status).toBe(
      200,
    );
    expect((await jc(fresh, 'device-regen-003')).status).toBe(401);
    expect(await ExamEntryCode.countDocuments({ sessionId: s.id, participantKey: p1.key })).toBe(0);
  });

  it('eski (kod+PIN) kirish ishlaydi; kodsiz eski ishtirokchi: kod null, qayta yaratilsa paydo bo`ladi', async () => {
    const s = await scheduled();
    await ExamSession.updateOne(
      { _id: s.id },
      { $set: { scheduledStart: new Date(Date.now() - 60_000) } },
    );
    const legacy = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV,
    });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    const doc = (await ExamSession.findById(s.id))!;
    const p2 = doc.participants.find((p) => p.fullName === 'Oquvchi 2')!;
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': p2.key },
      { $set: { 'participants.$.codeEnc': null } },
    );
    await ExamEntryCode.deleteMany({ sessionId: s.id, participantKey: p2.key });
    const shown = await call('get', `/sessions/${s.id}/participants/${p2.key}/code`, admin);
    expect(shown.body.data.code).toBeNull();
    const still = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 2']!.pin,
      deviceId: 'device-legacy-2',
    });
    expect(still.status).toBe(200);
    await call('post', `/sessions/${s.id}/participants/${p2.key}/regenerate-pin`, admin);
    expect((await codes(s.id))['Oquvchi 2']).toMatch(/^[A-Z2-9]{3}-/);
  });

  it('boshqa maktab imtihoni kodi: tenant izolyatsiyasi (kod faqat o`z imtihoniga olib boradi); o`chirilgan imtihon yozuvlari tozalanadi', async () => {
    const s = await scheduled();
    const c = (await codes(s.id))['Oquvchi 1']!;
    const entry = await ExamEntryCode.findOne({ sessionId: s.id }).lean();
    expect(String(entry!.schoolId)).toBe(school.id);
    const r = await jc(c, 'device-tenant-01');
    expect(r.body.data.exam.title).toBe('DTM sinov');
    // imtihon o'chiriladi (urinishlar yo'q): kodlar ham o'chadi
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'draft' } });
    expect((await call('delete', `/sessions/${s.id}`, admin)).status).toBe(200);
    expect(await ExamEntryCode.countDocuments({ sessionId: s.id })).toBe(0);
    expect((await jc(c, 'device-tenant-02')).status).toBe(401);
  });
});
