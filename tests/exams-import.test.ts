import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import request from 'supertest';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ExamAsset } from '../src/models/ExamAsset';
import { ExamImportSession } from '../src/models/ExamImportSession';
import { ExamTopic } from '../src/models/ExamTopic';
import { Question } from '../src/models/Question';
import { assetsService } from '../src/modules/exams/assets.service';
import { parseAnswerPairs } from '../src/modules/exams/import/import.docx';
import { ommlToLatex } from '../src/modules/exams/import/omml';
import { parseXml } from '../src/modules/exams/import/xml';
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
let math: Doc, phys: Doc;
let admin: string, tm: string, oadmin: string, plain: string;
let rootId: string;
let mathTopic = '';
let physTopic = '';
const mkTopic = (schoolId: string, subjectId: string, name: string, by: string) =>
  ExamTopic.create({ schoolId, subjectId, name, nameKey: name.toLowerCase(), createdBy: by });

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const CT_OK =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const CT_MACRO = CT_OK.replace(
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.ms-word.document.macroEnabled.main+xml',
);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const P = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const IMG = (rid: string) =>
  `<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="${rid}"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>`;
const FRAC =
  '<m:oMath><m:f><m:num><m:r><m:t>x+1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>';

async function docx(
  body: string,
  o: {
    ct?: string;
    docXml?: string;
    media?: Record<string, Buffer>;
    extra?: Record<string, string | Buffer>;
  } = {},
) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', o.ct ?? CT_OK);
  zip.file(
    'word/document.xml',
    o.docXml ?? `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
  );
  const rels = Object.keys(o.media ?? {})
    .map((n, i) => `<Relationship Id="rId${i + 5}" Type="x" Target="media/${n}"/>`)
    .join('');
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
  for (const [n, b] of Object.entries(o.media ?? {})) zip.file(`word/media/${n}`, b);
  for (const [n, b] of Object.entries(o.extra ?? {})) zip.file(n, b);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function xlsx(rows: (string | number | null)[][], header?: string[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(
    header ?? [
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
    ],
  );
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const hdr = (t: string, sid?: string) => (sid ? { ...bearer(t), 'X-School-Id': sid } : bearer(t));
const upWord = (t: string, buf: Buffer, name = 'q.docx', extra: Record<string, string> = {}) => {
  const r = request(app).post('/api/v1/exams/import/word').set(bearer(t));
  for (const [k, v] of Object.entries({ topicId: mathTopic, ...extra })) r.field(k, v);
  return r.attach('file', buf, { filename: name, contentType: DOCX });
};
const upXlsx = (t: string, buf: Buffer, name = 'q.xlsx', extra: Record<string, string> = {}) => {
  const r = request(app).post('/api/v1/exams/import/excel').set(bearer(t));
  for (const [k, v] of Object.entries({ topicId: mathTopic, ...extra })) r.field(k, v);
  return r.attach('file', buf, { filename: name, contentType: XLSX });
};
const commit = (t: string, id: string, body: object = {}) =>
  request(app).post(`/api/v1/exams/import/${id}/commit`).set(bearer(t)).send(body);

beforeEach(async () => {
  await ExamImportSession.deleteMany({});
  school = await makeSchool('a');
  other = await makeSchool('b');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  const root = await makeUser({ username: 'root', role: 'superadmin' });
  rootId = root.id;
  const tMath = await makeUser({ username: 'tmath', role: 'teacher', schoolId: school.id });
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
  const cls = await makeClass(school.id, year.id, '7-A');
  await assignSubject(school.id, cls as never, math.id, tMath.id);
  mathTopic = (await mkTopic(school.id, math.id, 'Kasrlar', rootId)).id;
  physTopic = (await mkTopic(school.id, phys.id, 'Kinematika', rootId)).id;
  for (const s of [school, other])
    await settingsStore.set('school', s.id, 'exams', { enabled: true }, rootId);
  admin = (await login('admin')).token;
  tm = (await login('tmath')).token;
  oadmin = (await login('oadmin')).token;
  plain = (await login('plain')).token;
});
afterEach(() => vi.restoreAllMocks());

describe('Word import: tuzilma va to`g`ri javob', () => {
  it('"*B)", javoblar jadvali, multi "AC", short "12,5|12.5", meta qatorlar', async () => {
    const body = [
      P('Ko‘rsatma matni: bu savol emas'),
      P('1. 2 + 2 nechiga teng?'),
      P('Fan: Matematika'),
      P('Mavzu: Qo‘shish'),
      P('Qiyinlik: 3'),
      P('Ball: 2,5'),
      P('A) 3'),
      P('*B) 4'),
      P('C) 5'),
      P('2. Tub sonlar?'),
      P('A) 2'),
      P('B) 4'),
      P('C) 7'),
      P('3. 25 / 2 = ?'),
      P('4. Insho yozing'),
      P('Tur: essay'),
      P('5. Eng katta sayyora?'),
      P('A) Yer'),
      P('B) Yupiter'),
      P('Javoblar'),
      P('2-AC, 3: 12,5|12.5; 5-B'),
    ].join('');
    const r = await upWord(admin, await docx(body), 'q.docx');
    expect(r.status).toBe(201);
    const it = r.body.data.items;
    expect(it).toHaveLength(5);
    expect(it[0]).toMatchObject({
      row: 1,
      type: 'single',
      difficulty: 3,
      points: 2.5,
      answer: { optionId: 'b' },
      errors: [],
    });
    expect(it[0].subjectName).toBe('Matematika'); // mavzuning fani
    expect(it[0]).not.toHaveProperty('topic');
    expect(r.body.data.topic).toMatchObject({ name: 'Kasrlar', subjectName: 'Matematika' });
    expect(r.body.data.warnings.join(' ')).toMatch(/e'tiborsiz/); // Fan:/Mavzu: qatorlari
    expect(it[1]).toMatchObject({ type: 'multi', answer: { optionIds: ['a', 'c'] }, errors: [] });
    expect(it[2]).toMatchObject({
      type: 'short',
      answer: { acceptedAnswers: ['12,5', '12.5'] },
      errors: [],
    });
    expect(it[3]).toMatchObject({ type: 'essay', errors: [] });
    expect(it[4]).toMatchObject({ type: 'single', answer: { optionId: 'b' }, errors: [] });
    expect(r.body.data.stats).toEqual({ total: 5, valid: 5, invalid: 0 });
  });

  it("to'g'ri javob yo'q, variantlar kam, qator xatolari (butun import yiqilmaydi)", async () => {
    const body = [P('1. Savol bir'), P('A) x'), P('B) y'), P('2. Savol ikki'), P('A) x')].join('');
    const r = await upWord(admin, await docx(body)); // standart fan ham yo'q
    expect(r.status).toBe(201);
    const [a, b] = r.body.data.items;
    expect(a.errors.join(' ')).toMatch(/To'g'ri variant/);
    expect(b.errors.join(' ')).toMatch(/Kamida 2 ta variant/);
    expect(r.body.data.stats).toMatchObject({ total: 2, valid: 0, invalid: 2 });
  });

  it('rasm (ExamAsset, qayta kodlangan) va Word formulasi (OMML -> LaTeX) olinadi', async () => {
    const png = await sharp({
      create: { width: 3000, height: 20, channels: 3, background: '#f00' },
    })
      .png()
      .toBuffer();
    const body = [
      `<w:p><w:r><w:t xml:space="preserve">1. Hisoblang: </w:t></w:r>${FRAC}</w:p>`,
      IMG('rId5'),
      P('*A) 1'),
      P('B) 2'),
      P('2. Murakkab formula'),
      '<w:p><m:oMath><m:foo><m:r><m:t>q</m:t></m:r></m:foo></m:oMath></w:p>',
      P('*A) 1'),
      P('B) 2'),
    ].join('');
    const r = await upWord(admin, await docx(body, { media: { 'image1.png': png } }), 'q.docx', {
      subjectId: math.id,
    });
    expect(r.status).toBe(201);
    const [q1, q2] = r.body.data.items;
    expect(q1.content.map((b: { type: string }) => b.type)).toEqual(['text', 'math', 'image']);
    expect(q1.content[1].tex).toBe('\\frac{x+1}{2}');
    const assetId = q1.content[2].assetId;
    const asset = await ExamAsset.findById(assetId);
    expect(asset).toMatchObject({ contentType: 'image/webp', width: 1600 });
    expect(await AuditLog.countDocuments({ action: 'exam.asset.upload' })).toBe(0);
    // O'tkazib bo'lmaydigan formula: "[formula]" + ogohlantirish, savol baribir ishlaydi
    expect(q2.content).toEqual([
      { type: 'text', text: 'Murakkab formula' },
      { type: 'text', text: '[formula]' },
    ]);
    expect(q2.warnings.join(' ')).toMatch(/formula/);
    expect(q2.errors).toEqual([]);
  });

  it('shablon (.docx) o`zi xatosiz import qilinadi', async () => {
    const t = await request(app)
      .get('/api/v1/exams/import/template/word')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (d: Buffer) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(t.status).toBe(200);
    expect(t.headers['content-disposition']).toContain('savollar-shablon.docx');
    const r = await upWord(admin, t.body as Buffer, 'q.docx');
    expect(r.status).toBe(201);
    expect(r.body.data.stats).toMatchObject({ total: 5, valid: 5, invalid: 0 });
    expect(r.body.data.items.map((i: { type: string }) => i.type)).toEqual([
      'single',
      'multi',
      'short',
      'essay',
      'single',
    ]);
  });

  it('javoblar juftliklari va OMML yordamchilari (birlik testlar)', () => {
    expect(parseAnswerPairs('1-B, 2-AC, 3: 12,5')).toEqual([
      [1, 'B'],
      [2, 'AC'],
      [3, '12,5'],
    ]);
    expect(parseAnswerPairs('1.A; 2) 7,5 | 7.5')).toEqual([
      [1, 'A'],
      [2, '7,5 | 7.5'],
    ]);
    const t = (x: string) => ommlToLatex(parseXml(`<m:oMath xmlns:m="m">${x}</m:oMath>`));
    expect(
      t(
        '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>3</m:t></m:r></m:e></m:rad>',
      ),
    ).toEqual({ tex: '\\sqrt{3}', ok: true });
    expect(
      t('<m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>')
        .tex,
    ).toBe('{x}^{2}');
    expect(
      t(
        '<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:r><m:t>i</m:t></m:r></m:e></m:nary>',
      ).tex,
    ).toBe('\\sum_{i=1}^{n} i');
    expect(t('<m:weird/>').ok).toBe(false);
  });
});

