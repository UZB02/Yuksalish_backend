import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { AuditLog } from '../src/models/AuditLog';
import { ExamCandidate } from '../src/models/ExamCandidate';
import { ExamSession } from '../src/models/ExamSession';
import { Question } from '../src/models/Question';
import { School } from '../src/models/School';
import { runExamCandidatePurge } from '../src/modules/exams/sessions/candidates.service';
import {
  PIN_ALPHABET,
  decryptPin,
  encryptPin,
  hashPin,
  randomPin,
} from '../src/modules/exams/sessions/pin';
import { canEnter, commonEnd, participantDeadline } from '../src/modules/exams/sessions/timing';
import { SCHOOL_PURGE_STEPS } from '../src/modules/schools/schoolPurge';
import { settingsStore } from '../src/modules/settings/settings.store';
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
let math: Doc, phys: Doc;
let c7a: Doc, c7b: Doc;
let rootId: string;
let root: string, admin: string, oadmin: string, tm: string, tm2: string, tp: string;
let tm2Id: string;
let topic: Doc, ptopic: Doc;
let qs: string[] = [];

const api = (m: 'get' | 'post' | 'patch' | 'delete', url: string, t: string, body?: object) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', school.id);
  return body ? r.send(body) : r;
};
const future = (min = 60) => new Date(Date.now() + min * 60_000).toISOString();
const manual = (ids: string[]) => ({ kind: 'manual', questionIds: ids });
const sec = (...items: object[]) => [{ title: 'Bo‘lim 1', items }];
const mkTopic = async (t: string, subjectId: string, name: string) =>
  (await api('post', `/subjects/${subjectId}/topics`, t, { name })).body.data as Doc;
const mkQ = async (t: string, topicId: string, extra: object = {}) =>
  (
    await api('post', '/questions', t, {
      topicId,
      type: 'short',
      content: [{ type: 'text', text: 'Savol' }],
      answer: { acceptedAnswers: ['1'] },
      status: 'active',
      sharing: { mode: 'subject' },
      ...extra,
    })
  ).body.data.id as string;

const body = (extra: object = {}) => ({
  title: 'Nazorat 1',
  type: 'quiz',
  subjectId: math.id,
  classIds: [c7a.id],
  sections: sec(manual([qs[0]!, qs[1]!])),
  scheduledStart: future(),
  durationMin: 40,
  resultsMode: 'score',
  ...extra,
});
const mkSession = async (t: string, extra: object = {}) => {
  const r = await api('post', '/sessions', t, body(extra));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; participants: unknown[] };
};
const addParts = (t: string, id: string, b: object) =>
  api('post', `/sessions/${id}/participants`, t, b);
const readyStudents = async (n = 3) => {
  for (let i = 0; i < n; i++) await makeStudent(school.id, c7a.id, `O'quvchi ${i + 1}`);
};

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  rootId = rootU.id;
  const tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  const tMath2 = await makeUser({ username: 'tmath2', role: 'teacher', schoolId: school.id });
  const tPhys = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  tm2Id = tMath2.id;
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
  c7b = (await makeClass(school.id, year.id, '7-B')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, tMath.id);
  await assignSubject(school.id, c7b as never, phys.id, tPhys.id);
  await assignSubject(school.id, c7a as never, math.id, tMath2.id);
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  root = (await login('root')).token;
  admin = (await login('admin')).token;
  oadmin = (await login('oadmin')).token;
  tm = (await login('tmath')).token;
  tm2 = (await login('tmath2')).token;
  tp = (await login('tphys')).token;
  topic = await mkTopic(admin, math.id, 'Kasrlar');
  ptopic = await mkTopic(admin, phys.id, 'Kuch');
  qs = [];
  for (let i = 0; i < 4; i++) qs.push(await mkQ(admin, topic.id, { difficulty: i < 2 ? 1 : 2 }));
  qs.push(await mkQ(admin, ptopic.id));
});

