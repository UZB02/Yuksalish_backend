import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcademicYear } from '../src/models/AcademicYear';
import { AuditLog } from '../src/models/AuditLog';
import { Subject } from '../src/models/Subject';
import { ExamTopic } from '../src/models/ExamTopic';
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
let math: Doc, phys: Doc, chem: Doc;
let root: string, admin: string, oadmin: string, tm: string, tm2: string, tp: string;
let tMath: Doc, tMath2: Doc;

const H = (t: string, sid?: string) => (sid ? { ...bearer(t), 'X-School-Id': sid } : bearer(t));
const mkTopic = (token: string, subjectId: string, body: object) =>
  request(app).post(`/api/v1/exams/subjects/${subjectId}/topics`).set(bearer(token)).send(body);
const listTopics = (token: string, subjectId: string, sid?: string) =>
  request(app).get(`/api/v1/exams/subjects/${subjectId}/topics`).set(H(token, sid));
const getTopic = (token: string, id: string) =>
  request(app).get(`/api/v1/exams/topics/${id}`).set(bearer(token));
const patchTopic = (token: string, id: string, body: object) =>
  request(app).patch(`/api/v1/exams/topics/${id}`).set(bearer(token)).send(body);
const delTopic = (token: string, id: string) =>
  request(app).delete(`/api/v1/exams/topics/${id}`).set(bearer(token));
const subjects = (token: string) => request(app).get('/api/v1/exams/subjects').set(bearer(token));
const mkQ = (token: string, topicId: string, extra: object = {}) =>
  request(app)
    .post('/api/v1/exams/questions')
    .set(bearer(token))
    .send({
      topicId,
      type: 'short',
      content: [{ type: 'text', text: 'Savol' }],
      answer: { acceptedAnswers: ['1'] },
      ...extra,
    });

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  chem = await makeSubject('Kimyo');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  tMath2 = await makeUser({ username: 'tmath2', role: 'teacher', schoolId: school.id });
  const tPhys = await makeUser({ username: 'tphys', role: 'teacher', schoolId: school.id });
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
  const c1 = await makeClass(school.id, year.id, '7-A');
  const c2 = await makeClass(school.id, year.id, '7-B');
  await assignSubject(school.id, c1 as never, math.id, tMath.id);
  await assignSubject(school.id, c1 as never, math.id, tMath2.id);
  await assignSubject(school.id, c2 as never, phys.id, tPhys.id);
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  root = (await login('root')).token;
  admin = (await login('admin')).token;
  oadmin = (await login('oadmin')).token;
  tm = (await login('tmath')).token;
  tm2 = (await login('tmath2')).token;
  tp = (await login('tphys')).token;
});