describe('Word import: xavfsizlik', () => {
  const ok = P('1. Savol') + P('*A) 1') + P('B) 2');

  it('.docx emas: matn, .doc kengaytma, .docm kengaytma va makro kontent turi rad etiladi', async () => {
    expect((await upWord(admin, Buffer.from('bu zip emas'))).status).toBe(400);
    expect((await upWord(admin, await docx(ok), 'q.docm')).status).toBe(400);
    expect((await upWord(admin, await docx(ok), 'q.doc')).status).toBe(400);
    const macro = await upWord(admin, await docx(ok, { ct: CT_MACRO }));
    expect(macro.status).toBe(400);
    expect(macro.body.error.message).toMatch(/Makro|docx/);
    const vba = await upWord(
      admin,
      await docx(ok, { extra: { 'word/vbaProject.bin': Buffer.from('x') } }),
    );
    expect(vba.status).toBe(400);
    // Zip, lekin Word emas
    const z = new JSZip();
    z.file('hello.txt', 'hi');
    expect((await upWord(admin, await z.generateAsync({ type: 'nodebuffer' }))).status).toBe(400);
    expect(await ExamImportSession.countDocuments()).toBe(0);
  });

  it('DOCTYPE/ENTITY bor XML (document.xml, rels, content types) parsedan oldin rad etiladi', async () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "&a;&a;&a;">]>';
    const inDoc = await docx('', {
      docXml: `${evil}<w:document ${NS}><w:body>${ok}</w:body></w:document>`,
    });
    const r1 = await upWord(admin, inDoc);
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/DOCTYPE|ENTITY/);
    const r2 = await upWord(
      admin,
      await docx(ok, { ct: CT_OK.replace('<Types', `${evil}<Types`) }),
    );
    expect(r2.status).toBe(400);
    const r3 = await upWord(
      admin,
      await docx(ok, { extra: { 'word/_rels/document.xml.rels': `${evil}<Relationships/>` } }),
    );
    expect(r3.status).toBe(400);
  });

  it('zip-bomba: siqish nisbati yuqori va yozuvlar soni juda ko`p bo`lsa parsedan oldin rad etiladi', async () => {
    const spy = vi.spyOn(assetsService, 'upload');
    const big = await docx(ok, {
      extra: { 'customXml/item1.xml': Buffer.alloc(15 * 1024 * 1024, 0x20) },
    });
    expect(big.length).toBeLessThan(5 * 1024 * 1024);
    const r1 = await upWord(admin, big);
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/siqish|katta/);

    const many: Record<string, string> = {};
    for (let i = 0; i < 510; i++) many[`customXml/f${i}.xml`] = '<a/>';
    const r2 = await upWord(admin, await docx(ok, { extra: many }));
    expect(r2.status).toBe(400);
    expect(r2.body.error.message).toMatch(/murakkab/);
    expect(spy).not.toHaveBeenCalled();
    expect(await ExamImportSession.countDocuments()).toBe(0);
  });

  it('bir vaqtda faqat bitta import: ikkinchisi 429', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    const real = assetsService.upload.bind(assetsService);
    vi.spyOn(assetsService, 'upload').mockImplementation(async (...a) => {
      await new Promise((r) => setTimeout(r, 900));
      return real(...a);
    });
    const slow = await docx(P('1. Savol') + IMG('rId5') + P('*A) 1') + P('B) 2'), {
      media: { 'a.png': png },
    });
    const [a, b] = await Promise.all([upWord(admin, slow, 'a.docx'), upWord(tm, slow, 'b.docx')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 429]);
    const loser = a.status === 429 ? a : b;
    expect(loser.body.error.message).toBe("Import band, keyinroq urinib ko'ring");
    // Semafor bo'shaydi
    vi.restoreAllMocks();
    expect((await upWord(admin, await docx(ok), 'c.docx')).status).toBe(201);
  });

  it("rasm bo'lmagan yoki qo'llanmaydigan format: ogohlantirish, import yiqilmaydi; HTML saqlanmaydi", async () => {
    const body = [
      P('1. <b>Savol</b><script>x</script>'),
      IMG('rId5'),
      IMG('rId99'),
      P('*A) 1'),
      P('B) 2'),
    ].join('');
    const r = await upWord(
      admin,
      await docx(body, { media: { 'a.emf': Buffer.from('emf-data') } }),
      'q.docx',
    );
    expect(r.status).toBe(201);
    const q = r.body.data.items[0];
    expect(q.content).toEqual([{ type: 'text', text: '<b>Savol</b><script>x</script>' }]);
    expect(q.warnings.length).toBe(2);
    expect(q.errors).toEqual([]);
  });
});

