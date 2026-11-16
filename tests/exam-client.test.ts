import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ExamAsset } from '../src/models/ExamAsset';
import { ExamAttempt } from '../src/models/ExamAttempt';
import { ExamJoinGuard } from '../src/models/ExamJoinGuard';
import { ExamSession } from '../src/models/ExamSession';
import { runExamSweeper } from '../src/modules/exam-client/exam-client.sweeper';
import { gradeQuestion } from '../src/modules/exam-client/grading';
import { seededRandom, selectQuestions } from '../src/modules/exam-client/selection';
import { decryptPin } from '../src/modules/exams/sessions/pin';
import { SCHOOL_PURGE_STEPS } from '../src/modules/schools/schoolPurge';
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
let rootId: string;
let admin: string, oadmin: string;
let topic: Doc;
let c7a: Doc;
const DEV_A = 'device-aaaaaaaa';
const DEV_B = 'device-bbbbbbbb';

const adm = (m: 'get' | 'post' | 'patch', url: string, t: string, body?: object) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', school.id);
  return body ? r.send(body) : r;
};

/** Barcha exam-client javoblari yig'iladi: javob kaliti sizib chiqmaganini tekshirish uchun */
const seen: unknown[] = [];
const ec = async (
  m: 'get' | 'post' | 'put',
  url: string,
  token: string | null,
  body?: object,
  ip = '10.0.0.1',
) => {
  let r = request(app)[m](`/api/v1/exam-client${url}`).set('X-Forwarded-For', ip);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  const res = body ? await r.send(body) : await r;
  seen.push({ url, body: res.body });
  return res;
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
  q: { single: string; multi: string; short: string; essay: string; math: string; image: string };
  assetId: string;
}