describe('Shablonlar: validatsiya va ko`rinish', () => {
  it('preview: qoida mavjud savollar sonini ko`rsatadi; yetmasa ok=false', async () => {
    const ok = await api('post', '/templates/preview', admin, {
      sections: sec({ kind: 'rule', topicId: topic.id, count: 3, difficulty: 1 }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.ok).toBe(false); // faqat 2 ta oson savol
    expect(ok.body.data.sections[0].items[0]).toMatchObject({
      available: 2,
      requested: 3,
      ok: false,
    });
    const good = await api('post', '/templates/preview', admin, {
      sections: sec({ kind: 'rule', topicId: topic.id, count: 4 }, manual([qs[4]!])),
    });
    expect(good.body.data.ok).toBe(true);
    expect(good.body.data.questionsPerParticipant).toBe(5);
  });

  it('qo`lda tanlangan savol o`qituvchiga ko`rinmasa (private boshqa muallifniki) xato', async () => {
    const priv = await mkQ(tm2, topic.id, { sharing: { mode: 'private' } });
    const r = await api('post', '/templates', tm, {
      title: 'Sh',
      subjectId: math.id,
      sections: sec(manual([priv])),
    });
    expect(r.status).toBe(400);
    const ok = await api('post', '/templates', tm2, {
      title: 'Sh',
      subjectId: math.id,
      sections: sec(manual([priv])),
    });
    expect(ok.status).toBe(201);
  });

  it('shablonni o`qituvchi faqat o`zinikini ko`radi; boshqa maktab 404; o`chirish', async () => {
    const t = await api('post', '/templates', tm, {
      title: 'Shablon',
      sections: sec(manual([qs[0]!])),
    });
    expect(t.status).toBe(201);
    expect((await api('get', `/templates/${t.body.data.id}`, tm2)).status).toBe(404);
    expect((await api('get', `/templates/${t.body.data.id}`, oadmin)).status).toBe(404);
    expect((await api('get', '/templates', tm)).body.data).toHaveLength(1);
    expect((await api('delete', `/templates/${t.body.data.id}`, tm)).status).toBe(200);
    expect((await api('get', '/templates', tm)).body.data).toHaveLength(0);
  });
});

describe('Preview: qoralamadagi savollar hisobi', () => {
  it('qoida: faol yetmasa qoralama soni va mavzu id qaytadi; xabarda qoralama eslatiladi', async () => {
    const t2 = await mkTopic(admin, math.id, 'Tenglamalar');
    for (let i = 0; i < 4; i++) await mkQ(admin, t2.id, { status: 'draft' });
    await mkQ(admin, t2.id);
    const r = await api('post', '/templates/preview', admin, {
      sections: sec({ kind: 'rule', topicId: t2.id, count: 3 }),
    });
    const it = r.body.data.sections[0].items[0];
    expect(it).toMatchObject({ available: 1, requested: 3, ok: false, draft: 4, topicId: t2.id });
    expect(r.body.data.errors.join(' ')).toMatch(/Qoralamada 4 ta/);
    // yetarli bo'lsa draft hisoblanmaydi
    const ok = await api('post', '/templates/preview', admin, {
      sections: sec({ kind: 'rule', topicId: t2.id, count: 1 }),
    });
    expect(ok.body.data.sections[0].items[0]).toMatchObject({ ok: true, draft: 0 });
  });

  it('qo`lda tanlangan qoralama savol: draft soni ko`rsatiladi', async () => {
    const d = await mkQ(admin, topic.id, { status: 'draft' });
    const r = await api('post', '/templates/preview', admin, {
      sections: sec(manual([qs[0]!, d])),
    });
    expect(r.body.data.sections[0].items[0]).toMatchObject({
      available: 1,
      requested: 2,
      draft: 1,
      ok: false,
    });
    expect(r.body.data.errors.join(' ')).toMatch(/1 tasi qoralamada/);
  });
});

describe('Imtihon yaratish: rollar', () => {
  it('o`qituvchi o`z sinf+fani uchun quiz yaratadi; boshqa sinf/fan, boshqa tur 403', async () => {
    expect((await api('post', '/sessions', tm, body())).status).toBe(201);
    expect((await api('post', '/sessions', tm, body({ classIds: [c7b.id] }))).status).toBe(403);
    expect((await api('post', '/sessions', tm, body({ subjectId: phys.id }))).status).toBe(403);
    for (const type of ['quarter', 'annual', 'trial', 'admission'])
      expect((await api('post', '/sessions', tm, body({ type }))).status, type).toBe(403);
    // boshqa fan o'qituvchisi (7-B fizika) 7-A matematikada yarata olmaydi
    expect((await api('post', '/sessions', tp, body())).status).toBe(403);
  });

  it('ma`muriyat barcha turlarni yaratadi', async () => {
    for (const type of ['quiz', 'quarter', 'annual', 'trial', 'admission'])
      expect((await api('post', '/sessions', admin, body({ type }))).status, type).toBe(201);
    expect((await api('post', '/sessions', root, body())).status).toBe(201);
  });

  it('teachersCanCreateQuizzes=false -> o`qituvchi 403, ma`muriyat ishlaydi', async () => {
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: true, teachersCanCreateQuizzes: false },
      rootId,
    );
    expect((await api('post', '/sessions', tm, body())).status).toBe(403);
    expect((await api('post', '/sessions', admin, body())).status).toBe(201);
  });

  it('validatsiya: qisqa davomiylik, o`tmishdagi bo`lmagan sana formati, noma`lum maydon', async () => {
    for (const extra of [
      { durationMin: 2 },
      { durationMin: 601 },
      { scheduledStart: '2026-12-01 10:00' },
      { resultsMode: 'xxx' },
      { unknown: 1 },
      { title: '  ' },
    ])
      expect(
        (await api('post', '/sessions', admin, body(extra))).status,
        JSON.stringify(extra),
      ).toBe(400);
  });

  it('boshqa maktab savol/sinfi bilan yaratib bo`lmaydi; boshqa maktab 404', async () => {
    const s = await mkSession(admin);
    expect((await api('get', `/sessions/${s.id}`, oadmin)).status).toBe(404);
    expect((await api('post', `/sessions/${s.id}/submit`, oadmin)).status).toBe(404);
    expect((await api('get', '/sessions', oadmin)).body.data).toHaveLength(0);
  });

  it('o`qituvchi faqat o`zi yaratgan yoki nazoratchi bo`lgan imtihonni ko`radi', async () => {
    const s = await mkSession(tm);
    expect((await api('get', `/sessions/${s.id}`, tm2)).status).toBe(404);
    expect((await api('get', '/sessions', tm2)).body.data).toHaveLength(0);
    await api('patch', `/sessions/${s.id}`, tm, { supervisorIds: [tm2Id] });
    expect((await api('get', `/sessions/${s.id}`, tm2)).status).toBe(200);
    expect((await api('get', '/sessions', tm2)).body.data).toHaveLength(1);
  });

  it('imtihon moduli o`chiq maktabda 403', async () => {
    await settingsStore.set('school', school.id, 'exams', { enabled: false }, rootId);
    expect((await api('get', '/sessions', admin)).status).toBe(403);
    expect((await api('get', '/candidates', admin)).status).toBe(403);
  });
});

