import ExcelJS from 'exceljs';
import { fmtDate, fmtDateTime } from '../reports/reports.labels';
import { safeText } from '../reports/reports.excel';
import { createDoc } from '../reports/reports.pdf';

/**
 * Haftalik dars jadvalini Excel/PDF ga chiqarish (sinf yoki o'qituvchi bo'yicha).
 * Bu yerda faqat chizish; ma'lumotni yig'ish timetable.export.service.ts da.
 */

export const WEEKDAY_NAMES = [
  '',
  'Dushanba',
  'Seshanba',
  'Chorshanba',
  'Payshanba',
  'Juma',
  'Shanba',
  'Yakshanba',
];

export interface ExportCell {
  subject: string;
  /** Sinf jadvalida o'qituvchi (qisqa), o'qituvchi jadvalida sinf nomi */
  detail: string;
  room: string | null;
}

export interface TimetableDoc {
  kind: 'class' | 'teacher';
  /** "5-A" yoki o'qituvchining to'liq ismi */
  title: string;
  schoolName: string;
  yearName: string | null;
  /** Masalan "Amal qilish: 02.09.2026 – …" */
  validity: string;
  draft: boolean;
  weekdays: number[];
  /** Qatorlar soni (1..rows dars) */
  rows: number;
  /** `${weekday}:${lessonNo}` -> katak */
  cells: Record<string, ExportCell[]>;
  lessonCount: number;
}

export const cellKey = (weekday: number, lessonNo: number) => `${weekday}:${lessonNo}`;
const docTitle = (d: TimetableDoc) => `Dars jadvali · ${d.title}${d.draft ? ' · QORALAMA' : ''}`;
const infoLine = (d: TimetableDoc, generated: string) =>
  [d.yearName ? `O'quv yili: ${d.yearName}` : null, d.validity, `Yaratilgan: ${generated}`]
    .filter(Boolean)
    .join('   |   ');
const roomText = (r: string) => `Xona: ${r}`;

