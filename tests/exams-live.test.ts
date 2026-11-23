import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ExamAttempt } from '../src/models/ExamAttempt';
import { ExamSession } from '../src/models/ExamSession';
import { Student } from '../src/models/Student';
import { WARN_MIN_GAP_MS } from '../src/modules/exams/sessions/sessions.live';
import { decryptPin } from '../src/modules/exams/sessions/pin';
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

useTestDb();

type Doc = { id: string };
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let math: Doc;
let admin = '';
let oadmin = '';
let tsup = '';
let tout = '';
let tsupId = '';
let topic: Doc;
let c7a: Doc;

const adm = (m: 'get' | 'post' | 'patch', url: string, t: string, body?: object) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', school.id);
  return body ? r.send(body) : r;
};
const ec = async (m: 'get' | 'post' | 'put', url: string, token: string | null, body?: object) => {
  let r = request(app)[m](`/api/v1/exam-client${url}`).set('X-Forwarded-For', '10.0.0.1');
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? await r.send(body) : await r;
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

interface Setup {
  id: string;
  code: string;
  start: Date;
  pins: Record<string, { pin: string; key: string }>;
  q: { a: string; b: string; c: string };
}

async function setup(students = 4) {
  const opt = (right: string) =>
    [
      { id: 'a', content: text('A') },
      { id: 'b', content: text('B') },
      { id: 'c', content: text('C') },
    ].map((o) => ({ ...o, right: o.id === right }));
  const mk = (t: string, right: string) =>
    mkQ({
      type: 'single',
      content: text(t),
      options: opt(right).map(({ id, content }) => ({ id, content })),
      answer: { optionId: right },
      points: 2,
    });
  const q = {
    a: await mk('Birinchi savol', 'b'),
    b: await mk('Ikkinchi savol', 'a'),
    c: await mk('Uchinchi', 'c'),
  };
  for (let i = 0; i < students; i++) await makeStudent(school.id, c7a.id, `Oquvchi ${i + 1}`);
  const start = new Date(Date.now() + 3_600_000);
  const created = await adm('post', '/sessions', admin, {
    title: 'Jonli sinov',
    type: 'quarter',
    subjectId: math.id,
    classIds: [c7a.id],
    sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: Object.values(q) }] }],
    scheduledStart: start.toISOString(),
    durationMin: 40,
    resultsMode: 'score',
    shuffleQuestions: false,
    shuffleOptions: false,
    supervisorIds: [tsupId],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  expect(
    (await adm('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] })).status,
  ).toBe(201);
  expect((await adm('post', `/sessions/${id}/submit`, admin)).status).toBe(200);
  const doc = (await ExamSession.findById(id))!;
  const pins: Setup['pins'] = {};
  for (const p of doc.participants)
    pins[p.fullName] = { pin: decryptPin(p.pinEnc, id)!, key: p.key };
  return { id, code: doc.code!, start, pins, q } as Setup;
}

const at = (d: Date) => clock.set(() => d);
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const secs = (d: Date, n: number) => new Date(d.getTime() + n * 1000);

async function joinStart(s: Setup, name: string, device = 'device-aaaaaaaa') {
  const j = await ec('post', '/join', null, {
    code: s.code,
    pin: s.pins[name]!.pin,
    deviceId: device,
  });
  expect(j.status, JSON.stringify(j.body)).toBe(200);
  const token = j.body.data.token as string;
  const st = await ec('post', '/start', token);
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return { token, questions: st.body.data.questions as { id: string }[] };
}
const live = (id: string, t = admin) => adm('get', `/sessions/${id}/live`, t);
const warn = (id: string, key: string, t: string, text: string) =>
  adm('post', `/sessions/${id}/participants/${key}/warn`, t, { text });
const stop = (id: string, key: string, t: string, body: object) =>
  adm('post', `/sessions/${id}/participants/${key}/terminate`, t, body);
interface LiveRow {
  key: string;
  fullName: string;
  className: string | null;
  answered: number;
  total: number;
  status: string;
  leaves: number;
  leaveDetail: Record<string, number>;
  lastLeaveAt: string | null;
  lastSeenAt: string | null;
  reconnects: number;
  warningsSent: number;
  warningsPending: number;
  terminated: { reason: string } | null;
}
/** Ixcham javobni (roster + standart qiymatsiz qatorlar) to'liq qatorlarga yoyadi: mijoz api qatlamidagi kabi */
function expandLive(d: {
  roster?: { key: string; fullName: string; className: string | null }[];
  rows: { key: string; status: string }[];
}): LiveRow[] {
  const roster = new Map((d.roster ?? []).map((p) => [p.key, p]));
  return d.rows.map((r) => ({
    answered: 0,
    total: 0,
    block: null,
    startedAt: null,
    submittedAt: null,
    deadline: null,
    lastSeenAt: null,
    leaves: 0,
    leaveDetail: { blur: 0, fullscreen: 0, hidden: 0 },
    lastLeaveAt: null,
    reconnects: 0,
    warningsSent: 0,
    warningsPending: 0,
    lastWarnAt: null,
    terminated: null,
    ...roster.get(r.key),
    ...r,
  })) as unknown as LiveRow[];
}
const itemsOf = (r: { body: { data: Parameters<typeof expandLive>[0] } }) =>
  expandLive(r.body.data);
const row = (r: { body: { data: Parameters<typeof expandLive>[0] } }, key: string) =>
  itemsOf(r).find((x) => x.key === key) as LiveRow;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  const t1 = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  const sup = await makeUser({ username: 'tsup', role: 'teacher', schoolId: school.id });
  tsupId = sup.id;
  await makeUser({ username: 'tout', role: 'teacher', schoolId: school.id });
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
  c7a = (await makeClass(school.id, year.id, '7-A')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, t1.id);
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  admin = (await login('admin')).token;
  oadmin = (await login('oadmin')).token;
  tsup = (await login('tsup')).token;
  tout = (await login('tout')).token;
  const tp = await adm('post', `/subjects/${math.id}/topics`, admin, { name: 'Kasrlar' });
  topic = tp.body.data as Doc;
});

