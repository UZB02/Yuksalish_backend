import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ExamAttempt } from '../src/models/ExamAttempt';
import { ExamSession } from '../src/models/ExamSession';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { autoCloseSessions, runExamSweeper } from '../src/modules/exam-client/exam-client.sweeper';
import { decryptPin } from '../src/modules/exams/sessions/pin';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import {
  buildExamClosedMessage,
  notifyExamClosed,
  runExamReminders,
} from '../src/modules/telegram/telegram.exams';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { settingsStore } from '../src/modules/settings/settings.store';
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
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let math: Doc;
let rootId: string;
let admin: string, adminNoPerm: string, oadmin: string, tm: string, tm2: string;
let tmId: string, adminId: string;
let topic: Doc;
let c7a: Doc;
const DEV = (n: number) => `device-${String(n).padStart(8, '0')}`;

const adm = (m: 'get' | 'post' | 'put', url: string, t: string, body?: object) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', school.id);
  return body ? r.send(body) : r;
};
const ec = (m: 'get' | 'post' | 'put', url: string, token: string | null, body?: object) => {
  let r = request(app)[m](`/api/v1/exam-client${url}`);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const text = (t: string) => [{ type: 'text', text: t }];
const mkQ = async (extra: Record<string, unknown>) => {
  const r = await adm('post', '/questions', admin, {
    topicId: topic.id,
    status: 'active',
    sharing: { mode: 'subject' },
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
};

interface S {
  id: string;
  code: string;
  start: Date;
  pins: Record<string, { pin: string; key: string }>;
  q: { single: string; multi: string; essay: string };
}
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const at = (d: Date) => clock.set(() => d);

async function setup(
  opts: {
    mode?: string;
    students?: number;
    extra?: object;
    supervisors?: string[];
    passPercent?: number;
  } = {},
): Promise<S> {
  const q = {
    single: await mkQ({
      type: 'single',
      content: text('Bitta'),
      options: [
        { id: 'a', content: text('A') },
        { id: 'b', content: text('B') },
        { id: 'c', content: text('C') },
      ],
      answer: { optionId: 'b' },
      points: 2,
    }),
    multi: await mkQ({
      type: 'multi',
      content: text('Ko`p'),
      options: [
        { id: 'a', content: text('A') },
        { id: 'b', content: text('B') },
        { id: 'c', content: text('C') },
      ],
      answer: { optionIds: ['a', 'b'], partialCredit: false },
      points: 2,
    }),
    essay: await mkQ({
      type: 'essay',
      content: text('Esse savoli'),
      answer: { rubric: 'Mezon matni' },
      points: 5,
    }),
  };
  for (let i = 0; i < (opts.students ?? 3); i++)
    await makeStudent(school.id, c7a.id, `Oquvchi ${i + 1}`);
  const start = new Date(Date.now() + 3_600_000);
  const created = await adm('post', '/sessions', admin, {
    title: 'Natija imtihoni',
    type: 'quarter',
    subjectId: math.id,
    classIds: [c7a.id],
    sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: Object.values(q) }] }],
    scheduledStart: start.toISOString(),
    durationMin: 40,
    resultsMode: opts.mode ?? 'score',
    supervisorIds: opts.supervisors ?? [],
    ...(opts.passPercent ? { passPercent: opts.passPercent } : {}),
    shuffleQuestions: false,
    shuffleOptions: false,
    ...opts.extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  await adm('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] });
  const sub = await adm('post', `/sessions/${id}/submit`, admin);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const doc = (await ExamSession.findById(id))!;
  const pins: S['pins'] = {};
  for (const p of doc.participants)
    pins[p.fullName] = { pin: decryptPin(p.pinEnc, id)!, key: p.key };
  return { id, code: doc.code!, start, pins, q };
}

async function joinStart(s: S, name: string, dev = 1) {
  const j = await ec('post', '/join', null, {
    code: s.code,
    pin: s.pins[name]!.pin,
    deviceId: DEV(dev),
  });
  expect(j.status, JSON.stringify(j.body)).toBe(200);
  const token = j.body.data.token as string;
  const st = await ec('post', '/start', token);
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return token;
}
const answer = (token: string, seq: number, answers: object[]) =>
  ec('put', '/answers', token, { clientSeq: seq, answers });

/** Oquvchi 1: hammasi to'g'ri + esse; Oquvchi 2: faqat single; Oquvchi 3: kirmagan */
async function runExam(s: S) {
  at(mins(s.start, 2));
  const t1 = await joinStart(s, 'Oquvchi 1', 1);
  await answer(t1, 1, [
    { qid: s.q.single, value: 'b' },
    { qid: s.q.multi, value: ['a', 'b'] },
    { qid: s.q.essay, value: '=HYPERLINK("http://x","bos")  Katta esse' },
  ]);
  await ec('post', '/submit', t1);
  const t2 = await joinStart(s, 'Oquvchi 2', 2);
  await answer(t2, 1, [
    { qid: s.q.single, value: 'b' },
    { qid: s.q.multi, value: ['a'] },
    { qid: s.q.essay, value: 'qisqa' },
  ]);
  await ec('post', '/submit', t2);
  return { t1, t2 };
}

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  rootId = rootU.id;
  const t1 = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tmId = t1.id;
  const t2 = await makeUser({ username: 'tmath2', role: 'teacher', schoolId: school.id });
  const a = await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['exams.manage'],
  });
  adminId = a.id;
  await makeUser({
    username: 'adminnp',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [],
  });
  await makeUser({
    username: 'oadmin',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['exams.manage'],
  });
  c7a = (await makeClass(school.id, year.id, '7-A')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, t1.id);
  await assignSubject(school.id, c7a as never, math.id, t2.id);
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  admin = (await login('admin')).token;
  adminNoPerm = (await login('adminnp')).token;
  oadmin = (await login('oadmin')).token;
  tm = (await login('tmath')).token;
  tm2 = (await login('tmath2')).token;
  topic = (await adm('post', `/subjects/${math.id}/topics`, admin, { name: 'Kasrlar' })).body
    .data as Doc;
});

