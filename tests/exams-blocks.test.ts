import ExcelJS from 'exceljs';
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
describe('birlik: normalizator, ball formulalari, tanlash, per_block vaqt', () => {
  it('normalizator: eski hujjat bitta blok (legacy), yangi hujjat bloklar', () => {
    const legacy = normalizeBlocks({
      sections: [
        { items: [{ kind: 'manual', questionIds: ['a'] }] },
        { items: [{ kind: 'rule', count: 3, topicId: 't' }] },
      ],
      subjectId: 's1',
    });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      blockId: 'main',
      legacy: true,
      subjectId: 's1',
      coefficient: 1,
    });
    expect(blockQuestionCount(legacy[0]!)).toBe(4);
    expect(scoringOf({ sections: [], subjectId: null })).toBeUndefined();
    const b = normalizeBlocks({
      blocks: [
        {
          blockId: 'b1',
          subjectId: 's',
          items: [{ kind: 'manual', questionIds: ['q1'] }],
          contribQuestions: [
            { questionId: 'q1', addedBy: 'u', addedAt: null },
            { questionId: 'q2', addedBy: 'u', addedAt: null },
          ],
          durationMin: 10,
        },
      ],
    });
    expect(b[0]!.legacy).toBe(false);
    expect(blockQuestionCount(b[0]!)).toBe(2); // q1 takrorsiz
    expect(sumBlockDurations(b)).toBe(10);
  });

  const pool = new Map(
    [
      ['1', 'single', 2],
      ['2', 'multi', 4],
      ['3', 'single', 1],
      ['4', 'essay', 5],
    ].map(([id, type, points]) => [
      id as string,
      {
        questionId: id,
        type: type as string,
        points: points as number,
        options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        answer:
          type === 'single'
            ? { optionId: 'a' }
            : type === 'multi'
              ? { optionIds: ['a', 'b'], partialCredit: true }
              : {},
      },
    ]),
  );
  const order = [
    { blockId: 'B1', qid: '1', type: 'single', points: 2, optionPerm: ['a', 'b'] },
    { blockId: 'B1', qid: '2', type: 'multi', points: 4, optionPerm: ['a', 'b', 'c'] },
    { blockId: 'B2', qid: '3', type: 'single', points: 1, optionPerm: ['a', 'b'] },
    { blockId: 'B2', qid: '4', type: 'essay', points: 5, optionPerm: [] },
  ];
  const saved = (m: Record<string, unknown>) =>
    Object.entries(m).map(([qid, value]) => ({
      qid,
      value,
      flagged: false,
      answered: true,
      at: new Date(),
    }));
  const opts = (mode: 'points' | 'coefficient') => ({
    mode,
    blocks: [
      { blockId: 'B1', coefficient: 3.1 },
      { blockId: 'B2', coefficient: 2.1 },
    ],
  });
  const answers = saved({ '1': 'a', '2': ['a'], '3': 'a', '4': 'esse matni' });

  it('ball: points rejimi blok va umumiy yig`indi (multi qisman, esse kutilmoqda va baholangan)', () => {
    const p = gradeAttempt(order, answers, pool, [], opts('points'));
    expect(p.blocks).toEqual([
      expect.objectContaining({ blockId: 'B1', earned: 4, max: 6, questions: 2, correct: 1 }),
      expect.objectContaining({ blockId: 'B2', earned: 1, max: 6, essayPending: 1 }),
    ]);
    expect(p).toMatchObject({ earned: 5, max: 12, essayPending: 1 });
    const manual = [{ qid: '4', points: 2.5, comment: '', gradedBy: 'u', gradedAt: new Date() }];
    const g = gradeAttempt(order, answers, pool, manual, opts('points'));
    expect(g.blocks![1]).toMatchObject({ earned: 3.5, max: 6, essayPending: 0 });
    expect(g.earned).toBe(7.5);
  });

  it('ball: coefficient rejimi: (savol ulushlari yig`indisi) x koeffitsiyent; esse = ball/maks ulushi', () => {
    const c = gradeAttempt(order, answers, pool, [], opts('coefficient'));
    // B1: 1 (to'liq) + 0.5 (multi 1/2) = 1.5 x 3.1 = 4.65; max 2 x 3.1 = 6.2
    expect(c.blocks![0]).toMatchObject({ earned: 4.65, max: 6.2 });
    // B2: 1 + esse(kutilmoqda 0) = 1 x 2.1 = 2.1; max 4.2
    expect(c.blocks![1]).toMatchObject({ earned: 2.1, max: 4.2, essayPending: 1 });
    expect(c.earned).toBe(6.75);
    expect(c.max).toBe(10.4);
    const manual = [{ qid: '4', points: 2.5, comment: '', gradedBy: 'u', gradedAt: new Date() }];
    const g = gradeAttempt(order, answers, pool, manual, opts('coefficient'));
    expect(g.blocks![1]).toMatchObject({ earned: 3.15, max: 4.2, essayPending: 0 }); // (1 + 0.5) x 2.1
    expect(g.earned).toBe(7.8);
    // hammasi to'g'ri: maksimumga teng
    const full = gradeAttempt(
      order,
      saved({ '1': 'a', '2': ['a', 'b'], '3': 'a', '4': 'x' }),
      pool,
      [{ qid: '4', points: 5, comment: '', gradedBy: 'u', gradedAt: new Date() }],
      opts('coefficient'),
    );
    expect(full.earned).toBe(full.max);
  });

  it('ball: opts yo`q (eski) natija shakli o`zgarmaydi: blocks maydoni yo`q', () => {
    const l = gradeAttempt(order, answers, pool, []);
    expect(l.blocks).toBeUndefined();
    expect(l).toMatchObject({ earned: 5, max: 12 });
  });

  it('tanlash: bloklar tartibi saqlanadi, blockId belgilanadi, blok ichida aralashtiriladi, qo`lda takrorsiz', () => {
    const r = selectQuestions({
      blocks: [
        { blockId: 'B1', items: [{ kind: 'manual', questionIds: ['1', '2'] }] },
        { blockId: 'B2', items: [{ kind: 'manual', questionIds: ['3', '4', '1'] }] },
      ],
      pool: pool as never,
      shuffleQuestions: true,
      shuffleOptions: true,
      seed: 'x',
    });
    expect(r.map((o) => o.blockId)).toEqual(['B1', 'B1', 'B2', 'B2']);
    expect(new Set(r.map((o) => o.qid)).size).toBe(4); // '1' ikkinchi blokda qaytmaydi
    expect(
      r
        .slice(0, 2)
        .map((o) => o.qid)
        .sort(),
    ).toEqual(['1', '2']);
  });

  it('per_block vaqt: ketma-ket ochilish, hard chegarasi, grace dan keyin avtomatik o`tish, erta yakunlash, oxirgi blok', () => {
    const t0 = new Date('2026-12-01T10:00:00Z');
    const hard = mins(t0, 60);
    const st = initBlockState(
      [
        { blockId: 'A', durationMin: 30 },
        { blockId: 'B', durationMin: 20 },
      ],
      t0,
      hard,
    );
    expect(st[0]!.deadline).toEqual(mins(t0, 30));
    expect(st[1]!.startedAt).toBeNull();
    expect(projectedDeadline(st, 0, hard)).toEqual(mins(t0, 50));
    // vaqt tugamagan: o'zgarmaydi
    expect(advanceExpired(st, 0, mins(t0, 29), hard, 5000).changed).toBe(false);
    // grace ichida hali A
    expect(advanceExpired(st, 0, new Date(mins(t0, 30).getTime() + 3000), hard, 5000).index).toBe(
      0,
    );
    // A tugadi: B A ning deadline idan boshlanadi (o'quvchi ulanmagan bo'lsa ham)
    const adv = advanceExpired(st, 0, mins(t0, 40), hard, 5000);
    expect(adv.index).toBe(1);
    expect(adv.state[0]!.closedAt).toEqual(mins(t0, 30));
    expect(adv.state[1]!.startedAt).toEqual(mins(t0, 30));
    expect(adv.state[1]!.deadline).toEqual(mins(t0, 50));
    // hammasi tugadi: finished
    const done = advanceExpired(st, 0, mins(t0, 51), hard, 5000);
    expect(done).toMatchObject({ finished: true, index: 1 });
    expect(done.finishedAt).toEqual(mins(t0, 50));
    // erta yakunlash: B hozirdan boshlanadi
    const fin = finishCurrentBlock(st, 0, mins(t0, 10), hard);
    expect(fin.index).toBe(1);
    expect(fin.state[1]!.deadline).toEqual(mins(t0, 30));
    expect(finishCurrentBlock(fin.state, 1, mins(t0, 12), hard).finished).toBe(true);
    // kech boshlagan (hard torroq): blok deadline hard bilan cheklanadi
    const late = initBlockState(
      [
        { blockId: 'A', durationMin: 30 },
        { blockId: 'B', durationMin: 20 },
      ],
      mins(t0, 45),
      hard,
    );
    expect(late[0]!.deadline).toEqual(hard);
    expect(projectedDeadline(late, 0, hard)).toEqual(hard);
    // hammaga +10: joriy blokka qo'shiladi, har o'quvchi aynan 10 daqiqa ko'p oladi
    const ext = extendCurrentBlock(st, 0, 10, mins(t0, 70));
    expect(ext[0]!.deadline).toEqual(mins(t0, 40));
    expect(projectedDeadline(ext, 0, mins(t0, 70))).toEqual(mins(t0, 60));
  });
});