async function setup(
  opts: { resultsMode?: string; extra?: object; students?: number; shuffle?: boolean } = {},
) {
  const asset = await ExamAsset.create({
    schoolId: school.id,
    hash: `h${Math.random()}`,
    data: Buffer.from('RIFFxxxxWEBPfake'),
    size: 16,
  });
  const q = {
    single: await mkQ({
      type: 'single',
      content: text('Bitta javob'),
      options: [
        { id: 'a', content: text('Birinchi') },
        { id: 'b', content: text('Ikkinchi') },
        { id: 'c', content: text('Uchinchi') },
      ],
      answer: { optionId: 'b' },
      points: 2,
    }),
    multi: await mkQ({
      type: 'multi',
      content: text('Bir nechta'),
      options: [
        { id: 'a', content: text('A') },
        { id: 'b', content: text('B') },
        { id: 'c', content: text('C') },
        { id: 'd', content: text('D') },
      ],
      answer: { optionIds: ['a', 'b'], partialCredit: true },
      points: 4,
    }),
    short: await mkQ({
      type: 'short',
      content: text('Qisqa'),
      answer: { acceptedAnswers: ['12,5', 'o`n ikki'] },
      points: 1,
    }),
    essay: await mkQ({
      type: 'essay',
      content: text('Esse'),
      answer: { rubric: 'Maxfiy mezon' },
      points: 5,
    }),
    math: await mkQ({
      type: 'short',
      content: [{ type: 'math', tex: 'x^2+1' }],
      answer: { acceptedAnswers: ['2'] },
      points: 1,
    }),
    image: await mkQ({
      type: 'single',
      content: [{ type: 'image', assetId: asset.id }, ...text('Rasmli')],
      options: [
        { id: 'a', content: text('Ha') },
        { id: 'b', content: text("Yo'q") },
      ],
      answer: { optionId: 'a' },
      points: 1,
    }),
  };
  for (let i = 0; i < (opts.students ?? 3); i++)
    await makeStudent(school.id, c7a.id, `Oquvchi ${i + 1}`);
  const start = new Date(Date.now() + 3_600_000);
  const created = await adm('post', '/sessions', admin, {
    title: 'Sinov imtihoni',
    type: 'quarter',
    subjectId: math.id,
    classIds: [c7a.id],
    sections: [{ title: 'B', items: [{ kind: 'manual', questionIds: Object.values(q) }] }],
    scheduledStart: start.toISOString(),
    durationMin: 40,
    resultsMode: opts.resultsMode ?? 'score',
    shuffleQuestions: opts.shuffle ?? true,
    shuffleOptions: opts.shuffle ?? true,
    ...opts.extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  expect(
    (await adm('post', `/sessions/${id}/participants`, admin, { classIds: [c7a.id] })).status,
  ).toBe(201);
  const sub = await adm('post', `/sessions/${id}/submit`, admin);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const doc = (await ExamSession.findById(id))!;
  const pins: Setup['pins'] = {};
  for (const p of doc.participants)
    pins[p.fullName] = { pin: decryptPin(p.pinEnc, id)!, key: p.key };
  return { id, code: doc.code!, start, pins, q, assetId: asset.id } as Setup;
}

const at = (d: Date) => clock.set(() => d);
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

async function joinAs(s: Setup, name: string, device = DEV_A) {
  const r = await ec('post', '/join', null, {
    code: s.code,
    pin: s.pins[name]!.pin,
    deviceId: device,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data as { token: string; attemptStatus: string };
}
async function startAs(token: string) {
  const r = await ec('post', '/start', token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data as {
    questions: { id: string; type: string; options: { id: string }[] }[];
    deadline: string;
    saved: unknown[];
  };
}
const put = (token: string, clientSeq: number, answers: object[]) =>
  ec('put', '/answers', token, { clientSeq, answers });

beforeEach(async () => {
  seen.length = 0;
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  rootId = rootU.id;
  const t1 = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
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
  const tp = await adm('post', `/subjects/${math.id}/topics`, admin, { name: 'Kasrlar' });
  topic = tp.body.data as Doc;
});

describe('selectQuestions / grading (birlik testlari)', () => {
  const pool = new Map(
    ['1', '2', '3', '4', '5', '6'].map((id) => [
      id,
      {
        questionId: id,
        type: id === '6' ? 'short' : 'single',
        points: 1,
        options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      },
    ]),
  );
  const base = {
    sections: [
      {
        items: [
          { kind: 'manual' as const, questionIds: ['1', '2'] },
          { kind: 'rule' as const, count: 3, poolIds: ['1', '2', '3', '4', '5'] },
        ],
      },
    ],
    pool,
    shuffleQuestions: true,
    shuffleOptions: true,
  };
  it('deterministik (bir xil seed), qo`lda va qoida takrorsiz, soni to`g`ri', () => {
    const a = selectQuestions({ ...base, seed: 's1' });
    const b = selectQuestions({ ...base, seed: 's1' });
    expect(a).toEqual(b);
    expect(a).toHaveLength(5); // 2 qo'lda + 3 qoida
    expect(new Set(a.map((x) => x.qid)).size).toBe(5);
    const rules = a.map((x) => x.qid).filter((x) => !['1', '2'].includes(x));
    expect(rules.every((x) => ['3', '4', '5'].includes(x))).toBe(true); // qo'lda tanlanganlar qoida hovuzidan chiqarildi
    const c = selectQuestions({ ...base, seed: 's2' });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });
  it('shuffle yo`q: qo`lda tanlov tartibi va asl variantlar tartibi', () => {
    const r = selectQuestions({
      ...base,
      shuffleQuestions: false,
      shuffleOptions: false,
      seed: 'x',
    });
    expect(r.slice(0, 2).map((x) => x.qid)).toEqual(['1', '2']);
    expect(r[0]!.optionPerm).toEqual(['a', 'b', 'c']);
    const p = selectQuestions({ ...base, seed: 'x' });
    expect(p.every((x) => [...x.optionPerm].sort().join() === 'a,b,c')).toBe(true);
    expect(
      selectQuestions({ ...base, seed: 'x' }).find((x) => x.type === 'short')?.optionPerm ?? [],
    ).toEqual([]);
  });
  it('PRNG: bir xil seed bir xil ketma-ketlik', () => {
    const r1 = seededRandom('abc');
    const r2 = seededRandom('abc');
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
  it('baholash: single, multi (to`liq/qisman/xato), short normalizatsiya, essay kutilmoqda', () => {
    const single = { questionId: 'q', type: 'single', points: 2, answer: { optionId: 'b' } };
    expect(gradeQuestion(single, 'b')).toMatchObject({ got: 2, ok: true });
    expect(gradeQuestion(single, 'a')).toMatchObject({ got: 0, ok: false });
    expect(gradeQuestion(single, null)).toMatchObject({ got: 0, ok: false });
    const multi = {
      questionId: 'q',
      type: 'multi',
      points: 4,
      answer: { optionIds: ['a', 'b'], partialCredit: true },
    };
    expect(gradeQuestion(multi, ['b', 'a'])).toMatchObject({ got: 4, ok: true });
    expect(gradeQuestion(multi, ['a'])).toMatchObject({ got: 2, ok: false });
    expect(gradeQuestion(multi, ['a', 'c'])).toMatchObject({ got: 0, ok: false });
    expect(gradeQuestion(multi, ['c', 'd', 'a'])).toMatchObject({ got: 0 });
    const strict = { ...multi, answer: { optionIds: ['a', 'b'], partialCredit: false } };
    expect(gradeQuestion(strict, ['a'])).toMatchObject({ got: 0, ok: false });
    const short = {
      questionId: 'q',
      type: 'short',
      points: 1,
      answer: { acceptedAnswers: ['12,5', 'Ikki'] },
    };
    expect(gradeQuestion(short, ' 12.50 ')).toMatchObject({ ok: true });
    expect(gradeQuestion(short, 'IKKI')).toMatchObject({ ok: true });
    expect(gradeQuestion(short, '13')).toMatchObject({ ok: false });
    expect(
      gradeQuestion({ questionId: 'q', type: 'essay', points: 5, answer: {} }, 'matn'),
    ).toMatchObject({ got: 0, ok: null });
  });
});

describe('POST /join', () => {
  it('muvaffaqiyat: token, ishtirokchi, imtihon ma`lumoti; token faqat xesh ko`rinishida saqlanadi', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const r = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = r.body.data;
    expect(d.token).toHaveLength(43);
    expect(d.participant).toMatchObject({ fullName: 'Oquvchi 1', className: '7-A' });
    expect(d.exam).toMatchObject({
      title: 'Sinov imtihoni',
      durationMin: 40,
      questionCount: 6,
      resultsMode: 'score',
      freeNavigation: true,
    });
    expect(new Date(d.exam.deadlinePreview).getTime()).toBe(mins(s.start, 40).getTime()); // kechikkan: umumiy tugash
    const a = (await ExamAttempt.findOne({}))!;
    expect(a.tokenHash).not.toBe(d.token);
    expect(a.tokenHash).toHaveLength(64);
    expect(JSON.stringify(a)).not.toContain(d.token);
    // PIN kichik harf va bo'shliq bilan ham
    const lower = await ec('post', '/join', null, {
      code: s.code,
      pin: ` ${s.pins['Oquvchi 2']!.pin.toLowerCase()} `,
      deviceId: DEV_B,
    });
    expect(lower.status).toBe(200);
  });

  it('noto`g`ri kod / PIN / mavjud emas / modul o`chiq: BIR XIL javob', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    const good = s.pins['Oquvchi 1']!.pin;
    const wrongPin = await ec('post', '/join', null, {
      code: s.code,
      pin: 'ZZZZZZ',
      deviceId: DEV_A,
    });
    const wrongCode = await ec('post', '/join', null, {
      code: '000000',
      pin: good,
      deviceId: DEV_A,
    });
    await settingsStore.set('school', school.id, 'exams', { enabled: false }, rootId);
    const disabled = await ec('post', '/join', null, { code: s.code, pin: good, deviceId: DEV_B });
    for (const r of [wrongPin, wrongCode, disabled]) expect(r.status).toBe(401);
    expect(wrongPin.body).toEqual(wrongCode.body);
    expect(wrongPin.body).toEqual(disabled.body);
    expect(wrongPin.body.error.message).toBe("Kod yoki PIN noto'g'ri");
  });

  it('brute-force: qurilma bo`yicha 5 xatodan keyin blok (DB da), to`g`ri PIN ham o`tmaydi; boshqa qurilma ishlaydi; sessiya hisoblagichi va ogohlantirish', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    for (let i = 0; i < 5; i++) {
      expect(
        (await ec('post', '/join', null, { code: s.code, pin: 'ZZZZZ' + i, deviceId: DEV_A }))
          .status,
      ).toBe(401);
    }
    const blocked = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(blocked.status).toBe(429);
    // Blok bazada: jarayon xotirasiga bog'liq emas
    const g = await ExamJoinGuard.findOne({ key: `dev:${s.code}:${DEV_A}` });
    expect(g?.blockedUntil && g.blockedUntil > clock.now()).toBeTruthy();
    expect(
      (
        await ec('post', '/join', null, {
          code: s.code,
          pin: s.pins['Oquvchi 1']!.pin,
          deviceId: DEV_B,
        })
      ).status,
    ).toBe(200);
    // 5 daqiqadan keyin blok tugaydi
    at(mins(s.start, 12));
    expect(
      (
        await ec('post', '/join', null, {
          code: s.code,
          pin: s.pins['Oquvchi 2']!.pin,
          deviceId: DEV_A,
        })
      ).status,
    ).toBe(200);
    const doc = await ExamSession.findById(s.id);
    expect((doc!.joinFailures as { count: number }).count).toBe(5);
    await ExamSession.updateOne({ _id: s.id }, { $set: { 'joinFailures.count': 199 } });
    await ec('post', '/join', null, { code: s.code, pin: 'QQQQQQ', deviceId: 'device-cccccccc' });
    const after = await ExamSession.findById(s.id);
    expect((after!.joinFailures as { alertAt: Date | null }).alertAt).not.toBeNull();
    const att = await adm('get', `/sessions/${s.id}/attempts`, admin);
    expect(att.body.data.joinAlert.failures).toBeGreaterThanOrEqual(200);
    expect(att.body.data.joinAlert.alertAt).not.toBeNull();
  });

  it('oyna qoidalari: boshlanishdan oldin, tugagandan keyin 409; to`liq vaqt berilgan bo`lsa kiradi; status scheduled -> open', async () => {
    const s = await setup();
    at(mins(s.start, -5));
    const early = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/hali boshlanmagan/);
    expect((await ExamSession.findById(s.id))!.status).toBe('scheduled');
    at(mins(s.start, 41));
    const late = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/tugagan/);
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 1']!.key },
      { $set: { 'participants.$.fullTimeGranted': true, 'participants.$.extraMinutes': 5 } },
    );
    const granted = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(granted.status).toBe(200);
    expect(new Date(granted.body.data.exam.deadlinePreview).getTime()).toBe(
      mins(clock.now(), 45).getTime(),
    );
    at(mins(s.start, 1));
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'scheduled' } });
    await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 2']!.pin,
      deviceId: DEV_B,
    });
    const st = await ExamSession.findById(s.id);
    expect(st!.status).toBe('open');
    expect(st!.openedAt).not.toBeNull();
  });

  it('yopilgan/bekor qilingan sessiya kodi ishlamaydi (bir xil xato)', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    expect((await adm('post', `/sessions/${s.id}/close`, admin)).status).toBe(200);
    const r = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(r.status).toBe(401);
  });

  it('bir xil kod boshqa maktabda: PIN to`g`ri sessiyani topadi (maktablar aralashmaydi)', async () => {
    const s = await setup();
    at(mins(s.start, 5));
    // boshqa maktabda bir xil kodli faol sessiya (to'g'ridan-to'g'ri DB)
    await ExamSession.collection.insertOne({
      schoolId: other._id,
      title: 'Boshqa',
      type: 'quiz',
      status: 'open',
      code: s.code,
      codeActive: true,
      classIds: [],
      academicYearId: other._id,
      scheduledStart: s.start,
      durationMin: 40,
      sections: [],
      resultsMode: 'score',
      pinSalt: 'othersalt',
      participants: [],
      questionPool: [],
      isDeleted: false,
      createdBy: other._id,
    });
    const r = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.exam.title).toBe('Sinov imtihoni');
  });
});