describe('GET /sessions/:id/live: ruxsat va mazmun', () => {
  it('admin va tayinlangan nazoratchi ko`radi; boshqa o`qituvchi, boshqa maktab va tokensiz ko`rmaydi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    expect((await live(s.id)).status).toBe(200);
    expect((await live(s.id, tsup)).status).toBe(200);
    expect((await live(s.id, tout)).status).toBe(404);
    expect(
      (await request(app).get(`/api/v1/exams/sessions/${s.id}/live`).set(bearer(oadmin))).status,
    ).toBe(404);
    expect((await request(app).get(`/api/v1/exams/sessions/${s.id}/live`)).status).toBe(401);
    // ogohlantirish va to'xtatish ham shunday: tashqi o'qituvchi 404
    const key = s.pins['Oquvchi 1']!.key;
    expect((await warn(s.id, key, tout, 'Salom')).status).toBe(404);
    expect((await stop(s.id, key, tout, { reason: 'x' })).status).toBe(404);
  });

  it('qoralama imtihon: 409; sessiya bayroqlari canMonitor/canIntervene holatga mos', async () => {
    const s = await setup();
    const g1 = await adm('get', `/sessions/${s.id}`, admin);
    expect(g1.body.data).toMatchObject({ canMonitor: true, canIntervene: false });
    at(mins(s.start, 5));
    await joinStart(s, 'Oquvchi 1');
    const g2 = await adm('get', `/sessions/${s.id}`, tsup);
    expect(g2.body.data).toMatchObject({ canMonitor: true, canIntervene: true });
    const draft = await adm('post', '/sessions', admin, {
      title: 'Q',
      type: 'quarter',
      subjectId: math.id,
      classIds: [c7a.id],
      sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: [s.q.a] }] }],
      scheduledStart: s.start.toISOString(),
      durationMin: 40,
    });
    expect((await live(draft.body.data.id as string)).status).toBe(409);
  });

  it('hisoblagichlar, qator maydonlari; savol matni, variantlar, javoblar va kalit YO`Q; yengil javob', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    await ec('put', '/answers', a.token, {
      clientSeq: 1,
      answers: [{ qid: a.questions[0]!.id, value: 'b', flagged: false }],
    });
    await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 2']!.pin,
      deviceId: 'device-bbbbbbbb',
    });
    const r = await live(s.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.counts).toEqual({
      total: 4,
      notStarted: 2,
      joined: 1,
      inProgress: 1,
      submitted: 0,
      terminated: 0,
      warned: 0,
      withLeaves: 0,
    });
    expect(d.session).toMatchObject({ title: 'Jonli sinov', status: 'open' });
    expect(d.canIntervene).toBe(true);
    expect(d.staleAfterSec).toBe(60);
    const k1 = row(r, s.pins['Oquvchi 1']!.key);
    expect(k1).toMatchObject({
      fullName: 'Oquvchi 1',
      className: '7-A',
      status: 'in_progress',
      answered: 1,
      total: 3,
      leaves: 0,
      warningsSent: 0,
      terminated: null,
    });
    expect(k1.lastSeenAt).toBeTruthy();
    expect(row(r, s.pins['Oquvchi 3']!.key)).toMatchObject({ status: 'not_started', total: 0 });
    const raw = JSON.stringify(r.body);
    for (const bad of [
      'Birinchi savol',
      'optionPerm',
      'optionId',
      'acceptedAnswers',
      'tokenHash',
      'deviceId',
      'pinHash',
      'pinEnc',
      'codeEnc',
    ]) {
      expect(raw).not.toContain(bad);
    }
  });

  it('proyeksiya: katta urinish hujjatlari (order/saved) javobga tushmaydi; 300 ishtirokchi', async () => {
    const s = await setup(1);
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const att = (await ExamAttempt.findOne({}))!;
    const huge = Array.from({ length: 400 }, (_, i) => ({
      qid: `q${i}`,
      value: 'x'.repeat(200),
      flagged: false,
      answered: true,
      at: new Date(),
    }));
    await ExamAttempt.updateOne({ _id: att._id }, { $set: { saved: huge, answeredCount: 400 } });
    const doc = (await ExamSession.findById(s.id))!;
    const extra = Array.from({ length: 299 }, (_, i) => ({
      key: `Z${String(i).padStart(7, '0')}`,
      kind: 'guest',
      fullName: `Mehmon ${i}`,
      origin: 'Namangan',
      pinHash: 'h',
      pinEnc: 'e',
      pinSalt: 's',
    }));
    await ExamSession.updateOne({ _id: doc._id }, { $push: { participants: { $each: extra } } });
    await ExamAttempt.insertMany(
      extra.slice(0, 150).map((p, i) => ({
        schoolId: school.id,
        sessionId: doc._id,
        participantKey: p.key,
        participantKind: 'guest',
        fullName: p.fullName,
        tokenHash: `t${i}`.padEnd(64, 'x'),
        tokenExpiresAt: mins(s.start, 600),
        deviceId: `dev-${i}-aaaaaa`,
        status: 'in_progress',
        order: Array.from({ length: 100 }, (_, j) => ({
          qid: `q${j}`,
          type: 'single',
          points: 1,
          optionPerm: ['a', 'b', 'c', 'd'],
        })),
        counters: { blur: i % 3, fullscreenExit: 0, visibilityHidden: 0, reconnect: 0 },
        lastSeenAt: new Date(),
      })),
    );
    const t0 = Date.now();
    const r = await live(s.id);
    const ms = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(r.body.data.rows).toHaveLength(300);
    expect(r.body.data.counts.inProgress).toBe(151);
    expect(row(r, a.questions.length ? s.pins['Oquvchi 1']!.key : '')).toMatchObject({
      answered: 400,
      total: 3,
    });
    // 300 qator ~ yuzlab bayt/qator; savollar/javoblar (yuzlab KB) kirmaydi
    expect(JSON.stringify(r.body).length).toBeLessThan(160_000);
    expect(ms).toBeLessThan(3000);
  });
});