describe('Ishtirokchilar va PIN', () => {
  it('sinf -> faqat FAOL o`quvchilar; takror qo`shilmaydi; PIN DTO da yo`q', async () => {
    await readyStudents(3);
    await makeStudent(school.id, c7a.id, 'Chiqib ketgan', { status: 'transferred' });
    await makeStudent(school.id, c7a.id, 'O`chirilgan', { isDeleted: true });
    const s = await mkSession(admin);
    const r = await addParts(admin, s.id, { classIds: [c7a.id] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ added: 3, total: 3 });
    const again = await addParts(admin, s.id, { classIds: [c7a.id] });
    expect(again.body.data).toMatchObject({ added: 0, skipped: 3, total: 3 });

    const d = await api('get', `/sessions/${s.id}`, admin);
    const text = JSON.stringify(d.body);
    for (const p of d.body.data.participants) {
      expect(p.hasPin).toBe(true);
      expect(Object.keys(p)).not.toContain('pin');
      expect(Object.keys(p)).not.toContain('pinEnc');
      expect(Object.keys(p)).not.toContain('pinHash');
    }
    expect(text).not.toMatch(/pinEnc|pinHash|questionPool|acceptedAnswers/);
    const list = await api('get', '/sessions', admin);
    expect(list.body.data[0].participants).toBeUndefined();
  });

  it('PIN lar sessiya ichida noyob, alifbo 0/O/1/I siz; shifrlash aylanadi, boshqa sessiya id da ochilmaydi', async () => {
    await readyStudents(40);
    const s = await mkSession(admin);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    const doc = (await ExamSession.findById(s.id))!;
    const hashes = new Set(doc.participants.map((p) => p.pinHash));
    expect(hashes.size).toBe(40);
    const pins = doc.participants.map((p) => decryptPin(p.pinEnc, s.id)!);
    expect(new Set(pins).size).toBe(40);
    for (const p of pins) {
      expect(p).toHaveLength(6);
      for (const ch of p) expect(PIN_ALPHABET).toContain(ch);
    }
    expect(PIN_ALPHABET).not.toMatch(/[01OIL]/);
    for (const [i, p] of doc.participants.entries())
      expect(hashPin(doc.pinSalt, pins[i]!)).toBe(p.pinHash);
    expect(decryptPin(doc.participants[0]!.pinEnc, '64b000000000000000000001')).toBeNull();
    const e = encryptPin(randomPin(), s.id);
    expect(e).not.toBe(encryptPin(randomPin(), s.id));
  });

  it('mehmon va nomzod faqat ma`muriyat; nomzod faqat kirish imtihoniga', async () => {
    const s = await mkSession(tm);
    expect(
      (await addParts(tm, s.id, { guests: [{ fullName: 'Mehmon Aka', origin: '5-maktab' }] }))
        .status,
    ).toBe(403);
    const a = await mkSession(admin);
    const g = await addParts(admin, a.id, {
      guests: [{ fullName: 'Mehmon Aka', origin: '5-maktab' }],
    });
    expect(g.body.data.added).toBe(1);
    const cand = await api('post', '/candidates', admin, { fullName: 'Nomzod N', targetGrade: 1 });
    expect((await addParts(admin, a.id, { candidateIds: [cand.body.data.id] })).status).toBe(400);
    const adm = await mkSession(admin, { type: 'admission' });
    expect(
      (await addParts(admin, adm.id, { candidateIds: [cand.body.data.id] })).body.data.added,
    ).toBe(1);
  });

  it('o`qituvchi o`z sinfi tashqarisidagi o`quvchini qo`sha olmaydi', async () => {
    const other7b = await makeStudent(school.id, c7b.id, 'Boshqa sinf');
    const s = await mkSession(tm);
    expect((await addParts(tm, s.id, { studentIds: [String(other7b._id)] })).status).toBe(403);
    expect((await addParts(tm, s.id, { classIds: [c7b.id] })).status).toBe(403);
  });

  it('PIN qayta yaratiladi (eskisi o`zgaradi), ishtirokchi olib tashlanadi; audit da PIN yo`q', async () => {
    await readyStudents(2);
    const s = await mkSession(admin);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    const before = (await ExamSession.findById(s.id))!;
    const key = before.participants[0]!.key;
    const oldHash = before.participants[0]!.pinHash;
    expect(
      (await api('post', `/sessions/${s.id}/participants/${key}/regenerate-pin`, admin)).status,
    ).toBe(200);
    const after = (await ExamSession.findById(s.id))!;
    expect(after.participants[0]!.pinHash).not.toBe(oldHash);
    expect(
      (await api('delete', `/sessions/${s.id}/participants/${key}`, admin)).body.data.total,
    ).toBe(1);
    const logs = JSON.stringify(await AuditLog.find({ entity: 'exam_session' }).lean());
    expect(logs).not.toMatch(/pinEnc|pinHash/);
    for (const p of before.participants) {
      expect(logs).not.toContain(decryptPin(p.pinEnc, s.id)!);
      expect(logs).not.toContain(p.pinHash);
    }
  });
});