describe('qurilma bog`lash', () => {
  it('boshqa qurilma 409; allow-reentry dan keyin o`tadi (bir martalik), eski token bekor', async () => {
    const s = await setup();
    at(mins(s.start, 2));
    const a = await joinAs(s, 'Oquvchi 1', DEV_A);
    const second = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_B,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/Boshqa qurilmada/);
    // o'sha qurilmadan qayta kirish: yangi token, eskisi ishlamaydi
    const again = await joinAs(s, 'Oquvchi 1', DEV_A);
    expect(again.token).not.toBe(a.token);
    expect((await ec('get', '/state', a.token)).status).toBe(401);
    expect((await ec('get', '/state', again.token)).status).toBe(200);
    const key = s.pins['Oquvchi 1']!.key;
    expect(
      (await adm('post', `/sessions/${s.id}/participants/${key}/allow-reentry`, admin)).status,
    ).toBe(200);
    const moved = await joinAs(s, 'Oquvchi 1', DEV_B);
    expect((await ec('get', '/state', again.token)).status).toBe(401);
    expect((await ec('get', '/state', moved.token)).status).toBe(200);
    expect(
      (
        await ec('post', '/join', null, {
          code: s.code,
          pin: s.pins['Oquvchi 1']!.pin,
          deviceId: DEV_A,
        })
      ).status,
    ).toBe(409);
    expect(
      (await ExamSession.findById(s.id))!.participants.find((p) => p.key === key)!.allowReentry,
    ).toBe(false);
    const log = await AuditLog.findOne({ action: 'exam.session.allow_reentry' });
    expect(log).not.toBeNull();
    // ruxsatsiz rol/boshqa maktab
    expect(
      (
        await request(app)
          .post(`/api/v1/exams/sessions/${s.id}/participants/${key}/allow-reentry`)
          .set(bearer(oadmin))
      ).status,
    ).toBe(404);
  });
});