// ---------------------------------------------------------------------------------------------
describe('orqaga moslik: eski (blokisiz) hujjatlar', () => {
  it('eski sessiya va urinish hujjatlari (blocks/scoringMode/timingMode/blockState yo`q): DTO, start, javob, topshirish, baho, natijalar', async () => {
    await makeStudent(school.id, c7a.id, 'Oquvchi 1');
    const created = await call('post', '/sessions', admin, {
      title: 'Eski',
      type: 'quarter',
      subjectId: math.id,
      classIds: [c7a.id],
      sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: [ids.m1, ids.m2] }] }],
      scheduledStart: startAt().toISOString(),
      durationMin: 40,
      resultsMode: 'score',
      shuffleQuestions: false,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data.blocks).toHaveLength(1);
    expect(created.body.data.blocks[0]).toMatchObject({ legacy: true, id: 'main', count: 2 });
    expect(created.body.data).toMatchObject({ scoringMode: 'points', timingMode: 'common' });
    await call('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] });
    expect((await call('post', `/sessions/${id}/submit`, admin)).status).toBe(200);
    // Eski hujjat holati: yangi maydonlar umuman yo'q
    await ExamSession.collection.updateOne(
      { _id: new (await import('mongoose')).Types.ObjectId(id) },
      { $unset: { blocks: '', scoringMode: '', timingMode: '', contribDeadline: '' } },
    );
    const doc = (await ExamSession.findById(id))!;
    const p = doc.participants[0]!;
    at(mins(doc.scheduledStart, 1));
    const j = await ec('post', '/join', null, {
      code: doc.code,
      pin: decryptPin(p.pinEnc, id),
      deviceId: DEV,
    });
    expect(j.status).toBe(200);
    expect(j.body.data.exam).toMatchObject({ freeNavigation: true, timingMode: 'common' });
    expect(j.body.data.exam.blocks).toHaveLength(1);
    const token = j.body.data.token as string;
    const st = await ec('post', '/start', token);
    expect(st.status).toBe(200);
    expect(st.body.data.block).toBeNull();
    expect(st.body.data.questions).toHaveLength(2);
    for (const q of st.body.data.questions) expect(q).not.toHaveProperty('blockId');
    const a = await ExamAttempt.findOne({ sessionId: id });
    // eski urinish hujjati holatini taqlid qilamiz
    await ExamAttempt.collection.updateOne(
      { _id: a!._id },
      { $unset: { blockState: '', blockIndex: '', hardDeadline: '' } },
    );
    const q1 = st.body.data.questions.find((q: { id: string }) => q.id === ids.m1);
    const put = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [{ qid: ids.m1, value: q1.options[0].id }],
    });
    expect(put.status).toBe(200);
    expect(put.body.data).not.toHaveProperty('rejected');
    const sub = await ec('post', '/submit', token);
    expect(sub.status).toBe(200);
    expect(sub.body.data.score.max).toBe(6);
    expect(sub.body.data.blocks).toBeUndefined(); // eski natija shakli
    const att = (await ExamAttempt.findOne({ sessionId: id }))!;
    expect(att.score!.blocks).toBeUndefined();
    // admin natijalar: bitta (legacy) blok, ball eski usulda
    const res = await call('get', `/sessions/${id}/results`, admin);
    expect(res.status).toBe(200);
    expect(res.body.data.blocks).toHaveLength(1);
    expect(res.body.data.rows[0].blocks).toEqual([
      expect.objectContaining({ blockId: 'main', max: 6 }),
    ]);
    expect(res.body.data.session.scoringMode).toBe('points');
    const an = await call('get', `/sessions/${id}/results/analysis`, admin);
    expect(an.status).toBe(200);
    expect(an.body.data.questions.every((q: { blockId: string }) => q.blockId === 'main')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('tuzuvchi: bloklar yaratish va tekshiruvlar', () => {
  it('2 blokli imtihon: DTO (fan, koeffitsiyent, davomiylik, durationMin = yig`indi), shablon, audit', async () => {
    const r = await mkSession({ mathContrib: [tmathId], langContrib: [tlangId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({
      scoringMode: 'coefficient',
      timingMode: 'per_block',
      durationMin: 50,
    });
    expect(d.sections).toEqual([]);
    expect(d.blocks).toHaveLength(2);
    expect(d.blocks[0]).toMatchObject({
      subjectName: 'Matematika',
      title: 'Matematika',
      coefficient: 3.1,
      durationMin: 30,
      targetCount: 2,
      count: 2,
      status: 'open',
    });
    expect(d.blocks[0].contributors).toEqual([expect.objectContaining({ id: tmathId })]);
    expect(d.subjectId).toBeNull();
    // shablon blok bilan
    const t = await call('post', '/templates', admin, {
      title: 'DTM shablon',
      blocks: blocksBody({ mathContrib: [tmathId] }),
      scoringMode: 'coefficient',
      timingMode: 'per_block',
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.data.blocks[0].contributorIds).toEqual([]); // o'qituvchilar shablonga o'tmaydi
    const s2 = await call('post', '/sessions', admin, {
      title: 'Shablondan',
      type: 'trial',
      templateId: t.body.data.id,
      scheduledStart: startAt().toISOString(),
    });
    expect(s2.status, JSON.stringify(s2.body)).toBe(201);
    expect(s2.body.data).toMatchObject({
      timingMode: 'per_block',
      scoringMode: 'coefficient',
      durationMin: 50,
    });
    expect(s2.body.data.blocks).toHaveLength(2);
    // preview
    const pv = await call('post', '/templates/preview', admin, { blocks: blocksBody() });
    expect(pv.body.data.blocks).toHaveLength(2);
    expect(pv.body.data.ok).toBe(true);
  });

  it('tekshiruvlar: blok faniga mos kelmagan savol/mavzu, per_block da davomiylik, bloklar+bo`limlar, fan o`qitmaydigan o`qituvchi, ikki blokda bir savol', async () => {
    // matematika blokiga ona tili savoli
    const bad = await mkSession({ mathItems: [{ kind: 'manual', questionIds: [ids.l1] }] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/topilmadi|ko'rinmaydi|faol emas/);
    const badRule = await mkSession({
      mathItems: [{ kind: 'rule', topicId: langTopic.id, count: 1 }],
    });
    expect(badRule.status).toBe(400);
    expect(JSON.stringify(badRule.body)).toMatch(/blok faniga mos emas/);
    // per_block: davomiylik majburiy
    const body = blocksBody();
    delete (body[0] as { durationMin?: number }).durationMin;
    const nodur = await call('post', '/sessions', admin, {
      title: 'X',
      type: 'quarter',
      blocks: body,
      timingMode: 'per_block',
      scheduledStart: startAt().toISOString(),
    });
    expect(nodur.status).toBe(400);
    // umumiy rejimda durationMin majburiy
    const nod = await call('post', '/sessions', admin, {
      title: 'X',
      type: 'quarter',
      blocks: blocksBody(),
      timingMode: 'common',
      scheduledStart: startAt().toISOString(),
    });
    expect(nod.status).toBe(400);
    // bloklar va bo'limlar birga
    const both = await call('post', '/sessions', admin, {
      title: 'X',
      type: 'quarter',
      blocks: blocksBody(),
      sections: [{ title: 'a', items: [{ kind: 'manual', questionIds: [ids.m1] }] }],
      durationMin: 30,
      scheduledStart: startAt().toISOString(),
    });
    expect(both.status).toBe(400);
    // bloklarsiz koeffitsiyent
    const coef = await call('post', '/sessions', admin, {
      title: 'X',
      type: 'quarter',
      subjectId: math.id,
      sections: [{ title: 'a', items: [{ kind: 'manual', questionIds: [ids.m1] }] }],
      durationMin: 30,
      scoringMode: 'coefficient',
      scheduledStart: startAt().toISOString(),
    });
    expect(coef.status).toBe(400);
    // fanni o'qitmaydigan o'qituvchini biriktirib bo'lmaydi (tlang matematikani o'qitmaydi)
    const wrongT = await mkSession({ mathContrib: [tlangId] });
    expect(wrongT.status).toBe(400);
    expect(JSON.stringify(wrongT.body)).toMatch(/o'qitmaydi/);
    // boshqa maktab o'qituvchisi
    const otherT = await User.findOne({ username: 'tfake' });
    expect((await mkSession({ mathContrib: [otherT!.id] })).status).toBe(400);
    // contribDeadline boshlanishdan keyin
    const late = await mkSession(
      {},
      { contribDeadline: new Date(Date.now() + 9 * 3_600_000).toISOString() },
    );
    expect(late.status).toBe(400);
    // bir savol ikki blokda: ikkinchi blokka (ona tili) ona tili savolini emas, matematik savol -> mos emas; shuning uchun
    // matematika ichida ikkita blok yaratamiz
    const two = blocksBody();
    two[1] = { ...two[0]!, coefficient: 2.1 } as never;
    const dup = await call('post', '/sessions', admin, {
      title: 'X',
      type: 'quarter',
      blocks: two,
      timingMode: 'per_block',
      scheduledStart: startAt().toISOString(),
    });
    expect(dup.status).toBe(400);
    expect(JSON.stringify(dup.body)).toMatch(/ikki blokda/);
  });

  it('o`qituvchining nazorat ishi = bitta blok: ruxsat; 2 blok, boshqa fan va o`qituvchi biriktirish taqiqlanadi', async () => {
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: true, teachersCanCreateQuizzes: true },
      rootId,
    );
    const mine = await mkQ(tmath, mathTopic.id, single('Mening savolim'));
    const ok = await call('post', '/sessions', tmath, {
      title: 'Nazorat',
      type: 'quiz',
      classIds: [c7a.id],
      blocks: [
        { subjectId: math.id, targetCount: 1, items: [{ kind: 'manual', questionIds: [mine] }] },
      ],
      scheduledStart: startAt().toISOString(),
      durationMin: 20,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.subjectId).toBe(math.id);
    expect(ok.body.data.blocks).toHaveLength(1);
    const two = await call('post', '/sessions', tmath, {
      title: 'Nazorat 2',
      type: 'quiz',
      classIds: [c7a.id],
      blocks: blocksBody(),
      scheduledStart: startAt().toISOString(),
      durationMin: 20,
    });
    expect(two.status).toBe(403);
    const withContrib = await call('post', '/sessions', tmath, {
      title: 'Nazorat 3',
      type: 'quiz',
      classIds: [c7a.id],
      blocks: [
        {
          subjectId: math.id,
          contributorIds: [tfreeId],
          items: [{ kind: 'manual', questionIds: [mine] }],
        },
      ],
      scheduledStart: startAt().toISOString(),
      durationMin: 20,
    });
    expect(withContrib.status).toBe(403);
  });

  it('rejalashtirish: maqsaddan kam savol 409 (confirmShort bilan o`tadi), bo`sh blok 400; kod va muzlatilgan blok', async () => {
    await makeStudent(school.id, c7a.id, 'Oquvchi 1');
    const r = await mkSession({ mathTarget: 5 });
    const id = r.body.data.id as string;
    await call('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] });
    const no = await call('post', `/sessions/${id}/submit`, admin);
    expect(no.status).toBe(409);
    expect(JSON.stringify(no.body)).toMatch(/2\/5/);
    // bo'sh blok
    const e = await call('patch', `/sessions/${id}`, admin, {
      blocks: blocksBody({ mathItems: [], mathTarget: 0 }),
    });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const empty = await call('post', `/sessions/${id}/submit`, admin, { confirmShort: true });
    expect(empty.status).toBe(400);
    expect(JSON.stringify(empty.body)).toMatch(/savol yo'q/);
    await call('patch', `/sessions/${id}`, admin, { blocks: blocksBody({ mathTarget: 5 }) });
    const yes = await call('post', `/sessions/${id}/submit`, admin, { confirmShort: true });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    const doc = (await ExamSession.findById(id).select('+questionPool'))!;
    expect(doc.status).toBe('scheduled');
    expect(doc.questionPool).toHaveLength(4);
    expect(doc.blocks).toHaveLength(2);
    // muzlatilgandan keyin tahrirlab bo'lmaydi
    expect((await call('patch', `/sessions/${id}`, admin, { blocks: blocksBody() })).status).toBe(
      409,
    );
  });

  it('tenant: boshqa maktab tuzuvchisi blok endpointlarini ko`ra olmaydi (404), ruxsatsiz 403', async () => {
    const s = await mkSession({ mathContrib: [tmathId] });
    const id = s.body.data.id as string;
    const bid = s.body.data.blocks[0].id as string;
    const o = (m: 'get' | 'post' | 'delete', url: string, body?: object) => {
      const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(oadmin));
      return body ? r.send(body) : r;
    };
    expect((await o('get', `/sessions/${id}/blocks/${bid}/questions`)).status).toBe(404);
    expect((await o('post', `/sessions/${id}/blocks/${bid}/ready`, { ready: true })).status).toBe(
      404,
    );
    expect((await o('delete', `/sessions/${id}/blocks/${bid}/questions/${ids.m1}`)).status).toBe(
      404,
    );
    expect((await o('get', `/my-blocks/${id}/${bid}`)).status).toBe(404);
    expect((await o('get', '/my-blocks')).body.data).toEqual([]);
    // boshqa maktab o'qituvchisi
    const f = request(app).get(`/api/v1/exams/my-blocks/${id}/${bid}`).set(bearer(tfake));
    expect((await f).status).toBe(404); // boshqa maktab o'qituvchisi: sessiya mavjudligi oshkor bo'lmaydi
  });
});

// ---------------------------------------------------------------------------------------------
describe('biriktirilgan o`qituvchi (hissa qo`shuvchi)', () => {
  it('faqat O`Z blokini ko`radi: ro`yxat, blok sahifasi; boshqa blok/imtihon/ishtirokchi/PIN/javob kaliti ko`rinmaydi', async () => {
    const s = await mkSession({
      mathContrib: [tmathId],
      langContrib: [tlangId],
      contribDeadline: new Date(Date.now() + 3_600_000),
    });
    const id = s.body.data.id as string;
    const [bm, bl] = [s.body.data.blocks[0].id as string, s.body.data.blocks[1].id as string];
    const list = await call('get', '/my-blocks', tmath);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      sessionId: id,
      blockId: bm,
      examTitle: 'DTM sinov',
      subjectName: 'Matematika',
      targetCount: 2,
      count: 2,
      locked: false,
    });
    expect(JSON.stringify(list.body)).not.toMatch(/Ona tili|coefficient|participants|pin/i);
    const det = await call('get', `/my-blocks/${id}/${bm}`, tmath);
    expect(det.status, JSON.stringify(det.body)).toBe(200);
    expect(det.body.data.block).toMatchObject({
      subjectName: 'Matematika',
      targetCount: 2,
      locked: false,
    });
    expect(det.body.data.exam.title).toBe('DTM sinov');
    expect(det.body.data.questions).toHaveLength(2);
    expect(det.body.data.questions[0].canRemove).toBe(false); // tuzuvchi savoli
    const dump = JSON.stringify(det.body);
    expect(dump).not.toMatch(/"answer"|optionId|rubric|pin|participants|coefficient|durationMin/);
    // boshqa blok va imtihon
    expect((await call('get', `/my-blocks/${id}/${bl}`, tmath)).status).toBe(404);
    expect((await call('get', `/sessions/${id}`, tmath)).status).toBe(404);
    expect((await call('get', `/sessions/${id}/results`, tmath)).status).toBe(404);
    expect((await call('get', `/sessions/${id}/blocks/${bl}/questions`, tmath)).status).toBe(404);
    expect((await call('post', `/sessions/${id}/print`, tmath)).status).toBe(404);
    const sl = await call('get', '/sessions', tmath);
    expect(sl.body.data).toEqual([]);
    // biriktirilmagan o'qituvchi (xuddi shu fan)
    expect((await call('get', `/my-blocks/${id}/${bm}`, tfree)).status).toBe(404);
    expect((await call('get', '/my-blocks', tfree)).body.data).toEqual([]);
    expect(
      (await call('post', `/my-blocks/${id}/${bm}/questions`, tfree, { questionIds: [ids.m1] }))
        .status,
    ).toBe(404);
    // eski (blokisiz) imtihon: 404
    const legacy = await call('post', '/sessions', admin, {
      title: 'Eski',
      type: 'quarter',
      subjectId: math.id,
      sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: [ids.m1] }] }],
      scheduledStart: startAt().toISOString(),
      durationMin: 40,
    });
    expect(
      (await call('get', `/my-blocks/${legacy.body.data.id}/${'0'.repeat(24)}`, tmath)).status,
    ).toBe(404);
    expect((await call('get', `/my-blocks/${legacy.body.data.id}/main`, tmath)).status).toBe(400);
  });

  it('bankdan tanlash: faqat blok fanidagi, ko`rinadigan FAOL savol; yangi savol bankka "Imtihon: ..." mavzusiga tushadi (faol, yopiq, muallif = o`qituvchi)', async () => {
    const s = await mkSession({
      mathContrib: [tmathId],
      mathItems: [],
      mathTarget: 3,
      contribDeadline: new Date(Date.now() + 3_600_000),
    });
    const id = s.body.data.id as string;
    const bm = s.body.data.blocks[0].id as string;
    const url = `/my-blocks/${id}/${bm}`;
    // o'zining bankidagi savol
    const own = await mkQ(tmath, mathTopic.id, single('O`zimniki'));
    const add = await call('post', `${url}/questions`, tmath, { questionIds: [own] });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.data).toMatchObject({ added: 1, count: 1, target: 3 });
    // takror qo'shish: e'tiborsiz
    expect(
      (await call('post', `${url}/questions`, tmath, { questionIds: [own] })).body.data.added,
    ).toBe(0);
    // boshqa fan (ona tili) savoli: rad
    const wrongSubject = await call('post', `${url}/questions`, tmath, { questionIds: [ids.l1] });
    expect(wrongSubject.status).toBe(400);
    // ulashilmagan boshqa muallif savoli (admin yaratgan, sharing private)
    const priv = await call('post', '/questions', admin, {
      topicId: mathTopic.id,
      status: 'active',
      sharing: { mode: 'private' },
      ...single('Yopiq'),
    });
    expect(
      (await call('post', `${url}/questions`, tmath, { questionIds: [priv.body.data.id] })).status,
    ).toBe(400);
    // qoralama savol
    const draft = await mkQ(tmath, mathTopic.id, { ...single('Qoralama'), status: 'draft' });
    expect((await call('post', `${url}/questions`, tmath, { questionIds: [draft] })).status).toBe(
      400,
    );
    // yangi savol yozish
    const created = await call('post', `${url}/questions/new`, tmath, {
      ...single('Yangi blok savoli', 'b', 3),
      difficulty: 2,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.count).toBe(2);
    const q = (await Question.findById(created.body.data.question.id))!;
    expect(q).toMatchObject({ status: 'active', authorId: expect.anything() });
    expect(String(q.subjectId)).toBe(math.id);
    expect(String(q.authorId)).toBe(tmathId);
    expect(q.sharing?.mode).toBe('private');
    const topic = (await ExamTopic.findById(q.topicId))!;
    expect(topic.name).toBe('Imtihon: DTM sinov');
    expect(String(topic.subjectId)).toBe(math.id);
    // ikkinchi savol shu mavzuga (dublikat mavzu yaratilmaydi)
    await call('post', `${url}/questions/new`, tmath, single('Yana bitta'));
    expect(await ExamTopic.countDocuments({ name: 'Imtihon: DTM sinov', subjectId: math.id })).toBe(
      1,
    );
    // o'qituvchi faqat o'zi qo'shganini olib tashlaydi
    const det = await call('get', url, tmath);
    expect(det.body.data.questions).toHaveLength(3);
    expect(det.body.data.questions.every((x: { canRemove: boolean }) => x.canRemove)).toBe(true);
    const rm = await call('delete', `${url}/questions/${own}`, tmath);
    expect(rm.status).toBe(200);
    expect(rm.body.data.count).toBe(2);
    expect(await Question.countDocuments({ _id: own })).toBe(1); // bankdan o'chmaydi
    // tuzuvchi o'qituvchi qo'shgan savolni ko'radi va istalganini olib tashlay oladi
    const comp = await call('get', `/sessions/${id}/blocks/${bm}/questions`, admin);
    expect(comp.body.data.questions).toHaveLength(2);
    expect(comp.body.data.questions[0].source).toBe('contributor');
    const crm = await call(
      'delete',
      `/sessions/${id}/blocks/${bm}/questions/${created.body.data.question.id}`,
      admin,
    );
    expect(crm.status).toBe(200);
    expect(crm.body.data.count).toBe(1);
    // tuzuvchi imtihon DTO sida o'qituvchi savollari
    const sd = await call('get', `/sessions/${id}`, admin);
    expect(sd.body.data.blocks[0].contribQuestions).toHaveLength(1);
    expect(sd.body.data.blocks[0].contribQuestions[0].addedByName).toBe('Test tmath');
  });

  it('muddat o`tgach blok faqat o`qish uchun (o`qituvchiga), tuzuvchi esa tahrirlaydi; "tayyor" va holat qulfi', async () => {
    const dl = new Date(Date.now() + 3_600_000);
    const s = await mkSession({
      mathContrib: [tmathId],
      mathItems: [],
      mathTarget: 3,
      contribDeadline: dl,
    });
    const id = s.body.data.id as string;
    const bm = s.body.data.blocks[0].id as string;
    const url = `/my-blocks/${id}/${bm}`;
    expect((await call('post', `${url}/questions/new`, tmath, single('Vaqtida'))).status).toBe(201);
    at(mins(dl, 5)); // muddatdan keyin
    const det = await call('get', url, tmath);
    expect(det.body.data.block).toMatchObject({ locked: true, lockReason: 'deadline' });
    expect((await call('post', `${url}/questions/new`, tmath, single('Kech'))).status).toBe(403);
    expect((await call('post', `${url}/questions`, tmath, { questionIds: [ids.m1] })).status).toBe(
      403,
    );
    const mine = det.body.data.questions[0].id as string;
    expect((await call('delete', `${url}/questions/${mine}`, tmath)).status).toBe(403);
    expect((await call('get', '/my-blocks', tmath)).body.data[0]).toMatchObject({
      locked: true,
      lockReason: 'deadline',
    });
    // tuzuvchi hamon tahrirlay oladi
    expect(
      (await call('delete', `/sessions/${id}/blocks/${bm}/questions/${mine}`, admin)).status,
    ).toBe(200);
    const upd = await call('patch', `/sessions/${id}`, admin, {
      blocks: [
        {
          ...blocksBody()[0],
          blockId: bm,
          items: [{ kind: 'manual', questionIds: [ids.m1, ids.m2] }],
          contributorIds: [tmathId],
        },
        blocksBody()[1],
      ],
      contribDeadline: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    // muddat uzaytirilgach yana ochiladi
    clock.reset();
    expect((await call('get', url, tmath)).body.data.block.locked).toBe(false);
    // "tayyor": o'qituvchi uchun qulf
    expect(
      (await call('post', `/sessions/${id}/blocks/${bm}/ready`, tmath, { ready: true })).status,
    ).toBe(404);
    expect(
      (await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: true })).body.data
        .status,
    ).toBe('ready');
    expect((await call('post', `${url}/questions/new`, tmath, single('Tayyor'))).status).toBe(403);
    expect((await call('get', url, tmath)).body.data.block.lockReason).toBe('ready');
    await call('post', `/sessions/${id}/blocks/${bm}/ready`, admin, { ready: false });
    expect(
      (await call('post', `${url}/questions/new`, tmath, single('Qayta ochildi'))).status,
    ).toBe(201);
    // PATCH da blockId saqlansa o'qituvchi savollari va tayyorlik saqlanadi
    const keep = await call('get', `/sessions/${id}`, admin);
    expect(keep.body.data.blocks[0].contribQuestions.length).toBe(1);
  });

  it('imtihon rejalashtirilgach (muzlatilgan) blok o`qituvchi uchun yopiq', async () => {
    const s = await scheduled({ mathContrib: [tmathId] });
    const sd = (await ExamSession.findById(s.id))!;
    const bm = sd.blocks[0]!.blockId;
    const det = await call('get', `/my-blocks/${s.id}/${bm}`, tmath);
    expect(det.body.data.block).toMatchObject({ locked: true, lockReason: 'status' });
    expect(
      (await call('post', `/my-blocks/${s.id}/${bm}/questions/new`, tmath, single('Kech'))).status,
    ).toBe(403);
  });

  it('Excel importi blok ichida: oldindan ko`rish + tasdiqlash savollarni bankka (faol, "Imtihon: ..." mavzusi) va blokka qo`shadi', async () => {
    const s = await mkSession({ mathContrib: [tmathId], mathItems: [], mathTarget: 3 });
    const id = s.body.data.id as string;
    const bm = s.body.data.blocks[0].id as string;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow([
      'Fan',
      'Mavzu',
      'Qiyinlik',
      'Tur',
      'Savol',
      'A',
      'B',
      'C',
      'D',
      "To'g'ri javob",
      'Ball',
      'Qisman ball',
    ]);
    ws.addRow(['Matematika', 'X', 2, 'single', 'Birinchi?', 'x', 'y', null, null, 'A', 1, null]);
    ws.addRow(['Matematika', 'X', 2, 'single', 'Ikkinchi?', 'x', 'y', null, null, 'B', 1, null]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const pv = await request(app)
      .post(`/api/v1/exams/my-blocks/${id}/${bm}/import/excel`)
      .set(bearer(tmath))
      .attach('file', buf, { filename: 'q.xlsx', contentType: XLSX });
    expect(pv.status, JSON.stringify(pv.body)).toBe(201);
    expect(pv.body.data.topic.name).toBe('Imtihon: DTM sinov');
    const cm = await call(
      'post',
      `/my-blocks/${id}/${bm}/import/${pv.body.data.id}/commit`,
      tmath,
      {},
    );
    expect(cm.status, JSON.stringify(cm.body)).toBe(200);
    expect(cm.body.data).toMatchObject({ created: 2, addedToBlock: 2, count: 2 });
    const qs = await Question.find({ authorId: tmathId }).lean();
    expect(qs).toHaveLength(2);
    expect(qs.every((q) => q.status === 'active' && q.sharing?.mode === 'private')).toBe(true);
    // boshqa o'qituvchi (tlang) matematika blokiga import qila olmaydi
    const bad = await request(app)
      .post(`/api/v1/exams/my-blocks/${id}/${bm}/import/excel`)
      .set(bearer(tlang))
      .attach('file', buf, { filename: 'q.xlsx', contentType: XLSX });
    expect(bad.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
describe('imtihon topshirish: bloklar, per_block vaqt, ball, natijalar', () => {
  it('per_block: faqat joriy blok savollari, javob faqat joriy blokka, blokni yakunlash, orqaga yo`q, vaqt tugashi, natija bloklar bilan', async () => {
    const s = await scheduled();
    at(mins(s.start, 2));
    const { token, join, start } = await joinStart(s);
    expect(join.exam).toMatchObject({
      timingMode: 'per_block',
      freeNavigation: false,
      questionCount: 4,
    });
    expect(
      join.exam.blocks.map((b: { questionCount: number; durationMin: number }) => [
        b.questionCount,
        b.durationMin,
      ]),
    ).toEqual([
      [2, 30],
      [2, 20],
    ]);
    expect(start.block).toMatchObject({ index: 0, total: 2 });
    expect(start.questions).toHaveLength(2); // faqat 1-blok
    expect(JSON.stringify(start)).not.toMatch(/Lang 1|Lang esse/); // 2-blok kontenti yuborilmaydi
    const b1 = start.block.id as string;
    const bd = new Date(start.block.deadline).getTime();
    expect(bd).toBe(mins(s.start, 32).getTime()); // 30 daqiqa, joriy blok
    // javob: joriy blok savollari
    const m1 = start.questions.find((q: { id: string }) => q.id === ids.m1);
    const m2 = start.questions.find((q: { id: string }) => q.id === ids.m2);
    const okAns = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [
        { qid: ids.m1, value: 'a' },
        { qid: ids.m2, value: ['a'] },
      ],
    });
    expect(okAns.status).toBe(200);
    expect(okAns.body.data.rejected).toBeUndefined();
    expect(m1 && m2).toBeTruthy();
    // 2-blok savoliga javob: rad etiladi (hali ochilmagan), 1-blok javobi saqlanadi
    const early = await ec('put', '/answers', token, {
      clientSeq: 2,
      answers: [
        { qid: ids.l1, value: 'b' },
        { qid: ids.m1, value: 'a' },
      ],
    });
    expect(early.status).toBe(200);
    expect(early.body.data.rejected).toEqual([ids.l1]);
    // blokni yakunlash: eskirgan blockId e'tiborsiz (idempotent)
    expect(
      (await ec('post', '/blocks/finish', token, { blockId: 'x'.repeat(24) })).body.data.block.id,
    ).toBe(b1);
    at(mins(s.start, 12));
    const fin = await ec('post', '/blocks/finish', token, { blockId: b1 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.data.finished).toBe(false);
    expect(fin.body.data.block).toMatchObject({ index: 1 });
    expect(fin.body.data.questions.map((q: { id: string }) => q.id).sort()).toEqual(
      [ids.l1, ids.l2].sort(),
    );
    expect(JSON.stringify(fin.body)).not.toMatch(/Math 1|Math 2/); // orqaga qaytish yo'q: yopilgan blok kontenti qaytmaydi
    expect(new Date(fin.body.data.block.deadline).getTime()).toBe(mins(s.start, 32).getTime()); // 12 + 20
    // yopilgan blokka javob: server rad etadi, saqlangan javob o'zgarmaydi
    const back = await ec('put', '/answers', token, {
      clientSeq: 3,
      answers: [{ qid: ids.m1, value: 'b' }],
    });
    expect(back.status).toBe(200);
    expect(back.body.data.rejected).toEqual([ids.m1]);
    const att = (await ExamAttempt.findOne({ sessionId: s.id }))!;
    expect(att.saved.find((x) => x.qid === ids.m1)!.value).toBe('a');
    // oldingi blokni qayta yakunlash: hech narsa o'zgarmaydi
    expect((await ec('post', '/blocks/finish', token, { blockId: b1 })).body.data.block.index).toBe(
      1,
    );
    // 2-blokka javob + state
    expect(
      (
        await ec('put', '/answers', token, {
          clientSeq: 4,
          answers: [
            { qid: ids.l1, value: 'b' },
            { qid: ids.l2, value: 'esse' },
          ],
        })
      ).body.data.rejected,
    ).toBeUndefined();
    const stt = await ec('get', '/state', token);
    expect(stt.body.data.block).toMatchObject({ index: 1, id: fin.body.data.block.id });
    // /start qayta chaqirilsa joriy blok (idempotent), eski blok savollari yo'q
    const again = await ec('post', '/start', token);
    expect(again.body.data.questions.map((q: { id: string }) => q.id).sort()).toEqual(
      [ids.l1, ids.l2].sort(),
    );
    // oxirgi blokni yakunlash: topshirish va natija
    const last = await ec('post', '/blocks/finish', token, { blockId: fin.body.data.block.id });
    expect(last.body.data.finished).toBe(true);
    expect(last.body.data.score).toMatchObject({ earned: 4.65 + 2.1, max: 10.4 });
    expect(last.body.data.score.essayPending).toBe(1);
    expect(last.body.data.blocks).toEqual([
      expect.objectContaining({ title: 'Matematika', earned: 4.65, max: 6.2 }),
      expect.objectContaining({ title: 'Ona tili', earned: 2.1, max: 4.2 }),
    ]);
    expect(last.body.data.review).toHaveLength(4);
    expect(last.body.data.review[0]).toHaveProperty('blockId');
    const st2 = (await ExamAttempt.findOne({ sessionId: s.id }))!;
    expect(st2.status).toBe('submitted');
    // topshirilgandan keyin javob 409
    expect(
      (await ec('put', '/answers', token, { clientSeq: 9, answers: [{ qid: ids.l1, value: 'a' }] }))
        .status,
    ).toBe(409);
  });

  it('per_block: vaqti tugagan blok avtomatik yopiladi (keyingi blok oldingi deadline dan), oxirgi blok tugagach avtomatik topshiriladi; sweeper', async () => {
    const s = await scheduled();
    at(mins(s.start, 1));
    const { token } = await joinStart(s);
    // 1-blok (30 daq) tugab, 2-blokning 5 daqiqasi o'tgan payt
    at(mins(s.start, 1 + 30 + 5));
    const st = await ec('get', '/state', token);
    expect(st.body.data.block.index).toBe(1);
    expect(new Date(st.body.data.block.startedAt).getTime()).toBe(mins(s.start, 31).getTime());
    // hard chegara: boshlanishdan 50 daqiqa (1 daqiqa kech kirgan o'quvchi oxirgi blokdan yo'qotadi)
    expect(new Date(st.body.data.block.deadline).getTime()).toBe(mins(s.start, 50).getTime());
    // 1-blok javobi endi rad etiladi (token egasi ulanmagan bo'lsa ham vaqt o'tgan)
    const late = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [{ qid: ids.m1, value: 'a' }],
    });
    expect(late.body.data.rejected).toEqual([ids.m1]);
    // hamma bloklar tugadi: sweeper avtomatik topshiradi
    at(mins(s.start, 52));
    expect(await runExamSweeper()).toBe(1);
    const att = (await ExamAttempt.findOne({ sessionId: s.id }))!;
    expect(att.status).toBe('auto_submitted');
    expect(att.score?.blocks).toHaveLength(2);
    expect(att.submittedAt!.getTime()).toBe(mins(s.start, 50).getTime());
    // lazy yo'l: boshqa o'quvchi sweepersiz so'rov bilan topshiriladi
    clock.reset();
  });

  it('per_block: kechikkan o`quvchi umumiy tugash bilan cheklanadi; to`liq vaqt berilsa boshlagan vaqtidan yig`indi; hammaga +N daqiqa joriy blokka', async () => {
    const s = await scheduled();
    // 2 o'quvchi: biri kech (umumiy oyna 50 daq: start..start+50), 35-daqiqada boshlaydi
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 2']!.key },
      { $set: { 'participants.$.fullTimeGranted': true } },
    );
    at(mins(s.start, 35));
    const late = await joinStart(s, 'Oquvchi 1');
    // 1-blok: min(35+30, start+50) = start+50 (hard bilan cheklangan)
    expect(new Date(late.start.block.deadline).getTime()).toBe(mins(s.start, 50).getTime());
    expect(new Date(late.start.deadline).getTime()).toBe(mins(s.start, 50).getTime());
    // to'liq vaqt berilgan: yig'indi 50 daqiqa boshlagan vaqtdan
    at(mins(s.start, 55));
    const j2 = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 2']!.pin,
      deviceId: 'device-bbbbbbbb',
    });
    expect(j2.status, JSON.stringify(j2.body)).toBe(200);
    const st2 = await ec('post', '/start', j2.body.data.token);
    expect(new Date(st2.body.data.block.deadline).getTime()).toBe(mins(s.start, 85).getTime()); // 55 + 30
    expect(new Date(st2.body.data.deadline).getTime()).toBe(mins(s.start, 105).getTime()); // 55 + 50
    // hammaga +10 daqiqa (ochiq imtihon): joriy blok +10, urinish deadline +10
    const att0 = (await ExamAttempt.findOne({ participantKey: s.pins['Oquvchi 2']!.key }))!;
    expect(att0.blockIndex).toBe(0);
    at(mins(s.start, 60));
    const ex = await call('post', `/sessions/${s.id}/extend`, admin, { minutes: 10 });
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect(ex.body.data.durationMin).toBe(60);
    const att1 = (await ExamAttempt.findOne({ participantKey: s.pins['Oquvchi 2']!.key }))!;
    expect(att1.blockState[0]!.extraMin).toBe(10);
    expect(att1.blockState[0]!.deadline!.getTime()).toBe(mins(s.start, 95).getTime());
    expect(att1.deadline!.getTime()).toBe(mins(s.start, 115).getTime()); // har o'quvchi aynan +10
    expect(att1.hardDeadline!.getTime()).toBe(mins(s.start, 115).getTime());
  });

  it('common rejimi + bloklar: erkin navigatsiya (hamma savol), blok sarlavhalari, bitta umumiy deadline; blokni yakunlash 409', async () => {
    const s = await scheduled({ timingMode: 'common' }, { durationMin: 45 });
    at(mins(s.start, 1));
    const { token, join, start } = await joinStart(s);
    expect(join.exam).toMatchObject({ freeNavigation: true, timingMode: 'common' });
    expect(start.block).toBeNull();
    expect(start.questions).toHaveLength(4);
    expect(start.questions.every((q: { blockId: string }) => !!q.blockId)).toBe(true);
    expect(new Date(start.deadline).getTime()).toBe(mins(s.start, 45).getTime());
    expect(
      (await ec('post', '/blocks/finish', token, { blockId: start.questions[0].blockId })).status,
    ).toBe(409);
    // blokli javoblar hammasi qabul qilinadi
    const put = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [
        { qid: ids.m1, value: 'a' },
        { qid: ids.l1, value: 'b' },
      ],
    });
    expect(put.body.data.rejected).toBeUndefined();
    const sub = await ec('post', '/submit', token);
    expect(sub.body.data.blocks).toHaveLength(2);
  });

  it('natijalar: blok ustunlari, ishtirokchi tafsiloti, esse baholash blok balini yangilaydi, tahlil blok bo`yicha, Excel/PDF eksport blok ustunlari; points rejimi', async () => {
    const s = await scheduled({ scoringMode: 'points' });
    at(mins(s.start, 1));
    const { token } = await joinStart(s);
    await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [
        { qid: ids.m1, value: 'a' },
        { qid: ids.m2, value: ['a'] },
      ],
    });
    const b1 = (await ExamAttempt.findOne({ sessionId: s.id }))!.blockState[0]!.blockId;
    await ec('post', '/blocks/finish', token, { blockId: b1 });
    await ec('put', '/answers', token, {
      clientSeq: 2,
      answers: [
        { qid: ids.l1, value: 'b' },
        { qid: ids.l2, value: 'Esse javobi' },
      ],
    });
    const last = (await ec('get', '/state', token)).body.data.block.id as string;
    await ec('post', '/blocks/finish', token, { blockId: last });
    const res = await call('get', `/sessions/${s.id}/results`, admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.session).toMatchObject({ scoringMode: 'points', timingMode: 'per_block' });
    expect(
      res.body.data.blocks.map((b: { title: string; coefficient: number }) => [
        b.title,
        b.coefficient,
      ]),
    ).toEqual([
      ['Matematika', 3.1],
      ['Ona tili', 2.1],
    ]);
    const row = res.body.data.rows.find((r: { fullName: string }) => r.fullName === 'Oquvchi 1');
    expect(row.blocks).toEqual([
      expect.objectContaining({ earned: 4, max: 6 }),
      expect.objectContaining({ earned: 1, max: 6 }),
    ]);
    expect(row).toMatchObject({ earned: 5, max: 12, essayPending: 1 });
    // esse baholash
    const g = await call(
      'put',
      `/sessions/${s.id}/results/${s.pins['Oquvchi 1']!.key}/essays/${ids.l2}`,
      admin,
      { points: 2.5 },
    );
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.data).toMatchObject({ earned: 7.5, max: 12 });
    const det = await call('get', `/sessions/${s.id}/results/${s.pins['Oquvchi 1']!.key}`, admin);
    expect(det.body.data.blockScores).toEqual([
      expect.objectContaining({ earned: 4, max: 6 }),
      expect.objectContaining({ earned: 3.5, max: 6 }),
    ]);
    expect(
      det.body.data.questions.map((q: { blockId: string }) => q.blockId).filter(Boolean),
    ).toHaveLength(4);
    // tahlil: savollar blok bo'yicha guruhlangan
    const an = await call('get', `/sessions/${s.id}/results/analysis`, admin);
    expect(an.body.data.blocks).toHaveLength(2);
    const order = an.body.data.questions.map((q: { blockId: string }) => q.blockId);
    expect(order[0]).toBe(order[1]);
    expect(order[2]).toBe(order[3]);
    expect(order[0]).not.toBe(order[2]);
    // eksport
    const ex = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=xlsx`)
      .set(bearer(admin))
      .set('X-School-Id', school.id)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(ex.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(ex.body as never);
    const headers: string[] = [];
    wb.worksheets[0]!.eachRow((r) =>
      headers.push(r.values ? (r.values as unknown[]).join('|') : ''),
    );
    expect(headers.join('\n')).toMatch(/Matematika \(maks\. 6\).*Ona tili \(maks\. 6\)/);
    const pdf = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=pdf`)
      .set(bearer(admin))
      .set('X-School-Id', school.id);
    expect(pdf.status).toBe(200);
  });

  it('natijalar tenant izolyatsiyasi: boshqa maktab 404; biriktirilgan o`qituvchi natijalarni ko`ra olmaydi', async () => {
    const s = await scheduled({ mathContrib: [tmathId] });
    const o = request(app).get(`/api/v1/exams/sessions/${s.id}/results`).set(bearer(oadmin));
    expect((await o).status).toBe(404);
    expect((await call('get', `/sessions/${s.id}/results`, tmath)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Telegram: blokka biriktirish va muddat eslatmasi', () => {
  let fake: FakeTelegram;
  async function startBot() {
    fake = new FakeTelegram();
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
      { _id: tmathId },
      { 'telegram.chatId': 222, 'telegram.linkedAt': new Date() },
    );
    await User.updateOne(
      { _id: tlangId },
      { 'telegram.chatId': 333, 'telegram.linkedAt': new Date() },
    );
  }
  const outbox = () => TelegramOutbox.find({ kind: 'examBlock' }).sort({ createdAt: 1 }).lean();

  it('biriktirilganda xabar (escape), dedupe, faqat yangi biriktirilganlarga; tugma o`chiq va bot yo`q bo`lsa yo`q', async () => {
    await startBot();
    const dl = new Date(Date.now() + 3_600_000);
    const r = await call('post', '/sessions', admin, {
      title: 'A & B <i>',
      type: 'quarter',
      classIds: [c7a.id],
      blocks: blocksBody({ mathContrib: [tmathId], mathTarget: 30 }),
      scoringMode: 'coefficient',
      timingMode: 'per_block',
      scheduledStart: startAt().toISOString(),
      contribDeadline: dl.toISOString(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await new Promise((x) => setTimeout(x, 300));
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const bm = r.body.data.blocks[0].id as string;
    expect(rows[0]!.dedupeKey).toBe(`exam:${r.body.data.id}:contrib:${bm}:${tmathId}:assigned`);
    expect(rows[0]!.parseMode).toBe('HTML');
    expect(rows[0]!.text).toContain(
      '«A &amp; B &lt;i&gt;» imtihoni uchun Matematika fanidan savollar tayyorlashga biriktirildingiz',
    );
    expect(rows[0]!.text).toContain('Savollar soni: 30');
    expect(rows[0]!.text).toContain('Muddat:');
    // yangi o'qituvchi biriktiriladi: faqat yangi
    const upd = await call('patch', `/sessions/${r.body.data.id}`, admin, {
      blocks: [
        { ...blocksBody({ mathContrib: [tmathId], mathTarget: 30 })[0], blockId: bm },
        { ...blocksBody({ langContrib: [tlangId] })[1] },
      ],
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    await new Promise((x) => setTimeout(x, 300));
    const rows2 = await outbox();
    expect(rows2.map((x) => String(x.userId)).sort()).toEqual([tmathId, tlangId].sort());
    // takroriy chaqiruv: dedupe
    await notifyBlockAssignments(r.body.data.id, [{ blockId: bm, userIds: [tmathId] }]);
    expect((await outbox()).length).toBe(2);
    // tugma o'chiq
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examReminders: false } },
      rootId,
    );
    await TelegramOutbox.deleteMany({});
    expect(
      await notifyBlockAssignments(r.body.data.id, [{ blockId: bm, userIds: [tmathId] }]),
    ).toBe(0);
    uninstallTelegram();
    expect(
      await notifyBlockAssignments(r.body.data.id, [{ blockId: bm, userIds: [tmathId] }]),
    ).toBe(0);
  });

  it('muddatdan 1 kun oldin: maqsadga yetmagan blok o`qituvchilariga bir marta; oyna tashqarisi, tayyor blok, to`lgan blok va tugma o`chiq: yo`q', async () => {
    await startBot();
    const dl = new Date(Date.now() + 20 * 3_600_000);
    const r = await call('post', '/sessions', admin, {
      title: 'Eslatma',
      type: 'quarter',
      classIds: [c7a.id],
      blocks: blocksBody({
        mathContrib: [tmathId],
        langContrib: [tlangId],
        mathTarget: 5,
        langTarget: 2,
      }),
      timingMode: 'per_block',
      scheduledStart: new Date(Date.now() + 30 * 3_600_000).toISOString(),
      contribDeadline: dl.toISOString(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await new Promise((x) => setTimeout(x, 300));
    await TelegramOutbox.deleteMany({});
    const id = r.body.data.id as string;
    // muddatgacha > 24 soat: yo'q
    at(new Date(dl.getTime() - 26 * 3_600_000));
    expect(await runBlockReminders()).toBe(0);
    // 23 soat qolgan: faqat matematika (2/5), ona tili to'lgan (2/2)
    at(new Date(dl.getTime() - 23 * 3_600_000));
    expect(await runBlockReminders()).toBe(1);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.userId)).toBe(tmathId);
    expect(rows[0]!.dedupeKey).toBe(
      `exam:${id}:contrib:${r.body.data.blocks[0].id}:${tmathId}:reminder`,
    );
    expect(rows[0]!.text).toContain('2/5');
    // takror: dedupe
    at(new Date(dl.getTime() - 2 * 3_600_000));
    await runBlockReminders();
    expect(await TelegramOutbox.countDocuments({ kind: 'examBlock' })).toBe(1);
    // muddatdan keyin yo'q
    await TelegramOutbox.deleteMany({});
    at(new Date(dl.getTime() + 60_000));
    expect(await runBlockReminders()).toBe(0);
    // tayyor blok: yo'q
    at(new Date(dl.getTime() - 5 * 3_600_000));
    await call('post', `/sessions/${id}/blocks/${r.body.data.blocks[0].id}/ready`, admin, {
      ready: true,
    });
    expect(await runBlockReminders()).toBe(0);
    await call('post', `/sessions/${id}/blocks/${r.body.data.blocks[0].id}/ready`, admin, {
      ready: false,
    });
    // tugma o'chiq
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examReminders: false } },
      rootId,
    );
    expect(await runBlockReminders()).toBe(0);
    uninstallTelegram();
    expect(await runBlockReminders()).toBe(0);
    void adminId;
  });
});

describe('"Hozir ochish" muddatidan oldin', () => {
  it('boshlanish hozirga suriladi va o`quvchi darhol kira oladi', async () => {
    const s = await scheduled();
    expect(s.start.getTime()).toBeGreaterThan(Date.now());
    const before = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV,
    });
    expect(before.status).toBe(409);
    expect(before.body.error.message).toContain('hali boshlanmagan');
    const dur = s.doc.durationMin;
    const o = await call('post', `/sessions/${s.id}/open`, admin);
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const doc = (await ExamSession.findById(s.id))!;
    expect(doc.status).toBe('open');
    expect(doc.scheduledStart.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - doc.scheduledStart.getTime()).toBeLessThan(60_000);
    expect(doc.durationMin).toBe(dur);
    await joinStart(s);
  });
});