describe('Holatlar, tasdiq, snapshot, kod', () => {
  const submit = (t: string, id: string) => api('post', `/sessions/${id}/submit`, t);

  it('submit: ishtirokchisiz 400; o`tgan vaqt 400; muvaffaqiyatda scheduled + 6 xonali kod', async () => {
    const s = await mkSession(admin);
    expect((await submit(admin, s.id)).status).toBe(400);
    await readyStudents(2);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    await api('patch', `/sessions/${s.id}`, admin, {
      scheduledStart: new Date(Date.now() - 7_200_000).toISOString(),
      durationMin: 30,
    });
    expect((await submit(admin, s.id)).status).toBe(400);
    await api('patch', `/sessions/${s.id}`, admin, { scheduledStart: future() });
    const r = await submit(admin, s.id);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('scheduled');
    expect(r.body.data.code).toMatch(/^\d{6}$/);
    expect(r.body.data.pool.frozen).toBe(true);
    // rejalashtirilgandan keyin tahrirlab bo'lmaydi
    expect((await api('patch', `/sessions/${s.id}`, admin, { title: 'Yangi' })).status).toBe(409);
  });

  it('snapshot: bankdagi tahrir va o`chirish sessiyaga ta`sir qilmaydi', async () => {
    await readyStudents(1);
    const s = await mkSession(admin);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    await submit(admin, s.id);
    const q0 = (await Question.findById(qs[0]))!;
    await api('patch', `/questions/${qs[0]}`, admin, {
      content: [{ type: 'text', text: 'O‘ZGARDI' }],
      answer: { acceptedAnswers: ['999'] },
    });
    await api('delete', `/questions/${qs[1]}`, admin);
    const doc = (await ExamSession.findById(s.id).select('+questionPool'))!;
    expect(doc.questionPool).toHaveLength(2);
    const p0 = doc.questionPool.find((x) => String(x.questionId) === qs[0])!;
    expect(JSON.stringify(p0.content)).toContain('Savol');
    expect(JSON.stringify(p0.content)).not.toContain('O‘ZGARDI');
    expect(JSON.stringify(p0.answer)).toContain('1');
    expect(JSON.stringify(p0.answer)).not.toContain('999');
    expect(doc.questionPool.some((x) => String(x.questionId) === qs[1])).toBe(true);
    void q0;
    // javob kaliti admin DTO ga chiqmaydi
    expect(JSON.stringify((await api('get', `/sessions/${s.id}`, admin)).body)).not.toMatch(
      /acceptedAnswers|questionPool/,
    );
  });

  it('qoida bo`yicha: eligible savollar poolga tushadi va poolIds saqlanadi', async () => {
    await readyStudents(1);
    const s = await mkSession(admin, {
      sections: sec({ kind: 'rule', topicId: topic.id, count: 2 }),
    });
    await addParts(admin, s.id, { classIds: [c7a.id] });
    await submit(admin, s.id);
    const doc = (await ExamSession.findById(s.id).select('+questionPool'))!;
    expect(doc.questionPool).toHaveLength(4);
    const item = doc.sections[0]!.items[0] as unknown as { poolIds: unknown[] };
    expect(item.poolIds).toHaveLength(4);
  });

  it('kod: faol (scheduled/open) sessiyalar orasida noyob; yopilgach qayta ishlatiladi; to`qnashuvda yangisi', async () => {
    await readyStudents(1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await mkSession(admin, { title: `S${i}` });
      await addParts(admin, s.id, { classIds: [c7a.id] });
      ids.push(s.id);
    }
    const codes: string[] = [];
    for (const id of ids) codes.push((await submit(admin, id)).body.data.code);
    expect(new Set(codes).size).toBe(3);
    // Indeks: bir maktabda bir xil faol kod yozib bo'lmaydi
    const idx = (await ExamSession.collection.indexes()).find(
      (i) => i.name === 'unique_active_exam_code',
    );
    expect(idx?.unique).toBe(true);
    expect(idx?.partialFilterExpression).toEqual({ codeActive: true });
    await expect(
      ExamSession.updateOne({ _id: ids[0] }, { $set: { code: codes[1] } }),
    ).rejects.toThrow(/duplicate|E11000/);
    // yopilgach kod bo'shaydi
    await api('post', `/sessions/${ids[1]}/close`, admin);
    await ExamSession.updateOne({ _id: ids[0] }, { $set: { code: codes[1] } });
    // boshqa maktabda bir xil kod mumkin
    const o = (await ExamSession.findById(ids[2]))!;
    expect(o.codeActive).toBe(true);
  });

  it('tasdiq: teacherQuizNeedsApproval=true -> pending_approval; faqat ma`muriyat tasdiqlaydi/rad etadi', async () => {
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: true, teacherQuizNeedsApproval: true },
      rootId,
    );
    await readyStudents(1);
    const s = await mkSession(tm);
    await addParts(tm, s.id, { classIds: [c7a.id] });
    const sub = await submit(tm, s.id);
    expect(sub.body.data.status).toBe('pending_approval');
    expect(sub.body.data.code).toBeNull();
    expect((await api('post', `/sessions/${s.id}/open`, tm)).status).toBe(409);
    expect((await api('post', `/sessions/${s.id}/approve`, tm)).status).toBe(403);
    expect((await api('post', `/sessions/${s.id}/reject`, tm, { reason: 'x' })).status).toBe(403);
    // rad etish: sabab majburiy
    expect((await api('post', `/sessions/${s.id}/reject`, admin, {})).status).toBe(400);
    const rej = await api('post', `/sessions/${s.id}/reject`, admin, { reason: 'Savollar kam' });
    expect(rej.body.data).toMatchObject({ status: 'draft' });
    expect(rej.body.data.approval).toMatchObject({ status: 'rejected', reason: 'Savollar kam' });
    await submit(tm, s.id);
    const ap = await api('post', `/sessions/${s.id}/approve`, admin);
    expect(ap.status).toBe(200);
    expect(ap.body.data.status).toBe('scheduled');
    expect(ap.body.data.approval.status).toBe('approved');
    expect(ap.body.data.code).toMatch(/^\d{6}$/);
  });

  it('tasdiq o`chiq bo`lsa o`qituvchi imtihoni to`g`ridan-to`g`ri scheduled; ma`muriyatga tasdiq kerak emas', async () => {
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: true, teacherQuizNeedsApproval: true },
      rootId,
    );
    await readyStudents(1);
    const a = await mkSession(admin);
    await addParts(admin, a.id, { classIds: [c7a.id] });
    expect((await submit(admin, a.id)).body.data.status).toBe('scheduled');
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: true, teacherQuizNeedsApproval: false },
      rootId,
    );
    const s = await mkSession(tm);
    await addParts(tm, s.id, { classIds: [c7a.id] });
    expect((await submit(tm, s.id)).body.data.status).toBe('scheduled');
  });

  it('open/close/cancel va o`chirish qoidalari', async () => {
    await readyStudents(1);
    const s = await mkSession(admin);
    expect((await api('delete', `/sessions/${s.id}`, tp)).status).toBe(404);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    await submit(admin, s.id);
    expect((await api('delete', `/sessions/${s.id}`, admin)).status).toBe(409);
    expect((await api('post', `/sessions/${s.id}/open`, admin)).body.data.status).toBe('open');
    expect((await api('post', `/sessions/${s.id}/open`, admin)).status).toBe(409);
    expect((await api('post', `/sessions/${s.id}/close`, admin)).body.data.status).toBe('closed');
    const c = await mkSession(admin);
    expect(
      (await api('post', `/sessions/${c.id}/cancel`, admin, { reason: 'Sabab' })).body.data.status,
    ).toBe('cancelled');
    expect((await api('delete', `/sessions/${c.id}`, admin)).status).toBe(200);
    expect((await api('get', `/sessions/${c.id}`, admin)).status).toBe(404);
  });

  it('audit: yozuvlar bor, savol/javob kaliti yo`q', async () => {
    await readyStudents(1);
    const s = await mkSession(admin);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    await submit(admin, s.id);
    const actions = (await AuditLog.find({ entity: 'exam_session' }).lean()).map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'exam.session.create',
        'exam.session.participants_add',
        'exam.session.submit',
      ]),
    );
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toMatch(/acceptedAnswers/);
  });
});