describe('POST /start', () => {
  it('idempotent: ikkinchi chaqiruv bir xil savollar/tartib/deadline; javob kaliti va qiyinlik yo`q', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    const a = await startAs(token);
    const b = await startAs(token);
    expect(a.questions.map((x) => x.id)).toEqual(b.questions.map((x) => x.id));
    expect(a.deadline).toBe(b.deadline);
    expect(a.questions).toHaveLength(6);
    expect(new Date(a.deadline).getTime()).toBe(mins(s.start, 40).getTime());
    expect(await ExamAttempt.countDocuments()).toBe(1);
    const q = a.questions.find((x) => x.type === 'single' && x.options.length === 3)!;
    expect(Object.keys(q).sort()).toEqual(['content', 'id', 'options', 'points', 'type']);
    expect(JSON.stringify(a)).not.toMatch(/difficulty|topicId|subjectId|sharing/);
  });

  it('har ishtirokchiga alohida tartib; qayta kirishda (yangi token) o`sha tartib saqlanadi', async () => {
    const s = await setup({ students: 6 });
    at(mins(s.start, 3));
    const orders: string[] = [];
    for (const n of ['Oquvchi 1', 'Oquvchi 2', 'Oquvchi 3', 'Oquvchi 4']) {
      const { token } = await joinAs(s, n);
      orders.push((await startAs(token)).questions.map((x) => x.id).join());
    }
    expect(new Set(orders).size).toBeGreaterThan(1);
    const { token } = await joinAs(s, 'Oquvchi 1');
    expect((await startAs(token)).questions.map((x) => x.id).join()).toBe(orders[0]);
  });

  it('start kechikkan o`quvchiga faqat qolgan vaqt (umumiy tugash), to`liq vaqt berilsa o`z boshlanishidan', async () => {
    const s = await setup();
    at(mins(s.start, 20));
    const { token } = await joinAs(s, 'Oquvchi 1');
    expect(new Date((await startAs(token)).deadline).getTime()).toBe(mins(s.start, 40).getTime());
    await ExamSession.updateOne(
      { _id: s.id, 'participants.key': s.pins['Oquvchi 2']!.key },
      { $set: { 'participants.$.fullTimeGranted': true } },
    );
    const t2 = await joinAs(s, 'Oquvchi 2', DEV_B);
    expect(new Date((await startAs(t2.token)).deadline).getTime()).toBe(
      mins(s.start, 60).getTime(),
    );
  });

  it('rasm: faqat shu urinish savollaridagi rasm; boshqasi 404; tokensiz 401', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    await startAs(token);
    const img = await request(app)
      .get(`/api/v1/exam-client/assets/${s.assetId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(img.status).toBe(200);
    expect(img.headers['cache-control']).toBe('no-store');
    const foreign = await ExamAsset.create({
      schoolId: other.id,
      hash: 'zz',
      data: Buffer.from('x'),
      size: 1,
    });
    expect(
      (
        await request(app)
          .get(`/api/v1/exam-client/assets/${foreign.id}`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(404);
    const mine = await ExamAsset.create({
      schoolId: school.id,
      hash: 'yy',
      data: Buffer.from('x'),
      size: 1,
    });
    expect(
      (
        await request(app)
          .get(`/api/v1/exam-client/assets/${mine.id}`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(404);
    expect((await request(app).get(`/api/v1/exam-client/assets/${s.assetId}`)).status).toBe(401);
  });
});

describe('PUT /answers', () => {
  it('saqlaydi, clientSeq idempotent, eskirgan seq e`tiborsiz, javoblar birlashadi', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    const st = await startAs(token);
    const sg = st.questions.find((x) => x.type === 'single' && x.options.length === 3)!;
    const sh = st.questions.find((x) => x.type === 'short')!;
    const r1 = await put(token, 1, [{ qid: sg.id, value: 'b' }]);
    expect(r1.body.data).toMatchObject({ savedSeq: 1, answeredCount: 1 });
    const r2 = await put(token, 2, [{ qid: sh.id, value: '12.5', flagged: true }]);
    expect(r2.body.data).toMatchObject({ savedSeq: 2, answeredCount: 2 });
    // eskirgan: o'zgarmaydi
    const stale = await put(token, 1, [{ qid: sg.id, value: 'a' }]);
    expect(stale.status).toBe(200);
    expect(stale.body.data).toMatchObject({ savedSeq: 2, stale: true });
    const doc = (await ExamAttempt.findOne({}))!;
    expect(doc.saved.find((x) => x.qid === sg.id)!.value).toBe('b');
    expect(doc.saved.find((x) => x.qid === sh.id)!.flagged).toBe(true);
    // javobni tozalash
    const cleared = await put(token, 3, [{ qid: sg.id, value: null }]);
    expect(cleared.body.data.answeredCount).toBe(1);
    // resume: state va start javoblarni qaytaradi
    expect((await ec('get', '/state', token)).body.data).toMatchObject({
      status: 'in_progress',
      answeredCount: 1,
      total: 6,
      clientSeq: 3,
    });
    const again = await startAs(token);
    expect(again.saved).toHaveLength(2);
  });

  it('tekshiruvlar: begona savol, noto`g`ri variant, uzun esse, "$" bilan boshlanuvchi matn matn sifatida saqlanadi', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    const st = await startAs(token);
    const sg = st.questions.find((x) => x.type === 'single' && x.options.length === 3)!;
    const es = st.questions.find((x) => x.type === 'essay')!;
    const sh = st.questions.find((x) => x.type === 'short')!;
    expect((await put(token, 1, [{ qid: '64b000000000000000000001', value: 'x' }])).status).toBe(
      400,
    );
    expect((await put(token, 1, [{ qid: sg.id, value: 'zzz' }])).status).toBe(400);
    expect((await put(token, 1, [{ qid: sg.id, value: ['a'] }])).status).toBe(400);
    expect((await put(token, 1, [{ qid: es.id, value: 'x'.repeat(10_001) }])).status).toBe(400);
    expect((await put(token, 1, [{ qid: es.id, value: 'x'.repeat(10_000) }])).status).toBe(200);
    expect((await put(token, 2, [{ qid: sh.id, value: '$where: 1' }])).status).toBe(200);
    expect((await ExamAttempt.findOne({}))!.saved.find((x) => x.qid === sh.id)!.value).toBe(
      '$where: 1',
    );
    expect(
      (await ec('put', '/answers', token, { clientSeq: 3, answers: [], extra: 1 })).status,
    ).toBe(400);
  });

  it('deadline dan keyin (grace dan so`ng) yozuv rad etiladi; topshirilgandan keyin ham', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    const st = await startAs(token);
    const sg = st.questions.find((x) => x.type === 'single' && x.options.length === 3)!;
    at(new Date(new Date(st.deadline).getTime() + 3_000)); // grace ichida
    expect((await put(token, 1, [{ qid: sg.id, value: 'a' }])).status).toBe(200);
    at(new Date(new Date(st.deadline).getTime() + 6_000));
    const late = await put(token, 2, [{ qid: sg.id, value: 'b' }]);
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/tugagan/);
    expect((await ExamAttempt.findOne({}))!.saved[0]!.value).toBe('a');
  });
});