describe('A1: avtomatik yopish', () => {
  it('umumiy tugash o`tdi va jarayonda urinish yo`q -> closed (kod bo`shaydi, audit); idempotent; oldin yopilmaydi', async () => {
    const s = await setup();
    at(mins(s.start, 2));
    const t1 = await joinStart(s, 'Oquvchi 1');
    await answer(t1, 1, [{ qid: s.q.single, value: 'b' }]);
    at(mins(s.start, 30));
    expect(await runExamSweeper()).toBe(0);
    expect((await ExamSession.findById(s.id))!.status).toBe('open');
    at(mins(s.start, 41)); // grace dan keyin: urinish avtomatik topshiriladi va sessiya yopiladi
    expect(await runExamSweeper()).toBe(1);
    const doc = (await ExamSession.findById(s.id))!;
    expect(doc.status).toBe('closed');
    expect(doc.codeActive).toBe(false);
    expect(doc.closedAt).not.toBeNull();
    const log = await AuditLog.findOne({ action: 'exam.session.auto_close' });
    expect(log?.userId).toBeNull();
    expect(await autoCloseSessions(clock.now())).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'exam.session.auto_close' })).toBe(1);
  });

  it('to`liq vaqt berilgan hali kirmagan ishtirokchi oynasi tugaguncha ochiq turadi; davom etayotgan urinish ham ushlab turadi', async () => {
    const s = await setup();
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 2']!.key },
      { $set: { 'participants.$.fullTimeGranted': true } },
    );
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'open' } });
    at(mins(s.start, 41));
    expect(await autoCloseSessions(clock.now())).toBe(0); // grant bor, oyna: 40 + 40 daqiqa
    at(mins(s.start, 81));
    expect(await autoCloseSessions(clock.now())).toBe(1);
    // to'liq vaqtli urinish deadline i umumiy tugashdan keyin
    const s2 = await setup();
    await ExamSession.updateOne(
      { _id: s2.id, 'participants.key': s2.pins['Oquvchi 1']!.key },
      { $set: { 'participants.$.fullTimeGranted': true } },
    );
    at(mins(s2.start, 30));
    const t = await joinStart(s2, 'Oquvchi 1');
    expect(t).toBeTruthy();
    at(mins(s2.start, 45)); // umumiy tugash o'tgan, lekin urinish deadline i 30+40=70
    await runExamSweeper();
    expect((await ExamSession.findById(s2.id))!.status).toBe('open');
    at(mins(s2.start, 71));
    await runExamSweeper();
    expect((await ExamSession.findById(s2.id))!.status).toBe('closed');
  });

  it('"timeUp" belgisi: umumiy vaqt o`tgan ochiq imtihonda DTO da true', async () => {
    const s = await setup();
    at(mins(s.start, 2));
    await joinStart(s, 'Oquvchi 1');
    expect((await adm('get', `/sessions/${s.id}`, admin)).body.data.timeUp).toBe(false);
    clock.reset();
    await ExamSession.updateOne(
      { _id: s.id },
      { $set: { scheduledStart: new Date(Date.now() - 50 * 60_000) } },
    );
    const d = await adm('get', `/sessions/${s.id}`, admin);
    expect(d.body.data).toMatchObject({ status: 'open', timeUp: true });
  });
});