/** "Mirzamatov Mansur Karimovich" -> "Mirzamatov M." */
export function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${Array.from(parts[1])[0]}.`;
}

/** "Amal qilish: 02.09.2026 – …" */
export function validityText(from: string | null, to: string | null): string {
  if (!from) return '';
  return `Amal qilish: ${fmtDate(from)} – ${to ? fmtDate(to) : '…'}`;
}

/** Excel varaq nomi: <=31 belgi, taqiqlangan belgilarsiz, takrorlanmas */
export function uniqueSheetName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[\\/*?:[\]]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, 31) || 'Varaq';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - 3)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

// ---------------- Excel ----------------

const THIN = { style: 'thin', color: { argb: 'FFD1D5DB' } } as const;
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } as const;
const SIDE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } } as const;
const GREY = { argb: 'FF6B7280' };
const DAY_COL_WIDTH = 26;

function cellRichText(list: ExportCell[]): ExcelJS.CellRichTextValue | null {
  if (!list.length) return null;
  const richText: ExcelJS.RichText[] = [];
  list.forEach((c, i) => {
    if (i > 0) richText.push({ text: '\n\n' });
    richText.push({ text: safeText(c.subject), font: { bold: true, size: 11 } });
    if (c.detail) richText.push({ text: `\n${safeText(c.detail)}`, font: { size: 10 } });
    if (c.room) {
      richText.push({ text: `\n${safeText(roomText(c.room))}`, font: { size: 9, color: GREY } });
    }
  });
  return { richText };
}

const linesOf = (list: ExportCell[]) =>
  list.reduce((n, c) => n + 1 + (c.detail ? 1 : 0) + (c.room ? 1 : 0), 0) +
  Math.max(0, list.length - 1);

function writeSheet(ws: ExcelJS.Worksheet, d: TimetableDoc, generated: string) {
  const lastCol = 1 + d.weekdays.length;
  const banner = (row: number, text: string, font: Partial<ExcelJS.Font>, height?: number) => {
    const r = ws.getRow(row);
    r.getCell(1).value = safeText(text);
    r.getCell(1).font = font;
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    if (lastCol > 1) ws.mergeCells(row, 1, row, lastCol);
    if (height) r.height = height;
  };
  banner(1, d.schoolName, { bold: true, size: 14 }, 22);
  banner(
    2,
    docTitle(d),
    { bold: true, size: 12, color: d.draft ? { argb: 'FFB91C1C' } : undefined },
    20,
  );
  banner(3, infoLine(d, generated), { size: 9, color: GREY }, 16);

  const headRow = 4;
  const head = ws.getRow(headRow);
  head.height = 24;
  ['№', ...d.weekdays.map((w) => WEEKDAY_NAMES[w])].forEach((text, i) => {
    const c = head.getCell(i + 1);
    c.value = text;
    c.font = { bold: true };
    c.fill = HEAD_FILL;
    c.border = BORDER;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  ws.getColumn(1).width = 6;
  d.weekdays.forEach((_, i) => {
    ws.getColumn(i + 2).width = DAY_COL_WIDTH;
  });

  for (let n = 1; n <= d.rows; n++) {
    const r = ws.getRow(headRow + n);
    const first = r.getCell(1);
    first.value = n;
    first.font = { bold: true };
    first.fill = SIDE_FILL;
    first.border = BORDER;
    first.alignment = { vertical: 'middle', horizontal: 'center' };
    let maxLines = 1;
    d.weekdays.forEach((w, i) => {
      const list = d.cells[cellKey(w, n)] ?? [];
      const c = r.getCell(i + 2);
      c.value = cellRichText(list);
      c.border = BORDER;
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      maxLines = Math.max(maxLines, linesOf(list));
    });
    r.height = Math.max(36, maxLines * 15 + 8);
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headRow }];
  ws.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  ws.headerFooter = { oddFooter: '&R&P / &N' };
}

export interface ExcelOptions {
  /** Umumiy sahifa (maktab bo'yicha eksportda): sarlavha va birinchi ustun nomi */
  overview?: { sheetTitle: string; firstColumn: string };
}

/** Maktab bo'yicha eksportda "Umumiy" sahifa (boshqa turlarda yo'q) */
export function exportOverview(type: string): ExcelOptions {
  if (type === 'timetable_school_classes') {
    return { overview: { sheetTitle: 'Sinflar jadvali', firstColumn: 'Sinf' } };
  }
  if (type === 'timetable_school_teachers') {
    return { overview: { sheetTitle: "O'qituvchilar jadvali", firstColumn: "O'qituvchi" } };
  }
  return {};
}

/** Fayl nomi uchun ASCII slug: "Mirzamatov M." -> "Mirzamatov-M", "5-A" -> "5-A" */
export function fileSlug(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ʻʼ‘’`´']/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'jadval';
}