describe('Oynadan chiqish: nazoratchiga darhol ko`rinadi', () => {
  it('blur/visibility/fullscreen hodisalari hisoblagich va oxirgi vaqtni yangilaydi; reconnect chiqish emas', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const key = s.pins['Oquvchi 1']!.key;
    expect(row(await live(s.id), key)).toMatchObject({ leaves: 0, lastLeaveAt: null });
    at(mins(s.start, 6));
    await ec('post', '/events', a.token, { type: 'blur' });
    await ec('post', '/events', a.token, { type: 'visibility_hidden' });
    await ec('post', '/events', a.token, { type: 'fullscreen_exit' });
    await ec('post', '/events', a.token, { type: 'reconnect' });
    const r = await live(s.id, tsup);
    const k = row(r, key);
    expect(k.leaves).toBe(3);
    expect(k.leaveDetail).toEqual({ blur: 1, fullscreen: 1, hidden: 1 });
    expect(k.reconnects).toBe(1);
    expect(new Date(k.lastLeaveAt!).getTime()).toBe(mins(s.start, 6).getTime());
    expect(r.body.data.counts.withLeaves).toBe(1);
    // test bloklanmadi: javob saqlanadi
    const put = await ec('put', '/answers', a.token, {
      clientSeq: 1,
      answers: [{ qid: a.questions[0]!.id, value: 'a', flagged: false }],
    });
    expect(put.status).toBe(200);
  });
});