describe('POST /events va /heartbeat', () => {
  it('hodisalar hisoblanadi, ro`yxat 200 bilan cheklangan; heartbeat lastSeenAt ni yangilaydi', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    await startAs(token);
    for (let i = 0; i < 205; i++) {
      await ec('post', '/events', token, {
        type: i % 2 ? 'blur' : 'visibility_hidden',
        at: new Date().toISOString(),
      });
    }
    await ec('post', '/events', token, { type: 'fullscreen_exit' });
    await ec('post', '/events', token, { type: 'reconnect' });
    const a = (await ExamAttempt.findOne({}))!;
    expect(a.events).toHaveLength(200);
    expect(a.counters).toMatchObject({
      blur: 102,
      visibilityHidden: 103,
      fullscreenExit: 1,
      reconnect: 1,
    });
    expect((await ec('post', '/events', token, { type: 'xxx' })).status).toBe(400);
    at(mins(s.start, 4));
    await ec('post', '/heartbeat', token);
    expect((await ExamAttempt.findOne({}))!.lastSeenAt!.getTime()).toBe(mins(s.start, 4).getTime());
    const list = await adm('get', `/sessions/${s.id}/attempts`, admin);
    const row = list.body.data.items.find(
      (x: { key: string }) => x.key === s.pins['Oquvchi 1']!.key,
    );
    expect(row).toMatchObject({ status: 'in_progress', warnings: 205 + 1 - 0, total: 6 });
    expect(
      list.body.data.items.find((x: { key: string }) => x.key === s.pins['Oquvchi 2']!.key).status,
    ).toBe('not_started');
    expect(JSON.stringify(list.body)).not.toMatch(/acceptedAnswers|saved|questionPool/);
  });
});

