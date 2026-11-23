import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ExamAttempt } from '../src/models/ExamAttempt';
import { ExamSession } from '../src/models/ExamSession';
import { Question } from '../src/models/Question';
import { User } from '../src/models/User';
import {
  blockQuestionCount,
  effectiveItems,
  normalizeBlocks,
} from '../src/modules/exams/blocks/blocks.core';
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
let math: Doc, lang: Doc;
let admin = '';
let tmath = '';
let tother = '';
let tmathId = '';
let algebra: Doc, geometry: Doc, langTopic: Doc;
let c7a: Doc;
/** Algebra: oson 6, o'rta 8, qiyin 4; Geometriya: oson 4, o'rta 6, qiyin 2 (hammasi faol) */
const bank: Record<string, string[]> = {};

const call = (m: 'get' | 'post' | 'patch' | 'delete', url: string, t: string, body?: object) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', school.id);
  return body ? r.send(body) : r;
};
const ec = (m: 'get' | 'post' | 'put', url: string, token: string | null, body?: object) => {
  let r = request(app)[m](`/api/v1/exam-client${url}`).set('X-Forwarded-For', '10.0.0.7');
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const text = (t: string) => [{ type: 'text', text: t }];
const mk = async (topic: Doc, difficulty: number, label: string, extra: object = {}) => {
  const r = await call('post', '/questions', admin, {
    topicId: topic.id,
    status: 'active',
    sharing: { mode: 'subject' },
    difficulty,
    type: 'single',
    content: text(label),
    options: [
      { id: 'a', content: text('A') },
      { id: 'b', content: text('B') },
    ],
    answer: { optionId: 'b' },
    points: 1,
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
};
const fill = async (topic: Doc, name: string, easy: number, med: number, hard: number) => {
  for (const [d, n] of [
    [1, easy],
    [2, med],
    [3, hard],
  ] as const) {
    bank[`${name}${d}`] = [];
    for (let i = 0; i < n; i++)
      bank[`${name}${d}`]!.push(await mk(topic, d, `${name} d${d} #${i}`));
  }
};

const at = (d: Date) => clock.set(() => d);
const startAt = () => new Date(Date.now() + 3 * 3_600_000);

beforeEach(async () => {
  for (const k of Object.keys(bank)) delete bank[k];
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  lang = await makeSubject('Ona tili');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  const tm = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tother', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['exams.manage'],
  });
  tmathId = tm.id;
  c7a = (await makeClass(school.id, year.id, '7-A')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, tm.id);
  const c8 = (await makeClass(school.id, year.id, '8-A')) as unknown as Doc;
  const t2 = (await User_find('tother'))!;
  await assignSubject(school.id, c8 as never, math.id, t2);
  await makeStudent(school.id, c7a.id, 'Oquvchi 0');
  await settingsStore.set('school', school.id, 'exams', { enabled: true }, rootU.id);
  admin = (await login('admin')).token;
  tmath = (await login('tmath')).token;
  tother = (await login('tother')).token;
  algebra = (await call('post', `/subjects/${math.id}/topics`, admin, { name: 'Algebra' })).body
    .data;
  geometry = (await call('post', `/subjects/${math.id}/topics`, admin, { name: 'Geometriya' })).body
    .data;
  await call('post', `/subjects/${math.id}/topics`, admin, { name: 'Bo`sh' });
  langTopic = (await call('post', `/subjects/${lang.id}/topics`, admin, { name: 'Imlo' })).body
    .data;
  await fill(algebra, 'A', 6, 8, 4);
  await fill(geometry, 'G', 4, 6, 2);
  await mk(langTopic, 2, 'Til savoli');
  // qoralama savol hovuzga kirmaydi
  await mk(algebra, 2, 'Qoralama', { status: 'draft' });
});

async function User_find(username: string) {
  return (await User.findOne({ username }))!.id as string;
}

interface Made {
  id: string;
  blockId: string;
  fixed: string;
}
/** Blokli imtihon (matematika bloki, tmath biriktirilgan, 1 ta qat'iy savol), qoralama */
async function mkExam(
  extra: Record<string, unknown> = {},
  blockExtra: Record<string, unknown> = {},
): Promise<Made> {
  const fixed = bank['A2']![0]!;
  const r = await call('post', '/sessions', admin, {
    title: 'Tasodifiy sinov',
    type: 'quarter',
    classIds: [c7a.id],
    blocks: [
      {
        subjectId: math.id,
        targetCount: 10,
        coefficient: 1,
        durationMin: 30,
        contributorIds: [tmathId],
        items: [{ kind: 'manual', questionIds: [fixed] }],
        ...blockExtra,
      },
    ],
    scoringMode: 'points',
    timingMode: 'common',
    durationMin: 30,
    scheduledStart: startAt().toISOString(),
    resultsMode: 'score',
    shuffleQuestions: true,
    shuffleOptions: true,
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const d = r.body.data;
  const add = await call('post', `/sessions/${d.id}/participants`, admin, { classIds: [c7a.id] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { id: d.id as string, blockId: d.blocks[0].id as string, fixed };
}
const mb = (m: Made, tail: string) => `/my-blocks/${m.id}/${m.blockId}${tail}`;
const sel = (topics: Doc[], extra: object = {}) => ({
  topicIds: topics.map((t) => t.id),
  ...extra,
});

describe('Daraja bo`yicha tasodifiy: mavjudlik (availability)', () => {
  it('daraja bo`yicha jami/imtihonda/tanlash mumkin; faqat FAOL, blok fani, tanlangan mavzular; qat`iy savol "imtihonda" hisoblanadi', async () => {
    const m = await mkExam();
    const r = await call('post', mb(m, '/random/availability'), tmath, sel([algebra]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.difficulties).toEqual({
      '1': { total: 6, inExam: 0, available: 6 },
      '2': { total: 8, inExam: 1, available: 7 }, // 1 ta qat'iy savol shu mavzuda
      '3': { total: 4, inExam: 0, available: 4 },
    });
    expect(r.body.data.topics).toEqual(['Algebra']);
    const both = await call('post', mb(m, '/random/availability'), tmath, sel([algebra, geometry]));
    expect(both.body.data.difficulties['1'].total).toBe(10);
    expect(both.body.data.difficulties['2'].available).toBe(13);
    const all = await call('post', mb(m, '/random/availability'), tmath, { allTopics: true });
    expect(all.body.data.difficulties['3'].total).toBe(6); // boshqa fan (Imlo) kirmaydi
    expect(all.body.data.topics.sort()).toEqual(['Algebra', 'Bo`sh', 'Geometriya']);
    // tur filtri
    const none = await call(
      'post',
      mb(m, '/random/availability'),
      tmath,
      sel([algebra], { type: 'essay' }),
    );
    expect(none.body.data.difficulties['1'].total).toBe(0);
  });

  it('boshqa fan mavzusi / mavzusiz so`rov: 400; begona o`qituvchi va boshqa maktab: 404', async () => {
    const m = await mkExam();
    expect(
      (await call('post', mb(m, '/random/availability'), tmath, sel([langTopic]))).status,
    ).toBe(400);
    expect((await call('post', mb(m, '/random/availability'), tmath, {})).status).toBe(400);
    expect((await call('post', mb(m, '/random/availability'), tother, sel([algebra]))).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .post(`/api/v1/exams${mb(m, '/random/availability')}`)
          .send({})
      ).status,
    ).toBe(401);
  });
});

describe('Rejim 1: tasodifiy tanlash, almashtirish, qo`shish', () => {
  const counts = (easy: number, medium: number, hard: number) => ({
    counts: { easy, medium, hard },
  });

  it('so`ralgan soncha, takrorsiz, faqat FAOL va imtihonda yo`q savollar; to`g`ri javob belgilangan; hech narsa saqlanmaydi', async () => {
    const m = await mkExam();
    const r = await call('post', mb(m, '/random/preview'), tmath, {
      ...sel([algebra, geometry]),
      ...counts(3, 5, 2),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = r.body.data.items as {
      id: string;
      difficulty: number;
      options: { correct: boolean }[];
    }[];
    expect(items).toHaveLength(10);
    expect(new Set(items.map((x) => x.id)).size).toBe(10);
    expect(items.filter((x) => x.difficulty === 1)).toHaveLength(3);
    expect(items.filter((x) => x.difficulty === 2)).toHaveLength(5);
    expect(items.filter((x) => x.difficulty === 3)).toHaveLength(2);
    expect(items.map((x) => x.id)).not.toContain(m.fixed);
    const draft = await Question.find({ status: 'draft' });
    expect(items.map((x) => x.id)).not.toContain(String(draft[0]!._id));
    for (const it of items) expect(it.options.filter((o) => o.correct)).toHaveLength(1);
    expect(r.body.data.shortfall).toEqual({ '1': 0, '2': 0, '3': 0 });
    // saqlanmagan
    const s = (await ExamSession.findById(m.id))!;
    expect(blockQuestionCount(normalizeBlocks(s)[0]!)).toBe(1);
  });

  it('tasodifiylik: ketma-ket tanlovlar bir xil emas; yetmasa bor qadar va kamchilik aniq ko`rsatiladi', async () => {
    const m = await mkExam();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r = await call('post', mb(m, '/random/preview'), tmath, {
        ...sel([algebra]),
        ...counts(0, 3, 0),
      });
      seen.add(
        (r.body.data.items as { id: string }[])
          .map((x) => x.id)
          .sort()
          .join(','),
      );
    }
    expect(seen.size).toBeGreaterThan(1);
    const few = await call('post', mb(m, '/random/preview'), tmath, {
      ...sel([algebra]),
      ...counts(0, 0, 9),
    });
    expect(few.body.data.items).toHaveLength(4);
    expect(few.body.data.shortfall).toEqual({ '1': 0, '2': 0, '3': 5 });
    expect(few.body.data.available['3']).toBe(4);
    expect(
      (
        await call('post', mb(m, '/random/preview'), tmath, {
          ...sel([algebra]),
          ...counts(0, 0, 0),
        })
      ).status,
    ).toBe(400);
  });

  it('almashtirish: shu daraja, joriy ro`yxat va imtihondagilarsiz; boshqa qolmasa 409', async () => {
    const m = await mkExam();
    const first = await call('post', mb(m, '/random/preview'), tmath, {
      ...sel([algebra]),
      ...counts(0, 0, 3),
    });
    const cur = (first.body.data.items as { id: string }[]).map((x) => x.id);
    const rep = await call('post', mb(m, '/random/replace'), tmath, {
      ...sel([algebra]),
      difficulty: 3,
      exclude: cur,
    });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(cur).not.toContain(rep.body.data.item.id);
    expect(rep.body.data.item.difficulty).toBe(3);
    expect(bank['A3']).toContain(rep.body.data.item.id);
    expect(rep.body.data.remaining).toBe(0); // 4 ta qiyin: 3 joriy + 1 yangi
    const none = await call('post', mb(m, '/random/replace'), tmath, {
      ...sel([algebra]),
      difficulty: 3,
      exclude: [...cur, rep.body.data.item.id],
    });
    expect(none.status).toBe(409);
    expect(none.body.error.message).toContain('boshqa savol qolmadi');
  });

  it('qo`shish: mavjud "bankdan qo`shish" yo`li; qo`shilgach shu savollar qayta tanlanmaydi', async () => {
    const m = await mkExam();
    const pv = await call('post', mb(m, '/random/preview'), tmath, {
      ...sel([algebra, geometry]),
      ...counts(2, 2, 1),
    });
    const ids = (pv.body.data.items as { id: string }[]).map((x) => x.id);
    const add = await call('post', mb(m, '/questions'), tmath, { questionIds: ids });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.data).toMatchObject({ added: 5, count: 6 });
    const av = await call('post', mb(m, '/random/availability'), tmath, sel([algebra, geometry]));
    const used = (d: string) => av.body.data.difficulties[d].inExam;
    expect(used('1') + used('2') + used('3')).toBe(6); // 5 yangi + 1 qat'iy
    const again = await call('post', mb(m, '/random/preview'), tmath, {
      ...sel([algebra, geometry]),
      ...counts(10, 13, 6),
    });
    const got = (again.body.data.items as { id: string }[]).map((x) => x.id);
    for (const id of [...ids, m.fixed]) expect(got).not.toContain(id);
    expect(again.body.data.shortfall['1']).toBe(10 - 8); // 10 ta oson, 2 tasi qo'shilgan
  });

  it('qulf: tuzuvchi "tayyor" qo`ysa, muddat o`tsa yoki imtihon qoralamadan chiqsa o`qituvchi qo`sha olmaydi (qoida ham)', async () => {
    const m = await mkExam();
    const rule = { ...sel([algebra]), difficulty: 2, count: 3 };
    expect((await call('post', mb(m, '/rules'), tmath, rule)).status).toBe(201);
    expect(
      (await call('post', `/sessions/${m.id}/blocks/${m.blockId}/ready`, admin, { ready: true }))
        .status,
    ).toBe(200);
    const locked = await call('post', mb(m, '/rules'), tmath, rule);
    expect(locked.status).toBe(403);
    expect(locked.body.error.message).toContain('faqat o‘qish');
    // muddat
    const m2 = await mkExam({ contribDeadline: new Date(Date.now() + 3_600_000).toISOString() });
    at(new Date(Date.now() + 2 * 3_600_000));
    expect((await call('post', mb(m2, '/rules'), tmath, rule)).status).toBe(403);
    // tuzuvchi muddatdan keyin ham qo'sha oladi
    expect((await call('post', mb(m2, '/rules'), admin, rule)).status).toBe(201);
    expect(
      (await call('post', mb(m2, '/questions'), tmath, { questionIds: [bank['G1']![0]] })).status,
    ).toBe(403);
  });
});

describe('Rejim 2: qoidalar (har o`quvchiga boshqacha)', () => {
  it('bir nechta mavzu bilan qoida saqlanadi, blok ro`yxatida nomlar/hovuz bilan chiqadi, nishonga hisoblanadi; tahrirlash va olib tashlash egasi/tuzuvchi uchun', async () => {
    const m = await mkExam();
    const add = await call('post', mb(m, '/rules'), tmath, {
      ...sel([algebra, geometry]),
      difficulty: 2,
      count: 10,
    });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.data).toMatchObject({ poolSize: 13, enough: true });
    const ruleId = add.body.data.ruleId as string;
    const all = await call('post', mb(m, '/rules'), tmath, {
      allTopics: true,
      difficulty: 3,
      count: 4,
    });
    expect(all.status).toBe(201);
    const view = await call('get', mb(m, ''), tmath);
    expect(view.body.data.block.count).toBe(1 + 10 + 4);
    const rules = view.body.data.rules as {
      ruleId: string;
      topicName: string | null;
      allTopics: boolean;
      poolSize: number;
      difficulty: number;
      count: number;
      canRemove: boolean;
    }[];
    const r1 = rules.find((x) => x.ruleId === ruleId)!;
    expect(r1).toMatchObject({ difficulty: 2, count: 10, poolSize: 13, canRemove: true });
    expect(r1.topicName!.split(', ').sort()).toEqual(['Algebra', 'Geometriya']);
    expect(rules.find((x) => x.allTopics)).toMatchObject({
      poolSize: 6,
      count: 4,
      topicName: null,
    });
    // tahrirlash
    expect((await call('patch', mb(m, `/rules/${ruleId}`), tmath, { count: 6 })).status).toBe(200);
    expect((await call('get', mb(m, ''), tmath)).body.data.block.count).toBe(1 + 6 + 4);
    // boshqa o'qituvchi qoidani ko'rmaydi (404); tuzuvchi olib tashlay oladi
    expect((await call('delete', mb(m, `/rules/${ruleId}`), tother)).status).toBe(404);
    expect((await call('delete', mb(m, `/rules/${ruleId}`), admin)).status).toBe(200);
    expect((await call('get', mb(m, ''), tmath)).body.data.block.count).toBe(1 + 4);
    // tuzuvchi ko'rib chiqish sahifasi ro'yxati va olib tashlash
    const rev = await call('get', `/sessions/${m.id}/blocks/${m.blockId}/questions`, admin);
    expect(rev.body.data.rules).toHaveLength(1);
    expect(rev.body.data.rules[0]).toMatchObject({ allTopics: true, poolSize: 6 });
    const rid = rev.body.data.rules[0].ruleId as string;
    expect(
      (await call('delete', `/sessions/${m.id}/blocks/${m.blockId}/rules/${rid}`, admin)).status,
    ).toBe(200);
    expect(
      (await call('get', `/sessions/${m.id}/blocks/${m.blockId}/questions`, admin)).body.data.rules,
    ).toHaveLength(0);
    const log = await AuditLog.find({ action: { $regex: '^exam.block.rule_' } });
    expect(log.map((l) => l.action).sort()).toEqual([
      'exam.block.rule_add',
      'exam.block.rule_add',
      'exam.block.rule_remove',
      'exam.block.rule_remove',
      'exam.block.rule_update',
    ]);
  });

  it('o`qituvchi boshqa o`qituvchi qo`shgan qoidani o`zgartira/o`chira olmaydi (egalik); tekshiruvlar', async () => {
    const m = await mkExam({}, { contributorIds: [tmathId, await User_find('tother')] });
    const r = await call('post', mb(m, '/rules'), tother, {
      ...sel([algebra]),
      difficulty: 1,
      count: 2,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rid = r.body.data.ruleId as string;
    expect((await call('patch', mb(m, `/rules/${rid}`), tmath, { count: 3 })).status).toBe(404);
    expect((await call('delete', mb(m, `/rules/${rid}`), tmath)).status).toBe(404);
    expect((await call('patch', mb(m, `/rules/${rid}`), tother, { count: 3 })).status).toBe(200);
    // tekshiruvlar
    expect((await call('post', mb(m, '/rules'), tmath, { difficulty: 2, count: 2 })).status).toBe(
      400,
    );
    expect(
      (await call('post', mb(m, '/rules'), tmath, { ...sel([algebra]), difficulty: 4, count: 2 }))
        .status,
    ).toBe(400);
    expect(
      (await call('post', mb(m, '/rules'), tmath, { ...sel([algebra]), difficulty: 2, count: 0 }))
        .status,
    ).toBe(400);
    expect(
      (await call('post', mb(m, '/rules'), tmath, { ...sel([langTopic]), difficulty: 2, count: 1 }))
        .status,
    ).toBe(400);
  });

  it('eski shakl (bitta topicId) qoida mavjud hujjatlarda ishlaydi: tekshiruv, DTO, rejalashtirish', async () => {
    const m = await mkExam(
      {},
      {
        items: [
          { kind: 'manual', questionIds: [bank['A2']![0]] },
          { kind: 'rule', topicId: geometry.id, count: 3, difficulty: 2 },
        ],
      },
    );
    const d = await call('get', `/sessions/${m.id}`, admin);
    expect(d.body.data.blocks[0].items[1]).toMatchObject({
      kind: 'rule',
      topicId: geometry.id,
      count: 3,
    });
    expect(d.body.data.blocks[0].items[1].topicIds).toBeUndefined();
    const rev = await call('get', `/sessions/${m.id}/blocks/${m.blockId}/questions`, admin);
    expect(rev.body.data.rules[0]).toMatchObject({
      topicName: 'Geometriya',
      count: 3,
      poolSize: 6,
      ruleId: null,
    });
    expect(
      (await call('post', `/sessions/${m.id}/blocks/${m.blockId}/ready`, admin, { ready: true }))
        .status,
    ).toBe(200);
    const sub = await call('post', `/sessions/${m.id}/submit`, admin, { confirmShort: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const s = (await ExamSession.findById(m.id))!;
    const rule = (s.blocks[0]!.items as unknown as { kind: string; poolIds?: unknown[] }[]).find(
      (i) => i.kind === 'rule',
    )!;
    expect(rule.poolIds).toHaveLength(6);
  });
});

describe('Rejalashtirish: hovuz tekshiruvi va muzlatish', () => {
  async function ready(m: Made) {
    expect(
      (await call('post', `/sessions/${m.id}/blocks/${m.blockId}/ready`, admin, { ready: true }))
        .status,
    ).toBe(200);
  }

  it('yetarli savol yo`q: aniq xato (mavzu nomlari, daraja, kerak/bor); kesishuvchi qoidalar umumiy yetishmovchiligi ham', async () => {
    const m = await mkExam();
    await call('post', mb(m, '/rules'), admin, { ...sel([algebra]), difficulty: 3, count: 9 });
    await ready(m);
    const sub = await call('post', `/sessions/${m.id}/submit`, admin, { confirmShort: true });
    expect(sub.status).toBe(400);
    const msgs = JSON.stringify(sub.body.error.details);
    expect(msgs).toContain('Algebra');
    expect(msgs).toContain('qiyin');
    expect(msgs).toMatch(/kerak 9, bor 4/);
    // kesishuvchi qoidalar: har biri yetarli, lekin birgalikda yetmaydi (Algebra qiyin 4 ta: 3 + 3 > 4)
    const m2 = await mkExam();
    await call('post', mb(m2, '/rules'), admin, { ...sel([algebra]), difficulty: 3, count: 3 });
    await call('post', mb(m2, '/rules'), admin, { allTopics: true, difficulty: 3, count: 3 });
    await ready(m2);
    const sub2 = await call('post', `/sessions/${m2.id}/submit`, admin, { confirmShort: true });
    expect(sub2.status).toBe(200); // 6 ta qiyin bor (Algebra 4 + Geometriya 2): yetarli
    const m3 = await mkExam();
    await call('post', mb(m3, '/rules'), admin, { ...sel([algebra]), difficulty: 3, count: 3 });
    await call('post', mb(m3, '/rules'), admin, { ...sel([algebra]), difficulty: 3, count: 3 });
    await ready(m3);
    const sub3 = await call('post', `/sessions/${m3.id}/submit`, admin, { confirmShort: true });
    expect(sub3.status).toBe(400);
    expect(JSON.stringify(sub3.body.error.details)).toContain('bir-birining savollarini oladi');
  });

  it('muzlatish: qoida hovuzi (poolIds) saqlanadi va savollar nusxasiga tushadi; qoida o`zgarmaydi', async () => {
    const m = await mkExam();
    await call('post', mb(m, '/rules'), tmath, {
      ...sel([algebra, geometry]),
      difficulty: 2,
      count: 5,
    });
    await ready(m);
    expect(
      (await call('post', `/sessions/${m.id}/submit`, admin, { confirmShort: true })).status,
    ).toBe(200);
    const s = (await ExamSession.findById(m.id).select('+questionPool'))!;
    const nb = normalizeBlocks(s)[0]!;
    expect(nb.contribRules).toHaveLength(1);
    expect(nb.contribRules[0]!.poolIds).toHaveLength(14); // 14 ta o'rta (qat'iy savol ham kiradi; tanlashda chiqarib tashlanadi)
    expect(nb.contribRules[0]).toMatchObject({
      count: 5,
      difficulty: 2,
      topicIds: [algebra.id, geometry.id],
    });
    const pool = new Set(s.questionPool.map((q) => String(q.questionId)));
    for (const id of nb.contribRules[0]!.poolIds as string[])
      expect(pool.has(String(id))).toBe(true);
    expect(effectiveItems(nb).filter((i) => i.kind === 'rule')).toHaveLength(1);
  });

  it('katta bank: qoida hovuzi qisqartiriladi (<= max(10 x son, 100)), lekin yetarlilik to`liq ro`yxat bo`yicha', async () => {
    const m = await mkExam();
    for (let i = 0; i < 130; i++) await mk(algebra, 1, `Ko'p ${i}`);
    await call('post', mb(m, '/rules'), tmath, { ...sel([algebra]), difficulty: 1, count: 3 });
    await ready(m);
    expect(
      (await call('post', `/sessions/${m.id}/submit`, admin, { confirmShort: true })).status,
    ).toBe(200);
    const s = (await ExamSession.findById(m.id))!;
    expect(normalizeBlocks(s)[0]!.contribRules[0]!.poolIds).toHaveLength(100);
  });
});

describe('Har o`quvchiga boshqacha: tanlash', () => {
  it('ikki o`quvchi: qat`iy savol bir xil, qoida savollari boshqacha, daraja aralashmasi bir xil', async () => {
    for (let i = 1; i <= 6; i++) await makeStudent(school.id, c7a.id, `Oquvchi ${i}`);
    const m = await mkExam();
    await call('post', mb(m, '/rules'), tmath, {
      ...sel([algebra, geometry]),
      difficulty: 2,
      count: 5,
    });
    await call('post', mb(m, '/rules'), tmath, { allTopics: true, difficulty: 3, count: 3 });
    await call('post', mb(m, '/rules'), tmath, {
      ...sel([algebra, geometry]),
      difficulty: 1,
      count: 1,
    });
    expect(
      (await call('post', `/sessions/${m.id}/participants`, admin, { classIds: [c7a.id] })).status,
    ).toBe(201);
    expect(
      (await call('post', `/sessions/${m.id}/blocks/${m.blockId}/ready`, admin, { ready: true }))
        .status,
    ).toBe(200);
    expect(
      (await call('post', `/sessions/${m.id}/submit`, admin, { confirmShort: true })).status,
    ).toBe(200);
    const doc = (await ExamSession.findById(m.id))!;
    const diff = new Map(
      (await Question.find({}).select('difficulty')).map((q) => [String(q._id), q.difficulty]),
    );
    at(new Date(doc.scheduledStart.getTime() + 5 * 60_000));
    const orders: string[][] = [];
    for (const [i, p] of doc.participants.entries()) {
      const pin = decryptPin(p.pinEnc, m.id)!;
      const j = await ec('post', '/join', null, {
        code: doc.code!,
        pin,
        deviceId: `device-rnd-${i}-aaaa`,
      });
      expect(j.status, JSON.stringify(j.body)).toBe(200);
      const st = await ec('post', '/start', j.body.data.token);
      expect(st.status, JSON.stringify(st.body)).toBe(200);
      const att = (await ExamAttempt.findOne({ participantKey: p.key }))!;
      const qids = att.order.map((o) => o.qid);
      orders.push(qids);
      expect(qids).toHaveLength(1 + 5 + 3 + 1);
      expect(qids).toContain(m.fixed);
      expect(new Set(qids).size).toBe(qids.length);
      const mix = [1, 2, 3].map((d) => qids.filter((q) => diff.get(q) === d).length);
      // qat'iy savol (o'rta) + qoidalar: oson 1, o'rta 1 + 5, qiyin 3
      expect(mix).toEqual([1, 6, 3]);
    }
    const sets = new Set(orders.map((o) => [...o].sort().join(',')));
    expect(sets.size).toBeGreaterThan(1); // 6 o'quvchi: hammasi bir xil bo'lishi amalda mumkin emas
    // javob kaliti klientga chiqmaydi
    const j = await ec('post', '/join', null, {
      code: doc.code!,
      pin: decryptPin(doc.participants[0]!.pinEnc, m.id)!,
      deviceId: 'device-rnd-0-aaaa',
    });
    const st = await ec('post', '/start', j.body.data.token);
    expect(JSON.stringify(st.body)).not.toContain('"answer"');
  });
});