describe('Ogohlantirish yuborish', () => {
  it('yuboriladi, heartbeat/state da yetkaziladi, tasdiqlanadi; hodisa va audit yoziladi; tezlik cheklovi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const key = s.pins['Oquvchi 1']!.key;
    expect((await ec('post', '/heartbeat', a.token)).body.data.warnings).toEqual([]);
    const w = await warn(s.id, key, tsup, '  Telefonni olib qo‘ying  ');
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.data.warningId).toBeTruthy();
    const hb = await ec('post', '/heartbeat', a.token);
    expect(hb.body.data.warnings).toHaveLength(1);
    expect(hb.body.data.warnings[0]).toMatchObject({
      id: w.body.data.warningId,
      text: 'Telefonni olib qo‘ying',
    });
    expect(hb.body.data.warnings[0]).not.toHaveProperty('by');
    const st = await ec('get', '/state', a.token);
    expect(st.body.data.warnings).toHaveLength(1);
    // nazoratchi ekrani: yuborilgan 1, tasdiqlanmagan 1
    const k1 = row(await live(s.id), key);
    expect(k1).toMatchObject({ warningsSent: 1, warningsPending: 1 });
    // 10 s ichida yana: 429
    at(secs(mins(s.start, 5), 5));
    const again = await warn(s.id, key, admin, 'Yana');
    expect(again.status).toBe(429);
    // tasdiqlash (faqat o'z ogohlantirishi; noma'lum id jim e'tiborsiz)
    const ack = await ec('post', '/warnings/ack', a.token, {
      ids: [w.body.data.warningId, 'nomalum'],
    });
    expect(ack.status).toBe(200);
    expect(ack.body.data.acknowledged).toBe(true);
    expect((await ec('post', '/heartbeat', a.token)).body.data.warnings).toEqual([]);
    expect(row(await live(s.id), key)).toMatchObject({ warningsSent: 1, warningsPending: 0 });
    // oraliqdan keyin yana yuboriladi
    at(secs(mins(s.start, 5), WARN_MIN_GAP_MS / 1000 + 1));
    expect((await warn(s.id, key, admin, 'Ikkinchi')).status).toBe(200);
    const att = (await ExamAttempt.findOne({}))!;
    expect(att.warnings).toHaveLength(2);
    expect(att.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['warning_sent', 'warning_ack']),
    );
    const logs = await AuditLog.find({ action: 'exam.session.warn' });
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs.map((l) => l.after))).toContain('Telefonni');
    expect((await live(s.id)).body.data.counts.warned).toBe(1);
  });

  it('boshqa o`quvchining token bilan tasdiqlash ta`sir qilmaydi; matn tekshiruvi; kirmagan/topshirgan: 409', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const b = await joinStart(s, 'Oquvchi 2', 'device-bbbbbbbb');
    const k1 = s.pins['Oquvchi 1']!.key;
    const w = await warn(s.id, k1, admin, 'Diqqat');
    const ack = await ec('post', '/warnings/ack', b.token, { ids: [w.body.data.warningId] });
    expect(ack.body.data.acknowledged).toBe(false);
    expect((await ec('post', '/heartbeat', a.token)).body.data.warnings).toHaveLength(1);
    // matn
    expect((await warn(s.id, k1, admin, '   ')).status).toBe(400);
    expect((await warn(s.id, k1, admin, 'x'.repeat(201))).status).toBe(400);
    expect((await warn(s.id, k1, admin, 'a\u0007b')).status).toBe(400);
    expect((await adm('post', `/sessions/${s.id}/participants/${k1}/warn`, admin, {})).status).toBe(
      400,
    );
    expect(
      (await adm('post', `/sessions/${s.id}/participants/${k1}/warn`, admin, { text: 'a', x: 1 }))
        .status,
    ).toBe(400);
    // kirmagan o'quvchi
    expect((await warn(s.id, s.pins['Oquvchi 4']!.key, admin, 'Salom')).status).toBe(409);
    // topshirgan o'quvchi
    await ec('post', '/submit', b.token);
    at(secs(mins(s.start, 6), 30));
    expect((await warn(s.id, s.pins['Oquvchi 2']!.key, admin, 'Salom')).status).toBe(409);
    // noma'lum ishtirokchi
    expect((await warn(s.id, 'ZZZZZZZZZ', admin, 'Salom')).status).toBe(404);
  });

  it('yopiq imtihonda ogohlantirish va to`xtatish: 409', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    await joinStart(s, 'Oquvchi 1');
    expect((await adm('post', `/sessions/${s.id}/close`, admin)).status).toBe(200);
    const key = s.pins['Oquvchi 1']!.key;
    expect((await warn(s.id, key, admin, 'Salom')).status).toBe(409);
    expect((await stop(s.id, key, admin, { reason: 'x' })).status).toBe(409);
    expect((await live(s.id)).status).toBe(200); // yopilgan: faqat ko'rish
    expect((await live(s.id)).body.data.canIntervene).toBe(false);
  });
});

