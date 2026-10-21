import ExcelJS from 'exceljs';
import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { contentDisposition, safeFileName } from '../src/modules/reports/reports.files';
import { safeText } from '../src/modules/reports/reports.excel';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
import { clock } from '../src/utils/clock';
import {
  AttendanceRecord,
  Score,
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z';
const Q = 'from=2026-10-01&to=2026-10-14';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let school: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc;
let evil: Doc, cyr: Doc, uz: Doc, plain: Doc;
let teacher: Doc;
let pos: Doc, neg: Doc;
let statuses: Record<AttendanceCategory, Doc>;
let root: string, admin: string, rep: string, t1: string, t2: string;

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('a');
  year = await makeYear(school.id);
  teacher = await makeUser({
    username: 'teacher1',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view', 'reports.export'],
  });
  const t2u = await makeUser({
    username: 'teacher2',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view', 'reports.export'],
  });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [teacher.id]);
  c6 = await makeClass(school.id, year.id, '6-A', [t2u.id]);
  evil = await makeStudent(school.id, c5.id, '=HYPERLINK("http://evil.example","bosing")');
  cyr = await makeStudent(school.id, c5.id, 'Қодиров Ғолиб Ҳасанович');
  uz = await makeStudent(school.id, c5.id, "Oʻrinboyev G'ani Toʻraqul oʻgʻli");
  plain = await makeStudent(school.id, c5.id, '@SUM(A1) Aliyev Ali');
  pos = await makeBehaviorType('Namunali xulq', 'positive', { color: '#16A34A' });
  neg = await makeBehaviorType('Dars paytida bezovtalik', 'negative', { color: '#DC2626' });
  statuses = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus("Sababli yo'q", 'absent_excused'),
    absent_unexcused: await makeStatus("Sababsiz yo'q", 'absent_unexcused'),
  };
  let n = 0;
  for (const st of [evil, cyr, uz, plain]) {
    for (const d of ['01', '02', '03']) {
      await Score.create({
        schoolId: school.id,
        studentId: st._id,
        classId: c5._id,
        teacherId: teacher._id,
        academicYearId: year._id,
        behaviorTypeId: (n++ % 2 ? neg : pos)._id,
        value: 60 + n * 3,
        comment: st === cyr ? 'Яхши ўқувчи' : null,
        date: `2026-10-${d}`,
      });
    }
    await AttendanceRecord.create({
      schoolId: school.id,
      studentId: st._id,
      classId: c5._id,
      academicYearId: year._id,
      date: '2026-10-12',
      lessonNo: 0,
      statusId: statuses.present._id,
      category: 'present',
      markedBy: teacher._id,
      updatedBy: teacher._id,
    });
  }
  [root, admin, rep, t1, t2] = await Promise.all(
    ['root', 'admin', 'rep', 'teacher1', 'teacher2'].map(async (u) => (await login(u)).token),
  );
});

type Res = request.Response;
const binary = (r: Res, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (d: Buffer) => chunks.push(d));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};
const exp = (t: string, path: string, h: Record<string, string> = {}) =>
  request(app).get(`/api/v1/reports${path}`).set(bearer(t)).set(h).buffer(true).parse(binary);
const body = (r: Res) => r.body as Buffer;

async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}
const textOf = (v: ExcelJS.CellValue) =>
  typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');