describe('Excel import', () => {
  it('shablon yuklab olinadi va o`zi xatosiz import qilinadi', async () => {
    const t = await request(app)
      .get('/api/v1/exams/import/template/excel')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (d: Buffer) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(t.status).toBe(200);
    expect(t.headers['content-disposition']).toContain('savollar-shablon.xlsx');
    await makeSubject('Ona tili');
    const r = await upXlsx(admin, t.body as Buffer);
    expect(r.status).toBe(201);
    expect(r.body.data.stats).toMatchObject({ total: 4, valid: 4, invalid: 0 });
    const types = r.body.data.items.map((i: { type: string }) => i.type);
    expect(types).toEqual(['single', 'multi', 'short', 'essay']);
  });

  it('javob turlari: "B", "A,C", "12,5|12.5", ball, qisman ball', async () => {
    const buf = await xlsx([
      ['Matematika', 'T', 2, 'single', '2+2?', '3', '4', '5', null, 'B', 1, null],
      ['matematika', null, null, 'multi', 'Tublar?', '2', '4', '7', null, 'A, C', '2,5', 'ha'],
      ['Matematika', null, 1, 'short', '25/2?', null, null, null, null, '12,5|12.5', null, null],
      ['Matematika', null, null, null, 'Tur avtomatik', 'x', 'y', null, null, 'A', null, null],
    ]);
    const r = await upXlsx(admin, buf);
    expect(r.status).toBe(201);
    const it = r.body.data.items;
    expect(it[0]).toMatchObject({
      row: 2,
      type: 'single',
      difficulty: 2,
      answer: { optionId: 'b' },
      errors: [],
    });
    expect(it[1]).toMatchObject({
      type: 'multi',
      points: 2.5,
      answer: { optionIds: ['a', 'c'], partialCredit: true },
      errors: [],
    });
    expect(it[2]).toMatchObject({
      type: 'short',
      answer: { acceptedAnswers: ['12,5', '12.5'] },
      errors: [],
    });
    expect(it[3]).toMatchObject({ type: 'single', errors: [] });
  });

  it('qator xatolari: bo`sh variant, noto`g`ri javob harfi, noto`g`ri qiyinlik/ball/tur', async () => {
    const buf = await xlsx([
      ['Kimyo', null, null, 'single', 'q', 'a', 'b', null, null, 'A', null, null],
      ['Matematika', null, null, 'single', 'q', 'a', null, 'c', null, 'A', null, null],
      ['Matematika', null, null, 'single', 'q', 'a', 'b', null, null, 'Z', null, null],
      ['Matematika', null, 5, 'single', 'q', 'a', 'b', null, null, 'A', 0, null],
      ['Matematika', null, null, 'mix', 'q', 'a', 'b', null, null, 'A', null, null],
      ['Matematika', null, null, 'single', 'q', 'a', 'b', null, null, null, null, null],
    ]);
    const r = await upXlsx(admin, buf);
    expect(r.status).toBe(201);
    const e = r.body.data.items.map((i: { errors: string[] }) => i.errors.join(' | '));
    expect(e[0]).toBe(''); // fayldagi fan ustuni e'tiborsiz: qator mavzuga qo'shiladi
    expect(e[1]).toMatch(/ketma-ket/);
    expect(e[2]).toMatch(/A-J/);
    expect(e[3]).toMatch(/Qiyinlik/);
    expect(e[3]).toMatch(/Ball/);
    expect(e[4]).toMatch(/Noma'lum tur/);
    expect(e[5]).toMatch(/To'g'ri variant/);
    expect(r.body.data.stats.valid).toBe(1); // faqat fayldagi "Kimyo" qatori (fan e'tiborsiz)
  });

  it("standart fan (subjectId), sarlavhalarsiz fayl, bo'sh fayl, katta fayl, soxta .xlsx", async () => {
    const buf = await xlsx([
      [null, null, null, 'short', '1+1?', null, null, null, null, '2', null, null],
    ]);
    const r = await upXlsx(admin, buf, 'q.xlsx');
    expect(r.body.data.items[0]).toMatchObject({ subjectName: 'Matematika', errors: [] });
    expect((await upXlsx(admin, await xlsx([[1]], ['X', 'Y']))).status).toBe(400);
    expect((await upXlsx(admin, await xlsx([]))).status).toBe(400);
    expect((await upXlsx(admin, Buffer.from('not a zip'))).status).toBe(400);
    expect((await upXlsx(admin, Buffer.alloc(5 * 1024 * 1024 + 10, 1))).status).toBe(400);
    expect((await upXlsx(admin, buf, 'q.xls')).status).toBe(400);
  });

  it('1000 qatordan ko`p fayl rad etiladi', async () => {
    const rows = Array.from({ length: 1001 }, () => [
      'Matematika',
      null,
      null,
      'short',
      'q',
      null,
      null,
      null,
      null,
      'a',
      null,
      null,
    ]);
    const r = await upXlsx(admin, await xlsx(rows));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/1000/);
  });
});