describe('Imtihonni to`xtatish', () => {
  it('sabab majburiy; shu paytgacha javoblar baholanadi va natijada qoladi; o`quvchi tomonida to`xtatilgan holat; qayta kirib davom etib bo`lmaydi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const key = s.pins['Oquvchi 1']!.key;
    // Birinchi savolga to'g'ri javob (qaysi variant to'g'ri ekanini tartibsiz aralashtirishsiz bilamiz: shuffle yo'q)
    const correct: Record<string, string> = { [s.q.a]: 'b', [s.q.b]: 'a', [s.q.c]: 'c' };
    const q0 = a.questions[0]!.id;
    await ec('put', '/answers', a.token, {
      clientSeq: 1,
      answers: [{ qid: q0, value: correct[q0]!, flagged: false }],
    });
    // sabab majburiy
    expect((await stop(s.id, key, tsup, {})).status).toBe(400);
    expect((await stop(s.id, key, tsup, { reason: '   ' })).status).toBe(400);
    expect((await stop(s.id, key, tsup, { reason: 'x'.repeat(301) })).status).toBe(400);
    at(mins(s.start, 8));
    const r = await stop(s.id, key, tsup, { reason: 'Telefondan foydalandi' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ terminated: true, score: { earned: 2, max: 6 } });
    const att = (await ExamAttempt.findOne({}))!;
    expect(att).toMatchObject({ status: 'submitted' });
    expect(att.terminated).toMatchObject({ reason: 'Telefondan foydalandi' });
    expect(att.submittedAt!.getTime()).toBe(mins(s.start, 8).getTime());
    expect(att.score).toMatchObject({ earned: 2, max: 6 });
    expect(att.events.some((e) => e.type === 'terminated')).toBe(true);
    // o'quvchi: heartbeat/state "submitted" + terminated; natija; yozish va boshlash 409
    const hb = await ec('post', '/heartbeat', a.token);
    expect(hb.body.data).toMatchObject({ status: 'submitted', terminated: true });
    const res = await ec('get', '/result', a.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'submitted', terminated: true });
    expect(JSON.stringify(res.body)).not.toContain('Telefondan');
    const late = await ec('put', '/answers', a.token, {
      clientSeq: 2,
      answers: [{ qid: a.questions[1]!.id, value: 'a', flagged: false }],
    });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toContain('to‘xtatilgan');
    expect((await ec('post', '/start', a.token)).status).toBe(409);
    expect((await ExamAttempt.findOne({}))!.answeredCount).toBe(1);
    // qayta kirish: natija ekrani (davom ettirib bo'lmaydi), hatto ruxsat berilsa ham
    const again = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: 'device-cccccccc',
    });
    expect(again.status).toBe(409); // boshqa qurilma: ruxsatsiz
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': key },
      { $set: { 'participants.$.allowReentry': true } },
    );
    const re = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: 'device-cccccccc',
    });
    expect(re.status).toBe(200);
    expect(re.body.data).toMatchObject({ attemptStatus: 'submitted', terminated: true });
    expect((await ec('post', '/start', re.body.data.token)).status).toBe(409);
    // nazoratchi ekrani
    const lv = await live(s.id);
    expect(row(lv, key)).toMatchObject({
      status: 'submitted',
      terminated: { reason: 'Telefondan foydalandi' },
    });
    expect(lv.body.data.counts).toMatchObject({ terminated: 1, submitted: 0, inProgress: 0 });
    const log = await AuditLog.findOne({ action: 'exam.session.terminate' });
    expect(log).toBeTruthy();
    expect(JSON.stringify(log!.after)).toContain('Telefondan');
  });

  it('qayta to`xtatish / topshirgan / kirmagan / boshlamagan: 409; topshirish idempotent natija qaytaradi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const k1 = s.pins['Oquvchi 1']!.key;
    expect((await stop(s.id, k1, admin, { reason: 'Birinchi' })).status).toBe(200);
    expect((await stop(s.id, k1, admin, { reason: 'Ikkinchi' })).status).toBe(409);
    // sabab ustiga yozilmadi
    expect((await ExamAttempt.findOne({}))!.terminated?.reason).toBe('Birinchi');
    // o'quvchi submit: mavjud natija (terminated belgisi bilan)
    const sub = await ec('post', '/submit', a.token);
    expect(sub.status).toBe(200);
    expect(sub.body.data.terminated).toBe(true);
    expect((await stop(s.id, s.pins['Oquvchi 3']!.key, admin, { reason: 'x' })).status).toBe(409);
    await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 2']!.pin,
      deviceId: 'device-bbbbbbbb',
    });
    expect((await stop(s.id, s.pins['Oquvchi 2']!.key, admin, { reason: 'x' })).status).toBe(409);
    // o'z topshirgan o'quvchisi
    const b = await joinStart(s, 'Oquvchi 4', 'device-dddddddd');
    await ec('post', '/submit', b.token);
    expect((await stop(s.id, s.pins['Oquvchi 4']!.key, admin, { reason: 'x' })).status).toBe(409);
    expect(
      (await ExamAttempt.findOne({ participantKey: s.pins['Oquvchi 4']!.key }))!.terminated,
    ).toBeNull();
  });

  it('poyga: bir vaqtda topshirish va to`xtatish: bittasi yutadi, holat izchil (ikki marta baholanmaydi)', async () => {
    const s = await setup(8);
    at(mins(s.start, 5));
    const names = Array.from({ length: 8 }, (_, i) => `Oquvchi ${i + 1}`);
    const sessions: Awaited<ReturnType<typeof joinStart>>[] = [];
    for (const [i, n] of names.entries()) sessions.push(await joinStart(s, n, `device-race${i}xx`));
    const results = await Promise.all(
      names.flatMap((n, i) => [
        ec('post', '/submit', sessions[i]!.token),
        stop(s.id, s.pins[n]!.key, admin, { reason: 'Poyga' }),
      ]),
    );
    const attempts = await ExamAttempt.find({});
    expect(attempts).toHaveLength(8);
    for (const a of attempts) {
      expect(a.status).toBe('submitted');
      expect(a.score).toBeTruthy();
    }
    for (let i = 0; i < 8; i++) {
      const submitRes = results[i * 2]!;
      const stopRes = results[i * 2 + 1]!;
      const a = attempts.find((x) => x.participantKey === s.pins[names[i]!]!.key)!;
      // stop 200 <=> terminated belgisi bor; aks holda 409 va belgisiz
      expect(stopRes.status === 200).toBe(!!a.terminated);
      expect([200, 409]).toContain(stopRes.status);
      expect(submitRes.status).toBe(200); // submit har holda natija qaytaradi (idempotent)
      expect(submitRes.body.data.terminated).toBe(!!a.terminated);
    }
  });

  it('vaqt tugashi (sweeper/blok) to`xtatilgan urinishni qayta topshirmaydi: submittedAt saqlanadi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const key = s.pins['Oquvchi 1']!.key;
    at(mins(s.start, 7));
    expect((await stop(s.id, key, admin, { reason: 'Sabab' })).status).toBe(200);
    at(mins(s.start, 60));
    const att = (await ExamAttempt.findOne({}))!;
    expect(att.submittedAt!.getTime()).toBe(mins(s.start, 7).getTime());
    expect((await ec('post', '/heartbeat', a.token)).body.data).toMatchObject({
      status: 'submitted',
      terminated: true,
    });
  });
});