describe('POST /submit va natija', () => {
  async function answerAll(s: Setup, token: string) {
    await startAs(token);
    // savollarni mazmuni bo'yicha aniqlash uchun admin savol id lariga moslab javob beramiz
    const ans = [
      { qid: s.q.single, value: 'b' }, // to'g'ri (2 ball)
      { qid: s.q.multi, value: ['a'] }, // qisman (2/4)
      { qid: s.q.short, value: ' 12.50 ' }, // normalizatsiya (1)
      { qid: s.q.essay, value: 'Esse matni' }, // kutilmoqda
      { qid: s.q.math, value: '3' }, // xato (0)
      { qid: s.q.image, value: 'b' }, // xato (0)
    ];
    expect((await put(token, 1, ans)).status).toBe(200);
  }

  it('score rejimi: ball, essay kutilmoqda; idempotent; keyin yozuv rad; javob kaliti yo`q', async () => {
    const s = await setup({ resultsMode: 'score' });
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    await answerAll(s, token);
    const r = await ec('post', '/submit', token);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'submitted', mode: 'score', available: true });
    expect(r.body.data.score).toMatchObject({ earned: 5, max: 14, autoMax: 9, essayPending: 1 });
    expect(r.body.data.review).toBeUndefined();
    const again = await ec('post', '/submit', token);
    expect(again.body.data.score).toEqual(r.body.data.score);
    expect(new Date(again.body.data.submittedAt).getTime()).toBe(
      new Date(r.body.data.submittedAt).getTime(),
    );
    expect((await ec('get', '/result', token)).body.data.score.earned).toBe(5);
    expect((await put(token, 2, [{ qid: s.q.single, value: 'a' }])).status).toBe(409);
    expect((await ec('post', '/start', token)).status).toBe(409);
    expect(JSON.stringify(r.body)).not.toMatch(/rubric|Maxfiy|acceptedAnswers/);
    // qayta kirish: topshirilgan holat va natija
    const re = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1']!.pin,
      deviceId: DEV_A,
    });
    expect(re.status).toBe(200);
    expect(re.body.data.attemptStatus).toBe('submitted');
  });

  it('score_answers: to`g`ri javoblar ko`rsatiladi (faqat shu rejimda)', async () => {
    const s = await setup({ resultsMode: 'score_answers' });
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    await answerAll(s, token);
    const r = await ec('post', '/submit', token);
    const review = r.body.data.review as {
      id: string;
      reveal: Record<string, string[]>;
      ok: boolean | null;
    }[];
    expect(review).toHaveLength(6);
    expect(review.find((x) => x.id === s.q.single)!.reveal).toEqual({ optionIds: ['b'] });
    expect(review.find((x) => x.id === s.q.multi)!.reveal.optionIds.sort()).toEqual(['a', 'b']);
    expect(review.find((x) => x.id === s.q.short)!.reveal.texts).toContain('12,5');
    expect(review.find((x) => x.id === s.q.essay)!.reveal).toEqual({});
    expect(JSON.stringify(r.body)).not.toMatch(/Maxfiy|rubric/);
  });

  it('after_publish va never: ball ko`rsatilmaydi', async () => {
    for (const mode of ['after_publish', 'never']) {
      const s = await setup({ resultsMode: mode });
      at(mins(s.start, 3));
      const { token } = await joinAs(s, 'Oquvchi 1');
      await answerAll(s, token);
      const r = await ec('post', '/submit', token);
      expect(r.body.data).toMatchObject({ status: 'submitted', mode, available: false });
      expect(r.body.data.score).toBeUndefined();
      expect((await ExamAttempt.findOne({ sessionId: s.id }))!.score).not.toBeNull(); // ball bazada hisoblangan
    }
  });

  it('sweeper: muddati o`tgan urinish avtomatik topshiriladi va baholanadi; yangi yozuv rad; tugamaganlarga tegmaydi', async () => {
    const s = await setup({ resultsMode: 'score' });
    at(mins(s.start, 3));
    const t1 = await joinAs(s, 'Oquvchi 1');
    await answerAll(s, t1.token);
    const t2 = await joinAs(s, 'Oquvchi 2', DEV_B);
    await startAs(t2.token);
    const deadline = mins(s.start, 40);
    at(new Date(deadline.getTime() + 3_000));
    expect(await runExamSweeper()).toBe(0); // grace ichida
    at(new Date(deadline.getTime() + 10_000));
    expect(await runExamSweeper()).toBe(2);
    const a1 = (await ExamAttempt.findOne({ participantKey: s.pins['Oquvchi 1']!.key }))!;
    expect(a1.status).toBe('auto_submitted');
    expect(a1.submittedAt!.getTime()).toBe(deadline.getTime());
    expect(a1.score).toMatchObject({ earned: 5, max: 14 });
    expect(
      (await ExamAttempt.findOne({ participantKey: s.pins['Oquvchi 2']!.key }))!.score,
    ).toMatchObject({ earned: 0 });
    expect(await runExamSweeper()).toBe(0); // idempotent
    expect((await put(t1.token, 5, [{ qid: s.q.single, value: 'a' }])).status).toBe(409);
    const res = await ec('post', '/submit', t1.token); // qayta topshirish: natija
    expect(res.body.data).toMatchObject({ status: 'auto_submitted', available: true });
  });
});

