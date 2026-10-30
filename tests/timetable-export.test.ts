import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { User } from '../src/models/User';
import { clock } from '../src/utils/clock';
import {
  app,
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
const API = '/api/v1/timetable';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// 2026-10-30 = juma
const TODAY = '2026-10-30';

let school: Doc, other: Doc;
let c1: Awaited<ReturnType<typeof makeClass>>;
let c2: Awaited<ReturnType<typeof makeClass>>;
let c3: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, eng: Doc, art: Doc;
let t1: Doc, t2: Doc, t3: Doc;
let admin: string, viewer: string, nobody: string, teacher1: string, teacher2: string;
let adminOther: string, teacherNoLessons: string;
let c1Version: string;

const e = (
  weekday: number,
  lessonNo: number,
  subjectId: string,
  teacherId: string,
  room?: string,
) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  ...(room ? { room } : {}),
});

type Res = request.Response;
const binary = (r: Res, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (d: Buffer) => chunks.push(d));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};
const exp = (t: string, p: string) =>
  request(app).get(`${API}${p}`).set(bearer(t)).buffer(true).parse(binary);
const body = (r: Res) => r.body as Buffer;
const post = (t: string, p: string, b: object = {}) =>
  request(app).post(`${API}${p}`).set(bearer(t)).send(b);
const put = (t: string, p: string, b: object) =>
  request(app).put(`${API}${p}`).set(bearer(t)).send(b);

async function makeVersion(
  classId: string,
  entries: object[],
  activate: boolean,
  validFrom = TODAY,
) {
  const c = await post(admin, `/classes/${classId}/versions`, { validFrom });
  expect(c.status).toBe(201);
  const id = c.body.data.version.id as string;
  expect((await put(admin, `/versions/${id}`, { entries })).status).toBe(200);
  if (activate)
    expect((await post(admin, `/versions/${id}/activate`, { validFrom })).status).toBe(200);
  return id;
}

async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}

async function pdfPages(buf: Buffer): Promise<{ pages: number; text: string }> {
  const spec = 'pdfjs-dist/legacy/build/pdf.mjs';
  const pdfjs = await import(/* @vite-ignore */ spec);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it: { str: string }) => it.str).join(' ') + '\n';
  }
  return { pages: doc.numPages, text };
}

