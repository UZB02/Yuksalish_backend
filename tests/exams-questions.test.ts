import { Types } from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ClassSubject } from '../src/models/ClassSubject';
import { ExamTopic } from '../src/models/ExamTopic';
import { Question } from '../src/models/Question';
import { User } from '../src/models/User';
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
let year: Awaited<ReturnType<typeof makeYear>>;
let math: Doc, phys: Doc;
let tMath: Doc, tPhys: Doc;
let root: string, admin: string, otherAdmin: string, tm: string, tp: string, plain: string;

const hdr = (token: string, schoolId?: string) =>
  schoolId ? { ...bearer(token), 'X-School-Id': schoolId } : bearer(token);

const opt = (id: string, text: string) => ({ id, content: [{ type: 'text', text }] });
/** Mavzular: fan id -> mavzu id (beforeEach da yaratiladi) */
const topicOf: Record<string, string> = {};
let math2Topic = '';
const mkTopic = (schoolId: string, subjectId: string, name: string, createdBy: string) =>
  ExamTopic.create({ schoolId, subjectId, name, nameKey: name.toLowerCase(), createdBy });

const single = (subjectId: string, extra: Record<string, unknown> = {}) => ({
  topicId: topicOf[subjectId],
  type: 'single',
  content: [{ type: 'text', text: '2+2 nechiga teng?' }],
  options: [opt('a', '3'), opt('b', '4'), opt('c', '5')],
  answer: { optionId: 'b' },
  ...extra,
});

const post = (token: string, body: unknown, schoolId?: string) =>
  request(app)
    .post('/api/v1/exams/questions')
    .set(hdr(token, schoolId))
    .send(body as object);
const getQ = (token: string, id: string, schoolId?: string) =>
  request(app).get(`/api/v1/exams/questions/${id}`).set(hdr(token, schoolId));
const patch = (token: string, id: string, body: unknown) =>
  request(app)
    .patch(`/api/v1/exams/questions/${id}`)
    .set(bearer(token))
    .send(body as object);
const act = (token: string, id: string, action: string) =>
  request(app).post(`/api/v1/exams/questions/${id}/${action}`).set(bearer(token));
const del = (token: string, id: string) =>
  request(app).delete(`/api/v1/exams/questions/${id}`).set(bearer(token));
const list = (token: string, qs = '', schoolId?: string) =>
  request(app).get(`/api/v1/exams/questions${qs}`).set(hdr(token, schoolId));

async function enable(schoolId: string, userId: string) {
  await settingsStore.set('school', schoolId, 'exams', { enabled: true }, userId);
}

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  const otherYear = await makeYear(other.id);
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tPhys = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['exams.manage'],
  });
  await makeUser({
    username: 'plain',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  await makeUser({
    username: 'oadmin',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['exams.manage'],
  });
  topicOf[math.id] = (await mkTopic(school.id, math.id, 'Kasrlar', rootU.id)).id;
  math2Topic = (await mkTopic(school.id, math.id, 'Tenglamalar', rootU.id)).id;
  topicOf[phys.id] = (await mkTopic(school.id, phys.id, 'Kinematika', rootU.id)).id;
  const c1 = await makeClass(school.id, year.id, '7-A');
  const c2 = await makeClass(school.id, year.id, '7-B');
  await assignSubject(school.id, c1 as never, math.id, tMath.id);
  await assignSubject(school.id, c2 as never, phys.id, tPhys.id);
  void otherYear;
  await enable(school.id, rootU.id);
  await enable(other.id, rootU.id);
  root = (await login('root')).token;
  admin = (await login('admin')).token;
  plain = (await login('plain')).token;
  otherAdmin = (await login('oadmin')).token;
  tm = (await login('tmath')).token;
  tp = (await login('tphys')).token;
});