describe('A2: qayta ochish', () => {
  async function closed() {
    const s = await setup();
    const tokens = await runExam(s);
    expect((await adm('post', `/sessions/${s.id}/close`, admin)).status).toBe(200);
    return { s, tokens };
  }
  it('sabab va kelajakdagi yangi tugash majburiy; faqat closed; cancelled mumkin emas', async () => {
    const { s } = await closed();
    clock.reset();
    const future = new Date(Date.now() + 2 * 3_600_000 + 3_600_000).toISOString();
    for (const b of [
      {},
      { reason: 'x' },
      { newEnd: future },
      { reason: 'x', newEnd: new Date(Date.now() - 1000).toISOString() },
      { reason: 'x', newEnd: 'abc' },
    ]) {
      expect(
        (await adm('post', `/sessions/${s.id}/reopen`, admin, b)).status,
        JSON.stringify(b),
      ).toBe(400);
    }
    const s2 = await setup();
    expect(
      (await adm('post', `/sessions/${s2.id}/reopen`, admin, { reason: 'x', newEnd: future }))
        .status,
    ).toBe(409); // open
    await adm('post', `/sessions/${s2.id}/cancel`, admin, { reason: 'x' });
    expect(
      (await adm('post', `/sessions/${s2.id}/reopen`, admin, { reason: 'x', newEnd: future }))
        .status,
    ).toBe(409);
    expect(
      (await adm('post', `/sessions/${s.id}/reopen`, tm2, { reason: 'x', newEnd: future })).status,
    ).toBe(404); // ko'rmaydi
  });

  it('ochiladi: kod qayta faol, topshirganlar qayta kira olmaydi, yangi ishtirokchi yangi tugashgacha kiradi; audit sabab bilan', async () => {
    const { s } = await closed();
    clock.reset();
    const newEnd = new Date(Date.now() + 90 * 60_000);
    // eski vaqt (boshlanish 1 soat keyin edi): reopen uchun boshlanish o'tgan bo'lishi kerak
    await ExamSession.updateOne(
      { _id: s.id },
      { $set: { scheduledStart: new Date(Date.now() - 60 * 60_000) } },
    );
    const r = await adm('post', `/sessions/${s.id}/reopen`, admin, {
      reason: 'Internet uzilgan edi',
      newEnd: newEnd.toISOString(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'open', code: s.code, codeChanged: false });
    expect(new Date(r.body.data.endsAt).getTime()).toBeGreaterThanOrEqual(newEnd.getTime());
    expect(new Date(r.body.data.endsAt).getTime()).toBeLessThan(newEnd.getTime() + 60_000);
    // topshirgan: urinish holati submitted, qayta start yo'q
    const j1 = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV(1),
    });
    expect(j1.body.data.attemptStatus).toBe('submitted');
    expect((await ec('post', '/start', j1.body.data.token)).status).toBe(409);
    // kirmagan ishtirokchi kiradi
    const j3 = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 3']!.pin,
      deviceId: DEV(3),
    });
    expect(j3.status).toBe(200);
    expect((await ec('post', '/start', j3.body.data.token)).status).toBe(200);
    const log = await AuditLog.findOne({ action: 'exam.session.reopen' });
    expect(log?.after).toMatchObject({
      reason: 'Internet uzilgan edi',
      status: 'open',
      codeChanged: false,
    });
  });

  it('eski kod boshqa faol imtihonda band bo`lsa yangi kod beriladi', async () => {
    const { s } = await closed();
    clock.reset();
    await ExamSession.updateOne(
      { _id: s.id },
      { $set: { scheduledStart: new Date(Date.now() - 60 * 60_000) } },
    );
    const b = await setup();
    await ExamSession.updateOne({ _id: b.id }, { $set: { code: s.code } }); // B shu kodni egalladi
    const r = await adm('post', `/sessions/${s.id}/reopen`, admin, {
      reason: 'Kod to`qnashuvi',
      newEnd: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.codeChanged).toBe(true);
    expect(r.body.data.code).not.toBe(s.code);
    expect(r.body.data.code).toMatch(/^\d{6}$/);
    expect((await ExamSession.findById(b.id))!.code).toBe(s.code);
  });

  it('jarayondagi urinish deadline i yangi tugashga ko`chadi', async () => {
    const s = await setup();
    at(mins(s.start, 2));
    const t = await joinStart(s, 'Oquvchi 1');
    await answer(t, 1, [{ qid: s.q.single, value: 'a' }]);
    await adm('post', `/sessions/${s.id}/close`, admin);
    clock.reset();
    await ExamSession.updateOne(
      { _id: s.id },
      { $set: { scheduledStart: new Date(Date.now() - 60 * 60_000) } },
    );
    const newEnd = new Date(Date.now() + 2 * 3_600_000);
    await adm('post', `/sessions/${s.id}/reopen`, admin, {
      reason: 'x',
      newEnd: newEnd.toISOString(),
    });
    const a = (await ExamAttempt.findOne({ sessionId: s.id }))!;
    expect(Math.abs(a.deadline!.getTime() - newEnd.getTime())).toBeLessThan(60_000);
  });
});