beforeEach(async () => {
  clock.set(() => new Date('2026-10-30T07:00:00Z'));
  school = await makeSchool('ex1');
  other = await makeSchool('ex2');
  const year = await makeYear(school.id);
  const yearO = await makeYear(other.id);
  t1 = await makeUser({ username: 'ex_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'ex_t2', role: 'teacher', schoolId: school.id });
  t3 = await makeUser({ username: 'ex_t3', role: 'teacher', schoolId: school.id });
  await User.updateOne({ _id: t1.id }, { fullName: 'Mirzamatov Mansur Karimovich' });
  await User.updateOne({ _id: t2.id }, { fullName: 'Oʻrinboyeva Gʻuncha' });
  await User.updateOne({ _id: t3.id }, { fullName: '=Formula Teacher' });
  const tO = await makeUser({ username: 'ex_to', role: 'teacher', schoolId: other.id });
  c1 = await makeClass(school.id, year.id, '5-A', [t1.id]);
  c2 = await makeClass(school.id, year.id, '5-B', []);
  c3 = await makeClass(school.id, year.id, '6-A', []); // jadvalsiz sinf
  const cO = await makeClass(other.id, yearO.id, '5-A');
  math = await makeSubject('Matematika');
  eng = await makeSubject('Ingliz tili');
  art = await makeSubject('Rasm');
  await makeUser({
    username: 'ex_admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.manage', 'timetable.view'],
  });
  await makeUser({
    username: 'ex_view',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.view'],
  });
  await makeUser({ username: 'ex_none', role: 'school_admin', schoolId: school.id });
  await makeUser({
    username: 'ex_adminO',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['timetable.manage', 'timetable.view'],
  });
  await makeUser({ username: 'ex_t4', role: 'teacher', schoolId: school.id });
  admin = (await login('ex_admin')).token;
  viewer = (await login('ex_view')).token;
  nobody = (await login('ex_none')).token;
  adminOther = (await login('ex_adminO')).token;
  teacher1 = (await login('ex_t1')).token;
  teacher2 = (await login('ex_t2')).token;
  teacherNoLessons = (await login('ex_t4')).token;

  // 5-A: faol (juma = 5-kun darslari ham bor), 5-B: faol; 6-A: versiyasiz
  c1Version = await makeVersion(
    c1.id,
    [
      e(1, 1, math.id, t1.id, '205'),
      e(1, 2, eng.id, t2.id),
      e(2, 1, art.id, t3.id),
      e(5, 4, math.id, t1.id, 'Sport zali'),
    ],
    true,
  );
  await makeVersion(c2.id, [e(1, 1, eng.id, t2.id), e(1, 2, math.id, t1.id)], true);
  // boshqa maktab
  void tO;
  void cO;
});

describe('sinf jadvali eksporti', () => {
  it('xlsx: content-type, fayl nomi, varaq, katak qiymatlari, muzlatilgan sarlavha', async () => {
    const r = await exp(viewer, `/classes/${c1.id}/export?format=xlsx`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain(XLSX);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-disposition']).toContain(
      'filename="dars-jadvali-5-A-2026-10-30.xlsx"',
    );
    expect(r.headers['content-disposition']).toContain(
      "filename*=UTF-8''dars-jadvali-5-A-2026-10-30.xlsx",
    );

    const wb = await readXlsx(body(r));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['5-A']);
    const ws = wb.getWorksheet('5-A')!;
    expect(ws.getCell('A1').value).toBe('Maktab ex1');
    expect(ws.getCell('A2').value).toBe('Dars jadvali · 5-A');
    expect(String(ws.getCell('A3').value)).toContain("O'quv yili: 2026-2027");
    expect(String(ws.getCell('A3').value)).toContain('Amal qilish: 30.10.2026 – …');
    // sarlavha qatori: № + ish kunlari (standart Du-Sha)
    const head = [1, 2, 3, 4, 5, 6, 7].map((c) => ws.getRow(4).getCell(c).text);
    expect(head.slice(0, 7)).toEqual([
      '№',
      'Dushanba',
      'Seshanba',
      'Chorshanba',
      'Payshanba',
      'Juma',
      'Shanba',
    ]);
    // 1-dars, dushanba
    expect(ws.getCell('B5').text).toBe('Matematika\nMirzamatov M.\nXona: 205');
    expect(ws.getCell('B6').text).toBe('Ingliz tili\nOʻrinboyeva G.');
    // formula injeksiyasidan himoya: "=" bilan boshlangan matn apostrof bilan
    expect(ws.getCell('C5').text).toBe("Rasm\n'=Formula T.");
    expect(ws.getCell('F8').text).toBe('Matematika\nMirzamatov M.\nXona: Sport zali');
    expect(ws.getCell('A5').value).toBe(1);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 4 });
    expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true });
  });

  it('pdf: %PDF, bitta sahifa, matn, fayl nomi', async () => {
    const r = await exp(viewer, `/classes/${c1.id}/export?format=pdf&date=2026-11-03`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toContain('dars-jadvali-5-A-2026-11-03.pdf');
    expect(body(r).subarray(0, 5).toString()).toBe('%PDF-');
    const { pages, text } = await pdfPages(body(r));
    expect(pages).toBe(1);
    expect(text).toContain('Dars jadvali · 5-A');
    expect(text).toContain('Matematika');
    expect(text).toContain('Mirzamatov M.');
    expect(text).toContain('Dushanba');
    expect(text).toContain('1 / 1');
  });

  it("sana versiya amal qilishidan oldin bo'lsa 404; versiyasiz sinf 404", async () => {
    expect((await exp(viewer, `/classes/${c1.id}/export?format=pdf&date=2026-10-01`)).status).toBe(
      404,
    );
    expect((await exp(viewer, `/classes/${c3.id}/export?format=xlsx`)).status).toBe(404);
  });

  it("format majburiy va yaroqli bo'lishi kerak", async () => {
    expect((await exp(viewer, `/classes/${c1.id}/export`)).status).toBe(400);
    expect((await exp(viewer, `/classes/${c1.id}/export?format=docx`)).status).toBe(400);
    expect((await exp(viewer, `/classes/${c1.id}/export?format=pdf&date=bad`)).status).toBe(400);
  });

  it("qoralama versionId: QORALAMA belgisi; faqat manage ko'ra oladi", async () => {
    const draftId = await makeVersion(c1.id, [e(3, 1, art.id, t3.id)], false, '2026-11-09');
    const r = await exp(admin, `/classes/${c1.id}/export?format=xlsx&versionId=${draftId}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('dars-jadvali-5-A-qoralama-2026-10-30.xlsx');
    const ws = (await readXlsx(body(r))).getWorksheet('5-A')!;
    expect(ws.getCell('A2').value).toBe('Dars jadvali · 5-A · QORALAMA');
    expect(ws.getCell('D5').text).toContain('Rasm');
    const p = await exp(admin, `/classes/${c1.id}/export?format=pdf&versionId=${draftId}`);
    expect((await pdfPages(body(p))).text).toContain('QORALAMA');
    // view-only: qoralama topilmaydi
    expect(
      (await exp(viewer, `/classes/${c1.id}/export?format=pdf&versionId=${draftId}`)).status,
    ).toBe(404);
    // faol versiya id bilan: QORALAMA yo'q
    const act = await exp(viewer, `/classes/${c1.id}/export?format=xlsx&versionId=${c1Version}`);
    expect(act.status).toBe(200);
    expect((await readXlsx(body(act))).getWorksheet('5-A')!.getCell('A2').value).toBe(
      'Dars jadvali · 5-A',
    );
    // boshqa sinfning versiyasi
    expect(
      (await exp(admin, `/classes/${c2.id}/export?format=pdf&versionId=${draftId}`)).status,
    ).toBe(404);
  });

  it("ruxsat: view yo'q admin va o'qituvchi 403; audit yoziladi", async () => {
    expect((await exp(nobody, `/classes/${c1.id}/export?format=pdf`)).status).toBe(403);
    expect((await exp(teacher1, `/classes/${c1.id}/export?format=pdf`)).status).toBe(403);
    expect((await exp(viewer, `/classes/${c1.id}/export?format=pdf`)).status).toBe(200);
    const log = await AuditLog.findOne({
      action: 'reports.export',
      entityId: 'timetable_class',
    }).lean();
    expect(log?.schoolId?.toString()).toBe(school.id);
    expect(log?.after).toMatchObject({ type: 'timetable_class', format: 'pdf', rowCount: 1 });
  });

  it('tenant: boshqa maktab sinfi 404', async () => {
    expect((await exp(adminOther, `/classes/${c1.id}/export?format=pdf`)).status).toBe(404);
  });
});

describe("o'qituvchi jadvali eksporti", () => {
  it("xlsx: barcha sinflar bo'yicha, sinf nomi va xona; fayl nomi ASCII", async () => {
    const r = await exp(viewer, `/teachers/${t1.id}/export?format=xlsx`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain(
      'filename="dars-jadvali-Mirzamatov-M-2026-10-30.xlsx"',
    );
    const wb = await readXlsx(body(r));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Mirzamatov Mansur Karimovich']);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A2').value).toBe('Dars jadvali · Mirzamatov Mansur Karimovich');
    expect(ws.getCell('B5').text).toBe('Matematika\n5-A\nXona: 205');
    expect(ws.getCell('B6').text).toBe('Matematika\n5-B');
    expect(ws.getCell('F8').text).toBe('Matematika\n5-A\nXona: Sport zali');
    // boshqa o'qituvchi darsi yo'q
    expect(ws.getCell('B6').text).not.toContain('Ingliz');
  });

  it('pdf; Unicode ism fayl nomida ASCII va filename* UTF-8', async () => {
    const r = await exp(admin, `/teachers/${t2.id}/export?format=pdf`);
    expect(r.status).toBe(200);
    expect(body(r).subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.headers['content-disposition']).toContain('dars-jadvali-Orinboyeva-G-2026-10-30.pdf');
    const { pages, text } = await pdfPages(body(r));
    expect(pages).toBe(1);
    expect(text).toContain('Ingliz tili');
    expect(text).toContain('5-A');
    expect(text).toContain('5-B');
  });

  it("darssiz o'qituvchi 404; o'qituvchi roli 403; boshqa maktab o'qituvchisi 404", async () => {
    const t4 = await User.findOne({ username: 'ex_t4' }).lean();
    expect((await exp(viewer, `/teachers/${t4?._id}/export?format=pdf`)).status).toBe(404);
    expect((await exp(nobody, `/teachers/${t1.id}/export?format=pdf`)).status).toBe(403);
    expect((await exp(teacher1, `/teachers/${t1.id}/export?format=pdf`)).status).toBe(200);
    expect((await exp(teacher1, `/teachers/${t2.id}/export?format=pdf`)).status).toBe(403);
    expect((await exp(adminOther, `/teachers/${t1.id}/export?format=pdf`)).status).toBe(404);
  });

  it('/me/export: view ruxsati kerak emas', async () => {
    const x = await exp(teacher2, '/me/export?format=xlsx');
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain(XLSX);
    const ws = (await readXlsx(body(x))).worksheets[0];
    expect(ws.getCell('B5').text).toBe('Ingliz tili\n5-B');
    expect(ws.getCell('B6').text).toBe('Ingliz tili\n5-A');
    const p = await exp(teacher2, '/me/export?format=pdf');
    expect(p.status).toBe(200);
    expect(body(p).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await exp(teacherNoLessons, '/me/export?format=pdf')).status).toBe(404);
    expect((await exp(nobody, '/me/export?format=pdf')).status).toBe(404); // admin o'qituvchi emas
  });
});

describe('butun maktab eksporti', () => {
  it('sinflar xlsx: Umumiy + har sinf uchun varaq (faqat versiyasi borlari)', async () => {
    const r = await exp(viewer, '/export?format=xlsx&kind=classes');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain(
      'dars-jadvali-maktab-sinflar-2026-10-30.xlsx',
    );
    const wb = await readXlsx(body(r));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Umumiy', '5-A', '5-B']);
    const ov = wb.getWorksheet('Umumiy')!;
    expect(ov.getCell('B6').text).toBe('5-A');
    expect(ov.getCell('C6').value).toBe(4);
    expect(ov.getCell('B7').text).toBe('5-B');
    expect(wb.getWorksheet('5-B')!.getCell('B5').text).toBe('Ingliz tili\nOʻrinboyeva G.');
  });

  it("kind standart classes; o'qituvchilar xlsx: darsi borlar, uz tartibida", async () => {
    const def = await exp(viewer, '/export?format=xlsx');
    expect((await readXlsx(body(def))).worksheets.map((w) => w.name)).toEqual([
      'Umumiy',
      '5-A',
      '5-B',
    ]);
    const r = await exp(viewer, '/export?format=xlsx&kind=teachers');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('maktab-oqituvchilar-2026-10-30.xlsx');
    const wb = await readXlsx(body(r));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Umumiy',
      '=Formula Teacher',
      'Mirzamatov Mansur Karimovich',
      'Oʻrinboyeva Gʻuncha',
    ]);
  });

  it("pdf: har sinf/o'qituvchi uchun bitta sahifa", async () => {
    const c = await exp(admin, '/export?format=pdf&kind=classes');
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toBe('application/pdf');
    expect(body(c).subarray(0, 5).toString()).toBe('%PDF-');
    const cp = await pdfPages(body(c));
    expect(cp.pages).toBe(2);
    expect(cp.text).toContain('1 / 2');
    expect(cp.text).toContain('2 / 2');
    const t = await exp(admin, '/export?format=pdf&kind=teachers');
    expect((await pdfPages(body(t))).pages).toBe(3);
  });

  it("ruxsat, tenant, bo'sh maktab, audit", async () => {
    expect((await exp(nobody, '/export?format=pdf')).status).toBe(403);
    expect((await exp(teacher1, '/export?format=pdf')).status).toBe(403);
    expect((await exp(viewer, '/export?format=pdf&kind=bad')).status).toBe(400);
    // boshqa maktabda jadval yo'q
    expect((await exp(adminOther, '/export?format=pdf')).status).toBe(404);
    // sana jadvaldan oldin
    expect((await exp(viewer, '/export?format=pdf&date=2026-09-01')).status).toBe(404);
    const log = await AuditLog.findOne({ entityId: 'timetable_school_classes' }).lean();
    expect(log).toBeNull();
    await exp(viewer, '/export?format=pdf&kind=classes');
    const l2 = await AuditLog.findOne({ entityId: 'timetable_school_classes' }).lean();
    expect(l2?.after).toMatchObject({ format: 'pdf', rowCount: 2 });
  });
});

describe('katta jadval: bitta sahifa', () => {
  it("12 dars x 6 kun to'la jadval ham 1 sahifa", async () => {
    const entries: object[] = [];
    for (let w = 1; w <= 6; w++) {
      for (let n = 1; n <= 12; n++)
        entries.push(e(w, n, n % 2 ? math.id : eng.id, n % 3 ? t1.id : t2.id, `${100 + n}`));
    }
    const id = await makeVersion(c3.id, entries, false, '2026-11-09');
    const r = await exp(admin, `/classes/${c3.id}/export?format=pdf&versionId=${id}`);
    expect(r.status).toBe(200);
    expect((await pdfPages(body(r))).pages).toBe(1);
    const x = await exp(admin, `/classes/${c3.id}/export?format=xlsx&versionId=${id}`);
    const ws = (await readXlsx(body(x))).worksheets[0];
    expect(ws.getCell('A16').value).toBe(12);
  });
});

/** Namuna fayllar (faqat TIMETABLE_SAMPLE_DIR berilganda yoziladi) */
describe.skipIf(!process.env.TIMETABLE_SAMPLE_DIR)('namuna fayllar', () => {
  it('yozadi', async () => {
    const dir = process.env.TIMETABLE_SAMPLE_DIR as string;
    fs.mkdirSync(dir, { recursive: true });
    const entries: object[] = [];
    const names = [
      'Karimova Dilnoza',
      'Yusupov Aziz',
      'Toshpulatova Malika',
      'Rahimov Jasur',
      'Qodirova Nodira',
    ];
    const teachers: string[] = [];
    for (const [i, fullName] of names.entries()) {
      const u = await makeUser({ username: `ex_s${i}`, role: 'teacher', schoolId: school.id });
      await User.updateOne({ _id: u.id }, { fullName });
      teachers.push(u.id);
    }
    const subs = [
      math.id,
      eng.id,
      art.id,
      (await makeSubject('Ona tili va adabiyot')).id,
      (await makeSubject('Jismoniy tarbiya')).id,
    ];
    for (let w = 1; w <= 6; w++) {
      for (let n = 1; n <= (w === 6 ? 4 : 7); n++) {
        const k = (w + n) % 5;
        entries.push(e(w, n, subs[k], teachers[k], (n + w) % 2 ? `${200 + n}` : ''));
      }
    }
    const id = await makeVersion(c3.id, entries, true, '2026-11-02');
    const save = async (name: string, p: string) => {
      const r = await exp(admin, p);
      expect(r.status).toBe(200);
      fs.writeFileSync(path.join(dir, name), body(r));
    };
    void id;
    await save('sinf-6-A.pdf', `/classes/${c3.id}/export?format=pdf&date=2026-11-03`);
    await save('sinf-6-A.xlsx', `/classes/${c3.id}/export?format=xlsx&date=2026-11-03`);
    await save('maktab-sinflar.xlsx', '/export?format=xlsx&kind=classes&date=2026-11-03');
    await save('maktab-oqituvchilar.pdf', '/export?format=pdf&kind=teachers&date=2026-11-03');
  });
});