describe('xavfsizlik', () => {
  it('hamma exam-client javoblarida javob kaliti kalitlari yo`q (natija ko`rinishidan tashqari)', async () => {
    const s = await setup({ resultsMode: 'score' });
    at(mins(s.start, 3));
    await ec('post', '/join', null, { code: s.code, pin: 'BAD123', deviceId: DEV_A });
    const { token } = await joinAs(s, 'Oquvchi 1');
    const st = await startAs(token);
    await put(token, 1, [{ qid: st.questions[0]!.id, value: null }]);
    await ec('get', '/state', token);
    await ec('post', '/events', token, { type: 'blur' });
    await ec('post', '/heartbeat', token);
    await ec('post', '/submit', token);
    await ec('get', '/result', token);
    const forbidden = new Set([
      'answer',
      'correct',
      'acceptedAnswers',
      'rubric',
      'optionId',
      'optionIds',
      'partialCredit',
      'difficulty',
    ]);
    const walk = (v: unknown, path: string, out: string[]) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (forbidden.has(k)) out.push(`${path}.${k}`);
          walk(x, `${path}.${k}`, out);
        }
      }
    };
    const bad: string[] = [];
    for (const r of seen) walk(r, 'res', bad);
    expect(bad).toEqual([]);
    expect(seen.length).toBeGreaterThan(8);
  });

  it('tokensiz/begona/muddati o`tgan token: 401; admin JWT exam-client da yaroqsiz; token admin API da yaroqsiz', async () => {
    const s = await setup();
    at(mins(s.start, 3));
    const { token } = await joinAs(s, 'Oquvchi 1');
    expect((await ec('get', '/state', null)).status).toBe(401);
    expect((await ec('get', '/state', 'x'.repeat(43))).status).toBe(401);
    expect((await ec('get', '/state', admin)).status).toBe(401);
    expect((await request(app).get('/api/v1/exams/sessions').set(bearer(token))).status).toBe(401);
    // client schoolId/sessionId yuborsa e'tiborsiz (strict: 400)
    expect(
      (await ec('put', '/answers', token, { clientSeq: 1, answers: [], schoolId: other.id }))
        .status,
    ).toBe(400);
    await ExamAttempt.updateOne(
      {},
      { $set: { tokenExpiresAt: new Date(clock.now().getTime() - 1000) } },
    );
    expect((await ec('get', '/state', token)).status).toBe(401);
  });

  it('noma`lum yo`l 404, javoblar no-store', async () => {
    const r = await ec('get', '/nope', null);
    expect(r.status).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('maktab o`chirish ro`yxatida examAttempts bor', () => {
    expect(SCHOOL_PURGE_STEPS.map((x) => x.key)).toContain('examAttempts');
  });
});
