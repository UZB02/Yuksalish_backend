/* eslint-disable @typescript-eslint/no-unused-vars -- ba'zi yordamchilar umumiy sarlavhadan keladi */
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
import { Types } from 'mongoose';
import { AuditLog } from '../src/models/AuditLog';
import { ExamJoinGuard } from '../src/models/ExamJoinGuard';
import { SubjectGrade } from '../src/models/SubjectGrade';
import { Student } from '../src/models/Student';
import { runExamReminders } from '../src/modules/telegram/telegram.exams';
import { hashPin } from '../src/modules/exams/sessions/pin';

const closeIt = async (id: string, t = admin) => call('post', `/sessions/${id}/close`, t);

/** Yopilgan, 1 o'quvchi topshirgan imtihon (blokli, umumiy vaqt) */
async function finished(o: BlockOpts = {}, extra: object = {}) {
  const s = await scheduled({ timingMode: 'common', ...o }, { durationMin: 45, ...extra });
  at(mins(s.start, 1));
  const { token } = await joinStart(s);
  await ec('put', '/answers', token, {
    clientSeq: 1,
    answers: [{ qid: ids.m1, value: 'a' }],
  });
  await ec('post', '/submit', token);
  clock.reset();
  expect((await closeIt(s.id)).status).toBe(200);
  return s;
}
const list = (t: string, qs = '') => call('get', `/results${qs}`, t);

describe('Natijalar moduli: ro`yxat', () => {
  it('yopilgan imtihonlar ro`yxati: nom, sana, fan, sinf; ochiq/qoralama yo`q; yopilganda ko`chirma saqlanadi', async () => {
    const s = await finished();
    await mkSession({}, { title: 'Qoralama' });
    const r = await list(admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({
      id: s.id,
      title: 'DTM sinov',
      blocksCount: 2,
      participants: 2,
      submitted: 1,
      examDeleted: false,
    });
    expect(r.body.data[0].subjects.map((x: { name: string }) => x.name).sort()).toEqual([
      'Matematika',
      'Ona tili',
    ]);
    expect(r.body.data[0].classes[0].name).toBe('7-A');
    const doc = (await ExamSession.findById(s.id))!;
    expect(doc.resultsMeta).toMatchObject({ title: 'DTM sinov', scoringMode: 'coefficient' });
    expect(r.body.meta.total).toBe(1);
  });

  it('eski yopilgan sessiya (ko`chirmasiz, blokisiz) ham ro`yxatda: kod jonli ma`lumotdan hisoblaydi (migratsiyasiz)', async () => {
    await makeStudent(school.id, c7a.id, 'Oquvchi 1');
    const created = await call('post', '/sessions', admin, {
      title: 'Eski yopilgan',
      type: 'quarter',
      subjectId: math.id,
      classIds: [c7a.id],
      sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: [ids.m1] }] }],
      scheduledStart: startAt().toISOString(),
      durationMin: 40,
    });
    const id = created.body.data.id as string;
    await call('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] });
    await call('post', `/sessions/${id}/submit`, admin);
    await ExamSession.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      {
        $set: { status: 'closed', codeActive: false },
        $unset: { blocks: '', resultsMeta: '', resultsKept: '', scheduleVersion: '' },
      },
    );
    const r = await list(admin);
    expect(r.body.data.map((x: { title: string }) => x.title)).toEqual(['Eski yopilgan']);
    expect(r.body.data[0].subjects[0].name).toBe('Matematika');
    expect((await call('get', `/sessions/${id}/results`, admin)).status).toBe(200);
  });

  it('filtrlar: sana oralig`i, fan, sinf, nom bo`yicha qidiruv; sahifalash', async () => {
    const a = await finished();
    const d = (await ExamSession.findById(a.id))!;
    const day = d.scheduledStart.toISOString().slice(0, 10);
    expect((await list(admin, `?from=${day}&to=${day}`)).body.data).toHaveLength(1);
    expect((await list(admin, '?from=2001-01-01&to=2001-01-02')).body.data).toHaveLength(0);
    expect((await list(admin, `?subjectId=${math.id}`)).body.data).toHaveLength(1);
    expect(
      (await list(admin, `?subjectId=${new Types.ObjectId().toString()}`)).body.data,
    ).toHaveLength(0);
    expect((await list(admin, `?classId=${c7a.id}`)).body.data).toHaveLength(1);
    expect((await list(admin, '?q=dtm')).body.data).toHaveLength(1);
    expect((await list(admin, '?q=yoq')).body.data).toHaveLength(0);
    expect((await list(admin, '?limit=1&page=2')).body.data).toHaveLength(0);
    expect((await list(admin, '?from=bad')).status).toBe(400);
  });

  it('tenant va ruxsat: boshqa maktab ko`rmaydi; o`qituvchi faqat o`z imtihonini; biriktirilgan (blok) o`qituvchi ko`rmaydi', async () => {
    await finished({ mathContrib: [tmathId] });
    const o = await request(app).get('/api/v1/exams/results').set(bearer(oadmin));
    expect(o.body.data).toEqual([]);
    expect((await list(tmath)).body.data).toEqual([]);
    expect((await list(tfree)).body.data).toEqual([]);
    expect((await list(admin)).body.data).toHaveLength(1);
    expect((await request(app).get('/api/v1/exams/results')).status).toBe(401);
  });
});