describe('Imtihon moduli yoqilmagan maktabda barcha endpointlar 403', () => {
  it("o'qituvchi (exams.questions doim bor), maktab admini va superadmin: hammasi 403", async () => {
    const off = await makeSchool('off');
    await makeUser({ username: 'toff', role: 'teacher', schoolId: off.id });
    await makeUser({
      username: 'aoff',
      role: 'school_admin',
      schoolId: off.id,
      permissions: ['exams.manage'],
    });
    const toff = (await login('toff')).token;
    const aoff = (await login('aoff')).token;
    const fake = '64b000000000000000000001';
    const calls = (token: string, sid?: string) => {
      const h = hdr(token, sid);
      const r = (m: 'get' | 'post' | 'patch' | 'delete', p: string) =>
        request(app)[m](`/api/v1/exams${p}`).set(h).send({});
      return [
        r('get', '/subjects'),
        r('get', `/subjects/${fake}/topics`),
        r('post', `/subjects/${fake}/topics`),
        r('get', `/topics/${fake}`),
        r('patch', `/topics/${fake}`),
        r('delete', `/topics/${fake}`),
        r('post', '/topics/reorder'),
        r('get', '/questions'),
        r('post', '/questions'),
        r('get', `/questions/${fake}`),
        r('patch', `/questions/${fake}`),
        r('post', `/questions/${fake}/archive`),
        r('post', `/questions/${fake}/restore`),
        r('post', `/questions/${fake}/duplicate`),
        r('delete', `/questions/${fake}`),
        r('post', '/assets'),
        r('get', `/assets/${fake}`),
      ];
    };
    for (const [who, token, sid] of [
      ['teacher', toff, undefined],
      ['school_admin', aoff, undefined],
      ['superadmin', root, off.id],
    ] as const) {
      const results = await Promise.all(calls(token, sid));
      results.forEach((res, i) => expect(res.status, `${who} #${i}`).toBe(403));
    }
  });

  it('autentifikatsiyasiz 401, ruxsatsiz maktab admini (yoqilgan maktab) 403', async () => {
    expect((await request(app).get('/api/v1/exams/questions')).status).toBe(401);
    expect((await list(plain)).status).toBe(403);
  });

  it('superadmin X-School-Id siz 400', async () => {
    expect((await list(root)).status).toBe(400);
  });
});