/** pdfjs-dist yordamida PDF matnini chiqaradi */
async function pdfText(buf: Buffer): Promise<{ pages: number; text: string }> {
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

describe('Excel eksport', () => {
  it('sinf hisoboti: sarlavha bloki, jadval, 2-varaq, formatlar, muzlatilgan qator, autoFilter', async () => {
    const res = await exp(admin, `/class/export?classId=${c5.id}&${Q}&format=xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(XLSX);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="sinf-5-A_2026-10-01_2026-10-14\.xlsx"; filename\*=UTF-8''sinf-5-A_2026-10-01_2026-10-14\.xlsx$/,
    );
    expect(body(res).subarray(0, 2).toString()).toBe('PK');

    const wb = await readXlsx(body(res));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["O'quvchilar", 'Xulq turlari']);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('Sinf hisoboti: 5-A');
    expect(ws.getCell('B2').value).toBe('Maktab a');
    expect(ws.getCell('B3').value).toBe('01.10.2026 — 14.10.2026');
    expect(String(ws.getCell('B4').value)).toMatch(
      /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(Asia\/Tashkent\)$/,
    );
    expect(String(ws.getCell('B4').value)).toContain('14.10.2026 12:00'); // clock 07:00Z -> 12:00 Toshkent? generatedAt real vaqt emas

    // Sarlavha qatorini topamiz
    let headerRow = 0;
    ws.eachRow((row, n) => {
      if (row.getCell(1).value === 'F.I.Sh.') headerRow = n;
    });
    expect(headerRow).toBeGreaterThan(5);
    const header = ws.getRow(headerRow);
    expect(header.getCell(1).font?.bold).toBe(true);
    expect((header.getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFE5E7EB');
    expect(String(header.getCell(5).value)).toBe('Reyting bali');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: headerRow });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual(30);

    // Qiymatlar: raqamlar raqam sifatida, formatli
    const rows: ExcelJS.Row[] = [];
    ws.eachRow((row, n) => {
      if (n > headerRow) rows.push(row);
    });
    // 4 ta o'quvchi + qisqartmalar izohi qatori (oxirgi)
    expect(rows).toHaveLength(5);
    expect(String(rows[4].getCell(1).value)).toContain('Maktabda');
    rows.pop();
    const cyrRow = rows.find((r) => String(r.getCell(1).value).startsWith('Қодиров'));
    expect(cyrRow).toBeTruthy();
    expect(typeof cyrRow?.getCell(5).value).toBe('number');
    expect(cyrRow?.getCell(5).numFmt).toBe('0.00');
    expect(typeof cyrRow?.getCell(9).value).toBe('number');
    expect(rows.some((r) => String(r.getCell(1).value).startsWith("Oʻrinboyev G'ani"))).toBe(true);

    // 2-varaq: xulq turlari
    const b = wb.worksheets[1];
    expect(b.getRow(1).getCell(1).value).toBe('Xulq turi');
    expect(b.rowCount).toBeGreaterThanOrEqual(3);
    expect(b.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('formula injeksiyasidan himoya: =, +, -, @ bilan boshlangan matn apostrof bilan, formula emas', async () => {
    const wb = await readXlsx(
      body(await exp(admin, `/class/export?classId=${c5.id}&${Q}&format=xlsx`)),
    );
    const ws = wb.worksheets[0];
    const names: string[] = [];
    let formulas = 0;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (
          cell.type === ExcelJS.ValueType.Formula ||
          (typeof cell.value === 'object' && cell.value && 'formula' in cell.value)
        )
          formulas++;
      });
      names.push(textOf(row.getCell(1).value));
    });
    expect(formulas).toBe(0);
    expect(names).toContain(`'=HYPERLINK("http://evil.example","bosing")`);
    expect(names).toContain("'@SUM(A1) Aliyev Ali");

    // Birlik testi
    expect(safeText('=1+1')).toBe("'=1+1");
    expect(safeText('+998901234567')).toBe("'+998901234567");
    expect(safeText('-cmd')).toBe("'-cmd");
    expect(safeText('@x')).toBe("'@x");
    expect(safeText('\tx')).toBe("'\tx");
    expect(safeText('Oddiy matn =')).toBe('Oddiy matn =');
  });

  it("o'quvchi hisoboti: 3 ta varaq (Kunlik ballar, Baholar, Davomat), baholarda xulq nomi va izoh", async () => {
    const res = await exp(admin, `/student/${cyr.id}/export?${Q}&format=xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''oquvchi-");
    const wb = await readXlsx(body(res));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Kunlik ballar', 'Baholar', 'Davomat']);
    const entries = wb.worksheets[1];
    expect(entries.getRow(1).values).toEqual([
      undefined,
      'Sana',
      'Ball',
      'Xulq turi',
      "O'qituvchi",
      'Izoh',
    ]);
    expect(entries.rowCount).toBe(4); // 3 baho + sarlavha
    // Sana — haqiqiy Excel sanasi, dd.mm.yyyy formatida
    expect(entries.getRow(2).getCell(1).value).toBeInstanceOf(Date);
    expect(entries.getRow(2).getCell(1).numFmt).toBe('dd.mm.yyyy');
    expect(String(entries.getRow(2).getCell(5).value)).toBe('Яхши ўқувчи');
    const att = wb.worksheets[2];
    expect(att.getRow(2).getCell(2).value).toBe('Keldi');
    expect(wb.worksheets[0].getCell('A1').value).toBe(
      "O'quvchi hisoboti: Қодиров Ғолиб Ҳasanovich".replace('Ҳasanovich', 'Ҳасанович'),
    );
  });

  it("barcha hisobot turlari xlsx va pdf: to'g'ri sarlavhalar, magic bytes, audit", async () => {
    const cases: [string, string][] = [
      [`/class/export?classId=${c5.id}&${Q}`, 'class'],
      [`/student/${uz.id}/export?${Q}`, 'student'],
      [`/teachers/export?${Q}`, 'teachers'],
      [`/school/export?${Q}`, 'school'],
      [`/behavior/export?${Q}`, 'behavior'],
    ];
    for (const [path, type] of cases) {
      const x = await exp(admin, `${path}&format=xlsx`);
      expect(x.status, path).toBe(200);
      expect(x.headers['content-type']).toContain(XLSX);
      expect(body(x).length).toBeGreaterThan(1000);
      expect((await readXlsx(body(x))).worksheets.length).toBeGreaterThanOrEqual(1);
      const p = await exp(admin, `${path}&format=pdf`);
      expect(p.status, path).toBe(200);
      expect(p.headers['content-type']).toBe('application/pdf');
      expect(p.headers['content-disposition']).toMatch(
        /^attachment; filename=".+\.pdf"; filename\*=UTF-8''.+\.pdf$/,
      );
      expect(p.headers['cache-control']).toBe('no-store');
      expect(body(p).subarray(0, 5).toString()).toBe('%PDF-');
      expect(body(p).length).toBeGreaterThan(2000);
      expect((await pdfText(body(p))).pages).toBeGreaterThanOrEqual(1);
      expect(await AuditLog.countDocuments({ action: 'reports.export', entityId: type })).toBe(2);
    }
    const sx = await exp(root, `/schools/export?${Q}&format=xlsx`);
    expect(sx.status).toBe(200);
    expect(
      body(await exp(root, `/schools/export?${Q}&format=pdf`))
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    const log = await AuditLog.findOne({
      action: 'reports.export',
      entityId: 'class',
      'after.format': 'xlsx',
    }).lean();
    expect(log).toMatchObject({
      entity: 'report',
      after: {
        type: 'class',
        format: 'xlsx',
        params: { classId: c5.id, from: '2026-10-01', to: '2026-10-14' },
        rowCount: 6,
      },
    });
    expect(String(log?.userId)).toBeTruthy();
    expect(String(log?.schoolId)).toBe(school.id);
    expect((await AuditLog.findOne({ entityId: 'schools' }).lean())?.schoolId).toBeNull();
  });
});

describe('PDF eksport', () => {
  it("kirill va o'zbek apostroflari (o', g', ʻ, ʼ) xatosiz; matn ajratib olinadi; kolontitul", async () => {
    const res = await exp(admin, `/class/export?classId=${c5.id}&${Q}&format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /filename="sinf-5-A_2026-10-01_2026-10-14\.pdf"/,
    );
    const { pages, text } = await pdfText(body(res));
    expect(pages).toBe(1);
    expect(text).toContain('Қодиров Ғолиб Ҳасанович');
    expect(text).toContain("Oʻrinboyev G'ani Toʻraqul oʻgʻli");
    expect(text).toContain('Sinf hisoboti: 5-A');
    expect(text).toContain('Maktab: Maktab a');
    expect(text).toContain('01.10.2026 — 14.10.2026');
    expect(text).toContain('Sahifa 1 / 1');
    expect(text).toContain('Yuksalish reyting tizimi');
    expect(text).toContain('Xulq turlari');
    expect(text).toContain('Namunali xulq');
  });

  it("uzun jadval sahifalarga bo'linadi, sarlavha qatori har sahifada takrorlanadi; uzun so'z kesilmaydi", async () => {
    for (let i = 0; i < 70; i++) {
      await makeStudent(
        school.id,
        c5.id,
        i === 0 ? 'U'.repeat(90) : `Talaba Nomer${String(i).padStart(2, '0')} Familiya`,
      );
    }
    const res = await exp(admin, `/class/export?classId=${c5.id}&${Q}&format=pdf`);
    expect(res.status).toBe(200);
    const { pages, text } = await pdfText(body(res));
    expect(pages).toBeGreaterThanOrEqual(3);
    const headerCount = text.split('F.I.Sh.').length - 1;
    expect(headerCount).toBeGreaterThanOrEqual(2);
    expect(headerCount).toBeGreaterThanOrEqual(pages - 1); // oxirgi sahifalar xulq turlari bo'lishi mumkin
    expect(text).toContain('(davomi)');
    expect(text).toContain(`Sahifa ${pages} / ${pages}`);
    expect(text).toContain('Sahifa 2 / ' + pages);
    expect(text).toContain('Talaba Nomer69 Familiya');
    expect(text.replace(/\s/g, '')).toContain('U'.repeat(90)); // uzun so'z qatorlarga bo'lingan, lekin yo'qolmagan
  });

  it("o'quvchi PDF: dinamika grafigi va davomat xulosasi bilan; schools/teachers PDF ham ochiladi", async () => {
    const res = await exp(admin, `/student/${cyr.id}/export?${Q}&format=pdf`);
    expect(res.status).toBe(200);
    const { text } = await pdfText(body(res));
    expect(text).toContain("O'quvchi hisoboti: Қодиров Ғолиб Ҳасанович");
    expect(text).toContain('Kunlik ball dinamikasi');
    expect(text).toContain('Davomat, %');
    expect(text).toContain('Яхши ўқувчи');
    expect(text).toContain('Baholar');
    expect(text).toContain('Davomat');
    const t = await pdfText(body(await exp(admin, `/teachers/export?${Q}&format=pdf`)));
    expect(t.text).toContain("O'qituvchilar faolligi hisoboti");
    expect(t.text).toContain('Test teacher1');
  });
});

describe('Eksport ruxsatlari va fayl nomi', () => {
  it("reports.export yo'q bo'lsa 403 (JSON esa ishlaydi); o'qituvchi faqat o'z sinfi; format validatsiyasi", async () => {
    expect((await exp(rep, `/class/export?classId=${c5.id}&${Q}&format=xlsx`)).status).toBe(403);
    expect(
      (await request(app).get(`/api/v1/reports/class?classId=${c5.id}&${Q}`).set(bearer(rep)))
        .status,
    ).toBe(200);
    expect((await exp(t2, `/class/export?classId=${c6.id}&${Q}&format=pdf`)).status).toBe(403); // teacher2 da reports.export yo'q
    expect((await exp(t1, `/class/export?classId=${c5.id}&${Q}&format=pdf`)).status).toBe(200);
    expect((await exp(t1, `/class/export?classId=${c6.id}&${Q}&format=pdf`)).status).toBe(404);
    expect((await exp(t1, `/school/export?${Q}&format=pdf`)).status).toBe(403);
    expect((await exp(admin, `/class/export?classId=${c5.id}&${Q}&format=docx`)).status).toBe(400);
    expect(
      (await exp(admin, `/class/export?classId=${c5.id}&from=2026-10-10&to=2026-10-01`)).status,
    ).toBe(400);
    expect((await exp(admin, `/class/export?${Q}`)).status).toBe(400);
    expect(
      (await request(app).get(`/api/v1/reports/class/export?classId=${c5.id}&${Q}`)).status,
    ).toBe(401);
    expect((await exp(root, `/school/export?${Q}&format=pdf`)).status).toBe(400); // X-School-Id kerak
    expect(
      (await exp(root, `/school/export?${Q}&format=pdf`, { 'X-School-Id': school.id })).status,
    ).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'reports.export' })).toBe(2);
    // format berilmasa — xlsx
    expect(
      (await exp(admin, `/class/export?classId=${c5.id}&${Q}`)).headers['content-type'],
    ).toContain(XLSX);
  });

  it("fayl nomi xavfsiz: bo'shliq, slash, qo'shtirnoq, kirill va apostrof", async () => {
    const weird = await makeClass(school.id, year.id, '7 "Ғ"/..\\x?');
    const res = await exp(admin, `/class/export?classId=${weird.id}&${Q}&format=pdf`);
    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'] as string;
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7E]+"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    expect(cd.split('filename="')[1].split('"')[0]).not.toMatch(/[\\/"]/);
    const encoded = cd.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe('sinf-7-Ғ-x_2026-10-01_2026-10-14.pdf');

    expect(safeFileName("O'quvchi: Aliyev/Ali", '2026-10-01', '2026-10-14', 'xlsx')).toBe(
      'O-quvchi-Aliyev-Ali_2026-10-01_2026-10-14.xlsx',
    );
    expect(safeFileName('', '2026-10-01', '2026-10-14', 'pdf')).toBe(
      'hisobot_2026-10-01_2026-10-14.pdf',
    );
    expect(safeFileName('../../etc/passwd', '2026-10-01', '2026-10-14', 'pdf')).not.toMatch(
      /[/\\]/,
    );
    const d = contentDisposition("Ғолиб G'ani (1).pdf");
    expect(d).toContain("filename*=UTF-8''%D0%93%CC%A3".slice(0, 0) + "filename*=UTF-8''");
    expect(d).toContain('%27'); // apostrof kodlangan
    expect(d).not.toMatch(/filename\*=UTF-8''[^;]*['()]/);
  });
});