describe('Mavzular: yaratish, ro`yxat, validatsiya', () => {
  it("o'qituvchi o'z fanida yaratadi; boshqa fan 403; fan yo'q 404; ma'muriyat hamma fanda", async () => {
    const r = await mkTopic(tm, math.id, { name: '  Kasrlar  ', description: ' Oddiy kasrlar ' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Kasrlar',
      description: 'Oddiy kasrlar',
      subjectName: 'Matematika',
      order: 1,
      isMine: true,
      canEdit: true,
      canDelete: true,
      questionsCount: 0,
    });
    expect((await mkTopic(tm, phys.id, { name: 'X' })).status).toBe(403);
    expect((await mkTopic(tm, '64b000000000000000000001', { name: 'X' })).status).toBe(403);
    expect((await mkTopic(admin, '64b000000000000000000001', { name: 'X' })).status).toBe(404);
    expect((await mkTopic(admin, chem.id, { name: 'Organik' })).status).toBe(201);
    const second = await mkTopic(tm, math.id, { name: 'Tenglamalar' });
    expect(second.body.data.order).toBe(2);
  });

  it('validatsiya: bo`sh/uzun nom, boshqaruv belgisi, noma`lum maydon, uzun tavsif', async () => {
    for (const body of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(151) },
      { name: 'a\u0000b' },
      { name: 'A', extra: 1 },
      { name: 'A', description: 'd'.repeat(501) },
      { name: 'A', subjectId: phys.id },
    ]) {
      expect((await mkTopic(admin, math.id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(
        400,
      );
    }
    expect(
      (await mkTopic(admin, math.id, { name: 'x'.repeat(150), description: 'd'.repeat(500) }))
        .status,
    ).toBe(201);
  });

  it("nom fan ichida noyob (katta-kichik harf va bo'shliqsiz): 409; boshqa fanda mumkin; o'chirilgach qayta ishlatiladi", async () => {
    const a = await mkTopic(tm, math.id, { name: 'Kasrlar' });
    expect((await mkTopic(tm2, math.id, { name: '  kASRLAR ' })).status).toBe(409);
    expect((await mkTopic(admin, phys.id, { name: 'Kasrlar' })).status).toBe(201);
    const b = await mkTopic(tm, math.id, { name: 'Tenglamalar' });
    expect((await patchTopic(tm, b.body.data.id, { name: 'kasrlar' })).status).toBe(409);
    expect((await patchTopic(tm, b.body.data.id, { name: 'Tenglamalar' })).status).toBe(200); // o'zi bilan to'qnashmaydi
    expect((await delTopic(tm, a.body.data.id)).status).toBe(200);
    expect((await mkTopic(tm2, math.id, { name: 'Kasrlar' })).status).toBe(201);
  });

  it("indeks: noyob + qisman (faqat o'chirilmagan), partial filter", async () => {
    const idx = await ExamTopic.collection.indexes();
    const u = idx.find((i) => i.name === 'unique_topic_name_active')!;
    expect(u.unique).toBe(true);
    expect(u.key).toEqual({ schoolId: 1, subjectId: 1, nameKey: 1 });
    expect(u.partialFilterExpression).toEqual({ isDeleted: false });
  });

  it("ro'yxat: o'qituvchi o'z fanidagi hamma mavzuni (hamkasbniki ham) ko'radi, boshqa fan 403; tartib bo'yicha", async () => {
    await mkTopic(tm, math.id, { name: 'B-mavzu' });
    await mkTopic(tm2, math.id, { name: 'A-mavzu' });
    const r = await listTopics(tm, math.id);
    expect(r.status).toBe(200);
    expect(r.body.data.subject).toMatchObject({ name: 'Matematika', isActive: true });
    expect(r.body.data.topics.map((t: { name: string }) => t.name)).toEqual(['B-mavzu', 'A-mavzu']);
    expect(r.body.data.topics.map((t: { canEdit: boolean }) => t.canEdit)).toEqual([true, false]);
    expect((await listTopics(tm, phys.id)).status).toBe(403);
    expect((await listTopics(admin, phys.id)).status).toBe(200);
    expect((await listTopics(tp, math.id)).status).toBe(403);
  });
});

describe('Mavzular: o`zgartirish, o`chirish, maktablar izolyatsiyasi', () => {
  it("tahrirlash/o'chirish: faqat yaratuvchi yoki ma'muriyat; hamkasb 403; boshqa fan mavzusi 404", async () => {
    const t = (await mkTopic(tm, math.id, { name: 'Kasrlar' })).body.data.id;
    expect((await getTopic(tm2, t)).status).toBe(200);
    expect((await patchTopic(tm2, t, { description: 'x' })).status).toBe(403);
    expect((await delTopic(tm2, t)).status).toBe(403);
    expect((await getTopic(tp, t)).status).toBe(404);
    expect((await patchTopic(tp, t, { name: 'Z' })).status).toBe(404);
    expect(
      (await patchTopic(tm, t, { name: 'Yangi', description: 'tavsif' })).body.data,
    ).toMatchObject({
      name: 'Yangi',
      description: 'tavsif',
    });
    expect((await patchTopic(admin, t, { name: 'Admin nomi' })).status).toBe(200);
    expect((await patchTopic(tm, t, { extra: 1 })).status).toBe(400);
    expect((await delTopic(admin, t)).status).toBe(200);
    expect((await getTopic(admin, t)).status).toBe(404);
    expect(await ExamTopic.findById(t).lean()).toMatchObject({ isDeleted: true });
  });

  it("savoli bor mavzuni o'chirib bo'lmaydi (409 'Mavzuda savollar bor'), hatto ko'rinmaydigan savol bo'lsa ham; bo'shagach mumkin", async () => {
    const t = (await mkTopic(tm, math.id, { name: 'Kasrlar' })).body.data.id;
    const q = (await mkQ(tm2, t)).body.data.id; // hamkasbning private savoli (tm uchun ko'rinmaydi)
    const d = await delTopic(tm, t);
    expect(d.status).toBe(409);
    expect(d.body.error.message).toBe('Mavzuda savollar bor');
    expect((await delTopic(admin, t)).status).toBe(409);
    expect((await getTopic(tm, t)).body.data).toMatchObject({
      canDelete: false,
      isEmpty: false,
      questionsCount: 0,
    });
    await request(app).delete(`/api/v1/exams/questions/${q}`).set(bearer(tm2));
    expect((await getTopic(tm, t)).body.data).toMatchObject({ canDelete: true, isEmpty: true });
    expect((await delTopic(tm, t)).status).toBe(200);
  });

  it('boshqa maktab: mavzu 404; o`z maktabida shu fan mavzulari ko`rinmaydi', async () => {
    const t = (await mkTopic(tm, math.id, { name: 'Kasrlar' })).body.data.id;
    expect((await getTopic(oadmin, t)).status).toBe(404);
    expect((await patchTopic(oadmin, t, { name: 'X' })).status).toBe(404);
    expect((await delTopic(oadmin, t)).status).toBe(404);
    expect((await listTopics(oadmin, math.id)).body.data.topics).toEqual([]);
    expect((await mkQ(oadmin, t)).status).toBe(400);
    const sup = await request(app).get(`/api/v1/exams/topics/${t}`).set(H(root, other.id));
    expect(sup.status).toBe(404);
    expect(
      (await request(app).get(`/api/v1/exams/topics/${t}`).set(H(root, school.id))).status,
    ).toBe(200);
  });

  it('tartiblash: ma`muriyat; o`qituvchi faqat o`zi yaratganlarni', async () => {
    const a = (await mkTopic(tm, math.id, { name: 'A' })).body.data.id;
    const b = (await mkTopic(tm, math.id, { name: 'B' })).body.data.id;
    const c = (await mkTopic(tm2, math.id, { name: 'C' })).body.data.id;
    const reorder = (token: string, ids: string[]) =>
      request(app)
        .post('/api/v1/exams/topics/reorder')
        .set(bearer(token))
        .send({ subjectId: math.id, ids });
    const r = await reorder(tm, [b, a]);
    expect(r.status).toBe(200);
    expect(r.body.data.topics.map((t: { name: string }) => t.name)).toEqual(['B', 'A', 'C']);
    expect((await reorder(tm, [a, c])).status).toBe(403);
    expect(
      (await reorder(admin, [c, a, b])).body.data.topics.map((t: { name: string }) => t.name),
    ).toEqual(['C', 'A', 'B']);
    expect((await reorder(admin, ['64b000000000000000000001'])).status).toBe(404);
    expect((await reorder(tp, [a])).status).toBe(403);
  });

  it("audit: yaratish, o'zgartirish, o'chirish xulosa bilan (tavsif matnisiz)", async () => {
    const t = (await mkTopic(tm, math.id, { name: 'Kasrlar', description: 'MAXFIYTAVSIF' })).body
      .data.id;
    await patchTopic(tm, t, { name: 'Kasrlar 2' });
    await delTopic(tm, t);
    const logs = await AuditLog.find({ entity: 'exam_topic' }).sort({ createdAt: 1 }).lean();
    expect(logs.map((l) => l.action)).toEqual([
      'exam.topic.create',
      'exam.topic.update',
      'exam.topic.delete',
    ]);
    expect(JSON.stringify(logs)).not.toContain('MAXFIYTAVSIF');
    expect(logs[0]!.after).toMatchObject({ name: 'Kasrlar', hasDescription: true });
  });
});

describe('Fan kartalari va sonlar (ulashish qoidalari bilan)', () => {
  it("o'qituvchi faqat o'z fanlarini ko'radi, fan biriktirilmaganda bo'sh; ma'muriyat hammasini", async () => {
    const a = await subjects(tm);
    expect(a.body.data.scope).toBe('own');
    expect(a.body.data.subjects.map((s: { name: string }) => s.name)).toEqual(['Matematika']);
    const none = await makeUser({ username: 'tnone', role: 'teacher', schoolId: school.id });
    void none;
    expect((await subjects((await login('tnone')).token)).body.data.subjects).toEqual([]);
    const b = await subjects(admin);
    expect(b.body.data.scope).toBe('all');
    expect(b.body.data.subjects.map((s: { name: string }) => s.name).sort()).toEqual([
      'Fizika',
      'Kimyo',
      'Matematika',
    ]);
  });

  it("sonlar: mavzular soni va foydalanuvchiga KO'RINADIGAN savollar (private/subject/users)", async () => {
    const t1 = (await mkTopic(tm, math.id, { name: 'Kasrlar' })).body.data.id;
    const t2 = (await mkTopic(tm, math.id, { name: 'Tenglamalar' })).body.data.id;
    await mkQ(tm, t1); // tm private
    await mkQ(tm, t1, { sharing: { mode: 'subject' } });
    await mkQ(tm2, t1); // tm2 private: tm ko'rmaydi
    await mkQ(tm2, t2, { sharing: { mode: 'users', userIds: [tMath.id] } });
    await mkQ(tm2, t2, { sharing: { mode: 'subject' } });
    await mkQ(admin, t2); // admin private: o'qituvchilar ko'rmaydi

    const forTm = (await listTopics(tm, math.id)).body.data.topics;
    expect(
      forTm.map((t: { name: string; questionsCount: number }) => [t.name, t.questionsCount]),
    ).toEqual([
      ['Kasrlar', 2], // o'ziniki 2 (private + subject), tm2 private yo'q
      ['Tenglamalar', 2], // tm ga ulashilgan 2 ta
    ]);
    const forTm2 = (await listTopics(tm2, math.id)).body.data.topics;
    expect(forTm2.map((t: { questionsCount: number }) => t.questionsCount)).toEqual([2, 2]); // tm subject-ulashgan 1 + o'ziniki 1 / o'ziniki 2
    const forAdmin = (await listTopics(admin, math.id)).body.data.topics;
    expect(forAdmin.map((t: { questionsCount: number }) => t.questionsCount)).toEqual([3, 3]);

    const sTm = (await subjects(tm)).body.data.subjects[0];
    expect(sTm).toMatchObject({ name: 'Matematika', topicsCount: 2, questionsCount: 4 });
    const sAdmin = (await subjects(admin)).body.data.subjects.find(
      (s: { name: string }) => s.name === 'Matematika',
    );
    expect(sAdmin).toMatchObject({ topicsCount: 2, questionsCount: 6 });
    // Savol filtri mavzu bo'yicha
    const l = await request(app).get(`/api/v1/exams/questions?topicId=${t1}`).set(bearer(tm));
    expect(l.body.data).toHaveLength(2);
  });

  it("ma'muriyat: mavzulari bor nofaol fan ham ko'rinadi (isActive=false), mavzusiz nofaol fan yo'q", async () => {
    const t = (await mkTopic(admin, chem.id, { name: 'Organik' })).body.data;
    expect(t.subjectName).toBe('Kimyo');
    await Subject.updateOne({ _id: chem.id }, { $set: { isActive: false } });
    await Subject.updateOne({ _id: phys.id }, { $set: { isActive: false } });
    const list = (await subjects(admin)).body.data.subjects as {
      name: string;
      isActive: boolean;
    }[];
    expect(list.find((s) => s.name === 'Kimyo')).toMatchObject({ isActive: false, topicsCount: 1 });
    expect(list.find((s) => s.name === 'Fizika')).toBeUndefined();
    // Nofaol fanga yangi mavzu qo'shib bo'lmaydi
    expect((await mkTopic(admin, chem.id, { name: 'Yangi' })).status).toBe(404);
  });
});

describe('Savolni mavzular orasida ko`chirish', () => {
  it("shu fan ichida: muharrir; boshqa fanga: faqat shu fanni o'qitgan muharrir yoki ma'muriyat; mavjud bo'lmagan/o'chirilgan mavzu 400", async () => {
    const m1 = (await mkTopic(tm, math.id, { name: 'M1' })).body.data.id;
    const m2 = (await mkTopic(tm, math.id, { name: 'M2' })).body.data.id;
    const p1 = (await mkTopic(admin, phys.id, { name: 'P1' })).body.data.id;
    const q = (await mkQ(tm, m1)).body.data.id;
    const move = (token: string, topicId: string) =>
      request(app).patch(`/api/v1/exams/questions/${q}`).set(bearer(token)).send({ topicId });
    const ok = await move(tm, m2);
    expect(ok.body.data).toMatchObject({ topicId: m2, topicName: 'M2', subjectName: 'Matematika' });
    expect(ok.body.data.version).toBe(1);
    expect((await move(tm, p1)).status).toBe(403);
    expect((await move(tm2, m1)).status).toBe(404); // boshqa muallifning private savoli
    const across = await move(admin, p1);
    expect(across.body.data).toMatchObject({ topicId: p1, subjectName: 'Fizika' });
    expect((await move(admin, '64b000000000000000000001')).status).toBe(400);
    await delTopic(admin, m1);
    expect((await move(admin, m1)).status).toBe(400);
    // Ikkala fanni o'qitadigan o'qituvchi fanlar orasida ko'chira oladi
    const both = await makeUser({ username: 'tboth', role: 'teacher', schoolId: school.id });
    const year = await AcademicYear.findOne({ schoolId: school.id });
    const c = await makeClass(school.id, year!.id, '9-A');
    await assignSubject(school.id, c as never, math.id, both.id);
    await assignSubject(school.id, c as never, phys.id, both.id);
    const tb = (await login('tboth')).token;
    const bq = (await mkQ(tb, m2)).body.data.id;
    const r = await request(app)
      .patch(`/api/v1/exams/questions/${bq}`)
      .set(bearer(tb))
      .send({ topicId: p1 });
    expect(r.body.data).toMatchObject({ topicId: p1, subjectName: 'Fizika' });
  });

  it("savol yaratish: mavzu majburiy; o'qituvchi o'qitmaydigan fan mavzusiga 403; mavzu fani bilan mos kelmagan subjectId 400", async () => {
    const m1 = (await mkTopic(tm, math.id, { name: 'M1' })).body.data.id;
    const p1 = (await mkTopic(admin, phys.id, { name: 'P1' })).body.data.id;
    expect((await mkQ(tm, m1)).status).toBe(201);
    expect((await mkQ(tm, p1)).status).toBe(403);
    expect((await mkQ(tm, m1, { topicId: undefined })).status).toBe(400);
    expect((await mkQ(tm, m1, { subjectId: phys.id })).status).toBe(400);
    expect((await mkQ(tm, m1, { subjectId: math.id })).status).toBe(201);
    const d = await mkQ(admin, p1);
    expect(d.body.data).toMatchObject({ subjectId: phys.id, topicId: p1, topicName: 'P1' });
  });
});