export async function renderTimetableExcel(
  docs: TimetableDoc[],
  opts: ExcelOptions = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yuksalish reyting tizimi';
  wb.created = new Date();
  const generated = `${fmtDateTime(new Date().toISOString())} (Asia/Tashkent)`;
  const used = new Set<string>();

  const overview = opts.overview && docs.length > 1 ? opts.overview : undefined;
  const ovWs = overview ? wb.addWorksheet(uniqueSheetName('Umumiy', used)) : null;

  const names: string[] = [];
  for (const d of docs) {
    const name = uniqueSheetName(d.title, used);
    names.push(name);
    writeSheet(wb.addWorksheet(name), d, generated);
  }

  if (ovWs && overview) {
    const first = docs[0];
    ovWs.getRow(1).getCell(1).value = safeText(first.schoolName);
    ovWs.getRow(1).getCell(1).font = { bold: true, size: 14 };
    ovWs.getRow(2).getCell(1).value = overview.sheetTitle;
    ovWs.getRow(2).getCell(1).font = { bold: true, size: 12 };
    ovWs.getRow(3).getCell(1).value = safeText(
      [first.yearName ? `O'quv yili: ${first.yearName}` : null, `Yaratilgan: ${generated}`]
        .filter(Boolean)
        .join('   |   '),
    );
    ovWs.getRow(3).getCell(1).font = { size: 9, color: GREY };
    const cols = ['№', overview.firstColumn, 'Haftalik darslar', 'Amal qilish'];
    const head = ovWs.getRow(5);
    cols.forEach((t, i) => {
      const c = head.getCell(i + 1);
      c.value = t;
      c.font = { bold: true };
      c.fill = HEAD_FILL;
      c.border = BORDER;
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    docs.forEach((d, i) => {
      const r = ovWs.getRow(6 + i);
      r.getCell(1).value = i + 1;
      r.getCell(2).value = { text: safeText(d.title), hyperlink: `#'${names[i]}'!A1` };
      r.getCell(2).font = { color: { argb: 'FF1D4ED8' }, underline: true };
      r.getCell(3).value = d.lessonCount;
      r.getCell(4).value = safeText(d.validity.replace(/^Amal qilish:s*/, ''));
      for (let c = 1; c <= 4; c++) {
        r.getCell(c).border = BORDER;
        r.getCell(c).alignment = {
          vertical: 'middle',
          horizontal: c === 2 || c === 4 ? 'left' : 'center',
          wrapText: true,
        };
      }
    });
    ovWs.getColumn(1).width = 6;
    ovWs.getColumn(2).width = 34;
    ovWs.getColumn(3).width = 18;
    ovWs.getColumn(4).width = 44;
    ovWs.views = [{ state: 'frozen', xSplit: 0, ySplit: 5 }];
    ovWs.pageSetup = {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------- PDF ----------------

const M = 28;
const HEADER_H = 52;
const FOOTER_H = 16;
const LESSON_COL_W = 30;
const HEAD_ROW_H = 20;
const PAD = 3;
const MAX_ROW_H = 78;
const FONT_MAX = 9.5;
const FONT_MIN = 5;

interface Block {
  text: string;
  bold: boolean;
  grey: boolean;
}

function blocksOf(list: ExportCell[]): Block[] {
  const out: Block[] = [];
  list.forEach((c, i) => {
    if (i > 0) out.push({ text: '', bold: false, grey: false });
    out.push({ text: c.subject, bold: true, grey: false });
    if (c.detail) out.push({ text: c.detail, bold: false, grey: false });
    if (c.room) out.push({ text: roomText(c.room), bold: false, grey: true });
  });
  return out;
}

export function renderTimetablePdf(docs: TimetableDoc[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const title = docs.length === 1 ? docTitle(docs[0]) : 'Dars jadvali';
    const doc = createDoc({
      size: 'A4',
      layout: 'landscape',
      margin: M,
      bufferPages: true,
      info: { Title: title, Author: 'Yuksalish reyting tizimi' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const generated = `${fmtDateTime(new Date().toISOString())} (Asia/Tashkent)`;
    const usableW = pageW - 2 * M;

    const line = (
      t: string,
      x: number,
      y: number,
      w: number,
      align: 'left' | 'center' | 'right' = 'left',
    ) => {
      // lineBreak: false -> pdfkit hech qachon yangi sahifa ochmaydi
      doc.text(t, x, y, { width: w, align, lineBreak: false });
    };
    const fit = (t: string, w: number) => {
      let s = t;
      while (s.length > 3 && doc.widthOfString(s) > w) s = `${s.slice(0, -2)}…`;
      return s;
    };

    const heightOf = (blocks: Block[], size: number, w: number): number => {
      let h = 0;
      for (const b of blocks) {
        doc.font(b.bold ? 'BodyBold' : 'Body').fontSize(size);
        h += b.text ? doc.heightOfString(b.text, { width: w, lineGap: 0.5 }) : size * 0.6;
      }
      return h;
    };

    docs.forEach((d, pi) => {
      if (pi > 0) doc.addPage();
      let y = M;

      doc.font('BodyBold').fontSize(13).fillColor('#111827');
      line(fit(d.schoolName, usableW), M, y, usableW);
      y += 18;
      doc
        .font('BodyBold')
        .fontSize(11.5)
        .fillColor(d.draft ? '#B91C1C' : '#111827');
      line(fit(docTitle(d), usableW), M, y, usableW);
      y += 16;
      doc.font('Body').fontSize(8).fillColor('#374151');
      line(fit(infoLine(d, generated), usableW), M, y, usableW);
      y = M + HEADER_H;

      const tableBottom = pageH - M - FOOTER_H;
      const colW = (usableW - LESSON_COL_W) / Math.max(1, d.weekdays.length);
      const rowH = Math.min(MAX_ROW_H, (tableBottom - y - HEAD_ROW_H) / Math.max(1, d.rows));
      const innerW = colW - 2 * PAD;

      // Qatorlarni sig'dirish uchun umumiy shrift o'lchami (butun jadval uchun bir xil)
      const grid = Array.from({ length: d.rows }, (_, ri) =>
        d.weekdays.map((w) => blocksOf(d.cells[cellKey(w, ri + 1)] ?? [])),
      );
      let size = FONT_MAX;
      while (size > FONT_MIN) {
        const ok = grid.every((row) =>
          row.every((blocks) => heightOf(blocks, size, innerW) <= rowH - 2 * PAD),
        );
        if (ok) break;
        size -= 0.5;
      }

      // Sarlavha qatori
      doc.lineWidth(0.5);
      doc.rect(M, y, LESSON_COL_W, HEAD_ROW_H).fillAndStroke('#E5E7EB', '#6B7280');
      d.weekdays.forEach((w, i) => {
        const x = M + LESSON_COL_W + i * colW;
        doc.rect(x, y, colW, HEAD_ROW_H).fillAndStroke('#E5E7EB', '#6B7280');
      });
      doc.font('BodyBold').fontSize(9).fillColor('#111827');
      line('№', M, y + 6, LESSON_COL_W, 'center');
      d.weekdays.forEach((w, i) => {
        line(WEEKDAY_NAMES[w], M + LESSON_COL_W + i * colW, y + 6, colW, 'center');
      });
      y += HEAD_ROW_H;

      // Qatorlar
      grid.forEach((row, ri) => {
        doc.rect(M, y, LESSON_COL_W, rowH).fillAndStroke('#F3F4F6', '#6B7280');
        doc.font('BodyBold').fontSize(10).fillColor('#111827');
        line(String(ri + 1), M, y + rowH / 2 - 5, LESSON_COL_W, 'center');
        row.forEach((blocks, ci) => {
          const x = M + LESSON_COL_W + ci * colW;
          doc.rect(x, y, colW, rowH).lineWidth(0.5).stroke('#6B7280');
          if (!blocks.length) return;
          const h = heightOf(blocks, size, innerW);
          let ty = y + Math.max(PAD, (rowH - h) / 2);
          for (const b of blocks) {
            doc
              .font(b.bold ? 'BodyBold' : 'Body')
              .fontSize(size)
              .fillColor(b.grey ? '#4B5563' : '#111827');
            if (!b.text) {
              ty += size * 0.6;
              continue;
            }
            const bh = doc.heightOfString(b.text, { width: innerW, lineGap: 0.5 });
            // height: katakdan chiqib ketmasin (sig'masa qirqiladi, yangi sahifa ochilmaydi)
            doc.text(b.text, x + PAD, ty, {
              width: innerW,
              align: 'center',
              lineGap: 0.5,
              height: Math.max(size, y + rowH - PAD - ty),
              ellipsis: true,
            });
            ty += bh;
          }
        });
        y += rowH;
      });
    });

    // Sahifa raqamlari. Pastki chegara ichiga yozilsa pdfkit bo'sh sahifa ochadi: vaqtincha 0
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Body').fontSize(7.5).fillColor('#6B7280');
      doc.text(`${i + 1} / ${range.count}`, M, pageH - M + 2, {
        width: usableW,
        align: 'right',
        lineBreak: false,
      });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