describe('Natijalar, profil va eksportda "Nazoratchi to`xtatgan: sabab"', () => {
  async function stopped() {
    const s = await setup();
    at(mins(s.start, 5));
    const a = await joinStart(s, 'Oquvchi 1');
    const b = await joinStart(s, 'Oquvchi 2', 'device-bbbbbbbb');
    await ec('put', '/answers', a.token, {
      clientSeq: 1,
      answers: [{ qid: a.questions[0]!.id, value: 'a', flagged: false }],
    });
    await ec('post', '/submit', b.token);
    at(mins(s.start, 9));
    expect(
      (await stop(s.id, s.pins['Oquvchi 1']!.key, admin, { reason: '=Ko‘chirdi' })).status,
    ).toBe(200);
    expect((await adm('post', `/sessions/${s.id}/close`, admin)).status).toBe(200);
    return s;
  }
  const res = (id: string, suffix = '') => adm('get', `/sessions/${id}/results${suffix}`, admin);

  it('natijalar ro`yxati va ishtirokchi tafsiloti', async () => {
    const s = await stopped();
    const r = await res(s.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.data.rows as {
      fullName: string;
      terminated: { reason: string } | null;
      status: string;
    }[];
    const o1 = rows.find((x) => x.fullName === 'Oquvchi 1')!;
    expect(o1.status).toBe('submitted');
    expect(o1.terminated).toMatchObject({ reason: '=Ko‘chirdi' });
    expect(rows.find((x) => x.fullName === 'Oquvchi 2')!.terminated).toBeNull();
    expect(rows.find((x) => x.fullName === 'Oquvchi 3')!.terminated).toBeNull();
    const d = await res(s.id, `/${s.pins['Oquvchi 1']!.key}`);
    expect(d.body.data.terminated).toMatchObject({ reason: '=Ko‘chirdi' });
    expect(d.body.data.score.earned).toBe(0);
  });

  it('Excel eksport: holat ustunida sabab (formula belgisi himoyalangan)', async () => {
    const s = await stopped();
    const r = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=xlsx`)
      .set(bearer(admin))
      .set('X-School-Id', school.id)
      .buffer(true)
      .parse((q, cb) => {
        const c: Buffer[] = [];
        q.on('data', (x: Buffer) => c.push(x));
        q.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as never);
    const all: string[] = [];
    wb.eachSheet((w) => w.eachRow((row2) => row2.eachCell((c) => all.push(String(c.value ?? '')))));
    expect(all.some((x) => x.includes("Nazoratchi to'xtatgan:") && x.includes('Ko‘chirdi'))).toBe(
      true,
    );
    expect(all.some((x) => x.startsWith('=Ko') || x.startsWith("Nazoratchi to'xtatgan"))).toBe(
      true,
    );
  });

  it('o`quvchi profili natijalari: sabab ko`rsatiladi; to`xtatilmaganda null', async () => {
    const s = await stopped();
    await makeUser({
      username: 'viewer',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['students.view'],
    });
    const viewer = (await login('viewer')).token;
    const sres = async (name: string) => {
      const id = (await Student.findOne({ fullName: name }))!.id as string;
      return request(app)
        .get(`/api/v1/students/${id}/exam-results`)
        .set(bearer(viewer))
        .set('X-School-Id', school.id);
    };
    const r1 = await sres('Oquvchi 1');
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.data.items[0]).toMatchObject({
      sessionId: s.id,
      terminated: { reason: '=Ko‘chirdi' },
    });
    const r2 = await sres('Oquvchi 2');
    expect(r2.body.data.items[0].terminated).toBeNull();
  });
});