describe('A3: hammaga vaqt qo`shish', () => {
  it('+N: davomiylik va davom etayotgan deadline lar (to`liq vaqtlilar ham); tekshiruvlar; audit', async () => {
    const s = await setup();
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 2']!.key },
      { $set: { 'participants.$.fullTimeGranted': true } },
    );
    at(mins(s.start, 5));
    const t1 = await joinStart(s, 'Oquvchi 1', 1);
    const t2 = await joinStart(s, 'Oquvchi 2', 2);
    expect(t1 && t2).toBeTruthy();
    const before = await ExamAttempt.find({ sessionId: s.id }).lean();
    const dl = (key: string, list: typeof before) =>
      list.find((a) => a.participantKey === key)!.deadline!.getTime();
    const k1 = s.pins['Oquvchi 1']!.key;
    const k2 = s.pins['Oquvchi 2']!.key;
    expect((await adm('post', `/sessions/${s.id}/extend`, admin, { minutes: 0 })).status).toBe(400);
    expect((await adm('post', `/sessions/${s.id}/extend`, admin, { minutes: 181 })).status).toBe(
      400,
    );
    expect((await adm('post', `/sessions/${s.id}/extend`, tm2, { minutes: 10 })).status).toBe(404);
    const r = await adm('post', `/sessions/${s.id}/extend`, admin, {
      minutes: 15,
      reason: 'Texnik nosozlik',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.durationMin).toBe(55);
    const after = await ExamAttempt.find({ sessionId: s.id }).lean();
    expect(dl(k1, after) - dl(k1, before)).toBe(15 * 60_000);
    expect(dl(k2, after) - dl(k2, before)).toBe(15 * 60_000);
    const log = await AuditLog.findOne({ action: 'exam.session.extend' });
    expect(log?.after).toMatchObject({ minutes: 15, durationMin: 55, reason: 'Texnik nosozlik' });
    await adm('post', `/sessions/${s.id}/close`, admin);
    expect((await adm('post', `/sessions/${s.id}/extend`, admin, { minutes: 5 })).status).toBe(409);
  });
});

describe('A4: kirish xabari', () => {
  it('oyna tugagach faqat to`g`ri kod+PIN jufti vaqtni ko`radi; noto`g`ri juftda umumiy xato', async () => {
    const s = await setup();
    at(mins(s.start, 45));
    const ok = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV(1),
    });
    expect(ok.status).toBe(409);
    const end = new Date(s.start.getTime() + 40 * 60_000);
    const hh = new Date(end.getTime() + 5 * 3_600_000).toISOString().slice(11, 16);
    expect(ok.body.error.message).toBe(`Imtihon ${hh} da tugagan. Nazoratchiga murojaat qiling.`);
    const bad = await ec('post', '/join', null, { code: s.code, pin: 'ZZZZZZ', deviceId: DEV(1) });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe("Kod yoki PIN noto'g'ri");
    expect(JSON.stringify(bad.body)).not.toContain(hh);
  });
});