describe("O'qituvchi doirasi (ClassSubject bo'yicha)", () => {
  it("o'z fani bo'yicha yaratadi, boshqa fan 403", async () => {
    const ok = await post(tm, single(math.id));
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      status: 'draft',
      isMine: true,
      canEdit: true,
      version: 1,
    });
    expect((await post(tm, single(phys.id))).status).toBe(403);
  });

  it("faol bo'lmagan o'quv yilidagi ClassSubject hisobga olinmaydi", async () => {
    const old = await makeYear(school.id, '2025-2026', false);
    const cls = await makeClass(school.id, old.id, '9-A');
    const t = await makeUser({ username: 'told', role: 'teacher', schoolId: school.id });
    await assignSubject(school.id, cls as never, math.id, t.id);
    const { token } = await login('told');
    expect((await post(token, single(math.id))).status).toBe(403);
    const subj = await request(app).get('/api/v1/exams/subjects').set(bearer(token));
    expect(subj.body.data).toMatchObject({ scope: 'own', subjects: [] });
  });

  it("/subjects: o'qituvchiga faqat o'z fanlari, ma'muriyatga hammasi", async () => {
    const a = await request(app).get('/api/v1/exams/subjects').set(bearer(tm));
    expect(a.body.data.scope).toBe('own');
    expect(a.body.data.subjects.map((s: { name: string }) => s.name)).toEqual(['Matematika']);
    const b = await request(app).get('/api/v1/exams/subjects').set(bearer(admin));
    expect(b.body.data.scope).toBe('all');
    expect(b.body.data.subjects.length).toBeGreaterThanOrEqual(2);
  });

  it("ko'rinish: o'z savollari; ulashilmagan (private) boshqa muallif savoli yo'q (faol bo'lsa ham)", async () => {
    const own = (await post(tm, single(math.id))).body.data.id;
    const adminDraft = (await post(admin, single(math.id))).body.data.id;
    const adminActive = (await post(admin, single(math.id, { status: 'active' }))).body.data.id;
    const physQ = (await post(admin, single(phys.id, { status: 'active' }))).body.data.id;

    const ids = (await list(tm)).body.data.map((q: { id: string }) => q.id);
    expect(ids).toEqual([own]);
    expect((await getQ(tm, adminDraft)).status).toBe(404);
    expect((await getQ(tm, adminActive)).status).toBe(404);
    expect((await getQ(tm, physQ)).status).toBe(404);
    expect((await getQ(tp, physQ)).status).toBe(404);

    // Ma'muriyat hammasini ko'radi
    const all = (await list(admin)).body.data.map((q: { id: string }) => q.id);
    expect(all).toEqual(expect.arrayContaining([own, adminDraft, adminActive, physQ]));
  });

  it("hamkasbga ulashilgan savol: to'liq (kalit bilan) ko'rinadi, tahrir/arxiv/o'chirish/ulashishni o'zgartirish 403, nusxa olish mumkin", async () => {
    const tm2 = await makeUser({ username: 'tm2', role: 'teacher', schoolId: school.id });
    const c = await makeClass(school.id, year.id, '8-A');
    await assignSubject(school.id, c as never, math.id, tm2.id);
    const t2 = (await login('tm2')).token;
    const id = (
      await post(
        tm,
        single(math.id, { status: 'active', sharing: { mode: 'subject', userIds: [] } }),
      )
    ).body.data.id;
    const r = await getQ(t2, id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      canEdit: false,
      sharedWithMe: true,
      answer: { optionId: 'b' },
    });
    expect(r.body.data).not.toHaveProperty('sharing'); // ulashish sozlamasini faqat muallif ko'radi
    expect((await patch(t2, id, { points: 5 })).status).toBe(403);
    expect((await patch(t2, id, { sharing: { mode: 'private' } })).status).toBe(403);
    expect((await act(t2, id, 'archive')).status).toBe(403);
    expect((await del(t2, id)).status).toBe(403);
    const copy = await act(t2, id, 'duplicate');
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({
      status: 'draft',
      isMine: true,
      canEdit: true,
      isShared: false,
      version: 1,
      sharing: { mode: 'private', userIds: [] },
      answer: { optionId: 'b' },
    });
    expect(await Question.countDocuments({ _id: id, status: 'active' })).toBe(1);
  });

  it("ulashish rejimlari: 'subject' faqat shu fanni o'qitadiganlarga, 'users' tanlanganlarga (fan shart emas), private qaytarilsa yopiladi", async () => {
    const tm2 = await makeUser({ username: 'tm2', role: 'teacher', schoolId: school.id });
    const c = await makeClass(school.id, year.id, '8-A');
    await assignSubject(school.id, c as never, math.id, tm2.id);
    const t2 = (await login('tm2')).token;
    const id = (await post(tm, single(math.id, { status: 'active' }))).body.data.id;
    expect((await getQ(t2, id)).status).toBe(404);

    // subject: fizika o'qituvchisi ko'rmaydi
    expect((await patch(tm, id, { sharing: { mode: 'subject' } })).body.data.sharing.mode).toBe(
      'subject',
    );
    expect((await getQ(t2, id)).status).toBe(200);
    expect((await getQ(tp, id)).status).toBe(404);
    // arxivlangach ulashilgan ko'rinmaydi
    await act(tm, id, 'archive');
    expect((await getQ(t2, id)).status).toBe(404);
    await act(tm, id, 'restore');

    // users: fizika o'qituvchisini tanlaymiz (fanni o'qitmasa ham ko'radi), tm2 endi ko'rmaydi
    const sh = await patch(tm, id, { sharing: { mode: 'users', userIds: [tPhys.id] } });
    expect(sh.status).toBe(200);
    expect(sh.body.data.sharing).toEqual({ mode: 'users', userIds: [tPhys.id] });
    expect((await getQ(tp, id)).status).toBe(200);
    expect((await getQ(t2, id)).status).toBe(404);
    // fan o'qituvchisi bo'lmagan ulashilgan nusxa ola olmaydi (fan unga biriktirilmagan)
    expect((await act(tp, id, 'duplicate')).status).toBe(403);

    // private: yana yopiladi
    await patch(tm, id, { sharing: { mode: 'private' } });
    expect((await getQ(tp, id)).status).toBe(404);
  });

  it("ulashish tekshiruvi: 'users' bo'sh, boshqa maktab o'qituvchisi, nofaol o'qituvchi, o'qituvchi bo'lmagan, noto'g'ri rejim", async () => {
    const foreign = await makeUser({ username: 'tforeign', role: 'teacher', schoolId: other.id });
    const off = await makeUser({
      username: 'toff2',
      role: 'teacher',
      schoolId: school.id,
      isActive: false,
    });
    const bad = (sharing: unknown) => post(tm, single(math.id, { sharing }));
    expect((await bad({ mode: 'users', userIds: [] })).status).toBe(400);
    expect((await bad({ mode: 'users', userIds: [foreign.id] })).status).toBe(400);
    expect((await bad({ mode: 'users', userIds: [off.id] })).status).toBe(400);
    expect(
      (await bad({ mode: 'users', userIds: [(await User.findOne({ username: 'admin' }))!.id] }))
        .status,
    ).toBe(400);
    expect((await bad({ mode: 'public' })).status).toBe(400);
    expect((await bad({ mode: 'subject', extra: 1 })).status).toBe(400);
    // 'subject'/'private' da userIds tozalanadi
    const ok = await bad({ mode: 'subject', userIds: [tPhys.id] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.sharing).toEqual({ mode: 'subject', userIds: [] });
  });

  it("'Menga ulashilgan' filtri va eski (sharing maydonsiz) hujjat = private", async () => {
    const id = (
      await post(
        tp,
        single(phys.id, { status: 'active', sharing: { mode: 'users', userIds: [tMath.id] } }),
      )
    ).body.data.id;
    const mine = (await post(tm, single(math.id))).body.data.id;
    const shared = (await list(tm, '?shared=true')).body.data;
    expect(shared.map((q: { id: string }) => q.id)).toEqual([id]);
    expect(shared[0]).toMatchObject({ isShared: true, sharedWithMe: true });
    expect((await list(tm)).body.data.map((q: { id: string }) => q.id).sort()).toEqual(
      [id, mine].sort(),
    );
    // Legacy hujjat: sharing maydoni yo'q
    await Question.collection.updateOne(
      { _id: new Types.ObjectId(mine) },
      { $unset: { sharing: '' } },
    );
    expect((await getQ(tp, mine)).status).toBe(404);
    expect((await getQ(tm, mine)).body.data).toMatchObject({
      isShared: false,
      sharing: { mode: 'private', userIds: [] },
    });
  });

  it("ulashish o'zgarishi audit'ga xulosa bilan yoziladi (versiya oshmaydi)", async () => {
    const id = (await post(tm, single(math.id))).body.data.id;
    const r = await patch(tm, id, { sharing: { mode: 'users', userIds: [tPhys.id] } });
    expect(r.body.data.version).toBe(1);
    const log = await AuditLog.findOne({ action: 'exam.question.update' }).lean();
    expect(log?.after).toMatchObject({ sharingMode: 'users', sharedCount: 1 });
    expect((log?.after as { changed: string[] }).changed).toContain('sharing');
    expect(JSON.stringify(log)).not.toContain(tPhys.id);
  });

  it("o'z savolini tahrirlaydi, ammo fanini boshqa (o'qitmaydigan) fanga ko'chira olmaydi", async () => {
    const id = (await post(tm, single(math.id))).body.data.id;
    // Shu fan ichida boshqa mavzuga ko'chirish mumkin; boshqa fanga (o'qitmaydigan) - 403
    expect((await patch(tm, id, { topicId: math2Topic })).body.data.topicId).toBe(math2Topic);
    expect((await patch(tm, id, { topicId: topicOf[phys.id] })).status).toBe(403);
    expect((await patch(tm, id, { subjectId: phys.id })).status).toBe(400); // subjectId endi yo'q (strict)
  });

  it("o'qituvchi fanni o'qitishdan chiqsa o'z savollarini ham ko'rmaydi (doira)", async () => {
    const id = (await post(tm, single(math.id))).body.data.id;
    await ClassSubject.deleteMany({ teacherId: tMath.id });
    expect((await getQ(tm, id)).status).toBe(404);
  });
});