describe('O`chirish: tanlov', () => {
  it('qoralama va rejalashtirilgan (urinishsiz) oddiy o`chadi, kod bo`shaydi; ochiq 409; boshqa o`qituvchi 404', async () => {
    const d = await mkSession();
    expect((await call('delete', `/sessions/${d.body.data.id}`, admin)).body.data.mode).toBe(
      'none',
    );
    const s = await scheduled();
    expect((await call('delete', `/sessions/${s.id}`, tmath)).status).toBe(404);
    expect((await call('delete', `/sessions/${s.id}`, admin)).status).toBe(200);
    expect((await ExamSession.findById(s.id))!.codeActive).toBe(false);
    expect((await call('get', `/sessions/${s.id}`, admin)).status).toBe(404);
    const o = await scheduled();
    await call('post', `/sessions/${o.id}/open`, admin);
    expect((await call('delete', `/sessions/${o.id}`, admin)).status).toBe(409);
  });

  it('urinishli imtihon: mode majburiy (400); exam_only: imtihon yashirin, natijalar Natijalar moduli va natija endpointlarida qoladi', async () => {
    const s = await finished();
    expect((await call('delete', `/sessions/${s.id}`, admin)).status).toBe(400);
    const del = await call('delete', `/sessions/${s.id}`, admin, { mode: 'exam_only' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await call('get', `/sessions/${s.id}`, admin)).status).toBe(404);
    expect((await call('get', '/sessions', admin)).body.data).toEqual([]);
    const r = await list(admin);
    expect(r.body.data[0]).toMatchObject({ id: s.id, examDeleted: true, title: 'DTM sinov' });
    const res = await call('get', `/sessions/${s.id}/results`, admin);
    expect(res.status).toBe(200);
    expect(
      res.body.data.rows.find((x: { fullName: string }) => x.fullName === 'Oquvchi 1').blocks,
    ).toHaveLength(2);
    expect((await call('get', `/sessions/${s.id}/results/analysis`, admin)).status).toBe(200);
    const key = s.pins['Oquvchi 1']!.key;
    expect((await call('get', `/sessions/${s.id}/results/${key}`, admin)).status).toBe(200);
    const ex = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=pdf`)
      .set(bearer(admin))
      .set('X-School-Id', school.id);
    expect(ex.status).toBe(200);
    // savol bankdan o'chirilsa ham natija buzilmaydi
    await Question.updateMany({}, { $set: { isDeleted: true } });
    expect((await call('get', `/sessions/${s.id}/results/${key}`, admin)).status).toBe(200);
    const other404 = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results`)
      .set(bearer(oadmin));
    expect(other404.status).toBe(404);
  });

  it('with_results: nom mos kelmasa 400; mos bo`lsa urinishlar, dedupe yozuvlari, kirish hisoblagichlari va sessiya o`chadi; boshqa ma`lumot tegilmaydi; audit qoladi', async () => {
    const keep = await finished();
    const s = await finished();
    await TelegramOutbox.create({
      userId: tmathId,
      chatId: 1,
      kind: 'examResults',
      text: 'x',
      dedupeKey: `exam:${s.id}:closed:${tmathId}`,
    });
    await TelegramOutbox.create({
      userId: tmathId,
      chatId: 1,
      kind: 'examResults',
      text: 'x',
      dedupeKey: `exam:${keep.id}:closed:${tmathId}`,
    });
    await ExamJoinGuard.create({
      key: `dev:${s.code}:device-zzzzzzzz`,
      count: 1,
      windowStart: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const stu = await Student.countDocuments();
    const grade = await SubjectGrade.countDocuments();
    const attemptsKeep = await ExamAttempt.countDocuments({ sessionId: keep.id });
    const bad = await call('delete', `/sessions/${s.id}`, admin, {
      mode: 'with_results',
      confirmTitle: 'dtm sinov',
    });
    expect(bad.status).toBe(400);
    expect(await ExamAttempt.countDocuments({ sessionId: s.id })).toBe(1);
    expect(
      (
        await call('delete', `/sessions/${s.id}`, tmath, {
          mode: 'with_results',
          confirmTitle: 'DTM sinov',
        })
      ).status,
    ).toBe(404);
    const ok = await call('delete', `/sessions/${s.id}`, admin, {
      mode: 'with_results',
      confirmTitle: 'DTM sinov',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await ExamSession.countDocuments({ _id: s.id })).toBe(0);
    expect(await ExamAttempt.countDocuments({ sessionId: s.id })).toBe(0);
    expect(await TelegramOutbox.countDocuments({ dedupeKey: new RegExp(`^exam:${s.id}:`) })).toBe(
      0,
    );
    expect(await ExamJoinGuard.countDocuments({ key: new RegExp(`:${s.code}:`) })).toBe(0);
    expect(await ExamSession.countDocuments({ _id: keep.id })).toBe(1);
    expect(await ExamAttempt.countDocuments({ sessionId: keep.id })).toBe(attemptsKeep);
    expect(
      await TelegramOutbox.countDocuments({ dedupeKey: new RegExp(`^exam:${keep.id}:`) }),
    ).toBe(1);
    expect(await Student.countDocuments()).toBe(stu);
    expect(await SubjectGrade.countDocuments()).toBe(grade);
    expect((await list(admin)).body.data.map((x: { id: string }) => x.id)).toEqual([keep.id]);
    const aud = await AuditLog.findOne({ action: 'exam.session.purge', entityId: s.id });
    expect(aud).toBeTruthy();
    expect(JSON.stringify(aud)).not.toMatch(/Oquvchi 1|Math 1/);
  });
});

describe('Nusxa olib yangi imtihon', () => {
  it('bloklar va sozlamalar ko`chadi; ishtirokchi, PIN, muddat, muzlatilgan savollar ko`chmaydi; o`chirilgan savol ogohlantirish bilan tashlanadi; Telegram nusxada yo`q, yangi muddat saqlanganda yuboriladi', async () => {
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
      { _id: tmathId },
      { 'telegram.chatId': 222, 'telegram.linkedAt': new Date() },
    );
    const dl = new Date(Date.now() + 3_600_000);
    const s = await mkSession({
      mathContrib: [tmathId],
      mathItems: [{ kind: 'manual', questionIds: [ids.m1] }],
      contribDeadline: dl,
    });
    const id = s.body.data.id as string;
    const bm = s.body.data.blocks[0].id as string;
    const mine = await mkQ(tmath, mathTopic.id, single('Ustoz savoli'));
    await call('post', `/my-blocks/${id}/${bm}/questions`, tmath, { questionIds: [mine] });
    await new Promise((x) => setTimeout(x, 300));
    await TelegramOutbox.deleteMany({});
    await Question.updateOne({ _id: ids.m1 }, { $set: { isDeleted: true } });
    const c = await call('post', `/sessions/${id}/copy`, admin);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const d = c.body.data.session;
    expect(d.title).toBe('DTM sinov (nusxa)');
    expect(d.status).toBe('draft');
    expect(d.id).not.toBe(id);
    expect(d).toMatchObject({
      scoringMode: 'coefficient',
      timingMode: 'per_block',
      durationMin: 50,
      participantsCount: 0,
      code: null,
      contribDeadline: null,
    });
    expect(d.blocks).toHaveLength(2);
    expect(d.blocks[0].id).not.toBe(bm);
    expect(d.blocks[0].contributors[0].id).toBe(tmathId);
    expect(d.blocks[0].contribQuestions).toEqual([]);
    expect(d.blocks[0].items).toEqual([{ kind: 'manual', questionIds: [mine] }]);
    expect(c.body.data.warnings.join(' ')).toMatch(/1 ta savol bankdan o'chirilgan/);
    const doc = (await ExamSession.findById(d.id).select('+questionPool'))!;
    expect(doc.questionPool).toHaveLength(0);
    expect(doc.poolFrozenAt).toBeNull();
    expect(doc.approval.status).toBe('none');
    await new Promise((x) => setTimeout(x, 300));
    expect(await TelegramOutbox.countDocuments({ kind: 'examBlock' })).toBe(0);
    const up = await call('patch', `/sessions/${d.id}`, admin, {
      contribDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    await new Promise((x) => setTimeout(x, 300));
    expect(await TelegramOutbox.countDocuments({ kind: 'examBlock', userId: tmathId })).toBe(1);
    uninstallTelegram();
  });

  it('yopilgan imtihondan ham nusxa olinadi (ishtirokchi va natija ko`chmaydi); o`chirilgan imtihon 404; o`qituvchi faqat o`zinikini', async () => {
    const s = await finished();
    const c = await call('post', `/sessions/${s.id}/copy`, admin);
    expect(c.status).toBe(201);
    expect(c.body.data.session.participantsCount).toBe(0);
    expect(await ExamAttempt.countDocuments({ sessionId: c.body.data.session.id })).toBe(0);
    expect((await call('post', `/sessions/${s.id}/copy`, tmath)).status).toBe(404);
    await call('delete', `/sessions/${s.id}`, admin, { mode: 'exam_only' });
    expect((await call('post', `/sessions/${s.id}/copy`, admin)).status).toBe(404);
    const o = await request(app)
      .post(`/api/v1/exams/sessions/${c.body.data.session.id}/copy`)
      .set(bearer(oadmin));
    expect(o.status).toBe(404);
  });

  it('eski (blokisiz) imtihon nusxasi bo`limlar bilan', async () => {
    const created = await call('post', '/sessions', admin, {
      title: 'Eski',
      type: 'quarter',
      subjectId: math.id,
      sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: [ids.m1, ids.m2] }] }],
      scheduledStart: startAt().toISOString(),
      durationMin: 40,
    });
    const c = await call('post', `/sessions/${created.body.data.id}/copy`, admin);
    expect(c.status).toBe(201);
    expect(c.body.data.session.sections[0].items[0].questionIds).toEqual([ids.m1, ids.m2]);
    expect(c.body.data.session.durationMin).toBe(40);
    expect(c.body.data.warnings).toEqual([]);
  });
});