describe('E6: natijalar', () => {
  it('ro`yxat: o`rinlar (teng ballar bir xil o`rin), tartib, holatlar, summary, passPercent', async () => {
    const s = await setup({ passPercent: 50 });
    await runExam(s);
    const r = await adm('get', `/sessions/${s.id}/results`, admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.data.rows as {
      fullName: string;
      rank: number | null;
      percent: number | null;
      status: string;
      essayPending: number;
      passed: boolean | null;
    }[];
    // Oquvchi 1: 4/9 (esse kutilmoqda) = 44.4; Oquvchi 2: 2/9 = 22.2
    expect(rows.map((x) => x.fullName)).toEqual(['Oquvchi 1', 'Oquvchi 2', 'Oquvchi 3']);
    expect(rows.map((x) => x.rank)).toEqual([1, 2, null]);
    expect(rows[0]).toMatchObject({
      status: 'submitted',
      percent: 44.4,
      essayPending: 1,
      passed: false,
    });
    expect(rows[2]).toMatchObject({ status: 'not_started', percent: null });
    expect(r.body.data.summary).toMatchObject({
      participants: 3,
      submitted: 2,
      averagePercent: 33.3,
      maxPercent: 44.4,
      minPercent: 22.2,
      passPercent: 50,
      passRate: 0,
      essayPending: 2,
    });
    // teng ballar: Oquvchi 2 ni ham 44.4 ga tenglashtirish
    await ExamAttempt.updateOne(
      { participantKey: s.pins['Oquvchi 2']!.key },
      { $set: { 'score.earned': 4 } },
    );
    const t = await adm('get', `/sessions/${s.id}/results`, admin);
    expect(t.body.data.rows.map((x: { rank: number | null }) => x.rank)).toEqual([1, 1, null]);
  });

  it('ruxsatlar: yaratuvchi o`qituvchi ko`radi; boshqa o`qituvchi 404; nazoratchi ko`radi; exams.results/manage siz ma`muriyat 403; boshqa maktab 404; boshlanmagan 409', async () => {
    const s = await setup();
    at(mins(s.start, 2));
    await joinStart(s, 'Oquvchi 1');
    expect((await adm('get', `/sessions/${s.id}/results`, tm)).status).toBe(404); // admin yaratgan, tm yaratuvchi emas
    expect((await adm('get', `/sessions/${s.id}/results`, adminNoPerm)).status).toBe(403);
    expect(
      (await request(app).get(`/api/v1/exams/sessions/${s.id}/results`).set(bearer(oadmin))).status,
    ).toBe(404);
    expect((await adm('get', `/sessions/${s.id}/results`, admin)).status).toBe(200);
    await adm('patch' as never, `/sessions/${s.id}`, admin, {}).catch(() => undefined);
    await ExamSession.updateOne({ _id: s.id }, { $addToSet: { supervisorIds: tmId } });
    expect((await adm('get', `/sessions/${s.id}/results`, tm)).status).toBe(200);
    expect((await adm('get', `/sessions/${s.id}/results`, tm2)).status).toBe(404);
    const d = await adm('get', `/sessions/${s.id}`, tm);
    expect(d.body.data.canViewResults).toBe(true);
    const sched = await setup();
    await ExamSession.updateOne({ _id: sched.id }, { $set: { status: 'scheduled' } });
    expect((await adm('get', `/sessions/${sched.id}/results`, admin)).status).toBe(409);
  });

  it('tafsilot: javoblar, to`g`ri javob, ball, esse matni va mezon; esse baholash umumiy ballni qayta hisoblaydi, ruxsatlar va validatsiya, audit', async () => {
    const s = await setup({ supervisors: [] });
    await runExam(s);
    const key = s.pins['Oquvchi 1']!.key;
    const d = await adm('get', `/sessions/${s.id}/results/${key}`, admin);
    expect(d.status).toBe(200);
    const qs = d.body.data.questions as {
      id: string;
      type: string;
      given: unknown;
      got: number | null;
      correct: Record<string, unknown>;
      graded: boolean | null;
    }[];
    expect(qs).toHaveLength(3);
    const essay = qs.find((x) => x.type === 'essay')!;
    expect(essay.given).toContain('HYPERLINK');
    expect(essay.correct).toEqual({ rubric: 'Mezon matni' });
    expect(essay.graded).toBe(false);
    expect(qs.find((x) => x.type === 'single')!.correct).toEqual({ optionIds: ['b'] });
    // baholash
    const url = `/sessions/${s.id}/results/${key}/essays/${s.q.essay}`;
    const put = (t: string, body: object) =>
      request(app)
        .put(`/api/v1/exams${url}`)
        .set(bearer(t))
        .set('X-School-Id', school.id)
        .send(body);
    expect((await put(admin, { points: 5.3 })).status).toBe(400);
    expect((await put(admin, { points: 6 })).status).toBe(400);
    expect((await put(admin, { points: -1 })).status).toBe(400);
    expect((await put(tm2, { points: 3 })).status).toBe(404);
    expect((await put(adminNoPerm, { points: 3 })).status).toBe(403);
    const ok = await put(admin, { points: 3.5, comment: 'Yaxshi, lekin to`liq emas' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ earned: 7.5, max: 9, essayPending: 0 });
    const list = await adm('get', `/sessions/${s.id}/results`, admin);
    const r1 = list.body.data.rows.find((x: { key: string }) => x.key === key);
    expect(r1).toMatchObject({ earned: 7.5, percent: 83.3, essayPending: 0 });
    const d2 = await adm('get', `/sessions/${s.id}/results/${key}`, admin);
    const e2 = d2.body.data.questions.find((x: { type: string }) => x.type === 'essay');
    expect(e2.grade).toMatchObject({ points: 3.5, comment: 'Yaxshi, lekin to`liq emas' });
    expect(e2.graded).toBe(true);
    // qayta baholash almashtiradi (massivda bitta yozuv)
    await put(admin, { points: 5 });
    expect((await ExamAttempt.findOne({ participantKey: key }))!.manual).toHaveLength(1);
    expect((await ExamAttempt.findOne({ participantKey: key }))!.score).toMatchObject({
      earned: 9,
    });
    const logs = JSON.stringify(await AuditLog.find({ action: 'exam.attempt.grade' }).lean());
    expect(logs).toContain('earned');
    expect(logs).not.toContain('HYPERLINK');
    expect(logs).not.toContain('To`liq');
    // nazoratchi o'qituvchi baholay oladi
    await ExamSession.updateOne({ _id: s.id }, { $addToSet: { supervisorIds: tmId } });
    expect((await put(tm, { points: 1 })).status).toBe(200);
    // kirmagan ishtirokchi: urinish yo'q
    const none = await adm('get', `/sessions/${s.id}/results/${s.pins['Oquvchi 3']!.key}`, admin);
    expect(none.body.data.status).toBe('not_started');
  });

  it('e`lon qilish: faqat after_publish; esse kutilsa tasdiq kerak; o`quvchi /result e`londan keyin ball ko`radi, qaytarib olinadi', async () => {
    const s = await setup({ mode: 'after_publish' });
    const { t1 } = await runExam(s);
    expect((await ec('get', '/result', t1)).body.data).toMatchObject({
      available: false,
      mode: 'after_publish',
    });
    const pub = (body: object) => adm('post', `/sessions/${s.id}/results/publish`, admin, body);
    const pending = await pub({ published: true });
    expect(pending.status).toBe(409);
    expect(pending.body.error.message).toMatch(/2 ta esse/);
    expect((await pub({ published: true, confirmPending: true })).status).toBe(200);
    const after = await ec('get', '/result', t1);
    expect(after.body.data).toMatchObject({ available: true });
    expect(after.body.data.score).toMatchObject({ earned: 4, max: 9 });
    expect(after.body.data.review).toBeUndefined();
    expect((await pub({ published: false })).status).toBe(200);
    expect((await ec('get', '/result', t1)).body.data.available).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'exam.session.publish' })).toBe(2);
    const imm = await setup({ mode: 'score' });
    expect(
      (await adm('post', `/sessions/${imm.id}/results/publish`, admin, { published: true })).status,
    ).toBe(409);
  });

  it('esse baholangach o`quvchi natijasi yangilanadi (score rejimi)', async () => {
    const s = await setup({ mode: 'score' });
    const { t1 } = await runExam(s);
    expect((await ec('get', '/result', t1)).body.data.score).toMatchObject({
      earned: 4,
      essayPending: 1,
    });
    await request(app)
      .put(`/api/v1/exams/sessions/${s.id}/results/${s.pins['Oquvchi 1']!.key}/essays/${s.q.essay}`)
      .set(bearer(admin))
      .set('X-School-Id', school.id)
      .send({ points: 4 });
    expect((await ec('get', '/result', t1)).body.data.score).toMatchObject({
      earned: 8,
      essayPending: 0,
    });
  });

  it('savollar tahlili: ko`rsatilgan, % to`g`ri, o`rtacha ball, variantlar taqsimoti, belgilar', async () => {
    const s = await setup({ students: 4 });
    at(mins(s.start, 2));
    // 4 o'quvchi: single: 3 ta 'b' (to'g'ri) 1 ta 'a'; multi: hammasi ['a','c']? (xato) ; esse yozilgan
    for (let i = 1; i <= 4; i++) {
      const t = await joinStart(s, `Oquvchi ${i}`, i);
      await answer(t, 1, [
        { qid: s.q.single, value: i === 4 ? 'a' : 'b' },
        { qid: s.q.multi, value: ['a', 'c'] },
        { qid: s.q.essay, value: 'esse' },
      ]);
      await ec('post', '/submit', t);
    }
    const r = await adm('get', `/sessions/${s.id}/results/analysis`, admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const q = r.body.data.questions as {
      id: string;
      shown: number;
      correctPercent: number | null;
      averagePoints: number | null;
      options: { id: string; chosen: number; percent: number; correct: boolean }[];
      flags: string[];
    }[];
    const single = q.find((x) => x.id === s.q.single)!;
    expect(single).toMatchObject({ shown: 4, correctPercent: 75, averagePoints: 1.5 });
    expect(single.options.find((o) => o.id === 'b')).toMatchObject({
      chosen: 3,
      percent: 75,
      correct: true,
    });
    expect(single.options.find((o) => o.id === 'a')).toMatchObject({ chosen: 1, correct: false });
    expect(single.flags).toEqual([]);
    const multi = q.find((x) => x.id === s.q.multi)!;
    expect(multi).toMatchObject({ correctPercent: 0, averagePoints: 0 });
    expect(multi.flags).toContain('too_hard');
    expect(multi.options.find((o) => o.id === 'c')).toMatchObject({
      chosen: 4,
      percent: 100,
      correct: false,
    });
    expect(multi.flags).toContain('distractor');
    const essay = q.find((x) => x.id === s.q.essay)!;
    expect(essay).toMatchObject({ shown: 4, correctPercent: null, averagePoints: null });
  });
});