describe('Maktablar izolyatsiyasi', () => {
  it('boshqa maktab savoliga 404 (get/patch/archive/delete/duplicate), ro`yxatda ko`rinmaydi', async () => {
    const id = (await post(admin, single(math.id, { status: 'active' }))).body.data.id;
    expect((await getQ(otherAdmin, id)).status).toBe(404);
    expect((await patch(otherAdmin, id, { points: 3 })).status).toBe(404);
    expect((await act(otherAdmin, id, 'archive')).status).toBe(404);
    expect((await act(otherAdmin, id, 'duplicate')).status).toBe(404);
    expect((await del(otherAdmin, id)).status).toBe(404);
    expect((await list(otherAdmin)).body.data).toEqual([]);
    // Superadmin boshqa maktab kontekstida ham 404
    expect((await getQ(root, id, other.id)).status).toBe(404);
    expect((await getQ(root, id, school.id)).status).toBe(200);
  });

  it("boshqa maktab fani (shaxsiy) bilan savol yaratib bo'lmaydi", async () => {
    const foreign = await makeSubject('Begona fan', other.id);
    // Boshqa maktab fani uchun mavzu yaratib bo'lmaydi
    const t = await request(app)
      .post(`/api/v1/exams/subjects/${foreign.id}/topics`)
      .set(bearer(admin))
      .send({ name: 'X' });
    expect(t.status).toBe(404);
    // Boshqa maktab mavzusiga savol yaratib bo'lmaydi (mavzu topilmadi)
    const ot = await mkTopic(
      other.id,
      math.id,
      'Boshqa',
      (await User.findOne({ username: 'oadmin' }))!.id,
    );
    expect((await post(admin, single(math.id, { topicId: ot.id }))).status).toBe(400);
    const own = await makeSubject('Shaxmat', school.id);
    const ownTopic = await mkTopic(
      school.id,
      own.id,
      'Ochilish',
      (await User.findOne({ username: 'admin' }))!.id,
    );
    expect((await post(admin, single(own.id, { topicId: ownTopic.id }))).status).toBe(201);
  });
});