describe('Jonli javob: ixcham shakl (E7)', () => {
  it('roster faqat rosterKey eskirganda yuboriladi; qatorlarda standart qiymatlar yo`q; sessiya hujjatidan PIN/kod maydonlari chiqmaydi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    await joinStart(s, 'Oquvchi 1');
    const first = await live(s.id);
    expect(first.status).toBe(200);
    expect(first.body.data.roster).toHaveLength(4);
    expect(first.body.data.roster[0]).toEqual(
      expect.objectContaining({
        key: expect.any(String),
        fullName: expect.any(String),
        className: '7-A',
      }),
    );
    const key = first.body.data.rosterKey as string;
    expect(key).toMatch(/^4:\d+$/);
    // mijoz kalitni yuboradi: roster yo'q, qatorlar bor
    const again = await adm(
      'get',
      `/sessions/${s.id}/live?roster=${encodeURIComponent(key)}`,
      admin,
    );
    expect(again.body.data.roster).toBeUndefined();
    expect(again.body.data.rows).toHaveLength(4);
    // kirmagan o'quvchi qatori: faqat key va status
    const idle = again.body.data.rows.find((r: { status: string }) => r.status === 'not_started');
    expect(Object.keys(idle).sort()).toEqual(['key', 'status']);
    // eskirgan kalit: yana roster
    const stale = await adm('get', `/sessions/${s.id}/live?roster=zzz`, admin);
    expect(stale.body.data.roster).toHaveLength(4);
    // ro'yxat o'zgarsa (individual vaqt) kalit o'zgaradi
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 2']!.key },
      { $set: { 'participants.$.extraMinutes': 5 } },
    );
    const changed = await adm(
      'get',
      `/sessions/${s.id}/live?roster=${encodeURIComponent(key)}`,
      admin,
    );
    expect(changed.body.data.rosterKey).not.toBe(key);
    expect(JSON.stringify(changed.body.data.roster)).toContain('"extraMinutes":5');
    const raw = JSON.stringify(first.body);
    for (const bad of ['pinHash', 'pinEnc', 'codeEnc', 'pinSalt', 'questionPool']) {
      expect(raw).not.toContain(bad);
    }
  });

  it('hajm: 300 ishtirokchi, ixcham javob eski (to`liq) shakldan ancha kichik', async () => {
    const s = await setup(1);
    at(mins(s.start, 5));
    const doc = (await ExamSession.findById(s.id))!;
    const extra = Array.from({ length: 299 }, (_, i) => ({
      key: `Z${String(i).padStart(7, '0')}`,
      kind: 'guest',
      fullName: `Mehmon ${i}`,
      origin: 'Namangan',
      pinHash: 'h',
      pinEnc: 'e',
      pinSalt: 's',
    }));
    await ExamSession.updateOne({ _id: doc._id }, { $push: { participants: { $each: extra } } });
    const first = await live(s.id);
    const second = await adm(
      'get',
      `/sessions/${s.id}/live?roster=${encodeURIComponent(first.body.data.rosterKey)}`,
      admin,
    );
    // ro'yxatsiz davriy javob: har qator ~ kalit+holat (~40 bayt)
    expect(JSON.stringify(second.body).length).toBeLessThan(30_000);
    expect(JSON.stringify(first.body).length).toBeGreaterThan(JSON.stringify(second.body).length);
  });
});