describe('E6: eksport', () => {
  it('Excel: content-type, 3 varaq, formula injeksiyasi apostrof bilan, telefon yo`q; PDF: %PDF', async () => {
    const s = await setup();
    await runExam(s);
    // mehmon "=cmd" ismi bilan (ishonchsiz matn)
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 3']!.key },
      { $set: { 'participants.$.fullName': '=SUM(1+1)', 'participants.$.className': '@x' } },
    );
    const res = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=xlsx`)
      .set(bearer(admin))
      .set('X-School-Id', school.id)
      .buffer(true)
      .parse((r, cb) => {
        const c: Buffer[] = [];
        r.on('data', (x: Buffer) => c.push(x));
        r.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Natijalar',
      'Savollar matritsasi',
      'Savollar',
    ]);
    const all: string[] = [];
    wb.eachSheet((w) => w.eachRow((row) => row.eachCell((c) => all.push(String(c.value ?? '')))));
    const joined = all.join('|');
    expect(joined).toContain("'=SUM(1+1)");
    expect(joined).toContain("'@x");
    expect(
      all.some(
        (x) => /^[=+\-@]/.test(x) && !x.startsWith("'") && x.length > 2 && /[A-Za-z(]/.test(x),
      ),
    ).toBe(false);
    expect(joined).not.toMatch(/998\d{9}|telefon/i);
    expect(joined).toContain('Oquvchi 1');
    const pdf = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=pdf`)
      .set(bearer(admin))
      .set('X-School-Id', school.id)
      .buffer(true)
      .parse((r, cb) => {
        const c: Buffer[] = [];
        r.on('data', (x: Buffer) => c.push(x));
        r.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await AuditLog.countDocuments({ action: 'exam.session.export' })).toBe(2);
    expect(
      (
        await request(app)
          .get(`/api/v1/exams/sessions/${s.id}/results/export?format=csv`)
          .set(bearer(admin))
          .set('X-School-Id', school.id)
      ).status,
    ).toBe(400);
    expect(
      (await adm('get', `/sessions/${s.id}/results/export?format=xlsx`, adminNoPerm)).status,
    ).toBe(403);
  });
});

