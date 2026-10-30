import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { fmtDate, fmtDateTime, fmtPeriod } from './reports.labels';
import type { Column, ReportLayout, Table } from './reports.layout';
import { fitLogo } from '../branding/branding.doc';

// ---- Shrift: DejaVu Sans (Unicode: o'zbek lotin/ʻ ʼ + kirill), assets/fonts da ----
function findFontsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'assets', 'fonts');
    if (fs.existsSync(path.join(candidate, 'DejaVuSans.ttf'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('PDF shriftlari topilmadi (assets/fonts/DejaVuSans.ttf)');
}

const FONT = 'Body';
const FONT_BOLD = 'BodyBold';
const M = 36; // sahifa chekkasi
const FOOT = 26; // pastki kolontitul uchun joy
const LINE = 10.5;
const PAD = 4;
const BODY_SIZE = 8;
const SWATCH = 10;
/** Ustun kengligiga qo'shiladigan kichik zaxira (o'lchov xatosi uchun) */
const SLACK = 1.5;

export function createDoc(
  opts: ConstructorParameters<typeof PDFDocument>[0] = {},
): PDFKit.PDFDocument {
  const fonts = findFontsDir();
  const doc = new PDFDocument(opts);
  doc.registerFont(FONT, path.join(fonts, 'DejaVuSans.ttf'));
  doc.registerFont(FONT_BOLD, path.join(fonts, 'DejaVuSans-Bold.ttf'));
  return doc;
}

export const fmtCell = (c: Column, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Ha' : "Yo'q";
  if (c.type === 'date' && typeof v === 'string') return fmtDate(v);
  if (typeof v === 'number') return c.type === 'int' ? String(Math.round(v)) : v.toFixed(2);
  return String(v);
};

/** Matnni kenglikka sig'dirib qatorlarga bo'ladi; faqat BO'SH JOYda uziladi (kengligidan uzun so'z harflab bo'linadi) */
function wrap(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (doc.widthOfString(w) > width) {
        let cut = w.length - 1;
        while (cut > 1 && doc.widthOfString(w.slice(0, cut)) > width) cut--;
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const trial = line ? `${line} ${w}` : w;
      if (doc.widthOfString(trial) <= width) line = trial;
      else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

/** Matnni kenglik ichida tekislab yozadi; pdfkit ning o'z o'rashiga (chegaradagi qiymatni defis joyida bo'lib yuborishiga) yo'l qo'ymaydi */
function putText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  w: number,
  align: 'left' | 'center' | 'right',
) {
  const tw = doc.widthOfString(text);
  const dx = align === 'right' ? w - tw : align === 'center' ? (w - tw) / 2 : 0;
  doc.text(text, x + Math.max(0, dx), y, { lineBreak: false });
}

const widthOf = (doc: PDFKit.PDFDocument, text: string, font: string, size: number) => {
  doc.font(font).fontSize(size);
  return doc.widthOfString(text);
};

const longestWord = (doc: PDFKit.PDFDocument, text: string, font: string, size: number) =>
  Math.max(
    0,
    ...text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => widthOf(doc, w, font, size)),
  );

export interface ColumnPlan {
  widths: number[];
  /** PDFda ishlatiladigan sarlavhalar (qisqartma bo'lishi mumkin) */
  headers: string[];
  headerSize: number;
  usedShort: boolean;
}

/**
 * Ustun kengliklarini sarlavha va qiymat o'lchamiga qarab taqsimlaydi.
 * Qoida: sarlavha so'zi HECH QACHON harf o'rtasidan bo'linmaydi — har bir ustun eng uzun sarlavha so'zidan
 * keng bo'ladi. Sig'masa shrift kichraytiriladi (8 -> 7), so'ng qisqartma (`short`) ishlatiladi.
 */
export function planColumns(doc: PDFKit.PDFDocument, table: Table, width: number): ColumnPlan {
  const cols = table.columns;
  const swatchCol = table.colorColumn ? cols.findIndex((c) => c.key === table.colorColumn) : -1;
  const extra = (i: number) => 2 * PAD + SLACK + (i === swatchCol ? SWATCH : 0);
  const cells = cols.map((c) => table.rows.slice(0, 500).map((r) => fmtCell(c, r[c.key])));
  // Qiymatdagi eng uzun so'z (juda uzunlari harflab bo'linadi, shuning uchun chegaralanadi)
  const dataWord = cols.map((_, i) =>
    Math.min(70, Math.max(0, ...cells[i].map((t) => longestWord(doc, t, FONT, BODY_SIZE)))),
  );
  const dataLine = cols.map((_, i) =>
    Math.min(220, Math.max(0, ...cells[i].map((t) => widthOf(doc, t, FONT, BODY_SIZE)))),
  );

  const attempts = [
    { size: 8, short: false },
    { size: 7.5, short: false },
    { size: 7, short: false },
    { size: 7, short: true },
    { size: 6.5, short: true },
  ];
  let chosen = attempts[attempts.length - 1];
  let mins: number[] = [];
  let headers: string[] = [];
  for (const a of attempts) {
    headers = cols.map((c) => (a.short && c.short ? c.short : c.header));
    mins = cols.map(
      (_, i) => Math.max(longestWord(doc, headers[i], FONT_BOLD, a.size), dataWord[i]) + extra(i),
    );
    chosen = a;
    if (mins.reduce((s, x) => s + x, 0) <= width) break;
  }
  const usedShort = chosen.short && cols.some((c) => c.short);

  const prefs = cols.map((_, i) =>
    Math.max(
      mins[i],
      Math.max(widthOf(doc, headers[i], FONT_BOLD, chosen.size), dataLine[i]) + extra(i),
    ),
  );
  const sumMin = mins.reduce((s, x) => s + x, 0);
  let widths: number[];
  if (sumMin >= width) {
    // Eng tor holat: proporsional kichraytiriladi (qisqartmalardan keyin bu amalda uchramaydi)
    widths = mins.map((m) => (m / sumMin) * width);
  } else {
    const spare = width - sumMin;
    const wants = prefs.map((p, i) => p - mins[i]);
    const sumWant = wants.reduce((s, x) => s + x, 0);
    if (sumWant <= spare) {
      // Hamma xohlagan kenglikka ega; ortig'i ustun og'irliklariga (col.width) ko'ra
      const rest = spare - sumWant;
      const sumW = cols.reduce((s, c) => s + c.width, 0);
      widths = prefs.map((p, i) => p + (rest * cols[i].width) / sumW);
    } else {
      widths = mins.map((m, i) => m + (spare * wants[i]) / sumWant);
    }
  }
  return { widths, headers, headerSize: chosen.size, usedShort };
}

function drawChart(
  doc: PDFKit.PDFDocument,
  chart: NonNullable<ReportLayout['chart']>,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  doc
    .font(FONT_BOLD)
    .fontSize(10)
    .fillColor('#111827')
    .text(chart.title, x, y, { lineBreak: false });
  const top = y + 16;
  const pw = w - 40;
  const ph = h - 36;
  const px = x + 34;
  const vals = chart.points.map((p) => p.value);
  const yMin = chart.yMin ?? Math.min(...vals);
  const yMax = chart.yMax ?? Math.max(...vals);
  const span = yMax - yMin || 1;

  doc.lineWidth(0.5).strokeColor('#9CA3AF');
  doc.rect(px, top, pw, ph).stroke();
  doc.font(FONT).fontSize(7).fillColor('#6B7280');
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (span * i) / 4;
    const gy = top + ph - (ph * i) / 4;
    doc
      .strokeColor('#E5E7EB')
      .moveTo(px, gy)
      .lineTo(px + pw, gy)
      .stroke();
    doc
      .fillColor('#6B7280')
      .text(v.toFixed(0), x, gy - 3, { width: 30, align: 'right', lineBreak: false });
  }
  const n = chart.points.length;
  const pt = (i: number) => ({
    x: px + (n === 1 ? pw / 2 : (pw * i) / (n - 1)),
    y: top + ph - (ph * (chart.points[i].value - yMin)) / span,
  });
  doc.lineWidth(1.4).strokeColor('#2563EB');
  chart.points.forEach((_, i) => {
    const p = pt(i);
    if (i === 0) doc.moveTo(p.x, p.y);
    else doc.lineTo(p.x, p.y);
  });
  doc.stroke();
  doc.fillColor('#2563EB');
  chart.points.forEach((_, i) => {
    const p = pt(i);
    doc.circle(p.x, p.y, 1.8).fill();
  });
  // Gorizontal belgilar: yorliqlar bir-biriga tegmasligi uchun qadam o'lchamga qarab tanlanadi
  doc.font(FONT).fontSize(7);
  const labelW = Math.max(...chart.points.map((p) => doc.widthOfString(p.label))) + 6;
  const step = Math.max(1, Math.ceil((labelW * n) / pw));
  doc.fillColor('#6B7280');
  for (let i = 0; i < n; i += step) {
    const p = pt(i);
    doc.text(chart.points[i].label, p.x - labelW / 2, top + ph + 3, {
      width: labelW,
      align: 'center',
      lineBreak: false,
    });
  }
}

/** Hisobotni A4 PDF ga aylantiradi (Unicode shrift, sahifalarga bo'lingan jadvallar, kolontitul) */
export function renderPdf(layout: ReportLayout, logo?: Buffer | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = createDoc({
      size: 'A4',
      layout: layout.orientation,
      margin: M,
      bufferPages: true,
      info: {
        Title: layout.title,
        Author: 'Yuksalish reyting tizimi',
        Creator: 'Yuksalish reyting tizimi',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const left = M;
      const width = doc.page.width - M * 2;
      const bottom = () => doc.page.height - M - FOOT;
      let y = M;

      // ---- Logo (chap yuqori) va sarlavha ----
      const logoBox = fitLogo(logo, 34, 90);
      if (logoBox)
        doc.image(logoBox.buffer, left, y, { width: logoBox.width, height: logoBox.height });
      const tx = logoBox ? left + logoBox.width + 8 : left;
      const tw = width - (tx - left);
      doc.font(FONT_BOLD).fontSize(16).fillColor('#111827');
      for (const line of wrap(doc, layout.title, tw)) {
        doc.text(line, tx, y, { lineBreak: false });
        y += 20;
      }
      doc.font(FONT).fontSize(9).fillColor('#374151');
      const info = [
        `Maktab: ${layout.meta.school?.name ?? 'Barcha maktablar'}`,
        `Davr: ${fmtPeriod(layout.meta.period)}`,
        `Yaratilgan: ${fmtDateTime(layout.meta.generatedAt)} (Asia/Tashkent)`,
      ];
      for (const t of info) {
        for (const ln of wrap(doc, t, tw)) {
          doc.text(ln, tx, y, { lineBreak: false });
          y += 12;
        }
      }
      y += 6;

      // ---- Ko'rsatkichlar bloki ----
      if (layout.kpis.length) {
        const perRow = layout.orientation === 'landscape' ? 4 : 3;
        const gap = 8;
        const bw = (width - gap * (perRow - 1)) / perRow;
        const inner = bw - 12;
        const bh = 40;
        layout.kpis.forEach((k, i) => {
          const col = i % perRow;
          if (col === 0 && i > 0) y += bh + gap;
          if (col === 0 && y + bh > bottom()) {
            doc.addPage();
            y = M;
          }
          const bx = left + col * (bw + gap);
          doc.roundedRect(bx, y, bw, bh, 4).fillAndStroke('#F3F4F6', '#E5E7EB');
          // Yorliq: kerak bo'lsa kichraytirilib 2 qatorgacha, qiymat: sig'ishi uchun shrift kichraytiriladi
          let ls = 7.5;
          doc.font(FONT).fontSize(ls);
          while (
            ls > 6 &&
            wrap(doc, k.label, inner).length > 1 &&
            doc.widthOfString(k.label) > inner
          ) {
            ls -= 0.5;
            doc.fontSize(ls);
          }
          const labelLines = wrap(doc, k.label, inner).slice(0, 2);
          doc.fillColor('#6B7280');
          labelLines.forEach((ln, idx) =>
            doc.text(ln, bx + 6, y + 4 + idx * 8.5, { lineBreak: false }),
          );
          const val = String(k.value ?? '—');
          let vs = 11;
          while (vs > 7 && widthOf(doc, val, FONT_BOLD, vs) > inner) vs -= 0.5;
          doc.font(FONT_BOLD).fontSize(vs).fillColor('#111827');
          const valLine = wrap(doc, val, inner)[0];
          doc.text(valLine, bx + 6, y + (labelLines.length > 1 ? 24 : 18), { lineBreak: false });
        });
        y += bh + 14;
      }

      // ---- Grafik ----
      if (layout.chart && layout.chart.points.length >= 2) {
        const h = 150;
        if (y + h > bottom()) {
          doc.addPage();
          y = M;
        }
        drawChart(doc, layout.chart, left, y, width, h);
        y += h + 12;
      }

      // ---- Jadvallar ----
      for (const table of layout.tables) {
        if (table.rows.length === 0 && layout.tables.length > 1) continue;
        y = drawTable(doc, table, left, width, y, bottom);
        y += 14;
      }

      // ---- Pastki kolontitul ----
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const oldBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // kolontitul yangi sahifa ochmasin
        const fy = doc.page.height - M - 8;
        doc
          .lineWidth(0.5)
          .strokeColor('#D1D5DB')
          .moveTo(left, fy - 6)
          .lineTo(left + width, fy - 6)
          .stroke();
        doc.font(FONT).fontSize(8).fillColor('#6B7280');
        doc.text('Yuksalish reyting tizimi', left, fy, { lineBreak: false });
        doc.text(`Sahifa ${i + 1} / ${range.count}`, left, fy, {
          width,
          align: 'right',
          lineBreak: false,
        });
        doc.page.margins.bottom = oldBottom;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function drawTable(
  doc: PDFKit.PDFDocument,
  table: Table,
  left: number,
  width: number,
  startY: number,
  bottom: () => number,
): number {
  const plan = planColumns(doc, table, width);
  const colW = plan.widths;
  const swatchCol = table.colorColumn
    ? table.columns.findIndex((c) => c.key === table.colorColumn)
    : -1;
  let y = startY;

  const title = (suffix = '') => {
    doc
      .font(FONT_BOLD)
      .fontSize(11)
      .fillColor('#111827')
      .text(`${table.title}${suffix}`, left, y, { lineBreak: false });
    y += 18;
  };
  const header = () => {
    doc.font(FONT_BOLD).fontSize(plan.headerSize);
    const lines = plan.headers.map((h, i) => wrap(doc, h, colW[i] - PAD * 2));
    const h = Math.max(...lines.map((l) => l.length)) * LINE + 8;
    doc.rect(left, y, width, h).fillAndStroke('#E5E7EB', '#D1D5DB');
    let x = left;
    lines.forEach((ls, i) => {
      doc.fillColor('#111827');
      ls.forEach((ln, k) =>
        putText(doc, ln, x + PAD, y + 4 + k * LINE, colW[i] - PAD * 2, 'center'),
      );
      x += colW[i];
    });
    y += h;
  };

  // Sarlavha + jadval sarlavhasi bitta sahifada qolishi uchun kamida 2 qator joy kerak
  if (y + 18 + 30 + 20 > bottom()) {
    doc.addPage();
    y = M;
  }
  title();
  header();

  table.rows.forEach((row, ri) => {
    doc.font(FONT).fontSize(BODY_SIZE);
    const cells = table.columns.map((c, i) => {
      const avail = colW[i] - PAD * 2 - (i === swatchCol ? SWATCH : 0);
      return wrap(doc, fmtCell(c, row[c.key]), avail);
    });
    const h = Math.max(16, Math.max(...cells.map((l) => l.length)) * LINE + 6);
    if (y + h > bottom()) {
      doc.addPage();
      y = M;
      title(' (davomi)');
      header();
    }
    doc.font(FONT).fontSize(BODY_SIZE);
    if (ri % 2 === 1) doc.rect(left, y, width, h).fill('#F9FAFB');
    doc
      .lineWidth(0.4)
      .strokeColor('#E5E7EB')
      .moveTo(left, y + h)
      .lineTo(left + width, y + h)
      .stroke();
    let x = left;
    cells.forEach((ls, i) => {
      const c = table.columns[i];
      const hasSwatch =
        i === swatchCol && table.colorKey && typeof row[table.colorKey] === 'string';
      if (hasSwatch)
        doc.circle(x + PAD + 3, y + 8, 3).fill(row[table.colorKey as string] as string);
      const inset = hasSwatch ? SWATCH : 0;
      const align =
        c.align ?? (c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left');
      doc.fillColor('#111827');
      ls.forEach((ln, k) =>
        putText(doc, ln, x + PAD + inset, y + 3 + k * LINE, colW[i] - PAD * 2 - inset, align),
      );
      x += colW[i];
    });
    y += h;
  });
  if (table.rows.length === 0) {
    doc
      .font(FONT)
      .fontSize(BODY_SIZE)
      .fillColor('#6B7280')
      .text("Ma'lumot yo'q", left + PAD, y + 4, { lineBreak: false });
    y += 18;
  }
  // Qisqartmalar / ustunlar izohi
  const abbr = plan.usedShort
    ? table.columns
        .filter((c, i) => c.short && plan.headers[i] === c.short)
        .map((c) => `${c.short} — ${c.header.toLowerCase()}`)
        .join(', ')
    : '';
  const legend = [table.legend, abbr ? `${abbr}.` : ''].filter(Boolean).join(' ');
  if (legend) {
    doc.font(FONT).fontSize(7).fillColor('#6B7280');
    y += 5;
    for (const ln of wrap(doc, legend, width)) {
      if (y + 10 > bottom()) {
        doc.addPage();
        y = M;
      }
      doc.text(ln, left, y, { lineBreak: false });
      y += 9;
    }
  }
  return y;
}
