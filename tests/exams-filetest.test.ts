import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ExamAttempt } from '../src/models/ExamAttempt';
import { ExamFile } from '../src/models/ExamFile';
import { ExamSession } from '../src/models/ExamSession';
import { AuditLog } from '../src/models/AuditLog';
import { gradeAttempt } from '../src/modules/exam-client/grading';
import { blockQuestionCount, normalizeBlocks } from '../src/modules/exams/blocks/blocks.core';
import {
  balancedVariant,
  fileTestOf,
  orderOfVariant,
  parseKeyText,
  poolOfFileBlock,
  validateFileTest,
} from '../src/modules/exams/filetest/filetest.core';
import { runFileSweeper } from '../src/modules/exams/filetest/filetest.lifecycle';
import * as storageMod from '../src/modules/exams/filetest/filetest.storage';
import {
  filePath,
  filesConfig,
  inspectUpload,
} from '../src/modules/exams/filetest/filetest.storage';
import { SCHOOL_PURGE_STEPS, purgeStep } from '../src/modules/schools/schoolPurge';
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
let admin: string, oadmin: string, tmath: string, tfree: string, tfake: string;
let tmathId: string;
let c7a: Doc;
let l1 = '';
let m1 = '';
const DEV = 'device-aaaaaaaa';

const call = (
  m: 'get' | 'post' | 'patch' | 'delete' | 'put',
  url: string,
  t: string,
  body?: object,
  schoolId = school.id,
) => {
  const r = request(app)[m](`/api/v1/exams${url}`).set(bearer(t)).set('X-School-Id', schoolId);
  return body ? r.send(body) : r;
};
const ec = (m: 'get' | 'post' | 'put', url: string, token: string | null, body?: object) => {
  let r = request(app)[m](`/api/v1/exam-client${url}`).set('X-Forwarded-For', '10.0.0.7');
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const text = (t: string) => [{ type: 'text', text: t }];
const at = (d: Date) => clock.set(() => d);
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const startAt = () => new Date(Date.now() + 3 * 3_600_000);

/** Kichik yaroqli PDF (tag: har xil bayt, ya'ni har xil hash) */
const pdf = (tag: string, extra = '') =>
  Buffer.from(
    `%PDF-1.4\n%${tag}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n${extra}trailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1',
  );
const png = (w = 60, h = 40, color = '#ffffff') =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toBuffer();

async function upload(t: string, sid: string, bid: string, buf: Buffer, name = 'a.pdf') {
  return request(app)
    .post(`/api/v1/exams/my-blocks/${sid}/${bid}/files`)
    .set(bearer(t))
    .set('X-School-Id', school.id)
    .attach('file', buf, { filename: name, contentType: 'application/octet-stream' });
}

const KEY_A = [
  { no: 1, type: 'choice', options: 4, correct: ['C'], points: 1 },
  { no: 2, type: 'short', accepted: ['25'], points: 1 },
  { no: 3, type: 'choice', options: 5, correct: ['B', 'D'], points: 2 },
  { no: 4, type: 'short', accepted: ['Toshkent', 'Tashkent'], points: 1 },
];
const KEY_B = [
  { no: 1, type: 'choice', options: 4, correct: ['A'], points: 1 },
  { no: 2, type: 'short', accepted: ['0.5', '1/2'], points: 1 },
  { no: 3, type: 'choice', options: 5, correct: ['E'], points: 2 },
  { no: 4, type: 'short', accepted: ['Samarqand'], points: 1 },
];

afterAll(async () => {
  // Sinov fayllari papkasi (%TEMP%) tozalanadi
  await fs.rm(filesConfig.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(filesConfig.dir, { recursive: true, force: true });
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  lang = await makeSubject('Ona tili');
  const rootU = await makeUser({ username: 'root', role: 'superadmin' });
  const tm = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
  const tf = await makeUser({ username: 'tfree', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'tfake', role: 'teacher', schoolId: other.id });
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
  tmathId = tm.id;
  c7a = (await makeClass(school.id, year.id, '7-A')) as unknown as Doc;
  await assignSubject(school.id, c7a as never, math.id, tm.id);
  const c8 = (await makeClass(school.id, year.id, '8-A')) as unknown as Doc;
  await assignSubject(school.id, c8 as never, math.id, tf.id);
  for (const s of [school, other]) {
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootU.id);
  }
  admin = (await login('admin')).token;
  oadmin = (await login('oadmin')).token;
  tmath = (await login('tmath')).token;
  tfree = (await login('tfree')).token;
  tfake = (await login('tfake')).token;
  const topic = (await call('post', `/subjects/${lang.id}/topics`, admin, { name: 'Imlo' })).body
    .data;
  const q = await call('post', '/questions', admin, {
    topicId: topic.id,
    status: 'active',
    sharing: { mode: 'subject' },
    type: 'single',
    content: text('Lang 1'),
    options: [
      { id: 'a', content: text('A') },
      { id: 'b', content: text('B') },
    ],
    answer: { optionId: 'b' },
    points: 3,
  });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  l1 = q.body.data.id;
  const mt = (await call('post', `/subjects/${math.id}/topics`, admin, { name: 'Algebra' })).body
    .data;
  const mq = await call('post', '/questions', admin, {
    topicId: mt.id,
    status: 'active',
    sharing: { mode: 'subject' },
    type: 'single',
    content: text('Math 1'),
    options: [
      { id: 'a', content: text('A') },
      { id: 'b', content: text('B') },
    ],
    answer: { optionId: 'a' },
    points: 2,
  });
  expect(mq.status, JSON.stringify(mq.body)).toBe(201);
  m1 = mq.body.data.id;
});

// ---------------------------------------------------------------------------------------------
describe('birlik: kalit matni, tekshiruv, sun`iy savollar, variant taqsimoti', () => {
  it('parseKeyText: harf, ko`p harf, qisqa javob, ball, turli ajratgichlar', () => {
    const r = parseKeyText('1-C 2-A 3-25 4-B,D 5-b,d 6-12|12.5*2 7) E 8: Toshkent');
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const by = (n: number) => r.items.find((x) => x.no === n)!;
    expect(by(1)).toMatchObject({ type: 'choice', correct: ['C'], options: 4, points: 1 });
    expect(by(3)).toMatchObject({ type: 'short', accepted: ['25'] });
    expect(by(4)).toMatchObject({ type: 'choice', correct: ['B', 'D'] });
    expect(by(5)).toMatchObject({ type: 'choice', correct: ['B', 'D'] }); // kichik harf
    expect(by(6)).toMatchObject({ type: 'short', accepted: ['12', '12.5'], points: 2 });
    expect(by(7)).toMatchObject({ type: 'choice', correct: ['E'], options: 5 }); // E variantlarni 5 ga oshiradi
    expect(by(8)).toMatchObject({ type: 'short', accepted: ['Toshkent'] });
  });

  it('parseKeyText: qator ajratilgan, kirill o`xshash harflar, bo`shliqli vergul, xatolar va tushib qolgan raqamlar', () => {
    const r = parseKeyText('1) А\n2) В, С\n4-C', { options: 5, points: 3 });
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({ correct: ['A'], options: 5, points: 3 }); // kirill А
    expect(r.items[1]).toMatchObject({ correct: ['B', 'C'] });
    expect(r.warnings[0]).toMatch(/3/); // 3-savol yo'q
    const dup = parseKeyText('1-A 1-B');
    expect(dup.errors.join()).toMatch(/takrorlangan/);
    expect(parseKeyText('salom dunyo').errors[0]).toMatch(/Misol/);
    expect(parseKeyText('1-A*0').errors.join()).toMatch(/ball/);
    expect(parseKeyText('300-A').errors.join()).toMatch(/raqam/);
  });

  it('validateFileTest: tuzilma (qoralama) va qat`iy (rejalashtirish) qoidalari', () => {
    const v = (letter: string, key: unknown[], files = ['f1']) => ({
      letter,
      kind: 'pdf',
      files,
      key,
    });
    const ok = fileTestOf({ variants: [v('A', KEY_A), v('B', KEY_B, ['f2'])] })!;
    expect(validateFileTest(ok, true)).toEqual([]);
    // qoralama: fayl yo'q ham mumkin, lekin elementlar to'g'ri bo'lishi shart
    const draft = fileTestOf({ variants: [v('A', KEY_A, [])] })!;
    expect(validateFileTest(draft, false)).toEqual([]);
    expect(
      validateFileTest(draft, true)
        .map((x) => x.message)
        .join(),
    ).toMatch(/fayl yuklanmagan/);
    // savollar soni va ballar yig'indisi variantlarda bir xil bo'lishi
    const diffN = fileTestOf({ variants: [v('A', KEY_A), v('B', KEY_B.slice(0, 3), ['f2'])] })!;
    expect(
      validateFileTest(diffN, true)
        .map((x) => x.message)
        .join(),
    ).toMatch(/savollar soni/);
    const diffP = fileTestOf({
      variants: [
        v('A', KEY_A),
        v(
          'B',
          KEY_B.map((k) => ({ ...k, points: 3 })),
          ['f2'],
        ),
      ],
    })!;
    expect(
      validateFileTest(diffP, true)
        .map((x) => x.message)
        .join(),
    ).toMatch(/ballar/);
    // to'g'ri javob variantlar orasida yo'q, raqamlar ketma-ket emas, harf takror
    const bad = fileTestOf({
      variants: [
        v('A', [{ no: 1, type: 'choice', options: 2, correct: ['D'], points: 1 }]),
        v('A', [{ no: 2, type: 'short', accepted: [], points: 1 }], ['f2']),
      ],
    })!;
    const msgs = validateFileTest(bad, false)
      .map((x) => x.message)
      .join('|');
    expect(msgs).toMatch(/"D" variantlar orasida yo'q/);
    expect(msgs).toMatch(/takrorlangan/);
    expect(msgs).toMatch(/ketma-ket/);
    expect(msgs).toMatch(/javob kiritilmagan/);
  });

  it('sun`iy savollar va baholash: bitta/ko`p tanlov, qisqa javob normallashuvi (25 = 25,0 = 25.0)', () => {
    const ft = fileTestOf({
      variants: [
        {
          letter: 'A',
          kind: 'pdf',
          files: ['f'],
          key: [...KEY_A, { no: 5, type: 'short', accepted: ['25'], points: 1 }],
        },
      ],
    })!;
    const pool = new Map(poolOfFileBlock('B1', null, ft).map((q) => [String(q.questionId), q]));
    expect(pool.size).toBe(5);
    expect(pool.get('fk:B1:A:3')!.type).toBe('multi');
    expect(pool.get('fk:B1:A:1')!.type).toBe('single');
    expect([...pool.keys()].every((k) => k.length <= 40)).toBe(true);
    const order = orderOfVariant('B1', ft.variants[0]!);
    const saved = (m: Record<string, unknown>) =>
      Object.entries(m).map(([qid, value]) => ({
        qid,
        value,
        flagged: false,
        answered: true,
        at: new Date(),
      }));
    const full = gradeAttempt(
      order,
      saved({
        'fk:B1:A:1': 'C',
        'fk:B1:A:2': '25,0',
        'fk:B1:A:3': ['D', 'B'],
        'fk:B1:A:4': '  TASHKENT ',
        'fk:B1:A:5': '25.00',
      }),
      pool as never,
    );
    expect(full.earned).toBe(6);
    expect(full.max).toBe(6);
    const part = gradeAttempt(
      order,
      saved({
        'fk:B1:A:1': 'A',
        'fk:B1:A:2': '26',
        'fk:B1:A:3': ['B'], // to'liq mos kelmasa ball yo'q (qisman ball yo'q)
        'fk:B1:A:4': 'Samarqand',
      }),
      pool as never,
    );
    expect(part.earned).toBe(0);
    // tartib: kalit raqamlari bo'yicha, aralashtirilmaydi; variantlar harflar bilan
    expect(order.map((o) => o.no)).toEqual([1, 2, 3, 4, 5]);
    expect(order[2]).toMatchObject({
      type: 'multi',
      variant: 'A',
      optionPerm: ['A', 'B', 'C', 'D', 'E'],
    });
  });

  it('balancedVariant: har davrda har variant bir martadan, farq <= 1, deterministik, tartib tasodifiy', () => {
    for (const letters of [['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D'], ['A']]) {
      const counts: Record<string, number> = {};
      const seq: string[] = [];
      for (let c = 0; c < 37; c++) {
        const l = balancedVariant(letters, c, 'sess:blk');
        seq.push(l);
        counts[l] = (counts[l] ?? 0) + 1;
        const vals = letters.map((x) => counts[x] ?? 0);
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
      }
      expect(seq).toEqual(
        Array.from({ length: 37 }, (_, c) => balancedVariant(letters, c, 'sess:blk')),
      );
    }
    // tartib hamma davrlarda bir xil emas
    const rounds = new Set<string>();
    for (let r = 0; r < 12; r++) {
      rounds.add(
        [0, 1, 2, 3].map((i) => balancedVariant(['A', 'B', 'C', 'D'], r * 4 + i, 's')).join(''),
      );
    }
    expect(rounds.size).toBeGreaterThan(3);
  });

  it('normalizeBlocks: eski blok `bank`; fayl bloki bank maydonlarini e`tiborsiz qoldiradi, savollar soni = kalit', () => {
    const [old] = normalizeBlocks({ blocks: [{ blockId: 'b1', subjectId: 's' }] });
    expect(old!.content).toBe('bank');
    expect(old!.fileTest).toBeNull();
    const ft = { variants: [{ letter: 'A', kind: 'pdf', files: ['f'], key: KEY_A }] };
    const [fb] = normalizeBlocks({
      blocks: [
        {
          blockId: 'b2',
          subjectId: 's',
          content: 'file',
          items: [{ kind: 'manual', questionIds: ['q1', 'q2'] }],
          contribQuestions: [{ questionId: 'q3', addedBy: 'u', addedAt: null }],
          fileTest: ft,
        },
      ],
    });
    expect(fb!.items).toEqual([]);
    expect(fb!.contribQuestions).toEqual([]);
    expect(blockQuestionCount(fb!)).toBe(4);
    expect(legacyOf()).toBe(true);
  });
});

function legacyOf() {
  const [l] = normalizeBlocks({ sections: [{ items: [{ kind: 'manual', questionIds: ['a'] }] }] });
  return l!.legacy && l!.content === 'bank';
}

// ---------------------------------------------------------------------------------------------
/** Buferni vaqtinchalik faylga yozib inspectUpload ga beradi (xizmat diskdan ishlaydi) */
async function inspect(buf: Buffer) {
  const dir = path.join(filesConfig.dir, '.tmp');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `t-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(p, buf);
  try {
    const r = await inspectUpload(p);
    return { ...r, data: await fs.readFile(r.path) };
  } finally {
    await fs.unlink(p).catch(() => undefined);
  }
}

describe('fayl tekshiruvi (magic-bytes, hajm, EXIF), diskdan', () => {
  it('PDF: yaroqli; skript, parol, buzilgan, bo`sh, katta, boshqa tur rad etiladi', async () => {
    const ok = await inspect(pdf('x'));
    expect(ok).toMatchObject({ kind: 'pdf', contentType: 'application/pdf', pages: 1 });
    await expect(inspect(pdf('x', '/S/JavaScript /JS (app.alert(1))\n'))).rejects.toThrow(/skript/);
    await expect(inspect(pdf('x', '/Encrypt 5 0 R\n'))).rejects.toThrow(/Parol/);
    await expect(inspect(Buffer.from('%PDF-1.4\nbuzilgan', 'latin1'))).rejects.toThrow(
      /to‘liq emas/,
    );
    await expect(inspect(Buffer.alloc(0))).rejects.toThrow(/bo‘sh/);
    await expect(inspect(Buffer.from('MZ\x90\x00exe fayl', 'latin1'))).rejects.toThrow(/Faqat PDF/);
    await expect(inspect(Buffer.alloc(filesConfig.maxFileBytes + 1, 1))).rejects.toThrow(/10 MB/);
  });

  it('PDF markeri 256 KB chunk chegarasida bo`lsa ham topiladi; sahifalar ikki marta sanalmaydi', async () => {
    const pad = Buffer.alloc(256 * 1024 - 20, 0x20);
    const pageMark = Buffer.from('/Type /Page ', 'latin1');
    const buf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      pad,
      pageMark,
      Buffer.from('/Type /Page \n%%EOF\n', 'latin1'),
    ]);
    expect((await inspect(buf)).pages).toBe(2);
    const js = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.alloc(256 * 1024 - 14, 0x20),
      Buffer.from('/JavaScript\n%%EOF', 'latin1'),
    ]);
    await expect(inspect(js)).rejects.toThrow(/skript/);
  });

  it('rasm: JPEG/PNG qayta kodlanadi (WebP), EXIF/GPS o`chadi, kattasi kichraytiriladi, buzilgan rad etiladi', async () => {
    const jpg = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'maxfiy-muallif' } })
      .toBuffer();
    expect((await sharp(jpg).metadata()).exif).toBeTruthy();
    const r = await inspect(jpg);
    expect(r).toMatchObject({ kind: 'image', contentType: 'image/webp', width: 2200 });
    expect(r.data.includes('maxfiy-muallif')).toBe(false);
    expect((await sharp(r.data).metadata()).exif).toBeUndefined();
    await expect(inspect(Buffer.concat([jpg.subarray(0, 3), Buffer.alloc(50, 7)]))).rejects.toThrow(
      /buzilgan/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
interface Spec {
  content: 'file' | 'bank';
  contrib?: string[];
}
/** Ustada usul tanlanmaydi (§23): bloklar odatiy yaratiladi, usulni keyin blok sahifasida `content` endpointi almashtiradi */
const modeOf = new WeakMap<object, 'file' | 'bank'>();
const specs = (...s: Spec[]) =>
  s.map((x, i) => {
    const b = {
      subjectId: i === 0 ? math.id : lang.id,
      targetCount: x.content === 'bank' ? 1 : 0,
      coefficient: 1,
      durationMin: 30,
      contributorIds: x.contrib ?? [],
      items: x.content === 'bank' ? [{ kind: 'manual', questionIds: [i === 0 ? m1 : l1] }] : [],
    };
    modeOf.set(b, x.content);
    return b;
  });

async function mkSession(blocks: ReturnType<typeof specs>, extra: object = {}) {
  const r = await call('post', '/sessions', admin, {
    title: 'DTM fayl',
    type: 'quarter',
    classIds: [c7a.id],
    blocks,
    scoringMode: 'points',
    timingMode: 'common',
    scheduledStart: startAt().toISOString(),
    durationMin: 60,
    resultsMode: 'score_answers',
    shuffleQuestions: true,
    shuffleOptions: true,
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const out = r.body.data as { id: string; blocks: { id: string }[] };
  for (const [i, b] of blocks.entries()) {
    if (modeOf.get(b) === 'file') {
      const sw = await call('put', `/my-blocks/${out.id}/${out.blocks[i]!.id}/content`, admin, {
        content: 'file',
        from: 'bank',
      });
      expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    }
  }
  return out;
}

/** Fayl blokini to'ldiradi: har variant uchun fayl yuklaydi va kalitni saqlaydi. Qaytaradi: fayl id lari */
async function fill(
  t: string,
  sid: string,
  bid: string,
  variants: { letter: string; key: unknown[]; tag?: string }[],
) {
  const out: Record<string, string> = {};
  const body = [];
  for (const v of variants) {
    const up = await upload(t, sid, bid, pdf(`${bid}${v.letter}${v.tag ?? ''}`));
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    out[v.letter] = up.body.data.file.id;
    body.push({ letter: v.letter, kind: 'pdf', files: [up.body.data.file.id], key: v.key });
  }
  const put = await call('put', `/my-blocks/${sid}/${bid}/file-test`, t, { variants: body });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return out;
}

async function schedule(sid: string, bids: string[], students = 4) {
  for (let i = 1; i <= students; i++) await makeStudent(school.id, c7a.id, `Oquvchi ${i}`);
  expect(
    (await call('post', `/sessions/${sid}/participants`, admin, { classIds: [c7a.id] })).status,
  ).toBe(201);
  for (const b of bids) {
    expect(
      (await call('post', `/sessions/${sid}/blocks/${b}/ready`, admin, { ready: true })).status,
    ).toBe(200);
  }
  const sub = await call('post', `/sessions/${sid}/submit`, admin, { confirmShort: true });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const doc = (await ExamSession.findById(sid))!;
  const pins: Record<string, string> = {};
  for (const p of doc.participants) pins[p.fullName] = decryptPin(p.pinEnc, sid)!;
  return { id: sid, code: doc.code!, start: doc.scheduledStart, pins };
}

async function join(s: Awaited<ReturnType<typeof schedule>>, name: string) {
  const j = await ec('post', '/join', null, { code: s.code, pin: s.pins[name], deviceId: DEV });
  expect(j.status, JSON.stringify(j.body)).toBe(200);
  return j.body.data.token as string;
}

const ANSWERS: Record<string, Record<number, unknown>> = {
  A: { 1: 'C', 2: '25,0', 3: ['D', 'B'], 4: ' tashkent ' },
  B: { 1: 'A', 2: '1/2', 3: 'E', 4: 'Samarqand' },
};
const qidOf = (bid: string, letter: string, no: number) => `fk:${bid}:${letter}:${no}`;

// ---------------------------------------------------------------------------------------------
describe('blok yaratish va fayl testini tahrirlash (ruxsat, qulf, tekshiruv)', () => {
  it('tuzuvchi `file` blok yaratadi; eski mijoz (content yubormasdan) tahrirlasa rejim va fayl testi saqlanadi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const [bf, bb] = s.blocks.map((b) => b.id);
    const det = await call('get', `/sessions/${s.id}`, admin);
    expect(det.body.data.blocks[0]).toMatchObject({ content: 'file', count: 0 });
    expect(det.body.data.blocks[1]).toMatchObject({ content: 'bank', count: 1 });
    await fill(tmath, s.id, bf!, [{ letter: 'A', key: KEY_A }]);
    const after = await call('get', `/sessions/${s.id}`, admin);
    expect(after.body.data.blocks[0]).toMatchObject({
      content: 'file',
      count: 4,
      targetCount: 4,
      fileTest: { questions: 4, variants: [{ letter: 'A', files: 1, questions: 4, points: 5 }] },
    });
    // kalit sessiya DTO sida YO'Q
    expect(JSON.stringify(after.body)).not.toMatch(/Toshkent|accepted|correct/);
    // eski mijoz: `content` yo'q, bloklar qayta yuboriladi
    const resend = await call('patch', `/sessions/${s.id}`, admin, {
      blocks: [
        { blockId: bf, subjectId: math.id, targetCount: 0, contributorIds: [tmathId], items: [] },
        {
          blockId: bb,
          subjectId: lang.id,
          targetCount: 1,
          items: [{ kind: 'manual', questionIds: [l1] }],
        },
      ],
    });
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    const again = await call('get', `/sessions/${s.id}`, admin);
    expect(again.body.data.blocks[0]).toMatchObject({ content: 'file', count: 4 });
    // ustada usul tanlanmaydi (§23): `content` yuborilsa sxema rad etadi
    const sw = await call('patch', `/sessions/${s.id}`, admin, {
      blocks: [
        {
          blockId: bf,
          subjectId: math.id,
          targetCount: 1,
          contributorIds: [tmathId],
          items: [],
          content: 'bank',
        },
      ],
    });
    expect(sw.status).toBe(400);
    const raw = (await ExamSession.findById(s.id))!.blocks[0] as unknown as {
      content: string;
      fileTest: unknown;
    };
    expect(raw.content).toBe('file');
    expect(raw.fileTest).toBeTruthy();
  });

  it('ruxsat: faqat biriktirilgan o`qituvchi va tuzuvchi; boshqa o`qituvchi/maktab: 404; bank blokida 409', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const [bf, bb] = s.blocks.map((b) => b.id);
    const url = `/my-blocks/${s.id}/${bf}/file-test`;
    expect((await call('get', url, tmath)).status).toBe(200);
    expect((await call('get', url, admin)).status).toBe(200);
    expect((await call('get', url, tfree)).status).toBe(404); // biriktirilmagan
    expect((await call('get', url, tfake, undefined, other.id)).status).toBe(404); // boshqa maktab o'qituvchisi
    expect((await call('get', url, oadmin, undefined, other.id)).status).toBe(404); // boshqa maktab admini
    expect((await call('put', url, tfree, { variants: [] })).status).toBe(404);
    expect((await upload(tfree, s.id, bf!, pdf('z'))).status).toBe(404);
    // bank bloki: fayl testi yo'q
    const bankUrl = `/my-blocks/${s.id}/${bb}/file-test`;
    expect((await call('put', bankUrl, admin, { variants: [] })).status).toBe(409);
    expect((await upload(admin, s.id, bb!, pdf('z'))).status).toBe(409);
    expect(
      (await call('get', `/my-blocks/${s.id}/${'0'.repeat(24)}/file-test`, admin)).status,
    ).toBe(404);
  });

  it('PUT tekshiruvi: noto`g`ri kalit 400, begona (boshqa maktab) fayl id 400, to`g`ri saqlanadi va kalit qaytadi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const url = `/my-blocks/${s.id}/${bf}/file-test`;
    const up = await upload(tmath, s.id, bf, pdf('1'));
    const fid = up.body.data.file.id as string;
    expect(up.body.data.file).toMatchObject({ kind: 'pdf', contentType: 'application/pdf' });
    const v = (key: unknown[], files = [fid]) => ({
      variants: [{ letter: 'A', kind: 'pdf', files, key }],
    });
    const badKey = await call(
      'put',
      url,
      tmath,
      v([{ no: 1, type: 'choice', options: 4, correct: [], points: 1 }]),
    );
    expect(badKey.status).toBe(400);
    expect(JSON.stringify(badKey.body)).toMatch(/to'g'ri javob belgilanmagan/);
    expect(
      (await call('put', url, tmath, v([{ no: 2, type: 'short', accepted: ['1'], points: 1 }])))
        .status,
    ).toBe(400);
    expect(
      (await call('put', url, tmath, { variants: [{ ...v(KEY_A).variants[0], letter: 'E' }] }))
        .status,
    ).toBe(400);
    expect((await call('put', url, tmath, v(KEY_A, ['f'.repeat(24)]))).status).toBe(400); // yo'q fayl
    // boshqa maktab fayli
    const foreign = await ExamFile.create({
      schoolId: other.id,
      sessionId: s.id,
      blockId: bf,
      storageName: 'f'.repeat(32),
      kind: 'pdf',
      contentType: 'application/pdf',
      state: 'ready',
    });
    expect((await call('put', url, tmath, v(KEY_A, [String(foreign._id)]))).status).toBe(400);
    const ok = await call('put', url, tmath, v(KEY_A));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.variants[0].key).toHaveLength(4);
    expect(ok.body.data.variants[0].files[0]).toMatchObject({ id: fid, kind: 'pdf' });
    expect((await ExamFile.findById(fid))!.bound).toBe(true);
    // dedup yo'q: har yuklash o'z yozuvi va o'z fayli (fayl aniq bitta imtihonga tegishli)
    const again = await upload(tmath, s.id, bf, pdf('1'));
    expect(again.body.data.file.id).not.toBe(fid);
    expect(await ExamFile.countDocuments({ schoolId: school.id })).toBe(2);
  });

  it('yuklash: noto`g`ri fayl 400, rasm EXIF siz qayta kodlanadi; ko`rish: egasi/tuzuvchi, begona 404', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    expect((await upload(tmath, s.id, bf, Buffer.from('MZexe'), 'a.pdf')).status).toBe(400);
    expect((await upload(tmath, s.id, bf, pdf('j', '/JavaScript\n'))).status).toBe(400);
    const img = await upload(tmath, s.id, bf, await png(), 'a.png');
    expect(img.status, JSON.stringify(img.body)).toBe(200);
    expect(img.body.data.file).toMatchObject({ kind: 'image', contentType: 'image/webp' });
    const fid = img.body.data.file.id as string;
    // saqlanmagan fayl: faqat yuklagan odam (va uning blokida) ko'radi
    const mine = await call('get', `/my-blocks/${s.id}/${bf}/files/${fid}`, tmath);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toBe('image/webp');
    expect(mine.headers['x-content-type-options']).toBe('nosniff');
    expect(mine.headers['cache-control']).toMatch(/private/);
    expect((await call('get', `/my-blocks/${s.id}/${bf}/files/${fid}`, admin)).status).toBe(404); // yuklamagan, hali bog'lanmagan
    expect((await call('get', `/my-blocks/${s.id}/${bf}/files/${fid}`, tfree)).status).toBe(404);
    // blokka bog'langach tuzuvchi ham ko'radi
    const put = await call('put', `/my-blocks/${s.id}/${bf}/file-test`, tmath, {
      variants: [{ letter: 'A', kind: 'image', files: [fid], key: KEY_A }],
    });
    expect(put.status).toBe(200);
    expect((await call('get', `/my-blocks/${s.id}/${bf}/files/${fid}`, admin)).status).toBe(200);
    expect((await call('get', `/my-blocks/${s.id}/${bf}/files/${fid}`, tfree)).status).toBe(404);
    expect((await call('get', `/my-blocks/${s.id}/${bf}/files/not-an-id`, tmath)).status).toBe(400);
  });

  it('kalit matnini o`qish endpointi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const r = await call('post', `/my-blocks/${s.id}/${bf}/file-test/key/parse`, tmath, {
      text: '1-C 2-A 3-25 4-B,D',
      options: 4,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.items).toHaveLength(4);
    expect(r.body.data.errors).toEqual([]);
    expect(
      (await call('post', `/my-blocks/${s.id}/${bf}/file-test/key/parse`, tfree, { text: '1-A' }))
        .status,
    ).toBe(404);
  });

  it('qulf: qoralamadan chiqqach, muddat o`tgach va tuzuvchi "tayyor" qo`ygach o`qituvchi o`zgartira olmaydi', async () => {
    const dl = new Date(Date.now() + 3_600_000);
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }), {
      contribDeadline: dl.toISOString(),
    });
    const bf = s.blocks[0]!.id;
    const fl = await fill(tmath, s.id, bf, [{ letter: 'A', key: KEY_A }]);
    const put = (t: string) =>
      call('put', `/my-blocks/${s.id}/${bf}/file-test`, t, {
        variants: [{ letter: 'A', kind: 'pdf', files: [fl.A], key: KEY_A }],
      });
    expect((await put(tmath)).status).toBe(200);
    // tuzuvchi "tayyor" qo'ydi: o'qituvchi uchun qulf, tuzuvchi o'zgartira oladi
    expect(
      (await call('post', `/sessions/${s.id}/blocks/${bf}/ready`, admin, { ready: true })).status,
    ).toBe(200);
    expect((await put(tmath)).status).toBe(403);
    expect((await put(admin)).status).toBe(200);
    expect(
      (await call('post', `/sessions/${s.id}/blocks/${bf}/ready`, admin, { ready: false })).status,
    ).toBe(200);
    // muddat o'tdi
    at(mins(dl, 5));
    expect((await put(tmath)).status).toBe(403);
    expect((await upload(tmath, s.id, bf, pdf('late'))).status).toBe(403);
    clock.reset();
    // imtihon qoralamadan chiqdi
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'scheduled' } });
    expect((await put(admin)).status).toBe(403);
    expect((await upload(admin, s.id, bf, pdf('late2'))).status).toBe(403);
  });

  it('"tayyor" va rejalashtirish: to`liq bo`lmagan fayl bloki rad etiladi; variantlarda soni/ball teng bo`lishi shart', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const [bf, bb] = s.blocks.map((b) => b.id);
    // bo'sh fayl bloki: "tayyor" 422
    const empty = await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true });
    expect(empty.status).toBe(400);
    expect(JSON.stringify(empty.body)).toMatch(/kamida bitta variant/);
    // faqat qoralama (faylsiz) saqlanadi, lekin "tayyor" bo'lmaydi
    await call('put', `/my-blocks/${s.id}/${bf}/file-test`, tmath, {
      variants: [{ letter: 'A', kind: 'pdf', files: [], key: KEY_A }],
    });
    const nofile = await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true });
    expect(nofile.status).toBe(400);
    expect(JSON.stringify(nofile.body)).toMatch(/fayl yuklanmagan/);
    // variantlarda ballar yig'indisi teng emas
    const fa = await upload(tmath, s.id, bf!, pdf('a1'));
    const fb = await upload(tmath, s.id, bf!, pdf('b1'));
    await call('put', `/my-blocks/${s.id}/${bf}/file-test`, tmath, {
      variants: [
        { letter: 'A', kind: 'pdf', files: [fa.body.data.file.id], key: KEY_A },
        {
          letter: 'B',
          kind: 'pdf',
          files: [fb.body.data.file.id],
          key: KEY_B.map((k) => ({ ...k, points: 2 })),
        },
      ],
    });
    const uneq = await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true });
    expect(uneq.status).toBe(400);
    expect(JSON.stringify(uneq.body)).toMatch(/ballar yig'indisi/);
    // tuzuvchi uchun ham xuddi shu
    expect(
      (await call('post', `/sessions/${s.id}/blocks/${bf}/ready`, admin, { ready: true })).status,
    ).toBe(400);
    // rejalashtirishdan oldin tekshiruv ham bor (tayyor belgisi aylanib o'tilsa ham): to'g'rilab qayta urinish
    await call('put', `/my-blocks/${s.id}/${bf}/file-test`, tmath, {
      variants: [
        { letter: 'A', kind: 'pdf', files: [fa.body.data.file.id], key: KEY_A },
        { letter: 'B', kind: 'pdf', files: [fb.body.data.file.id], key: KEY_B },
      ],
    });
    expect(
      (await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true })).status,
    ).toBe(200);
    await makeStudent(school.id, c7a.id, 'Oquvchi 1');
    await call('post', `/sessions/${s.id}/participants`, admin, { classIds: [c7a.id] });
    await call('post', `/sessions/${s.id}/blocks/${bb}/ready`, admin, { ready: true });
    expect(
      (await call('post', `/sessions/${s.id}/blocks/${bf}/ready`, admin, { ready: true })).status,
    ).toBe(200);
    // "tayyor" belgisidan keyin ma'lumot buzildi (qo'lda o'zgartirish): rejalashtirish baribir rad etadi
    await ExamSession.updateOne(
      { _id: s.id, 'blocks.blockId': bf },
      { $set: { 'blocks.$.fileTest.variants.1.key.0.points': 9 } },
    );
    const sub = await call('post', `/sessions/${s.id}/submit`, admin, { confirmShort: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(400);
    expect(JSON.stringify(sub.body)).toMatch(/ballar yig'indisi/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('imtihon topshirish: variant, fayl ruxsati, javoblar, baholash, natijalar', () => {
  async function ready(mode: 'common' | 'per_block' = 'common', resultsMode = 'score_answers') {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }), {
      timingMode: mode,
      resultsMode,
      ...(mode === 'per_block' ? { durationMin: undefined } : {}),
    });
    const [bf, bb] = s.blocks.map((b) => b.id) as [string, string];
    const files = await fill(tmath, s.id, bf, [
      { letter: 'A', key: KEY_A },
      { letter: 'B', key: KEY_B },
    ]);
    expect(
      (await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true })).status,
    ).toBe(200);
    const sc = await schedule(s.id, [bf, bb]);
    return { ...sc, bf, bb, files };
  }

  it('variantlar tekis taqsimlanadi, savollar kalit tartibida, javob kaliti mijozga chiqmaydi', async () => {
    const s = await ready();
    at(mins(s.start, 1));
    const seen: Record<string, number> = { A: 0, B: 0 };
    const variantOf: Record<string, string> = {};
    for (const name of ['Oquvchi 1', 'Oquvchi 2', 'Oquvchi 3', 'Oquvchi 4']) {
      const token = await join(s, name);
      const st = await ec('post', '/start', token);
      expect(st.status, JSON.stringify(st.body)).toBe(200);
      const fb = st.body.data.files as {
        blockId: string;
        variant: string;
        kind: string;
        files: { id: string }[];
      }[];
      expect(fb).toHaveLength(1);
      expect(fb[0]).toMatchObject({ blockId: s.bf, kind: 'pdf' });
      expect(fb[0]!.files).toEqual([{ id: s.files[fb[0]!.variant]! }]);
      seen[fb[0]!.variant]!++;
      variantOf[name] = fb[0]!.variant;
      const qs = (
        st.body.data.questions as {
          blockId: string;
          no?: number;
          type: string;
          id: string;
          content: unknown[];
        }[]
      ).filter((q) => q.blockId === s.bf);
      expect(qs.map((q) => q.no)).toEqual([1, 2, 3, 4]); // aralashtirilmagan
      expect(qs.map((q) => q.type)).toEqual(
        fb[0]!.variant === 'A'
          ? ['single', 'short', 'multi', 'short']
          : ['single', 'short', 'single', 'short'],
      );
      expect(qs[0]!.content).toEqual([]);
      expect(qs[0]!.id).toBe(qidOf(s.bf, fb[0]!.variant, 1));
      const dump = JSON.stringify(st.body).toLowerCase();
      for (const w of [
        'toshkent',
        'tashkent',
        'samarqand',
        'accepted',
        '"correct"',
        'optionid',
        'filetest',
      ]) {
        expect(dump, w).not.toContain(w);
      }
    }
    expect(seen).toEqual({ A: 2, B: 2 });
    // idempotent: qayta /start variantni o'zgartirmaydi, hisoblagich oshmaydi
    const t1 = await join(s, 'Oquvchi 1');
    const again = await ec('post', '/start', t1);
    expect(again.body.data.files[0].variant).toBe(variantOf['Oquvchi 1']);
    const doc = (await ExamSession.findById(s.id))!;
    expect(doc.fileCounters?.[s.bf]).toBe(4);
    // bank bloki (aralash imtihon) ham ishtirokchida
    expect(again.body.data.questions.some((q: { blockId: string }) => q.blockId === s.bb)).toBe(
      true,
    );
    expect(again.body.data.blocks.find((b: { id: string }) => b.id === s.bf).questionCount).toBe(4);
    const att = (await ExamAttempt.findOne({ sessionId: s.id }))!;
    expect(att.fileVariants[s.bf]).toMatch(/^[AB]$/);
  });

  it('fayl ruxsati: boshlashdan oldin 404, o`z varianti 200 (ETag/304, private kesh), begona variant/sessiya/token 404', async () => {
    const s = await ready();
    const s2 = await ready();
    at(mins(s.start, 1));
    const t1 = await join(s, 'Oquvchi 1');
    // boshlamagan (joined): fayl yo'q
    for (const id of Object.values(s.files))
      expect((await ec('get', `/files/${id}`, t1)).status).toBe(404);
    const st = await ec('post', '/start', t1);
    const mineId = st.body.data.files[0].files[0].id as string;
    const otherId = Object.values(s.files).find((x) => x !== mineId)!;
    const f = await ec('get', `/files/${mineId}`, t1);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect(f.headers['cache-control']).toBe('private, max-age=3600');
    expect(f.headers.vary).toMatch(/Authorization/i);
    expect(f.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(f.body).subarray(0, 5).toString()).toBe('%PDF-');
    const etag = f.headers.etag as string;
    const nm = await ec('get', `/files/${mineId}`, t1).set('If-None-Match', etag);
    expect(nm.status).toBe(304);
    // boshqa variant fayli, boshqa imtihon fayli, tokensiz, yaroqsiz id
    expect((await ec('get', `/files/${otherId}`, t1)).status).toBe(404);
    expect((await ec('get', `/files/${s2.files.A}`, t1)).status).toBe(404);
    expect((await ec('get', `/files/${mineId}`, null)).status).toBe(401);
    expect((await ec('get', `/files/zzz`, t1)).status).toBe(400);
    // boshqa ishtirokchi (boshqa variantdagi) bu faylni ola olmaydi
    const t2 = await join(s, 'Oquvchi 2');
    const st2 = await ec('post', '/start', t2);
    const id2 = st2.body.data.files[0].files[0].id as string;
    expect(id2).not.toBe(mineId);
    expect((await ec('get', `/files/${mineId}`, t2)).status).toBe(404);
    expect((await ec('get', `/files/${id2}`, t2)).status).toBe(200);
    // admin tokeni exam-client da ishlamaydi
    expect((await ec('get', `/files/${mineId}`, tmath)).status).toBe(401);
  });

  it('boshlanish vaqtidan oldin start qilib bo`lmaydi, shuning uchun fayl ham olinmaydi', async () => {
    const s = await ready();
    // boshlanishdan oldin kirib ham, boshlab ham bo'lmaydi: token berilmaydi, fayl esa tokensiz yopiq
    const j = await ec('post', '/join', null, {
      code: s.code,
      pin: s.pins['Oquvchi 1'],
      deviceId: DEV,
    });
    expect(j.status).toBe(409);
    expect((await ec('get', `/files/${s.files.A}`, null)).status).toBe(401);
    expect((await ec('get', `/files/${s.files.A}`, 'x'.repeat(40))).status).toBe(401);
    at(mins(s.start, 1));
    const t = await join(s, 'Oquvchi 1');
    // kirgan, lekin hali start qilmagan: fayl yo'q
    expect((await ec('get', `/files/${s.files.A}`, t)).status).toBe(404);
    expect((await ec('post', '/start', t)).status).toBe(200);
  });

  it('javoblar saqlanadi (yangi shakl: harf/ko`p harf/matn), baholanadi; natija, tafsilot, tahlil, eksport, variant ustuni', async () => {
    const s = await ready();
    at(mins(s.start, 1));
    const out: Record<string, { variant: string; token: string }> = {};
    for (const name of ['Oquvchi 1', 'Oquvchi 2', 'Oquvchi 3', 'Oquvchi 4']) {
      const token = await join(s, name);
      const st = await ec('post', '/start', token);
      out[name] = { variant: st.body.data.files[0].variant, token };
    }
    // 1-2: to'g'ri; 3: yarmi; 4: hammasi xato
    const answerFor = (name: string, mode: 'all' | 'half' | 'none') => {
      const v = out[name]!.variant;
      const right = ANSWERS[v]!;
      const wrong: Record<number, unknown> = {
        1: 'D',
        2: '99',
        3: v === 'A' ? ['A'] : 'A',
        4: 'x',
      };
      const pick = (n: number) =>
        mode === 'all' || (mode === 'half' && n <= 2) ? right[n] : wrong[n];
      return [1, 2, 3, 4].map((n) => ({ qid: qidOf(s.bf, v, n), value: pick(n) }));
    };
    const plan: [string, 'all' | 'half' | 'none'][] = [
      ['Oquvchi 1', 'all'],
      ['Oquvchi 2', 'all'],
      ['Oquvchi 3', 'half'],
      ['Oquvchi 4', 'none'],
    ];
    for (const [name, mode] of plan) {
      const { token } = out[name]!;
      const put = await ec('put', '/answers', token, {
        clientSeq: 1,
        answers: answerFor(name, mode),
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body.data.answeredCount).toBe(4);
      // noto'g'ri variantga yoki boshqa variant savoliga javob: 422
      const other2 = out[name]!.variant === 'A' ? 'B' : 'A';
      const bad = await ec('put', '/answers', token, {
        clientSeq: 2,
        answers: [{ qid: qidOf(s.bf, other2, 1), value: 'A' }],
      });
      expect(bad.status).toBe(400);
      const badLetter = await ec('put', '/answers', token, {
        clientSeq: 3,
        answers: [{ qid: qidOf(s.bf, out[name]!.variant, 1), value: 'F' }],
      });
      expect(badLetter.status).toBe(400); // 4 variantli savolda F yo'q
      const sub = await ec('post', '/submit', token);
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      const d = sub.body.data;
      const expected = mode === 'all' ? 5 : mode === 'half' ? 2 : 0; // lang bank bloki: javob berilmagan (0)
      expect(d.score.earned, name).toBe(expected);
      expect(d.score.max).toBe(5 + 3); // fayl bloki 5 + bank bloki 3
      // natija rejimi score_answers: kalit ko'rsatiladi
      const rv = d.review.find((r: { id: string }) => r.id === qidOf(s.bf, out[name]!.variant, 1));
      expect(rv.reveal.optionIds).toEqual([ANSWERS[out[name]!.variant]![1] === 'C' ? 'C' : 'A']);
    }
    // natijalar jadvali
    const res = await call('get', `/sessions/${s.id}/results`, admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.data.rows as {
      fullName: string;
      variant: string | null;
      earned: number;
      rank: number;
    }[];
    for (const r of rows) expect(r.variant).toBe(out[r.fullName]!.variant);
    expect(rows.find((r) => r.fullName === 'Oquvchi 1')!.earned).toBe(5);
    expect(res.body.data.summary.submitted).toBe(4);
    // ishtirokchi tafsiloti: variant, har savol: javob, to'g'ri javob, ball
    const key1 = (await ExamSession.findById(s.id))!.participants.find(
      (p) => p.fullName === 'Oquvchi 3',
    )!.key;
    const det = await call('get', `/sessions/${s.id}/results/${key1}`, admin);
    expect(det.status).toBe(200);
    const v3 = out['Oquvchi 3']!.variant;
    expect(det.body.data.variants[s.bf]).toBe(v3);
    expect(det.body.data.variant).toBe(v3);
    const q1 = det.body.data.questions[0];
    expect(q1.content[0].text).toBe(`${v3} varianti: 1-savol`);
    expect(q1.given).toBe(ANSWERS[v3]![1]);
    expect(q1.ok).toBe(true);
    const q3 = det.body.data.questions[2];
    expect(q3.type).toBe(v3 === 'A' ? 'multi' : 'single');
    expect(q3.correct.optionIds).toEqual(v3 === 'A' ? ['B', 'D'] : ['E']);
    expect(q3.ok).toBe(false);
    const q4 = det.body.data.questions[3];
    expect(q4.correct.texts).toEqual(v3 === 'A' ? ['Toshkent', 'Tashkent'] : ['Samarqand']);
    // tahlil: har variant savoli alohida (A varianti: 1-savol ...)
    const an = await call('get', `/sessions/${s.id}/results/analysis`, admin);
    expect(an.status).toBe(200);
    const aq = an.body.data.questions as {
      id: string;
      shown: number;
      correctPercent: number | null;
      blockId: string;
      content: { text: string }[];
    }[];
    const a1 = aq.find((q) => q.id === qidOf(s.bf, 'A', 1))!;
    expect(a1.content[0]!.text).toBe('A varianti: 1-savol');
    expect(a1.blockId).toBe(s.bf);
    expect(a1.shown).toBe(2);
    expect(aq.filter((q) => q.blockId === s.bf)).toHaveLength(8);
    // eksport: Variant ustuni, matritsa
    const x = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=xlsx`)
      .set(bearer(admin))
      .set('X-School-Id', school.id)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as never);
    const header = wb.worksheets[0]!.getRow(wb.worksheets[0]!.actualRowCount > 6 ? 6 : 6)
      .values as unknown[];
    const all = JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
    expect(all).toContain('Variant');
    expect(all).toContain('A varianti: 1-savol');
    void header;
  });

  it('natija rejimi: `score` bo`lsa topshirgandan keyin fayl yopiladi; `score_answers` da o`quvchi o`z faylini ko`radi', async () => {
    const strict = await ready('common', 'score');
    at(mins(strict.start, 1));
    const t = await join(strict, 'Oquvchi 1');
    const st = await ec('post', '/start', t);
    const id = st.body.data.files[0].files[0].id as string;
    expect((await ec('get', `/files/${id}`, t)).status).toBe(200);
    await ec('post', '/submit', t);
    expect((await ec('get', `/files/${id}`, t)).status).toBe(404);
    // topshirilgan urinishga javob yozilmaydi
    const vq = qidOf(strict.bf, st.body.data.files[0].variant, 1);
    expect(
      (await ec('put', '/answers', t, { clientSeq: 5, answers: [{ qid: vq, value: 'A' }] })).status,
    ).toBe(409);
    const open = await ready('common', 'score_answers');
    at(mins(open.start, 1));
    const t2 = await join(open, 'Oquvchi 1');
    const st2 = await ec('post', '/start', t2);
    const id2 = st2.body.data.files[0].files[0].id as string;
    await ec('post', '/submit', t2);
    expect((await ec('get', `/files/${id2}`, t2)).status).toBe(200);
  });

  it('blokma-blok vaqt: faqat JORIY blok fayli ochiq; blok tugagach yopiladi', async () => {
    // ikkala blok ham fayl bloki
    const s0 = await mkSession(
      specs({ content: 'file', contrib: [tmathId] }, { content: 'file' }),
      {
        timingMode: 'per_block',
        durationMin: undefined,
      },
    );
    const [b1, b2] = s0.blocks.map((b) => b.id) as [string, string];
    const f1 = await fill(admin, s0.id, b1, [{ letter: 'A', key: KEY_A }]);
    const f2 = await fill(admin, s0.id, b2, [{ letter: 'A', key: KEY_B, tag: 'lang' }]);
    const s = await schedule(s0.id, [b1, b2]);
    at(mins(s.start, 1));
    const t = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', t);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    // joriy blok: faqat birinchi blok fayli ko'rinadi
    expect(st.body.data.files).toHaveLength(1);
    expect(st.body.data.files[0].blockId).toBe(b1);
    expect((await ec('get', `/files/${f1.A}`, t)).status).toBe(200);
    expect((await ec('get', `/files/${f2.A}`, t)).status).toBe(404); // keyingi blok hali ochilmagan
    // blok javobi
    const put = await ec('put', '/answers', t, {
      clientSeq: 1,
      answers: [{ qid: qidOf(b1, 'A', 1), value: 'C' }],
    });
    expect(put.status).toBe(200);
    const fin = await ec('post', '/blocks/finish', t, { blockId: b1 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.data.files[0].blockId).toBe(b2);
    expect((await ec('get', `/files/${f1.A}`, t)).status).toBe(404); // oldingi blok yopildi
    expect((await ec('get', `/files/${f2.A}`, t)).status).toBe(200);
    // yopilgan blokka javob yozilmaydi
    const late = await ec('put', '/answers', t, {
      clientSeq: 2,
      answers: [{ qid: qidOf(b1, 'A', 2), value: '25' }],
    });
    expect(late.body.data.rejected).toEqual([qidOf(b1, 'A', 2)]);
  });

  it('bitta variantli blok; ko`p fayl (rasmlar) tartibi saqlanadi', async () => {
    const s0 = await mkSession(specs({ content: 'file' }, { content: 'bank' }));
    const bf = s0.blocks[0]!.id;
    const ids: string[] = [];
    for (const c of ['#fff', '#eee', '#ddd']) {
      const up = await upload(admin, s0.id, bf, await png(80, 60, c), 'p.png');
      ids.push(up.body.data.file.id);
    }
    const reversed = [...ids].reverse();
    const put = await call('put', `/my-blocks/${s0.id}/${bf}/file-test`, admin, {
      variants: [{ letter: 'C', kind: 'image', files: reversed, key: KEY_A }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.variants[0].files.map((f: { id: string }) => f.id)).toEqual(reversed);
    const s = await schedule(s0.id, [bf, s0.blocks[1]!.id]);
    at(mins(s.start, 1));
    const t = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', t);
    expect(st.body.data.files[0]).toMatchObject({ variant: 'C', kind: 'image' });
    expect(st.body.data.files[0].files.map((f: { id: string }) => f.id)).toEqual(reversed);
    const img = await ec('get', `/files/${reversed[0]}`, t);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
  });
});

// ---------------------------------------------------------------------------------------------
describe('orqaga moslik va tozalash', () => {
  it('savollar banki bloklari o`zgarmaydi: fayl maydonlari yo`q, `files` bo`sh, eski javob shakli', async () => {
    const s0 = await mkSession(specs({ content: 'bank' }, { content: 'bank' }));
    const bids = s0.blocks.map((b) => b.id) as [string, string];
    // ikkinchi blok ham bank (math fan uchun faqat 1 savol: l1 lang fani, shuning uchun faqat lang blok)
    const det = await call('get', `/sessions/${s0.id}`, admin);
    expect(
      det.body.data.blocks.every(
        (b: { content: string; fileTest: unknown }) => b.content === 'bank' && b.fileTest === null,
      ),
    ).toBe(true);
    void bids;
  });

  it('eski hujjat (content/fileTest maydonisiz) bank deb o`qiladi', async () => {
    const s0 = await mkSession(specs({ content: 'bank' }));
    await ExamSession.updateOne(
      { _id: s0.id },
      { $unset: { 'blocks.0.content': 1, 'blocks.0.fileTest': 1 } },
    );
    const det = await call('get', `/sessions/${s0.id}`, admin);
    expect(det.body.data.blocks[0]).toMatchObject({ content: 'bank', fileTest: null });
    const mine = await call('get', `/my-blocks`, tmath);
    expect(mine.status).toBe(200);
  });

  it('bog`lanmagan yuklash 24 soatdan keyin sweeper bilan tozalanadi (baytlar ham); bog`langan fayl qoladi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const old = await upload(tmath, s.id, bf, pdf('old'));
    const keep = await upload(tmath, s.id, bf, pdf('keep'));
    await call('put', `/my-blocks/${s.id}/${bf}/file-test`, tmath, {
      variants: [{ letter: 'A', kind: 'pdf', files: [keep.body.data.file.id], key: KEY_A }],
    });
    const oldDoc = (await ExamFile.findById(old.body.data.file.id))!;
    const keepDoc = (await ExamFile.findById(keep.body.data.file.id))!;
    const diskOf = (n: string) => path.join(filesConfig.dir, n);
    await fs.access(diskOf(oldDoc.storageName));
    // 23 soat: hali tegilmaydi
    await runFileSweeper(new Date(Date.now() + 23 * 3_600_000));
    expect(await ExamFile.countDocuments({ _id: oldDoc._id })).toBe(1);
    await runFileSweeper(new Date(Date.now() + 25 * 3_600_000));
    expect(await ExamFile.countDocuments({ _id: oldDoc._id })).toBe(0);
    await expect(fs.access(diskOf(oldDoc.storageName))).rejects.toThrow();
    expect(await ExamFile.countDocuments({ _id: keepDoc._id })).toBe(1);
    await fs.access(diskOf(keepDoc.storageName));
  });

  it('kalit auditga yozilmaydi (faqat tuzilma)', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    await fill(tmath, s.id, bf, [{ letter: 'A', key: KEY_A }]);
    const logs = await AuditLog.find({
      action: { $in: ['exam.block.file_test_save', 'exam.block.file_upload'] },
    }).lean();
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toMatch(/Toshkent|accepted|correct/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('qo`shimcha: shablon va nusxa', () => {
  it('imtihon nusxasi: rejim, yetkazish va kalit ko`chadi, fayllar ko`chmaydi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    await fill(tmath, s.id, bf, [{ letter: 'A', key: KEY_A }]);
    const cp = await call('post', `/sessions/${s.id}/copy`, admin, {});
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    const copy = await call('get', `/sessions/${cp.body.data.session.id}`, admin);
    // rejim, yetkazish va KALIT ko'chadi; fayllar ko'chmaydi ("faylni qayta yuklang")
    expect(copy.body.data.blocks[0]).toMatchObject({
      content: 'file',
      count: 4,
      fileTest: {
        delivery: 'screen',
        questions: 4,
        variants: [{ letter: 'A', files: 0, questions: 4 }],
      },
    });
    expect(copy.body.data.blocks[1]).toMatchObject({ content: 'bank', count: 1 });
  });
});

// =============================================================================================
// §23: usul almashtirish, qog'oz, diskda saqlash, oqim, umr sikli
// =============================================================================================
const diskNames = async () =>
  (await fs.readdir(filesConfig.dir)).filter((n) => /^[0-9a-f]{32}$/.test(n));
const tmpLeft = async () => {
  try {
    return await fs.readdir(path.join(filesConfig.dir, '.tmp'));
  } catch {
    return [];
  }
};
const PAPER_A = KEY_A;
const PAPER_B = KEY_B;

/** Imtihon: Matematika (fayl, ekranda), Ona tili (bank) — o'qituvchi kalitni to'ldiradi, tuzuvchi tasdiqlaydi */
async function mixedExam(delivery: 'screen' | 'paper' = 'screen', extra: object = {}) {
  const s = await mkSession(
    specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }),
    extra,
  );
  const [bf, bb] = s.blocks.map((b) => b.id) as [string, string];
  let files: Record<string, string> = {};
  if (delivery === 'screen') {
    files = await fill(tmath, s.id, bf, [
      { letter: 'A', key: KEY_A },
      { letter: 'B', key: KEY_B },
    ]);
  } else {
    const put = await call('put', `/my-blocks/${s.id}/${bf}/file-test`, tmath, {
      delivery: 'paper',
      variants: [
        { letter: 'A', kind: 'pdf', files: [], key: PAPER_A },
        { letter: 'B', kind: 'pdf', files: [], key: PAPER_B },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  expect(
    (await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true })).status,
  ).toBe(200);
  const sc = await schedule(s.id, [bf, bb]);
  return { ...sc, bf, bb, files };
}

describe('usul almashtirish (ustada emas, blok sahifasida), aralash imtihon', () => {
  it('almashtirish: ikkala mazmun saqlanadi, faqat faol usul N/maqsad/tayyor hisobida; qaytganda tiklanadi', async () => {
    const s = await mkSession(specs({ content: 'bank', contrib: [tmathId] }, { content: 'bank' }));
    const [bm] = s.blocks.map((b) => b.id) as [string];
    const url = `/my-blocks/${s.id}/${bm}`;
    // bank mazmuni qo'shamiz
    expect((await call('post', `${url}/questions`, tmath, { questionIds: [m1] })).status).toBe(200);
    const g0 = await call('get', `${url}/file-test`, tmath);
    expect(g0.body.data).toMatchObject({ content: 'bank', hasBank: true, hasFile: false });
    const toFile = await call('put', `${url}/content`, tmath, { content: 'file', from: 'bank' });
    expect(toFile.status, JSON.stringify(toFile.body)).toBe(200);
    expect(toFile.body.data).toMatchObject({ content: 'file', hasBank: true });
    // fayl rejimida N = 0 (kalit yo'q), bank mazmuni hisobda emas
    expect((await ExamSession.findById(s.id))!.blocks[0]).toMatchObject({ content: 'file' });
    const det1 = await call('get', `/sessions/${s.id}`, admin);
    expect(det1.body.data.blocks[0]).toMatchObject({ content: 'file', count: 0 });
    // bank savol qo'shish fayl rejimida 409
    const add = await call('post', `${url}/questions`, tmath, { questionIds: [m1] });
    expect(add.status).toBe(409);
    expect(JSON.stringify(add.body)).toMatch(/Fayl \+ kalit/);
    // kalit saqlaymiz
    await fill(tmath, s.id, bm, [{ letter: 'A', key: KEY_A }]);
    const det2 = await call('get', `/sessions/${s.id}`, admin);
    expect(det2.body.data.blocks[0]).toMatchObject({ content: 'file', count: 4, targetCount: 4 });
    // bank rejimiga qaytish: bank mazmuni tiklanadi, kalit yashirin qoladi
    const back = await call('put', `${url}/content`, tmath, { content: 'bank', from: 'file' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data).toMatchObject({ content: 'bank', hasBank: true, hasFile: true });
    const det3 = await call('get', `/sessions/${s.id}`, admin);
    expect(det3.body.data.blocks[0]).toMatchObject({ content: 'bank', count: 1 });
    const mb = await call('get', url, tmath);
    expect(mb.body.data.questions).toHaveLength(1);
    expect(mb.body.data.block.content).toBe('bank');
    // fayl testi o'chmagan: qayta almashtirsak kalit turadi
    const again = await call('put', `${url}/content`, tmath, { content: 'file', from: 'bank' });
    expect(again.body.data.variants[0].key).toHaveLength(4);
    expect((await ExamSession.findById(s.id))!.blocks[0]).toMatchObject({ targetCount: 4 });
    // bank rejimiga qaytganda maqsad tiklanadi
    await call('put', `${url}/content`, tmath, { content: 'bank', from: 'file' });
    expect((await ExamSession.findById(s.id))!.blocks[0]).toMatchObject({ targetCount: 1 });
  });

  it('almashtirish: tahrir qulfi (savollar bilan bir xil), noto`g`ri `from` 409, begona 404, "tayyor" belgisi bekor', async () => {
    const dl = new Date(Date.now() + 3_600_000);
    const s = await mkSession(specs({ content: 'bank', contrib: [tmathId] }, { content: 'bank' }), {
      contribDeadline: dl.toISOString(),
    });
    const bm = s.blocks[0]!.id;
    const url = `/my-blocks/${s.id}/${bm}/content`;
    expect((await call('put', url, tfree, { content: 'file', from: 'bank' })).status).toBe(404);
    expect((await call('put', url, tmath, { content: 'bank', from: 'file' })).status).toBe(409); // joriy: bank
    expect((await call('put', url, tmath, { content: 'x', from: 'bank' })).status).toBe(400);
    // tayyor (o'qituvchi) -> almashtirish tayyor belgisini bekor qiladi
    await call('post', `/my-blocks/${s.id}/${bm}/ready`, tmath, { ready: true });
    expect((await ExamSession.findById(s.id))!.blocks[0]).toMatchObject({ status: 'ready' });
    expect((await call('put', url, tmath, { content: 'file', from: 'bank' })).status).toBe(200);
    expect((await ExamSession.findById(s.id))!.blocks[0]).toMatchObject({
      status: 'open',
      content: 'file',
    });
    // tuzuvchi tayyor qo'ydi -> o'qituvchi uchun qulf
    await fill(tmath, s.id, bm, [{ letter: 'A', key: KEY_A }]);
    await call('post', `/sessions/${s.id}/blocks/${bm}/ready`, admin, { ready: true });
    expect((await call('put', url, tmath, { content: 'bank', from: 'file' })).status).toBe(403);
    // muddat o'tdi
    await call('post', `/sessions/${s.id}/blocks/${bm}/ready`, admin, { ready: false });
    at(mins(dl, 5));
    expect((await call('put', url, tmath, { content: 'bank', from: 'file' })).status).toBe(403);
    clock.reset();
    // imtihon qoralamadan chiqdi
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'scheduled' } });
    expect((await call('put', url, admin, { content: 'bank', from: 'file' })).status).toBe(403);
  });

  it('REGRESSIYA: ikki o`qituvchi bir vaqtda almashtirsa faqat biri o`tadi (atomik), natija izchil', async () => {
    const tm2 = await makeUser({ username: 'tmath2', role: 'teacher', schoolId: school.id });
    await assignSubject(school.id, c7a as never, math.id, tm2.id);
    const t2 = (await login('tmath2')).token;
    const s = await mkSession(
      specs({ content: 'bank', contrib: [tmathId, tm2.id] }, { content: 'bank' }),
    );
    const url = `/my-blocks/${s.id}/${s.blocks[0]!.id}/content`;
    for (let round = 0; round < 3; round++) {
      const from = round % 2 === 0 ? 'bank' : 'file';
      const to = from === 'bank' ? 'file' : 'bank';
      const [a, b] = await Promise.all([
        call('put', url, tmath, { content: to, from }),
        call('put', url, t2, { content: to, from }),
      ]);
      expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([200, 409]);
      expect((await ExamSession.findById(s.id))!.blocks[0]).toMatchObject({ content: to });
    }
    // bank yozuvi va almashtirish poygasi: savol qo'shish va file ga o'tish parallel -> yo qo'shiladi, yo 409; hech qachon aralash holat
    const [add, sw] = await Promise.all([
      call('post', `/my-blocks/${s.id}/${s.blocks[0]!.id}/questions`, tmath, { questionIds: [m1] }),
      call('put', url, t2, { content: 'file', from: 'bank' }),
    ]);
    const final = (await ExamSession.findById(s.id))!.blocks[0] as unknown as {
      content: string;
      contribQuestions: unknown[];
    };
    if (add.status === 200) expect(final.contribQuestions).toHaveLength(1);
    else expect(add.status).toBe(409);
    expect([200, 409]).toContain(sw.status);
  });

  it('aralash imtihon: Matematika fayl, Ona tili bank: boshlash, javob, ball yig`indisi, natijalar', async () => {
    const s = await mixedExam('screen');
    at(mins(s.start, 1));
    const token = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', token);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const qs = st.body.data.questions as { id: string; blockId: string; no?: number }[];
    expect(qs.filter((q) => q.blockId === s.bf)).toHaveLength(4);
    expect(qs.filter((q) => q.blockId === s.bb)).toHaveLength(1); // bank: Ona tili
    expect(st.body.data.files).toHaveLength(1); // faqat fayl bloki
    const v = st.body.data.files[0].variant as string;
    const bankQid = qs.find((q) => q.blockId === s.bb)!.id;
    const put = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [
        ...[1, 2, 3, 4].map((n) => ({ qid: qidOf(s.bf, v, n), value: ANSWERS[v]![n] })),
        { qid: bankQid, value: 'b' },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const sub = await ec('post', '/submit', token);
    expect(sub.body.data.score).toMatchObject({ earned: 5 + 3, max: 5 + 3 });
  });
});

describe('qog`oz yetkazish', () => {
  it('kalit saqlanadi, fayl yuklanmaydi (409), rejalashtirish fayllarsiz o`tadi; to`liq bo`lmagan kalit rad etiladi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const url = `/my-blocks/${s.id}/${bf}/file-test`;
    const put = await call('put', url, tmath, {
      delivery: 'paper',
      variants: [{ letter: 'A', kind: 'pdf', files: [], key: PAPER_A }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ delivery: 'paper', questions: 4 });
    expect((await upload(tmath, s.id, bf, pdf('p1'))).status).toBe(409);
    expect(await diskNames()).toEqual([]);
    // paper: fayl yuborilsa e'tiborsiz (ro'yxat bo'sh)
    const withFile = await call('put', url, tmath, {
      delivery: 'paper',
      variants: [{ letter: 'A', kind: 'pdf', files: ['a'.repeat(24)], key: PAPER_A }],
    });
    expect(withFile.status).toBe(200);
    expect(withFile.body.data.variants[0].files).toEqual([]);
    expect(
      (await call('post', `/my-blocks/${s.id}/${bf}/ready`, tmath, { ready: true })).status,
    ).toBe(200);
    // kalit to'liq emas (javobsiz element): "tayyor" rad
    const bad = await call('put', url, tmath, {
      delivery: 'paper',
      variants: [
        {
          letter: 'A',
          kind: 'pdf',
          files: [],
          key: [{ no: 1, type: 'choice', options: 4, correct: [], points: 1 }],
        },
      ],
    });
    expect(bad.status).toBe(400);
  });

  it('o`quvchi variantni tanlaydi (tasdiqdan keyin qulf), kalit chiqmaydi, ball tanlangan variant bo`yicha', async () => {
    const s = await mixedExam('paper');
    at(mins(s.start, 1));
    const token = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', token);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    // tanlashdan oldin: blok savollari yo'q, variantlar ro'yxati bor, fayl yo'q
    expect(st.body.data.files).toEqual([
      expect.objectContaining({
        blockId: s.bf,
        delivery: 'paper',
        variant: null,
        variants: ['A', 'B'],
        files: [],
      }),
    ]);
    expect(
      (st.body.data.questions as { blockId: string }[]).filter((q) => q.blockId === s.bf),
    ).toHaveLength(0);
    const dump = JSON.stringify(st.body).toLowerCase();
    for (const w of ['toshkent', 'samarqand', 'accepted', '"correct"'])
      expect(dump).not.toContain(w);
    // tanlashdan oldin javob yozib bo'lmaydi
    expect(
      (
        await ec('put', '/answers', token, {
          clientSeq: 1,
          answers: [{ qid: qidOf(s.bf, 'A', 1), value: 'C' }],
        })
      ).status,
    ).toBe(400);
    // noto'g'ri variant / blok
    expect((await ec('post', '/variant', token, { blockId: s.bf, variant: 'E' })).status).toBe(400);
    expect((await ec('post', '/variant', token, { blockId: s.bb, variant: 'A' })).status).toBe(409); // bank bloki
    const ch = await ec('post', '/variant', token, { blockId: s.bf, variant: 'B' });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    expect(ch.body.data.files[0]).toMatchObject({ variant: 'B', delivery: 'paper', files: [] });
    const qs = (ch.body.data.questions as { blockId: string; no?: number; id: string }[]).filter(
      (q) => q.blockId === s.bf,
    );
    expect(qs.map((q) => q.no)).toEqual([1, 2, 3, 4]);
    expect(qs[0]!.id).toBe(qidOf(s.bf, 'B', 1));
    // qulf
    const again = await ec('post', '/variant', token, { blockId: s.bf, variant: 'A' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/nazoratchiga/);
    // /start qayta: tanlov saqlangan
    expect((await ec('post', '/start', token)).body.data.files[0].variant).toBe('B');
    // javoblar B kaliti bo'yicha
    const put = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [1, 2, 3, 4].map((n) => ({ qid: qidOf(s.bf, 'B', n), value: ANSWERS.B![n] })),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const sub = await ec('post', '/submit', token);
    expect(sub.body.data.score.earned).toBe(5);
    // paper: fayl endpointi hech narsa bermaydi
    expect((await ec('get', `/files/${'a'.repeat(24)}`, token)).status).toBe(404);
  });

  it('tuzuvchi/nazoratchi variantni tuzatadi: javoblar savol raqami bo`yicha ko`chadi, ball qayta hisoblanadi, audit; boshqalar 404', async () => {
    const s = await mixedExam('paper');
    at(mins(s.start, 1));
    const token = await join(s, 'Oquvchi 1');
    await ec('post', '/start', token);
    await ec('post', '/variant', token, { blockId: s.bf, variant: 'A' }); // xato tanladi (qog'ozi B)
    // B ning to'g'ri javoblari: 1-A 2-1/2 3-E 4-Samarqand; A kaliti bilan ball kam bo'ladi
    const answers = [
      { n: 1, v: 'A' },
      { n: 2, v: '1/2' },
      { n: 3, v: 'E' },
      { n: 4, v: 'Samarqand' },
    ];
    // 3-savol A variantida 5 variantli multi: 'E' string multi uchun mos emas, shuning uchun multi ga massiv
    const put = await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [
        { qid: qidOf(s.bf, 'A', 1), value: 'A' },
        { qid: qidOf(s.bf, 'A', 2), value: '1/2' },
        { qid: qidOf(s.bf, 'A', 3), value: ['E'] },
        { qid: qidOf(s.bf, 'A', 4), value: 'Samarqand' },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    void answers;
    await ec('post', '/submit', token);
    const key = (await ExamSession.findById(s.id))!.participants.find(
      (p) => p.fullName === 'Oquvchi 1',
    )!.key;
    const before = await call('get', `/sessions/${s.id}/results`, admin);
    expect(
      before.body.data.rows.find((r: { fullName: string }) => r.fullName === 'Oquvchi 1'),
    ).toMatchObject({ variant: 'A' });
    const urlv = `/sessions/${s.id}/results/${key}/variant`;
    // ruxsatsizlar
    expect((await call('put', urlv, tfree, { blockId: s.bf, variant: 'B' })).status).toBe(404);
    expect((await call('put', urlv, tmath, { blockId: s.bf, variant: 'B' })).status).toBe(404); // biriktirilgan o'qituvchi nazoratchi emas
    expect((await call('put', urlv, admin, { blockId: s.bb, variant: 'B' })).status).toBe(409); // bank bloki
    expect((await call('put', urlv, admin, { blockId: s.bf, variant: 'D' })).status).toBe(400);
    const fix = await call('put', urlv, admin, { blockId: s.bf, variant: 'B' });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(fix.body.data).toEqual({ variant: 'B', previous: 'A' });
    const att = (await ExamAttempt.findOne({ sessionId: s.id, participantKey: key }))!;
    expect(att.fileVariants[s.bf]).toBe('B');
    expect(att.order.filter((o) => o.blockId === s.bf).map((o) => o.qid)).toEqual(
      [1, 2, 3, 4].map((n) => qidOf(s.bf, 'B', n)),
    );
    expect(att.saved.map((x) => x.qid).filter((q) => q.startsWith('fk:'))).toEqual(
      [1, 2, 3, 4].map((n) => qidOf(s.bf, 'B', n)),
    );
    const after = await call('get', `/sessions/${s.id}/results/${key}`, admin);
    expect(after.body.data.variant).toBe('B');
    // B kaliti: 1 A (to'g'ri), 2 1/2 (to'g'ri), 3 ['E'] single E (qiymat massiv: B da 'single' -> noto'g'ri), 4 to'g'ri
    expect(after.body.data.questions[0].ok).toBe(true);
    expect(after.body.data.questions[1].ok).toBe(true);
    const logs = await AuditLog.find({ action: 'exam.attempt.variant_correct' }).lean();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toMatch(/Samarqand|Toshkent/);
    // natijalar jadvalida yangi variant
    const rows = await call('get', `/sessions/${s.id}/results`, admin);
    expect(
      rows.body.data.rows.find((r: { fullName: string }) => r.fullName === 'Oquvchi 1'),
    ).toMatchObject({ variant: 'B' });
  });

  it('nazoratchi (supervisor) ham tuzata oladi; boshlamagan o`quvchi uchun 409; o`quvchi tokeni bilan imkonsiz', async () => {
    const s = await mixedExam('paper');
    await ExamSession.updateOne({ _id: s.id }, { $set: { supervisorIds: [tfree] as never } }).catch(
      () => undefined,
    );
    const sup = await makeUser({ username: 'nazorat', role: 'teacher', schoolId: school.id });
    await ExamSession.updateOne({ _id: s.id }, { $set: { supervisorIds: [sup.id] } });
    const ts = (await login('nazorat')).token;
    at(mins(s.start, 1));
    const key1 = (await ExamSession.findById(s.id))!.participants[0]!.key;
    const urlv = `/sessions/${s.id}/results/${key1}/variant`;
    expect((await call('put', urlv, ts, { blockId: s.bf, variant: 'A' })).status).toBe(404); // urinish yo'q
    const name = (await ExamSession.findById(s.id))!.participants[0]!.fullName;
    const token = await join(s, name);
    expect((await call('put', urlv, ts, { blockId: s.bf, variant: 'A' })).status).toBe(409); // hali boshlamagan
    await ec('post', '/start', token);
    // tanlamagan o'quvchi: nazoratchi o'zi belgilaydi
    expect((await call('put', urlv, ts, { blockId: s.bf, variant: 'A' })).status).toBe(200);
    expect((await ec('post', '/variant', token, { blockId: s.bf, variant: 'B' })).status).toBe(409);
    expect(
      (
        await ec('put', `/../sessions/x/results/${key1}/variant`, token, {
          blockId: s.bf,
          variant: 'A',
        })
      ).status,
    ).toBe(404);
  });
});

describe('diskda saqlash: yo`l xavfsizligi, atomiklik, chegaralar', () => {
  it('diskdagi nom faqat server yaratgan 32 hex; foydalanuvchi fayl nomi/yo`li ta`sir qilmaydi; .tmp toza', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    for (const evil of [
      '../../evil.pdf',
      '..\\..\\evil.pdf',
      '/etc/passwd',
      'a/b/../../c.pdf',
      '%2e%2e%2fx.pdf',
    ]) {
      const r = await upload(tmath, s.id, bf, pdf(`e${evil.length}`), evil);
      expect(r.status, `${evil}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    const names = await diskNames();
    expect(names).toHaveLength(5);
    // papkadan tashqariga hech narsa yozilmagan
    const parent = await fs.readdir(path.dirname(filesConfig.dir));
    expect(parent.some((n) => /evil|passwd/.test(n))).toBe(false);
    const all = await fs.readdir(filesConfig.dir);
    expect(all.filter((n) => !/^[0-9a-f]{32}$/.test(n))).toEqual(['.tmp']);
    expect(await tmpLeft()).toEqual([]);
    for (const bad of [
      '../x',
      'a/b',
      '..',
      '',
      'x'.repeat(32),
      'A'.repeat(32),
      `${'a'.repeat(31)}/`,
      'a'.repeat(33),
    ]) {
      expect(() => filePath(bad), bad).toThrow();
    }
    expect(filePath('a'.repeat(32))).toBe(path.join(filesConfig.dir, 'a'.repeat(32)));
  });

  it('xato yo`llarida vaqtinchalik fayl qoladi emas: noto`g`ri PDF, katta fayl, begona maktab, qulflangan blok', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    expect((await upload(tmath, s.id, bf, Buffer.from('MZ exe'))).status).toBe(400);
    expect((await upload(tmath, s.id, bf, pdf('j', '/JavaScript\n'))).status).toBe(400);
    expect(
      (await upload(tmath, s.id, bf, Buffer.alloc(filesConfig.maxFileBytes + 1024, 1))).status,
    ).toBe(400);
    expect((await upload(tfree, s.id, bf, pdf('z'))).status).toBe(404);
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'scheduled' } });
    expect((await upload(admin, s.id, bf, pdf('late'))).status).toBe(403);
    await new Promise((r) => setTimeout(r, 100));
    expect(await tmpLeft()).toEqual([]);
    expect(await diskNames()).toEqual([]);
    expect(await ExamFile.countDocuments({})).toBe(0);
    const big = await upload(tmath, s.id, bf, Buffer.alloc(1), 'x.pdf');
    void big;
  });

  it('chegaralar: 10 MB xabari, jami hajm (parallel yuklashga chidamli), bo`sh joy, papka yozilmasa 503', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const big = await upload(tmath, s.id, bf, Buffer.alloc(filesConfig.maxFileBytes + 10, 1));
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.body)).toMatch(/10 MB/);
    const size = pdf('qq0').length;
    const keep = filesConfig.maxTotalBytes;
    try {
      // jami hajm: ikkitaga joy
      filesConfig.maxTotalBytes = size * 2 + 10;
      const rs = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) => upload(tmath, s.id, bf, pdf(`qq${i}`))),
      );
      const okN = rs.filter((r) => r.status === 200).length;
      expect(okN, JSON.stringify(rs.map((r) => r.status))).toBe(2);
      for (const r of rs.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(JSON.stringify(r.body)).toMatch(/xotirasi to‘lgan/);
      }
      expect(await diskNames()).toHaveLength(2);
      expect(await ExamFile.countDocuments({ state: 'ready' })).toBe(2);
      expect(await tmpLeft()).toEqual([]);
    } finally {
      filesConfig.maxTotalBytes = keep;
    }
    // bo'sh joy
    const keepFree = filesConfig.minFreeBytes;
    try {
      filesConfig.minFreeBytes = Number.MAX_SAFE_INTEGER;
      const r = await upload(tmath, s.id, bf, pdf('free'));
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.body)).toMatch(/bo‘sh joy yetarli emas/);
      expect(await tmpLeft()).toEqual([]);
    } finally {
      filesConfig.minFreeBytes = keepFree;
    }
    // papka yozish uchun ochiq emas (u papka emas, fayl): aniq xabar, ma'lumot jimgina yo'qolmaydi
    const keepDir = filesConfig.dir;
    const blocker = path.join(path.dirname(keepDir), `blocker-${process.pid}`);
    await fs.writeFile(blocker, 'x');
    try {
      filesConfig.dir = blocker;
      const r = await upload(tmath, s.id, bf, pdf('nodir'));
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.body)).toMatch(/yozish uchun ochiq emas/);
    } finally {
      filesConfig.dir = keepDir;
      await fs.unlink(blocker).catch(() => undefined);
    }
    // kvotada faqat pending/ready hisoblanadi: expired bo'shatadi
    await ExamFile.updateMany({}, { $set: { state: 'expired' } });
    const keep2 = filesConfig.maxTotalBytes;
    try {
      filesConfig.maxTotalBytes = size + 10;
      expect((await upload(tmath, s.id, bf, pdf('qq9'))).status).toBe(200);
    } finally {
      filesConfig.maxTotalBytes = keep2;
    }
  });

  it('rasm xotirasi: bir vaqtda ko`p rasm yuklash ketma-ket (2 tadan), kirish pikseli chegarasi', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const imgs = await Promise.all([1, 2, 3, 4].map((i) => png(300 + i, 200, '#eeeeee')));
    const rs = await Promise.all(imgs.map((b) => upload(tmath, s.id, bf, b, 'a.png')));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const keep = filesConfig.maxInputPixels;
    try {
      filesConfig.maxInputPixels = 1000;
      const r = await upload(tmath, s.id, bf, await png(100, 100), 'big.png');
      expect(r.status).toBe(400);
    } finally {
      filesConfig.maxInputPixels = keep;
    }
    expect(await tmpLeft()).toEqual([]);
  });
});