describe('Validatsiya', () => {
  const bad = async (body: unknown, path?: string) => {
    const res = await post(admin, body);
    expect(res.status).toBe(400);
    if (path) {
      expect(res.body.error.details.map((d: { path: string }) => d.path).join('|')).toContain(path);
    }
    return res;
  };

  it("HTML kiritilmaydi: noma'lum blok turi va qo'shimcha maydonlar rad etiladi", async () => {
    await bad(single(math.id, { content: [{ type: 'html', html: '<b>x</b>' }] }));
    await bad(single(math.id, { content: [{ type: 'text', text: 'x', html: '<b>x</b>' }] }));
    await bad(single(math.id, { content: [{ type: 'math', tex: 'x', text: 'y' }] }));
    await bad(single(math.id, { html: '<p>x</p>' }));
    await bad(single(math.id, { authorId: '64b000000000000000000001' }));
    await bad(single(math.id, { schoolId: other.id }));
  });

  it("HTML ko'rinishidagi matn oddiy matn sifatida o'zgarishsiz saqlanadi", async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const res = await post(admin, single(math.id, { content: [{ type: 'text', text: evil }] }));
    expect(res.status).toBe(201);
    expect(res.body.data.content).toEqual([{ type: 'text', text: evil }]);
    const stored = await Question.findById(res.body.data.id).lean();
    expect(stored?.content[0]).toMatchObject({ type: 'text', text: evil });
    expect(JSON.stringify(stored)).not.toContain('"html"');
  });

  it('bo`sh blok, uzun matn, formula limiti, boshqaruv belgisi', async () => {
    await bad(single(math.id, { content: [] }), 'content');
    await bad(single(math.id, { content: [{ type: 'text', text: '   ' }] }));
    await bad(single(math.id, { content: [{ type: 'text', text: 'x'.repeat(5001) }] }));
    await bad(single(math.id, { content: [{ type: 'math', tex: 'x'.repeat(2001) }] }));
    await bad(single(math.id, { content: [{ type: 'text', text: 'a\u0000b' }] }));
    await bad(
      single(math.id, { content: Array.from({ length: 31 }, () => ({ type: 'text', text: 'x' })) }),
    );
    expect(
      (await post(admin, single(math.id, { content: [{ type: 'text', text: 'x'.repeat(5000) }] })))
        .status,
    ).toBe(201);
  });

  it("variantlar: 10 tadan ko'p, 2 tadan kam, takroriy id, to'g'ri javob ro'yxatda yo'q", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => opt(`o${i}`, `v${i}`));
    await bad(single(math.id, { options: eleven, answer: { optionId: 'o1' } }), 'options');
    const ten = Array.from({ length: 10 }, (_, i) => opt(`o${i}`, `v${i}`));
    expect(
      (await post(admin, single(math.id, { options: ten, answer: { optionId: 'o9' } }))).status,
    ).toBe(201);
    await bad(single(math.id, { options: [opt('a', 'x')], answer: { optionId: 'a' } }), 'options');
    await bad(single(math.id, { options: [opt('a', 'x'), opt('a', 'y')] }), 'options');
    await bad(single(math.id, { answer: { optionId: 'zzz' } }), 'answer.optionId');
    await bad(single(math.id, { answer: {} }), 'answer.optionId');
    await bad(
      single(math.id, { options: [opt('a b', 'x'), opt('c', 'y')], answer: { optionId: 'c' } }),
    );
  });

  it('multi: kamida bitta to`g`ri, ro`yxatdagi, takrorsiz; partialCredit saqlanadi', async () => {
    const m = (answer: unknown) => single(math.id, { type: 'multi', answer });
    await bad(m({ optionIds: [] }), 'answer.optionIds');
    await bad(m({ optionIds: ['a', 'a'] }), 'answer.optionIds');
    await bad(m({ optionIds: ['a', 'x'] }), 'answer.optionIds');
    const ok = await post(admin, m({ optionIds: ['a', 'b'], partialCredit: true }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.answer).toEqual({ optionIds: ['a', 'b'], partialCredit: true });
  });

  it("short: variantsiz, kamida bitta javob, normallashgan dublikatlar olib tashlanadi, 20 tadan ko'p emas", async () => {
    const s = (answer: unknown, extra: Record<string, unknown> = {}) => ({
      topicId: topicOf[math.id],
      type: 'short',
      content: [{ type: 'text', text: '5/2 = ?' }],
      answer,
      ...extra,
    });
    await bad(s({ acceptedAnswers: [] }), 'answer.acceptedAnswers');
    await bad(s({ acceptedAnswers: ['  '] }), 'answer.acceptedAnswers');
    await bad(
      s({ acceptedAnswers: ['1'] }, { options: [opt('a', 'x'), opt('b', 'y')] }),
      'options',
    );
    const many = Array.from({ length: 21 }, (_, i) => `javob${i}`);
    await bad(s({ acceptedAnswers: many }), 'answer.acceptedAnswers');
    const res = await post(
      admin,
      s({ acceptedAnswers: ['2,5', '2.5', ' 2.50 ', 'Olma', 'olma  '] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.answer).toEqual({ acceptedAnswers: ['2,5', 'Olma'] });
  });

  it('essay: rubrika ixtiyoriy, variant/javob maydonlari tozalanadi', async () => {
    const e = {
      topicId: topicOf[math.id],
      type: 'essay',
      content: [{ type: 'text', text: 'Yozing' }],
    };
    const res = await post(admin, {
      ...e,
      answer: { rubric: '  Mezon 1  ', acceptedAnswers: ['x'] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.answer).toEqual({ rubric: 'Mezon 1' });
    expect((await post(admin, e)).status).toBe(201);
    await bad({ ...e, options: [opt('a', 'x'), opt('b', 'y')] }, 'options');
  });

  it('ball, qiyinlik, tur, mavzu', async () => {
    await bad(single(math.id, { points: 0 }), 'points');
    await bad(single(math.id, { points: -1 }), 'points');
    await bad(single(math.id, { points: 101 }), 'points');
    await bad(single(math.id, { difficulty: 4 }), 'difficulty');
    await bad(single(math.id, { difficulty: 0 }), 'difficulty');
    await bad(single(math.id, { type: 'truefalse' }), 'type');
    await bad(single(math.id, { topicId: 'notanid' }), 'topicId');
    await bad(single(math.id, { topicId: undefined }), 'topicId');
    await bad(single(math.id, { subjectId: phys.id }), 'subjectId'); // mavzu fanidan farq qiladi
    await bad(single(math.id, { status: 'archived' }), 'status');
    const ok = await post(admin, single(math.id, { points: 100, difficulty: 3 }));
    expect(ok.body.data).toMatchObject({
      points: 100,
      difficulty: 3,
      topicName: 'Kasrlar',
      subjectId: math.id,
    });
    const def = await post(admin, single(math.id));
    expect(def.body.data).toMatchObject({ points: 1, difficulty: 2, status: 'draft' });
  });

  it("mavjud bo'lmagan rasm (assetId) rad etiladi", async () => {
    await bad(
      single(math.id, { content: [{ type: 'image', assetId: '64b000000000000000000009' }] }),
    );
    await bad(single(math.id, { content: [{ type: 'image', assetId: 'x' }] }));
  });

  it('tahrirda ham blok/tur qoidalari qayta tekshiriladi', async () => {
    const id = (await post(admin, single(math.id))).body.data.id;
    expect((await patch(admin, id, { content: [{ type: 'html', html: 'x' }] })).status).toBe(400);
    expect((await patch(admin, id, { answer: { optionId: 'nope' } })).status).toBe(400);
    expect((await patch(admin, id, { points: 0 })).status).toBe(400);
    expect((await patch(admin, id, { authorId: '64b000000000000000000001' })).status).toBe(400);
    expect((await patch(admin, id, { options: [opt('a', 'x')] })).status).toBe(400);
  });
});

describe('Javob kaliti DTO da', () => {
  it("ro'yxat DTO da javob kaliti va variantlar yo'q; to'liq DTO da kalit faqat tahrir huquqi borga", async () => {
    const created = await post(
      tm,
      single(math.id, { content: [{ type: 'text', text: 'SAVOLMATNI' }] }),
    );
    const id = created.body.data.id;
    await post(admin, {
      topicId: topicOf[math.id],
      type: 'short',
      status: 'active',
      content: [{ type: 'text', text: 'qisqa' }],
      answer: { acceptedAnswers: ['MAXFIYJAVOB'] },
    });
    await post(admin, {
      topicId: topicOf[math.id],
      type: 'essay',
      status: 'active',
      content: [{ type: 'text', text: 'esse' }],
      answer: { rubric: 'MAXFIYRUBRIKA' },
    });
    for (const token of [tm, admin]) {
      const r = await list(token);
      expect(r.status).toBe(200);
      const raw = JSON.stringify(r.body);
      expect(raw).not.toContain('MAXFIYJAVOB');
      expect(raw).not.toContain('MAXFIYRUBRIKA');
      expect(raw).not.toContain('"answer"');
      expect(raw).not.toContain('"optionId"');
      expect(raw).not.toContain('"options"');
      const row = r.body.data.find((q: { id: string }) => q.id === id);
      expect(row).toMatchObject({
        preview: 'SAVOLMATNI',
        optionsCount: 3,
        subjectName: 'Matematika',
      });
    }
    // Muallif va ma'muriyat to'liq DTO da kalitni oladi
    expect((await getQ(tm, id)).body.data.answer).toEqual({ optionId: 'b' });
    expect((await getQ(admin, id)).body.data.answer).toEqual({ optionId: 'b' });
  });
});

describe('Hayot sikli: tahrir, versiya, arxiv, o`chirish, nusxa', () => {
  it("versiya faqat mazmun/kalit/ball/tur o'zgarganda oshadi", async () => {
    const id = (await post(admin, single(math.id))).body.data.id;
    const v = async (body: unknown) => (await patch(admin, id, body)).body.data.version;
    expect(await v({ topicId: math2Topic, difficulty: 3 })).toBe(1);
    expect(await v({ points: 1 })).toBe(1); // o'zgarmagan
    expect(await v({ content: [{ type: 'text', text: 'Boshqa savol' }] })).toBe(2);
    expect(await v({ answer: { optionId: 'a' } })).toBe(3);
    expect(await v({ points: 2 })).toBe(4);
    expect(await v({ status: 'active' })).toBe(4);
  });

  it("tur o'zgarganda eski variantlar/kalit tozalanadi", async () => {
    const id = (await post(admin, single(math.id))).body.data.id;
    const r = await patch(admin, id, { type: 'short', answer: { acceptedAnswers: ['4'] } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      type: 'short',
      options: [],
      answer: { acceptedAnswers: ['4'] },
    });
    const bad = await patch(admin, id, { type: 'essay', answer: { acceptedAnswers: ['4'] } });
    expect(bad.status).toBe(200);
    expect(bad.body.data.answer).toEqual({ rubric: '' });
  });

  it("arxivlash/tiklash: arxivdagini tahrirlab bo'lmaydi, tiklash qoralamaga qaytaradi", async () => {
    const id = (await post(tm, single(math.id, { status: 'active' }))).body.data.id;
    expect((await act(tm, id, 'archive')).body.data.status).toBe('archived');
    expect((await act(tm, id, 'archive')).status).toBe(200); // idempotent
    expect((await patch(tm, id, { points: 2 })).status).toBe(409);
    // Arxivdagini hamkasb ko'rmaydi (faqat faol), muallif ko'radi
    expect((await getQ(tp, id)).status).toBe(404);
    expect((await getQ(tm, id)).status).toBe(200);
    expect((await act(tm, id, 'restore')).body.data.status).toBe('draft');
    expect((await patch(tm, id, { points: 2 })).status).toBe(200);
  });

  it("o'chirish: muallif/ma'muriyat istalgan holatdagi savolni yumshoq o'chiradi (faol, arxiv ham)", async () => {
    const draft = (await post(tm, single(math.id))).body.data.id;
    const active = (await post(tm, single(math.id, { status: 'active' }))).body.data.id;
    const archived = (await post(tm, single(math.id, { status: 'active' }))).body.data.id;
    await act(tm, archived, 'archive');
    for (const id of [draft, active, archived]) {
      expect((await del(tm, id)).status).toBe(200);
      expect((await getQ(tm, id)).status).toBe(404);
      expect((await patch(tm, id, { points: 2 })).status).toBe(404);
      expect(await Question.findById(id).lean()).toMatchObject({ isDeleted: true }); // hujjat bazada qoladi
    }
    const byAdmin = (await post(tm, single(math.id, { status: 'active' }))).body.data.id;
    expect((await del(admin, byAdmin)).status).toBe(200);
    expect((await list(admin)).body.data).toEqual([]);
  });

  it("nusxa: yangi qoralama, muallif = nusxalovchi, versiya 1; ma'muriyat o'qituvchi savolini nusxalaydi", async () => {
    const id = (await post(tm, single(math.id, { status: 'active', points: 3 }))).body.data.id;
    const d = await act(admin, id, 'duplicate');
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ status: 'draft', points: 3, version: 1, isMine: true });
    expect(d.body.data.id).not.toBe(id);
    expect(d.body.data.answer).toEqual({ optionId: 'b' });
    expect((await act(tm, id, 'duplicate')).status).toBe(201); // o'z savoli
  });

  it("ro'yxat filtrlari va sahifalash", async () => {
    await post(admin, single(math.id, { difficulty: 1, status: 'active' }));
    await post(admin, {
      ...single(math.id, { topicId: math2Topic, difficulty: 3 }),
      type: 'multi',
      answer: { optionIds: ['a'] },
    });
    await post(
      admin,
      single(phys.id, {
        content: [{ type: 'text', text: 'Tezlik formulasi' }],
      }),
    );
    const ids = async (qs: string) => (await list(admin, qs)).body.data.length;
    expect(await ids('')).toBe(3);
    expect(await ids(`?subjectId=${phys.id}`)).toBe(1);
    expect(await ids('?type=multi')).toBe(1);
    expect(await ids('?difficulty=1')).toBe(1);
    expect(await ids('?status=active')).toBe(1);
    expect(await ids(`?topicId=${math2Topic}`)).toBe(1);
    expect(await ids(`?topicId=${topicOf[math.id]}`)).toBe(1);
    expect(await ids('?search=tezlik')).toBe(1);
    expect(await ids('?search=.*')).toBe(0); // regex belgilari qochiriladi
    expect(await ids('?mine=true')).toBe(3);
    const page = await list(admin, '?limit=2&page=2');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect((await list(admin, '?limit=1000')).status).toBe(400);
    expect((await list(admin, '?status=hack')).status).toBe(400);
  });
});

describe('Audit', () => {
  it("yozuvlar xulosa bilan, javob kaliti va savol matni bo'lmagan holda yoziladi", async () => {
    const secretText = 'MAXFIYSAVOLMATNI';
    const secretKey = 'MAXFIYKALIT42';
    const created = await post(admin, {
      topicId: topicOf[math.id],
      type: 'short',
      content: [{ type: 'text', text: secretText }],
      answer: { acceptedAnswers: [secretKey] },
    });
    const id = created.body.data.id;
    await patch(admin, id, {
      answer: { acceptedAnswers: [secretKey, 'MAXFIYKALIT43'] },
      status: 'active',
    });
    await act(admin, id, 'archive');
    await act(admin, id, 'restore');
    const dup = (await act(admin, id, 'duplicate')).body.data.id;
    await del(admin, dup);

    const logs = await AuditLog.find({ entity: 'exam_question' }).sort({ createdAt: 1 }).lean();
    expect(logs.map((l) => l.action)).toEqual([
      'exam.question.create',
      'exam.question.update',
      'exam.question.archive',
      'exam.question.restore',
      'exam.question.duplicate',
      'exam.question.delete',
    ]);
    const raw = JSON.stringify(logs);
    expect(raw).not.toContain(secretKey);
    expect(raw).not.toContain('MAXFIYKALIT43');
    expect(raw).not.toContain(secretText);
    expect(logs[0].after).toMatchObject({ type: 'short', hasAnswerKey: true, version: 1 });
    expect(logs[1].after).toMatchObject({ version: 2 });
    expect((logs[1].after as { changed: string[] }).changed).toEqual(
      expect.arrayContaining(['answer', 'status']),
    );
    expect(String(logs[0].schoolId)).toBe(school.id);
  });
});

describe('Asset bilan savol', () => {
  it("o'z maktabi rasmi ruxsat, boshqa maktab rasmi rad etiladi", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } })
      .png()
      .toBuffer();
    const up = (token: string) =>
      request(app)
        .post('/api/v1/exams/assets')
        .set(bearer(token))
        .attach('image', png, { filename: 'a.png', contentType: 'image/png' });
    const mine = (await up(admin)).body.data.id;
    const foreign = (await up(otherAdmin)).body.data.id;
    const withImg = (assetId: string) =>
      single(math.id, {
        content: [
          { type: 'text', text: 'Rasmga qarang' },
          { type: 'image', assetId },
        ],
      });
    expect((await post(admin, withImg(mine))).status).toBe(201);
    expect((await post(admin, withImg(foreign))).status).toBe(400);
  });
});