describe('Import: mavzuga, oldindan ko`rish, tuzatish, import qilish', () => {
  const rowsXlsx = () =>
    xlsx([
      ['Matematika', 'A', 2, 'single', 'Birinchi?', 'x', 'y', null, null, 'A', 1, null],
      ['Fizika', 'B', 2, 'single', 'Ikkinchi?', 'x', 'y', null, null, 'B', 1, null],
      ['Kimyo', null, 2, 'single', 'Uchinchi?', 'x', 'y', null, null, 'B', 1, null],
      ['Matematika', null, 2, 'single', 'To‘rtinchi?', 'x', 'y', null, null, 'A', 1, null],
    ]);

  it("hamma qator tanlangan mavzuga tushadi (fayldagi Fan/Mavzu ustunlari e'tiborsiz, ogohlantirish bilan); QORALAMA, muallif = import qiluvchi, private; audit faqat sonlar", async () => {
    const r = await upXlsx(admin, await rowsXlsx());
    const id = r.body.data.id;
    expect(r.body.data.stats).toMatchObject({ total: 4, valid: 4, invalid: 0 });
    expect(r.body.data.topic).toMatchObject({
      id: mathTopic,
      name: 'Kasrlar',
      subjectName: 'Matematika',
    });
    expect(r.body.data.warnings.join(' ')).toMatch(/e'tiborsiz/);
    const c = await commit(admin, id, { exclude: [5] });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ created: 3, excluded: 1, total: 4, failed: [] });
    const qs = await Question.find({ schoolId: school.id }).lean();
    expect(qs).toHaveLength(3);
    for (const q of qs) {
      expect(q).toMatchObject({ status: 'draft', version: 1, scope: 'school' });
      expect(String(q.topicId)).toBe(mathTopic);
      expect(String(q.subjectId)).toBe(math.id);
      expect(q.sharing).toMatchObject({ mode: 'private' });
    }
    const log = await AuditLog.findOne({ action: 'exam.question.import' }).lean();
    expect(log?.after).toMatchObject({
      kind: 'excel',
      created: 3,
      total: 4,
      excluded: 1,
      failed: 0,
    });
    expect(JSON.stringify(log)).not.toContain('Birinchi');
  });

  it("ma'muriyat boshqa fan mavzusiga ham import qiladi: savollar o'sha mavzu va fanga tushadi", async () => {
    const r = await upXlsx(admin, await rowsXlsx(), 'q.xlsx', { topicId: physTopic });
    expect(r.body.data.topic.subjectName).toBe('Fizika');
    await commit(admin, r.body.data.id, {});
    const qs = await Question.find({ topicId: physTopic }).lean();
    expect(qs).toHaveLength(4);
    expect(qs.every((q) => String(q.subjectId) === phys.id)).toBe(true);
  });

  it("tuzatish (override): javob, tur, qiyinlik, ball qo'llanadi; fan/mavzu override'i (subjectId, topic) rad etiladi", async () => {
    const r = await xlsx([['M', null, 2, 'single', 'Bitta?', 'x', 'y', null, null, null, 1, null]]);
    const up = await upXlsx(admin, r);
    expect(up.body.data.items[0].errors.join(' ')).toMatch(/To'g'ri variant/);
    const c = await commit(admin, up.body.data.id, {
      overrides: [{ row: 2, answer: { optionId: 'b' }, difficulty: 3, points: 4, type: 'single' }],
    });
    expect(c.body.data).toMatchObject({ created: 1, failed: [] });
    expect(await Question.findOne({ 'content.text': 'Bitta?' }).lean()).toMatchObject({
      difficulty: 3,
      points: 4,
      answer: { optionId: 'b' },
    });
    const up2 = await upXlsx(admin, r);
    expect(
      (await commit(admin, up2.body.data.id, { overrides: [{ row: 2, subjectId: phys.id }] }))
        .status,
    ).toBe(400);
    expect(
      (await commit(admin, up2.body.data.id, { overrides: [{ row: 2, topic: 'X' }] })).status,
    ).toBe(400);
  });

  it("override ham qayta tekshiriladi: noto'g'ri javob import qilinmaydi", async () => {
    const r = await upXlsx(admin, await rowsXlsx());
    const c = await commit(admin, r.body.data.id, {
      exclude: [4, 5],
      overrides: [{ row: 2, answer: { optionId: 'zzz' } }],
    });
    expect(c.body.data.created).toBe(1);
    expect(c.body.data.failed.map((f: { row: number }) => f.row)).toEqual([2]);
  });

  it("o'qituvchi: faqat o'zi o'qitadigan fan mavzusiga import qiladi; o'qitmaydigan fan mavzusi 404, hech narsa yaratilmaydi", async () => {
    const ok = await upXlsx(tm, await rowsXlsx());
    expect(ok.status).toBe(201);
    expect((await commit(tm, ok.body.data.id, {})).body.data.created).toBe(4);
    const denied = await upXlsx(tm, await rowsXlsx(), 'q.xlsx', { topicId: physTopic });
    expect(denied.status).toBe(404);
    expect(await Question.countDocuments({ topicId: physTopic })).toBe(0);
    expect(
      (await upXlsx(tm, await rowsXlsx(), 'q.xlsx', { topicId: '64b000000000000000000001' }))
        .status,
    ).toBe(404);
    // Word ham
    expect(
      (
        await upWord(tm, await docx(P('1. S') + P('*A) 1') + P('B) 2')), 'q.docx', {
          topicId: physTopic,
        })
      ).status,
    ).toBe(404);
  });

  it("topicId majburiy va boshqa maktab/o'chirilgan mavzu 404; mavzu preview va commit orasida o'chirilsa 404", async () => {
    const buf = await rowsXlsx();
    const noTopic = await request(app)
      .post('/api/v1/exams/import/excel')
      .set(bearer(admin))
      .attach('file', buf, { filename: 'q.xlsx', contentType: XLSX });
    expect(noTopic.status).toBe(400);
    const ot = await mkTopic(other.id, math.id, 'Boshqa', rootId);
    expect((await upXlsx(admin, buf, 'q.xlsx', { topicId: ot.id })).status).toBe(404);
    const r = await upXlsx(admin, buf);
    await ExamTopic.updateOne({ _id: mathTopic }, { $set: { isDeleted: true } });
    expect((await commit(admin, r.body.data.id, {})).status).toBe(404);
    expect(await Question.countDocuments()).toBe(0);
    expect(
      (await request(app).get(`/api/v1/exams/import/${r.body.data.id}`).set(bearer(admin))).status,
    ).toBe(404);
  });

  it('idempotent: ikkinchi commit avvalgi natijani qaytaradi, savollar ikki marta yaratilmaydi; parallel commit ham bitta', async () => {
    const r = await upXlsx(admin, await rowsXlsx());
    const id = r.body.data.id;
    const [a, b] = await Promise.all([
      commit(admin, id, { exclude: [5] }),
      commit(admin, id, { exclude: [5] }),
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(await Question.countDocuments({ schoolId: school.id })).toBe(3);
    const again = await commit(admin, id, { exclude: [] });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: 3, replay: true });
    expect(await Question.countDocuments({ schoolId: school.id })).toBe(3);
    expect(await AuditLog.countDocuments({ action: 'exam.question.import' })).toBe(1);
  });

  it('sessiya: TTL (expiresAt), boshqa foydalanuvchi/maktab 404, ko`rish GET', async () => {
    const r = await upXlsx(admin, await rowsXlsx());
    const id = r.body.data.id;
    const exp = new Date(r.body.data.expiresAt).getTime() - Date.now();
    expect(exp).toBeGreaterThan(29 * 60_000);
    expect(exp).toBeLessThanOrEqual(30 * 60_000);
    const idx = await ExamImportSession.collection.indexes();
    expect(idx.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
    expect(
      (await request(app).get(`/api/v1/exams/import/${id}`).set(bearer(admin))).body.data.items,
    ).toHaveLength(4);
    expect((await request(app).get(`/api/v1/exams/import/${id}`).set(bearer(tm))).status).toBe(404);
    expect((await request(app).get(`/api/v1/exams/import/${id}`).set(bearer(oadmin))).status).toBe(
      404,
    );
    expect((await commit(tm, id)).status).toBe(404);
    expect((await commit(oadmin, id)).status).toBe(404);
    await ExamImportSession.updateOne(
      { _id: id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await request(app).get(`/api/v1/exams/import/${id}`).set(bearer(admin))).status).toBe(
      404,
    );
    expect((await commit(admin, id)).status).toBe(404);
    expect(await Question.countDocuments()).toBe(0);
  });

  it('modul o`chiq maktabda va ruxsatsiz admin: 403; autentifikatsiyasiz 401; so`rov validatsiyasi', async () => {
    const buf = await rowsXlsx();
    expect((await upXlsx(plain, buf)).status).toBe(403);
    expect((await request(app).post('/api/v1/exams/import/excel')).status).toBe(401);
    const off = await makeSchool('off');
    await makeUser({
      username: 'aoff',
      role: 'school_admin',
      schoolId: off.id,
      permissions: ['exams.manage'],
    });
    const aoff = (await login('aoff')).token;
    expect((await upXlsx(aoff, buf)).status).toBe(403);
    expect(
      (await request(app).get('/api/v1/exams/import/template/word').set(bearer(aoff))).status,
    ).toBe(403);
    const r = await upXlsx(admin, buf);
    expect((await commit(admin, r.body.data.id, { hack: 1 })).status).toBe(400);
    expect(
      (await commit(admin, r.body.data.id, { overrides: [{ row: 2, status: 'active' }] })).status,
    ).toBe(400);
    expect((await commit(admin, 'notanid')).status).toBe(400);
    void hdr;
  });
});