describe('diskdan oqim bilan berish', () => {
  it('REGRESSIYA: ko`p parallel so`rov to`liq fayl oladi, kesh yo`q; ETag/304; ketma-ket takror ham to`g`ri', async () => {
    const s = await mixedExam('screen');
    at(mins(s.start, 1));
    const token = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', token);
    const id = st.body.data.files[0].files[0].id as string;
    const doc = (await ExamFile.findById(id))!;
    const disk = await fs.readFile(path.join(filesConfig.dir, doc.storageName));
    const rs = await Promise.all(
      Array.from({ length: 30 }, () => ec('get', `/files/${id}`, token)),
    );
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect(Buffer.compare(Buffer.from(r.body), disk)).toBe(0);
      expect(r.headers['content-length']).toBe(String(disk.length));
    }
    const nm = await ec('get', `/files/${id}`, token).set(
      'If-None-Match',
      rs[0]!.headers.etag as string,
    );
    expect(nm.status).toBe(304);
    // keshdan modulida readTestFile yo'q
    const mod = storageMod;
    expect('readTestFile' in mod).toBe(false);
  });

  it('REGRESSIYA: mijoz uzilsa fayl deskriptori qaytariladi (fayl o`chirilishi mumkin), disk faylida yo`q bo`lsa 410', async () => {
    const s = await mixedExam('screen');
    at(mins(s.start, 1));
    const token = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', token);
    const id = st.body.data.files[0].files[0].id as string;
    const doc = (await ExamFile.findById(id))!;
    // kattaroq fayl: oqim bir necha bo'lak bo'lsin
    const bigPath = path.join(filesConfig.dir, doc.storageName);
    await fs.appendFile(bigPath, Buffer.alloc(3 * 1024 * 1024, 0x20));
    await ExamFile.updateOne({ _id: id }, { $set: { size: (await fs.stat(bigPath)).size } });
    const srv = app.listen(0);
    try {
      const port = (srv.address() as { port: number }).port;
      await Promise.all(
        Array.from(
          { length: 25 },
          () =>
            new Promise<void>((resolve) => {
              const req = http.get(
                {
                  port,
                  path: `/api/v1/exam-client/files/${id}`,
                  headers: { Authorization: `Bearer ${token}` },
                },
                (res) => {
                  res.once('data', () => {
                    res.destroy();
                    resolve();
                  });
                },
              );
              req.on('error', () => resolve());
            }),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await new Promise((r) => srv.close(r));
    }
    // deskriptor ochiq qolgan bo'lsa Windows da unlink xato beradi (Linux da ham sinov: fayl o'chadi)
    await fs.unlink(bigPath);
    const gone = await ec('get', `/files/${id}`, token);
    expect(gone.status).toBe(410);
    expect(JSON.stringify(gone.body)).toMatch(/Fayl muddati tugagan/);
    expect((await ExamFile.findById(id))!.state).toBe('expired');
  });
});

describe('umr sikli: 14 kun, o`chirilgan imtihon, yetimlar, tozalash, qayta yuklash', () => {
  const DAY = 86_400_000;
  const setClosed = (sid: string, daysAgo: number) =>
    ExamSession.updateOne(
      { _id: sid },
      {
        $set: {
          status: 'closed',
          closedAt: new Date(Date.now() - daysAgo * DAY),
          codeActive: false,
        },
      },
    );

  it('yopilgandan 14 kun keyin baytlar o`chadi, yozuv expired; natijalar/tahlil/eksport/tafsilot ishlaydi; 13 kunda tegilmaydi', async () => {
    const s = await mixedExam('screen');
    at(mins(s.start, 1));
    const token = await join(s, 'Oquvchi 1');
    const st = await ec('post', '/start', token);
    const v = st.body.data.files[0].variant as string;
    const fid = st.body.data.files[0].files[0].id as string;
    await ec('put', '/answers', token, {
      clientSeq: 1,
      answers: [1, 2, 3, 4].map((n) => ({ qid: qidOf(s.bf, v, n), value: ANSWERS[v]![n] })),
    });
    await ec('post', '/submit', token);
    clock.reset();
    // ochiq imtihon: hech qachon o'chmaydi (juda eski fayl bo'lsa ham)
    await ExamFile.updateMany({}, { $set: { createdAt: new Date(Date.now() - 300 * DAY) } });
    await runFileSweeper(new Date(Date.now() + 400 * DAY));
    expect(await ExamFile.countDocuments({ state: 'ready' })).toBe(2);
    await setClosed(s.id, 13);
    await runFileSweeper();
    expect(await ExamFile.countDocuments({ state: 'ready' })).toBe(2);
    await setClosed(s.id, 15);
    const r1 = await runFileSweeper();
    expect(r1.expired).toBe(2);
    expect(await diskNames()).toEqual([]);
    expect(await ExamFile.countDocuments({ state: 'expired' })).toBe(2);
    // idempotent
    expect(await runFileSweeper()).toEqual({ expired: 0, deleted: 0, diskOrphans: 0 });
    // natijalar ishlaydi
    const res = await call('get', `/sessions/${s.id}/results`, admin);
    expect(res.status).toBe(200);
    expect(
      res.body.data.rows.find((r: { fullName: string }) => r.fullName === 'Oquvchi 1'),
    ).toMatchObject({ earned: 5, variant: v });
    const key = (await ExamSession.findById(s.id))!.participants.find(
      (p) => p.fullName === 'Oquvchi 1',
    )!.key;
    expect((await call('get', `/sessions/${s.id}/results/${key}`, admin)).status).toBe(200);
    expect((await call('get', `/sessions/${s.id}/results/analysis`, admin)).status).toBe(200);
    const x = await request(app)
      .get(`/api/v1/exams/sessions/${s.id}/results/export?format=xlsx`)
      .set(bearer(admin))
      .set('X-School-Id', school.id);
    expect(x.status).toBe(200);
    // kalit saqlangan: tuzuvchi/o'qituvchi ko'rinishida kalit bor, fayl esa "expired"
    const ft = await call('get', `/my-blocks/${s.id}/${s.bf}/file-test`, admin);
    expect(ft.body.data.variants[0].key).toHaveLength(4);
    expect(
      ft.body.data.variants.every((x: { files: { state: string }[] }) =>
        x.files.every((f) => f.state === 'expired'),
      ),
    ).toBe(true);
    // fayl so'rovi: 410 xabari (tuzuvchi va o'quvchi)
    const adm = await call('get', `/my-blocks/${s.id}/${s.bf}/files/${fid}`, admin);
    expect(adm.status).toBe(410);
    expect(JSON.stringify(adm.body)).toMatch(/Fayl muddati tugagan/);
    const stu = await ec('get', `/files/${fid}`, token);
    expect(stu.status).toBe(410);
  });

  it('muddati tugagan faylli yopiq imtihonni qayta ochish rad etiladi; qayta yuklash (id va kalit o`zgarmaydi) -> ochiladi', async () => {
    const s = await mixedExam('screen');
    await setClosed(s.id, 20);
    await ExamSession.updateOne({ _id: s.id }, { $set: { status: 'closed' } });
    await runFileSweeper();
    const newEnd = new Date(
      (await ExamSession.findById(s.id))!.scheduledStart.getTime() + 90 * 60_000,
    ).toISOString();
    const body = { reason: 'Qayta ochish', newEnd };
    const no = await call('post', `/sessions/${s.id}/reopen`, admin, body);
    expect(no.status).toBe(409);
    expect(JSON.stringify(no.body)).toMatch(/faylni qayta yuklang/);
    const before = await call('get', `/my-blocks/${s.id}/${s.bf}/file-test`, admin);
    const ids = before.body.data.variants.flatMap((v: { files: { id: string }[] }) =>
      v.files.map((f) => f.id),
    ) as string[];
    // faqat tuzuvchi qayta yuklaydi (o'qituvchi 403), turi mos bo'lishi shart
    const rep = (t: string, id: string, buf: Buffer, name = 'x.pdf') =>
      request(app)
        .post(`/api/v1/exams/my-blocks/${s.id}/${s.bf}/files/${id}/replace`)
        .set(bearer(t))
        .set('X-School-Id', school.id)
        .attach('file', buf, { filename: name });
    expect((await rep(tmath, ids[0]!, pdf('r0'))).status).toBe(403);
    expect((await rep(admin, ids[0]!, await png(40, 40), 'a.png')).status).toBe(400);
    for (const [i, id] of ids.entries()) {
      const r = await rep(admin, id, pdf(`re${i}`));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    // bo'lmagan (ready) faylni almashtirib bo'lmaydi
    expect((await rep(admin, ids[0]!, pdf('again'))).status).toBe(409);
    const after = await call('get', `/my-blocks/${s.id}/${s.bf}/file-test`, admin);
    expect(after.body.data.variants.map((v: { key: unknown[] }) => v.key)).toEqual(
      before.body.data.variants.map((v: { key: unknown[] }) => v.key),
    );
    expect(
      after.body.data.variants.flatMap((v: { files: { id: string; state: string }[] }) =>
        v.files.map((f) => `${f.id}:${f.state}`),
      ),
    ).toEqual(ids.map((i) => `${i}:ready`));
    expect(await diskNames()).toHaveLength(2);
    const ok = await call('post', `/sessions/${s.id}/reopen`, admin, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // qayta ochilgan: closedAt bo'shadi, qoida qayta boshlanadi
    expect((await ExamSession.findById(s.id))!.closedAt).toBeNull();
    await runFileSweeper(new Date(Date.now() + 30 * DAY * 0));
    expect(await ExamFile.countDocuments({ state: 'ready' })).toBe(2);
  });

  it('o`chirilgan/bekor qilingan imtihon fayllari darhol (yozuv+bayt) o`chadi; faol imtihonniki hech qachon', async () => {
    const live = await mixedExam('screen');
    const del = await mixedExam('screen');
    const can = await mixedExam('screen');
    expect(await diskNames()).toHaveLength(6);
    await ExamSession.updateOne({ _id: del.id }, { $set: { isDeleted: true } });
    await ExamSession.updateOne({ _id: can.id }, { $set: { status: 'cancelled' } });
    const r = await runFileSweeper();
    expect(r.deleted).toBe(4);
    expect(await diskNames()).toHaveLength(2);
    expect(await ExamFile.countDocuments({ sessionId: live.id, state: 'ready' })).toBe(2);
    expect(await ExamFile.countDocuments({ sessionId: { $in: [del.id, can.id] } })).toBe(0);
    // hujjati butunlay yo'q imtihon
    await ExamSession.deleteOne({ _id: live.id });
    expect((await runFileSweeper()).deleted).toBe(2);
    expect(await diskNames()).toEqual([]);
  });

  it('REGRESSIYA: qoralama/rejalashtirilgan/ochiq imtihonga bog`langan fayl eski bo`lsa ham o`chirilmaydi; yozuvsiz disk fayllari yosh chegarasi bilan', async () => {
    const draft = await mkSession(
      specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }),
    );
    const bf = draft.blocks[0]!.id;
    const f = await fill(tmath, draft.id, bf, [{ letter: 'A', key: KEY_A }]);
    const sched = await mixedExam('screen');
    const open = await mixedExam('screen');
    await ExamSession.updateOne(
      { _id: open.id },
      { $set: { status: 'open', openedAt: new Date() } },
    );
    const old = new Date(Date.now() - 400 * DAY);
    await ExamFile.updateMany({}, { $set: { createdAt: old, updatedAt: old } });
    const far = new Date(Date.now() + 500 * DAY);
    const before = await ExamFile.countDocuments({});
    const r = await runFileSweeper(far);
    expect(r.deleted + r.expired).toBe(0);
    expect(await ExamFile.countDocuments({})).toBe(before);
    expect(await diskNames()).toHaveLength(before);
    void f;
    void sched;
    // yozuvsiz disk fayli: 30 daqiqalik tegilmaydi, 2 soatlik o'chadi; yozuvli fayl tegilmaydi; begona nom tegilmaydi
    const orphanYoung = path.join(filesConfig.dir, 'b'.repeat(32));
    const orphanOld = path.join(filesConfig.dir, 'c'.repeat(32));
    const foreign = path.join(filesConfig.dir, 'README.txt');
    const tmpOld = path.join(filesConfig.dir, '.tmp', 'up-old');
    const tmpYoung = path.join(filesConfig.dir, '.tmp', 'up-young');
    for (const p of [orphanYoung, orphanOld, foreign, tmpOld, tmpYoung]) await fs.writeFile(p, 'x');
    const t = (min: number) => new Date(Date.now() - min * 60_000);
    await fs.utimes(orphanYoung, t(30), t(30));
    await fs.utimes(orphanOld, t(120), t(120));
    await fs.utimes(foreign, t(1000), t(1000));
    await fs.utimes(tmpOld, t(120), t(120));
    await fs.utimes(tmpYoung, t(5), t(5));
    const r2 = await runFileSweeper();
    expect(r2.diskOrphans).toBe(2);
    await fs.access(orphanYoung);
    await fs.access(foreign);
    await fs.access(tmpYoung);
    await expect(fs.access(orphanOld)).rejects.toThrow();
    await expect(fs.access(tmpOld)).rejects.toThrow();
    expect(await ExamFile.countDocuments({ state: 'ready' })).toBe(before);
  });

  it('variant olib tashlansa yoki fayl almashtirilsa eski fayl darhol o`chadi (yozuv+bayt)', async () => {
    const s = await mkSession(specs({ content: 'file', contrib: [tmathId] }, { content: 'bank' }));
    const bf = s.blocks[0]!.id;
    const url = `/my-blocks/${s.id}/${bf}/file-test`;
    const f = await fill(tmath, s.id, bf, [
      { letter: 'A', key: KEY_A },
      { letter: 'B', key: KEY_B },
    ]);
    expect(await diskNames()).toHaveLength(2);
    const bDoc = (await ExamFile.findById(f.B))!;
    // B variantini olib tashlash
    const p1 = await call('put', url, tmath, {
      variants: [{ letter: 'A', kind: 'pdf', files: [f.A], key: KEY_A }],
    });
    expect(p1.status).toBe(200);
    expect(await ExamFile.countDocuments({ _id: f.B })).toBe(0);
    await expect(fs.access(path.join(filesConfig.dir, bDoc.storageName))).rejects.toThrow();
    // A faylini yangisiga almashtirish
    const up = await upload(tmath, s.id, bf, pdf('new-a'));
    const p2 = await call('put', url, tmath, {
      variants: [{ letter: 'A', kind: 'pdf', files: [up.body.data.file.id], key: KEY_A }],
    });
    expect(p2.status).toBe(200);
    expect(await ExamFile.countDocuments({ _id: f.A })).toBe(0);
    expect(await diskNames()).toHaveLength(1);
    // qog'ozga o'tish: hamma fayl o'chadi
    const p3 = await call('put', url, tmath, {
      delivery: 'paper',
      variants: [{ letter: 'A', kind: 'pdf', files: [], key: KEY_A }],
    });
    expect(p3.status).toBe(200);
    expect(await diskNames()).toEqual([]);
    expect(await ExamFile.countDocuments({})).toBe(0);
  });

  it('maktabni o`chirish (purge): yozuvlar VA diskdagi baytlar o`chadi, boshqa maktabniki tegilmaydi', async () => {
    const s = await mixedExam('screen');
    const step = SCHOOL_PURGE_STEPS.find((x) => x.key === 'examFiles')!;
    const otherName = 'd'.repeat(32);
    await fs.writeFile(path.join(filesConfig.dir, otherName), 'x');
    await ExamFile.create({
      schoolId: other.id,
      sessionId: s.id,
      blockId: s.bf,
      storageName: otherName,
      kind: 'pdf',
      contentType: 'application/pdf',
      state: 'ready',
    });
    expect(await diskNames()).toHaveLength(3);
    const n = await purgeStep(step, { schoolId: school._id, userIds: [] } as never);
    expect(n).toBe(2);
    expect(await diskNames()).toEqual([otherName]);
    expect(await ExamFile.countDocuments({ schoolId: school.id })).toBe(0);
    expect(await ExamFile.countDocuments({ schoolId: other.id })).toBe(1);
  });

  it('nusxa: ekranda "faylni qayta yuklang": kalit bor, fayl yo`q, tayyor/rejalashtirish rad; qog`ozda to`liq ishlaydi', async () => {
    const s = await mixedExam('screen');
    const cp = await call('post', `/sessions/${s.id}/copy`, admin, {});
    expect(cp.status).toBe(201);
    const cid = cp.body.data.session.id as string;
    const cbf = cp.body.data.session.blocks[0].id as string;
    const view = await call('get', `/my-blocks/${cid}/${cbf}/file-test`, admin);
    expect(
      view.body.data.variants.map((v: { files: unknown[]; key: unknown[] }) => [
        v.files.length,
        v.key.length,
      ]),
    ).toEqual([
      [0, 4],
      [0, 4],
    ]);
    const ready = await call('post', `/my-blocks/${cid}/${cbf}/ready`, admin, { ready: true });
    expect(ready.status).toBe(400);
    expect(JSON.stringify(ready.body)).toMatch(/fayl yuklanmagan/);
    // qog'oz: nusxa darhol tayyor bo'la oladi
    const p = await mixedExam('paper');
    const cp2 = await call('post', `/sessions/${p.id}/copy`, admin, {});
    const cbf2 = cp2.body.data.session.blocks[0].id as string;
    const r2 = await call('post', `/my-blocks/${cp2.body.data.session.id}/${cbf2}/ready`, admin, {
      ready: true,
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
  });
});