describe('E6: Telegram', () => {
  let fake: FakeTelegram;
  let leadId: string;
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
    leadId = adminId;
    await User.updateOne(
      { _id: adminId },
      { 'telegram.chatId': 111, 'telegram.linkedAt': new Date(), 'telegram.reportScope': 'all' },
    );
    await User.updateOne(
      { _id: tmId },
      { 'telegram.chatId': 222, 'telegram.linkedAt': new Date() },
    );
  }
  const outbox = () => TelegramOutbox.find().sort({ createdAt: 1 }).lean();

  it('yopilganda rahbariyatga xulosa (HTML, escape), esse bo`lsa tekshiruvchilarga eslatma; dedupe; tugma o`chiq bo`lsa hech narsa', async () => {
    await startBot();
    const s = await setup({ supervisors: [tmId] });
    await runExam(s);
    expect(await notifyExamClosed(s.id)).toBeGreaterThan(0);
    const rows = await outbox();
    const lead = rows.find((r) => String(r.userId) === leadId && r.kind === 'examResults')!;
    expect(lead.dedupeKey).toBe(`exam:${s.id}:closed:${leadId}`);
    expect(lead.parseMode).toBe('HTML');
    expect(lead.text).toContain('2/3');
    expect(lead.text).toContain('Natija imtihoni');
    expect(lead.text).toContain('7-A');
    expect(lead.text).toContain('Oquvchi 1');
    const essay = rows.filter((r) => r.kind === 'examEssays');
    expect(essay.map((r) => String(r.userId)).sort()).toEqual([adminId, tmId].sort());
    expect(essay[0]!.text).toContain('2 ta esse');
    // dedupe: qayta chaqirish yangi qator qo'shmaydi
    await notifyExamClosed(s.id);
    expect(await TelegramOutbox.countDocuments()).toBe(rows.length);
    // tugma o'chiq
    await TelegramOutbox.deleteMany({});
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examResults: false } },
      rootId,
    );
    expect(await notifyExamClosed(s.id)).toBe(0);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it('qo`lda yopish va avtomatik yopish xabar yuboradi; HTML escape', async () => {
    await startBot();
    const s = await setup();
    await runExam(s);
    await adm('post', `/sessions/${s.id}/close`, admin);
    await new Promise((r) => setTimeout(r, 400));
    expect(await TelegramOutbox.countDocuments({ kind: 'examResults' })).toBeGreaterThan(0);
    const msg = buildExamClosedMessage({
      schoolName: '<b>X</b>',
      title: 'A & B <i>',
      classes: ['7<A'],
      submitted: 1,
      total: 2,
      averagePercent: 50,
      top: [{ name: '<script>', percent: 50 }],
    });
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).toContain('A &amp; B &lt;i&gt;');
    expect(msg).not.toContain('<i>');
  });

  it('eslatma: boshlanishdan 30 daqiqa oldin nazoratchilarga bir marta; oyna tashqarisida va tugma o`chiqda yo`q; kech yaratilgan uchun oynada yetkaziladi', async () => {
    await startBot();
    const s = await setup({ supervisors: [tmId] });
    at(mins(s.start, -45));
    expect(await runExamReminders()).toBe(0);
    at(mins(s.start, -29));
    const n = await runExamReminders();
    expect(n).toBeGreaterThan(0);
    const rows = await outbox();
    const rem = rows.filter((r) => r.kind === 'examReminder');
    expect(rem.map((r) => String(r.userId)).sort()).toEqual([adminId, tmId].sort());
    expect(rem[0]!.dedupeKey).toMatch(new RegExp(`^exam:${s.id}:reminder:`));
    expect(rem[0]!.text).toContain('29 daqiqadan');
    expect(rem[0]!.text).toContain(s.code);
    at(mins(s.start, -10)); // keyingi daqiqalar: dedupe
    await runExamReminders();
    expect(await TelegramOutbox.countDocuments({ kind: 'examReminder' })).toBe(rem.length);
    at(mins(s.start, 1)); // boshlangandan keyin: yo'q
    await TelegramOutbox.deleteMany({});
    expect(await runExamReminders()).toBe(0);
    // tugma o'chiq
    const s2 = await setup();
    at(mins(s2.start, -20));
    await settingsStore.set(
      'school',
      school.id,
      'telegram',
      { notify: { examReminders: false } },
      rootId,
    );
    expect(await runExamReminders()).toBe(0);
  });

  it('bot ishlamasa hech narsa', async () => {
    const s = await setup();
    expect(await notifyExamClosed(s.id)).toBe(0);
    at(mins(s.start, -10));
    expect(await runExamReminders()).toBe(0);
    uninstallTelegram();
  });
});