describe('Individual vaqt (grant) va vaqt qoidalari', () => {
  it('faqat superadmin yoki nazoratchi bera oladi; boshqa o`qituvchi/ma`muriyat (nazoratchi bo`lmasa) 403/404', async () => {
    await readyStudents(1);
    const s = await mkSession(tm, { supervisorIds: [tm2Id] });
    await addParts(tm, s.id, { classIds: [c7a.id] });
    await api('post', `/sessions/${s.id}/submit`, tm);
    const key = (await ExamSession.findById(s.id))!.participants[0]!.key;
    const url = `/sessions/${s.id}/participants/${key}/grant`;
    expect((await api('post', url, tp, { fullTime: true })).status).toBe(404); // ko'rmaydi
    expect((await api('post', url, tm2, { fullTime: true, extraMinutes: 10 })).status).toBe(200);
    expect((await api('post', url, root, { extraMinutes: 5 })).body.data).toMatchObject({
      fullTimeGranted: true,
      extraMinutes: 5,
    });
    // yaratuvchi (nazoratchi sifatida avtomatik qo'shilgan) ham bera oladi
    expect((await api('post', url, tm, { fullTime: false })).status).toBe(200);
    // nazoratchi bo'lmagan ma'muriyat: spetsifikatsiya bo'yicha 403
    expect((await api('post', url, admin, { fullTime: true })).status).toBe(403);
    expect((await api('post', url, tm, { extraMinutes: 999 })).status).toBe(400);
    expect((await api('post', url, oadmin, { fullTime: true })).status).toBe(404);
  });

  it('timing: umumiy tugash, kirish oynasi va deadline', () => {
    const s = { scheduledStart: new Date('2026-12-01T05:00:00Z'), durationMin: 40 };
    const none = { fullTimeGranted: false, extraMinutes: 0 };
    const full = { fullTimeGranted: true, extraMinutes: 5 };
    expect(commonEnd(s).toISOString()).toBe('2026-12-01T05:40:00.000Z');
    expect(canEnter(s, none, new Date('2026-12-01T04:59:00Z'))).toBe(false);
    expect(canEnter(s, none, new Date('2026-12-01T05:10:00Z'))).toBe(true);
    expect(canEnter(s, none, new Date('2026-12-01T05:40:00Z'))).toBe(false);
    expect(canEnter(s, full, new Date('2026-12-01T05:50:00Z'))).toBe(true);
    const late = new Date('2026-12-01T05:20:00Z');
    expect(participantDeadline(s, none, late).toISOString()).toBe('2026-12-01T05:40:00.000Z');
    expect(participantDeadline(s, full, late).toISOString()).toBe('2026-12-01T06:05:00.000Z');
  });
});