describe('Tahrirlash uchun qaytarish', () => {
  it('rejalashtirilgan -> qoralama: nusxa tozalanadi, ishtirokchilar saqlanadi, barcha PIN yangilanadi (eski PIN kirmaydi), qayta rejalashtirish', async () => {
    const s = await scheduled();
    const oldPin = s.pins['Oquvchi 1']!.pin;
    const before = (await ExamSession.findById(s.id))!;
    expect((await call('post', `/sessions/${s.id}/return-to-draft`, tmath)).status).toBe(404);
    const r = await call('post', `/sessions/${s.id}/return-to-draft`, admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'draft', code: null, participantsCount: 2 });
    const d = (await ExamSession.findById(s.id).select('+questionPool'))!;
    expect(d.questionPool).toHaveLength(0);
    expect(d.poolFrozenAt).toBeNull();
    expect(d.codeActive).toBe(false);
    expect(d.scheduleVersion).toBe(1);
    expect(d.participants.every((p, i) => p.pinHash !== before.participants[i]!.pinHash)).toBe(
      true,
    );
    expect(hashPin(d.pinSalt, oldPin)).not.toBe(d.participants[0]!.pinHash);
    const j = await ec('post', '/join', null, { code: s.code, pin: oldPin, deviceId: DEV });
    expect(j.status).toBe(401);
    expect((await call('get', `/sessions/${s.id}/pin-sheet`, admin)).status).toBe(409);
    const sub = await call('post', `/sessions/${s.id}/submit`, admin, { confirmShort: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const re = (await ExamSession.findById(s.id).select('+questionPool'))!;
    expect(re.status).toBe('scheduled');
    expect(re.questionPool.length).toBe(4);
    const newPin = decryptPin(re.participants[0]!.pinEnc, s.id)!;
    expect(newPin).not.toBe(oldPin);
    expect(
      (await ec('post', '/join', null, { code: re.code, pin: oldPin, deviceId: DEV })).status,
    ).toBe(401);
    at(mins(re.scheduledStart, 1));
    expect(
      (await ec('post', '/join', null, { code: re.code, pin: newPin, deviceId: DEV })).status,
    ).toBe(200);
  });

  it('urinish bor bo`lsa qaytarib bo`lmaydi (409), holat o`zgarmaydi; poyga izchil; qoralama 409', async () => {
    const s = await scheduled();
    at(mins(s.start, 1));
    await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV,
    });
    clock.reset();
    const r = await call('post', `/sessions/${s.id}/return-to-draft`, admin);
    expect(r.status).toBe(409);
    const d = (await ExamSession.findById(s.id))!;
    expect(['scheduled', 'open']).toContain(d.status);
    expect(d.codeActive).toBe(true);
    expect(d.scheduleVersion).toBe(0);
    const s2 = await scheduled();
    at(mins(s2.start, 1));
    const [a, b] = await Promise.all([
      ec('post', '/join', null, {
        code: s2.code,
        pin: s2.pins['Oquvchi 2']!.pin,
        deviceId: 'device-bbbbbbbb',
      }),
      call('post', `/sessions/${s2.id}/return-to-draft`, admin),
    ]);
    clock.reset();
    const st = (await ExamSession.findById(s2.id))!;
    if (b.status === 200) {
      expect(st.status).toBe('draft');
      if (a.status === 200) {
        const t = a.body.data.token as string;
        expect((await ec('post', '/start', t)).status).toBe(409);
      }
    } else {
      expect(b.status).toBe(409);
      expect(['scheduled', 'open']).toContain(st.status);
      expect(st.codeActive).toBe(true);
    }
    const dr = await mkSession();
    expect((await call('post', `/sessions/${dr.body.data.id}/return-to-draft`, admin)).status).toBe(
      409,
    );
  });

  it('eslatma: qaytarilib qayta rejalashtirilgan imtihon yangi eslatma oladi; qaytarilmaganda eski kalit formati', async () => {
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
    const s = await scheduled();
    at(mins(s.start, -29));
    expect(await runExamReminders()).toBeGreaterThan(0);
    const rows = await TelegramOutbox.find({ kind: 'examReminder' }).lean();
    expect(rows[0]!.dedupeKey).toBe(`exam:${s.id}:reminder:${adminId}`);
    await runExamReminders();
    expect(await TelegramOutbox.countDocuments({ kind: 'examReminder' })).toBe(rows.length);
    clock.reset();
    expect((await call('post', `/sessions/${s.id}/return-to-draft`, admin)).status).toBe(200);
    expect(
      (await call('post', `/sessions/${s.id}/submit`, admin, { confirmShort: true })).status,
    ).toBe(200);
    at(mins(s.start, -28));
    expect(await runExamReminders()).toBeGreaterThan(0);
    const after = await TelegramOutbox.find({ kind: 'examReminder' }).lean();
    expect(after.length).toBe(rows.length * 2);
    expect(after.some((r) => r.dedupeKey === `exam:${s.id}:reminder:v1:${adminId}`)).toBe(true);
    uninstallTelegram();
  });
});

describe('Ishtirokchi tafsiloti: blok ballari o`sha ishtirokchiniki', () => {
  it('ro`yxatda birinchi bo`lmagan ishtirokchi topshirganda ham blockScores va percent to`g`ri (vizual tekshiruvda topilgan xato)', async () => {
    const s = await scheduled({ timingMode: 'common' }, { durationMin: 45 });
    at(mins(s.start, 1));
    const { token } = await joinStart(s, 'Oquvchi 2');
    await ec('put', '/answers', token, { clientSeq: 1, answers: [{ qid: ids.m1, value: 'a' }] });
    await ec('post', '/submit', token);
    clock.reset();
    await closeIt(s.id);
    const d = await call('get', `/sessions/${s.id}/results/${s.pins['Oquvchi 2']!.key}`, admin);
    expect(d.status).toBe(200);
    expect(d.body.data.blockScores).toHaveLength(2);
    expect(d.body.data.blockScores[0].max).toBeGreaterThan(0);
    expect(d.body.data.percent).not.toBeNull();
  });
});