describe('PIN varaqasi (PDF)', () => {
  it('PDF: content-type, bo`sh emas, kod/ism ichida; draft da 409; sinf filtri; audit sonlar bilan', async () => {
    await readyStudents(3);
    const s = await mkSession(admin);
    await addParts(admin, s.id, { classIds: [c7a.id] });
    expect((await api('get', `/sessions/${s.id}/pin-sheet`, admin)).status).toBe(409);
    await api('post', `/sessions/${s.id}/submit`, admin);
    const res = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/pin-sheet`)
      .set(bearer(admin))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const empty = await api('get', `/sessions/${s.id}/pin-sheet?class=9-Z`, admin);
    expect(empty.status).toBe(200);
    // boshqa o'qituvchi / boshqa maktab
    expect((await api('get', `/sessions/${s.id}/pin-sheet`, tm2)).status).toBe(404);
    expect((await api('get', `/sessions/${s.id}/pin-sheet`, oadmin)).status).toBe(404);
    const logs = await AuditLog.find({ action: 'exam.session.pin_sheet' })
      .sort({ createdAt: 1 })
      .lean();
    expect(logs.map((l) => (l.after as { count: number }).count)).toEqual([3, 0]);
  });

  it('EXAM_PIN_SECRET yo`q bo`lsa PIN yaratish 503 (meta ham xabar beradi)', async () => {
    const saved = env.EXAM_PIN_SECRET;
    (env as { EXAM_PIN_SECRET?: string }).EXAM_PIN_SECRET = undefined;
    try {
      const s = await mkSession(admin);
      await makeStudent(school.id, c7a.id, 'X Y');
      expect((await addParts(admin, s.id, { classIds: [c7a.id] })).status).toBe(503);
      expect((await api('get', '/sessions/meta', admin)).body.data.pinSecretConfigured).toBe(false);
    } finally {
      (env as { EXAM_PIN_SECRET?: string }).EXAM_PIN_SECRET = saved;
    }
  });
});

describe('Nomzodlar: PII maska va saqlash muddati', () => {
  it('ro`yxatda telefon maskalangan, batafsilda to`liq; o`qituvchi 403; boshqa maktab 404', async () => {
    const c = await api('post', '/candidates', admin, {
      fullName: 'Nomzod Bir',
      birthDate: '2014-05-06',
      targetGrade: 1,
      parentPhone: '+998901234567',
      notes: 'izoh',
    });
    expect(c.status).toBe(201);
    const list = await api('get', '/candidates', admin);
    expect(list.body.data[0].parentPhone).not.toContain('1234567');
    expect(list.body.data[0].parentPhone).toContain('*');
    expect(list.body.data[0].birthDate).toBeNull();
    const det = await api('get', `/candidates/${c.body.data.id}`, admin);
    expect(det.body.data.parentPhone).toBe('+998901234567');
    expect((await api('get', '/candidates', tm)).status).toBe(403);
    expect((await api('get', `/candidates/${c.body.data.id}`, oadmin)).status).toBe(404);
    const logs = JSON.stringify(await AuditLog.find({ entity: 'exam_candidate' }).lean());
    expect(logs).not.toContain('998901234567');
    expect(
      (await api('post', '/candidates', admin, { fullName: 'A', parentPhone: 'abc' })).status,
    ).toBe(400);
  });

  it('imtihoniga qo`shilgan nomzodni o`chirib bo`lmaydi', async () => {
    const c = await api('post', '/candidates', admin, { fullName: 'Nomzod Ikki' });
    const adm = await mkSession(admin, { type: 'admission' });
    await addParts(admin, adm.id, { candidateIds: [c.body.data.id] });
    expect((await api('delete', `/candidates/${c.body.data.id}`, admin)).status).toBe(409);
  });

  it('retention job: muddat o`tgan nomzodning telefon/tug`ilgan sanasi tozalanadi, ism qoladi; faol imtihoni bor-ku tegilmaydi', async () => {
    await settingsStore.set(
      'school',
      school.id,
      'exams',
      { enabled: true, candidateRetentionDays: 30 },
      rootId,
    );
    const old = await api('post', '/candidates', admin, {
      fullName: 'Eski',
      parentPhone: '+998901111111',
      birthDate: '2014-01-01',
    });
    const fresh = await api('post', '/candidates', admin, {
      fullName: 'Yangi',
      parentPhone: '+998902222222',
    });
    const live = await api('post', '/candidates', admin, {
      fullName: 'Faol',
      parentPhone: '+998903333333',
    });
    const adm = await mkSession(admin, { type: 'admission' });
    await addParts(admin, adm.id, { candidateIds: [live.body.data.id] });
    const past = new Date(Date.now() - 90 * 86_400_000);
    await ExamCandidate.collection.updateMany({}, { $set: { createdAt: past } });
    await ExamCandidate.collection.updateOne(
      { _id: new Types.ObjectId(fresh.body.data.id) },
      { $set: { createdAt: new Date() } },
    );
    const n = await runExamCandidatePurge();
    expect(n).toBe(1);
    const o = (await ExamCandidate.findById(old.body.data.id))!;
    expect(o.fullName).toBe('Eski');
    expect(o.parentPhone).toBeNull();
    expect(o.birthDate).toBeNull();
    expect(o.piiPurgedAt).not.toBeNull();
    expect((await ExamCandidate.findById(fresh.body.data.id))!.parentPhone).toBe('+998902222222');
    expect((await ExamCandidate.findById(live.body.data.id))!.parentPhone).toBe('+998903333333');
    expect(await runExamCandidatePurge()).toBe(0); // idempotent
  });
});

describe('Maktab o`chirish reestri', () => {
  it('yangi modellar schoolPurge da ro`yxatdan o`tgan', () => {
    const names = SCHOOL_PURGE_STEPS.map((s) => s.key);
    for (const n of ['examSessions', 'examTemplates', 'examCandidates']) expect(names).toContain(n);
  });
  it('maktab o`chirilganda imtihon ma`lumotlari ham tozalanadi (maktab hujjati bor)', async () => {
    expect(await School.countDocuments({ _id: other.id })).toBe(1);
  });
});
