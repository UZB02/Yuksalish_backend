import ExcelJS from 'exceljs';
import { fmtDate, fmtDateTime, fmtPeriod } from '../reports/reports.labels';
import { safeText } from '../reports/reports.excel';
import { createDoc } from '../reports/reports.pdf';
import type { JournalColumn, JournalGrid } from './journal.types';

export const WEEKDAY_SHORT = ['', 'Du', 'Se', 'Cho', 'Pa', 'Ju', 'Sha', 'Ya'];
const MONTHS = [
  'Yanvar',
  'Fevral',
  'Mart',
  'Aprel',
  'May',
  'Iyun',
  'Iyul',
  'Avgust',
  'Sentabr',
  'Oktabr',
  'Noyabr',
  'Dekabr',
];
export const monthLabel = (date: string) =>
  `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const dayNum = (date: string) => Number(date.slice(8, 10));

/** Baho ranglari (ARGB, Excel) va (HEX, PDF) */
const GRADE_FILL: Record<number, { argb: string; hex: string }> = {
  5: { argb: 'FFBBF7D0', hex: '#BBF7D0' },
  4: { argb: 'FFBFDBFE', hex: '#BFDBFE' },
  3: { argb: 'FFFDE68A', hex: '#FDE68A' },
  2: { argb: 'FFFECACA', hex: '#FECACA' },
};
const LOW_AVG = 3;

/** Dars ustuni belgisi: "3-d" (ish kuni ustuni uchun hafta kuni) */
export const lessonLabel = (c: Pick<JournalColumn, 'lessonNo' | 'weekday'>) =>
  c.lessonNo > 0 ? `${c.lessonNo}-d` : WEEKDAY_SHORT[c.weekday];

const CANCELLED_ARGB = 'FFE5E7EB';
const CANCELLED_HEX = '#E5E7EB';

/** Ustunlar oy bo'yicha guruhlanadi */
export function groupByMonth(cols: JournalGrid['columns']) {
  const groups: { label: string; columns: JournalGrid['columns'] }[] = [];
  for (const d of cols) {
    const label = monthLabel(d.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.columns.push(d);
    else groups.push({ label, columns: [d] });
  }
  return groups;
}

const fmtAvg = (v: number | null, digits = 1) => (v === null ? '' : v.toFixed(digits));
const THIN = { style: 'thin', color: { argb: 'FFD1D5DB' } } as const;
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

export async function renderJournalExcel(g: JournalGrid): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yuksalish reyting tizimi';
  wb.created = new Date();
  const ws = wb.addWorksheet(
    safeText(`${g.class.name} ${g.subject.name}`)
      .replace(/[\\/*?:[\]]/g, ' ')
      .slice(0, 31),
  );

  const nDays = g.columns.length;
  const firstDay = 3;
  const sumCol = firstDay + nDays; // O'rtacha
  const lastCol = sumCol + 3;

  const info: [string, string][] = [
    ['Sinf jurnali', ''],
    ['Maktab:', g.school.name],
    ['Sinf:', g.class.name],
    ['Fan:', g.subject.name],
    ["O'qituvchi:", g.teacher?.fullName ?? '—'],
    ['Davr:', fmtPeriod({ from: g.from, to: g.to })],
    ['Yaratilgan:', `${fmtDateTime(new Date().toISOString())} (Asia/Tashkent)`],
  ];
  info.forEach(([a, b], i) => {
    const r = ws.getRow(i + 1);
    r.getCell(1).value = safeText(a);
    r.getCell(1).font = { bold: true, size: i === 0 ? 14 : 11 };
    if (b) {
      r.getCell(3).value = safeText(b);
      r.getCell(3).alignment = { horizontal: 'left' };
    }
  });

  const hMonth = info.length + 2;
  const hDay = hMonth + 1;
  const hWeek = hMonth + 2;
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } as const;
  const head = (row: number, col: number, value: string | number) => {
    const c = ws.getRow(row).getCell(col);
    c.value = value;
    c.font = { bold: true };
    c.fill = headFill;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
  };

  const fixed: [number, string][] = [
    [1, '№'],
    [2, 'F.I.Sh.'],
    [sumCol, "O'rtacha"],
    [sumCol + 1, 'Baholar soni'],
    [sumCol + 2, 'Qoldirgan (N)'],
    [sumCol + 3, 'Qoldirgan (B)'],
  ];
  for (const [col, text] of fixed) {
    for (const r of [hMonth, hDay, hWeek]) head(r, col, r === hMonth ? text : '');
    ws.mergeCells(hMonth, col, hWeek, col);
  }

  let col = firstDay;
  for (const grp of groupByMonth(g.columns)) {
    for (let i = 0; i < grp.columns.length; i++) head(hMonth, col + i, i === 0 ? grp.label : '');
    if (grp.columns.length > 1) ws.mergeCells(hMonth, col, hMonth, col + grp.columns.length - 1);
    grp.columns.forEach((d, i) => {
      head(hDay, col + i, dayNum(d.date));
      head(hWeek, col + i, lessonLabel(d));
      if (d.cancelled) {
        for (const r of [hDay, hWeek]) {
          ws.getRow(r).getCell(col + i).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: CANCELLED_ARGB },
          };
        }
      }
    });
    col += grp.columns.length;
  }

  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 32;
  for (let i = 0; i < nDays; i++) ws.getColumn(firstDay + i).width = 5;
  for (let i = 0; i < 4; i++) ws.getColumn(sumCol + i).width = 11;

  const center = { vertical: 'middle', horizontal: 'center' } as const;
  g.students.forEach((s, idx) => {
    const r = ws.getRow(hWeek + 1 + idx);
    r.getCell(1).value = idx + 1;
    r.getCell(2).value = safeText(
      s.transferred ? `${s.fullName} (boshqa sinfga o'tgan)` : s.fullName,
    );
    if (s.transferred) r.getCell(2).font = { italic: true, color: { argb: 'FF6B7280' } };
    for (const c of [1, 2]) {
      r.getCell(c).border = BORDER;
      r.getCell(c).alignment = { vertical: 'middle', horizontal: c === 1 ? 'center' : 'left' };
    }
    g.columns.forEach((d, i) => {
      const cell = g.cells[s.id]?.[d.key];
      const x = r.getCell(firstDay + i);
      x.border = BORDER;
      x.alignment = center;
      if (d.cancelled) {
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CANCELLED_ARGB } };
      }
      if (!cell) return;
      if (cell.grade !== undefined) {
        x.value = cell.grade;
        x.font = { bold: true };
        x.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: GRADE_FILL[cell.grade].argb },
        };
      } else if (cell.absence === 'N' || cell.absence === 'B') {
        x.value = cell.absence;
        x.font = { bold: true, color: { argb: cell.absence === 'N' ? 'FFB91C1C' : 'FF6B7280' } };
      }
    });
    const sm = g.summary.perStudent[s.id];
    const vals: (number | null)[] = [sm.avg, sm.count, sm.absentN, sm.absentB];
    vals.forEach((v, i) => {
      const x = r.getCell(sumCol + i);
      x.value = v;
      x.border = BORDER;
      x.alignment = center;
      if (i === 0) {
        x.numFmt = '0.0';
        x.font = { bold: true };
        if (v !== null && v < LOW_AVG) {
          x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } };
        }
      }
    });
  });

  // Pastki qatorlar: sana bo'yicha o'rtacha va baholar soni
  const base = hWeek + 1 + g.students.length;
  const foot = (
    rowNo: number,
    label: string,
    pick: (date: string) => number | null,
    total: number | null,
    fmt: string,
  ) => {
    const r = ws.getRow(rowNo);
    r.getCell(2).value = label;
    r.getCell(2).font = { bold: true };
    g.columns.forEach((d, i) => {
      const x = r.getCell(firstDay + i);
      x.value = pick(d.key);
      x.numFmt = fmt;
      x.alignment = center;
      x.font = { size: 9 };
    });
    const t = r.getCell(sumCol);
    t.value = total;
    t.numFmt = fmt;
    t.font = { bold: true };
    t.alignment = center;
    for (let c = 1; c <= lastCol; c++) {
      r.getCell(c).border = BORDER;
      r.getCell(c).fill = headFill;
    }
  };
  foot(base, "Sinf o'rtachasi", (d) => g.summary.perColumn[d].avg, g.summary.classAvg, '0.0');
  foot(base + 1, 'Baholar soni', (d) => g.summary.perColumn[d].count, g.summary.classCount, '0');

  const note = ws.getRow(base + 3).getCell(1);
  note.value =
    '5 — a’lo, 4 — yaxshi, 3 — qoniqarli, 2 — qoniqarsiz; N — sababsiz yo‘q, B — sababli yo‘q';
  note.font = { italic: true, color: { argb: 'FF6B7280' } };

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: hWeek }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------- PDF ----------------

const M = 30;
const NUM_W = 20;
const NAME_W = 150;
const DAY_W = 20;
const SUM_W = 34;
const ROW_H = 16;
const HEAD_H = [14, 13, 13];
const FOOT_H = 14;
const MAX_DAYS_PER_PAGE = 23;

export interface Chunk {
  label: string;
  columns: JournalGrid['columns'];
}

/**
 * Oy bo'yicha, sahifaga sig'masa teng bo'laklarga (26 kun -> 13+13, 23+3 emas:
 * deyarli bo'sh sahifa chiqmasin).
 */
export function chunkDates(g: Pick<JournalGrid, 'columns'>): Chunk[] {
  const out: Chunk[] = [];
  for (const grp of groupByMonth(g.columns)) {
    const parts = Math.max(1, Math.ceil(grp.columns.length / MAX_DAYS_PER_PAGE));
    const size = Math.ceil(grp.columns.length / parts);
    for (let i = 0; i < grp.columns.length; i += size) {
      out.push({ label: grp.label, columns: grp.columns.slice(i, i + size) });
    }
  }
  return out;
}

export function renderJournalPdf(g: JournalGrid): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = createDoc({
      size: 'A4',
      layout: 'landscape',
      margin: M,
      bufferPages: true,
      info: {
        Title: `Sinf jurnali — ${g.class.name}, ${g.subject.name}`,
        Author: 'Yuksalish reyting tizimi',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageH = doc.page.height;
    const bottom = pageH - M - 18;
    const parts = chunkDates(g);
    const list = parts.length ? parts : [{ label: '', columns: [] as JournalGrid['columns'] }];

    const txt = (
      t: string,
      x: number,
      y: number,
      w: number,
      align: 'left' | 'center' | 'right' = 'center',
    ) => {
      doc.text(t, x, y, { width: w, align, lineBreak: false, height: 12 });
    };
    const box = (x: number, y: number, w: number, h: number, fill?: string) => {
      doc.rect(x, y, w, h);
      if (fill) doc.fillAndStroke(fill, '#9CA3AF');
      else doc.lineWidth(0.4).stroke('#9CA3AF');
    };

    list.forEach((part, pi) => {
      const lastPart = pi === list.length - 1;
      let y = 0;
      const header = (first: boolean) => {
        if (!first) doc.addPage();
        y = M;
        doc.font('BodyBold').fontSize(12).fillColor('#111827');
        doc.text(`Sinf jurnali — ${g.class.name}, ${g.subject.name}`, M, y, { lineBreak: false });
        y += 17;
        doc.font('Body').fontSize(8).fillColor('#374151');
        doc.text(
          `Maktab: ${g.school.name}   O'qituvchi: ${g.teacher?.fullName ?? '—'}   Davr: ${fmtPeriod({ from: g.from, to: g.to })}`,
          M,
          y,
          { lineBreak: false },
        );
        y += 14;
        // jadval sarlavhasi
        const x0 = M;
        const dx = x0 + NUM_W + NAME_W;
        const dw = part.columns.length * DAY_W;
        doc.font('BodyBold').fontSize(7).fillColor('#111827');
        box(x0, y, NUM_W, HEAD_H[0] + HEAD_H[1] + HEAD_H[2], '#E5E7EB');
        box(x0 + NUM_W, y, NAME_W, HEAD_H[0] + HEAD_H[1] + HEAD_H[2], '#E5E7EB');
        doc.fillColor('#111827');
        txt('№', x0, y + 16, NUM_W);
        txt('F.I.Sh.', x0 + NUM_W, y + 16, NAME_W);
        box(dx, y, dw, HEAD_H[0], '#E5E7EB');
        doc.fillColor('#111827');
        txt(part.label, dx, y + 3, dw);
        part.columns.forEach((d, i) => {
          const cx = dx + i * DAY_W;
          const hf = d.cancelled ? CANCELLED_HEX : '#E5E7EB';
          box(cx, y + HEAD_H[0], DAY_W, HEAD_H[1], hf);
          box(cx, y + HEAD_H[0] + HEAD_H[1], DAY_W, HEAD_H[2], hf);
          doc.fillColor('#111827');
          txt(String(dayNum(d.date)), cx, y + HEAD_H[0] + 2, DAY_W);
          doc.font('Body').fontSize(6);
          txt(lessonLabel(d), cx, y + HEAD_H[0] + HEAD_H[1] + 3, DAY_W);
          doc.font('BodyBold').fontSize(7);
        });
        if (lastPart) {
          const labels = ["O'rtacha", 'Baho soni', 'N', 'B'];
          labels.forEach((l, i) => {
            const cx = dx + dw + i * SUM_W;
            box(cx, y, SUM_W, HEAD_H[0] + HEAD_H[1] + HEAD_H[2], '#E5E7EB');
            doc.fillColor('#111827').fontSize(6.5);
            txt(l, cx, y + 16, SUM_W);
          });
        }
        y += HEAD_H[0] + HEAD_H[1] + HEAD_H[2];
      };
      header(pi === 0);

      g.students.forEach((s, idx) => {
        if (y + ROW_H > bottom - 2 * FOOT_H) header(false);
        const x0 = M;
        const dx = x0 + NUM_W + NAME_W;
        box(x0, y, NUM_W, ROW_H);
        box(x0 + NUM_W, y, NAME_W, ROW_H);
        doc.font('Body').fontSize(7).fillColor('#111827');
        txt(String(idx + 1), x0, y + 4.5, NUM_W);
        doc.fillColor(s.transferred ? '#6B7280' : '#111827');
        doc.fontSize(7.5);
        let name = s.transferred ? `${s.fullName} (boshqa sinfga o'tgan)` : s.fullName;
        while (name.length > 3 && doc.widthOfString(name) > NAME_W - 6)
          name = `${name.slice(0, -2)}…`;
        txt(name, x0 + NUM_W + 3, y + 4.5, NAME_W - 4, 'left');
        part.columns.forEach((d, i) => {
          const cx = dx + i * DAY_W;
          const c = g.cells[s.id]?.[d.key];
          if (c?.grade !== undefined) box(cx, y, DAY_W, ROW_H, GRADE_FILL[c.grade].hex);
          else box(cx, y, DAY_W, ROW_H, d.cancelled ? CANCELLED_HEX : undefined);
          if (!c) return;
          if (c.grade !== undefined) {
            doc.font('BodyBold').fontSize(8).fillColor('#111827');
            txt(String(c.grade), cx, y + 4, DAY_W);
            if (c.absence === 'N' || c.absence === 'B') {
              doc.font('Body').fontSize(5).fillColor('#B91C1C');
              txt(c.absence, cx + 1, y + 1, 7, 'left');
            }
          } else if (c.absence === 'N' || c.absence === 'B') {
            doc
              .font('BodyBold')
              .fontSize(8)
              .fillColor(c.absence === 'N' ? '#B91C1C' : '#6B7280');
            txt(c.absence, cx, y + 4, DAY_W);
          }
          if (c.absence === 'partial') {
            doc.circle(cx + DAY_W - 4, y + 4, 1.4).fill('#6B7280');
          }
        });
        if (lastPart) {
          const sm = g.summary.perStudent[s.id];
          const vals = [fmtAvg(sm.avg), String(sm.count), String(sm.absentN), String(sm.absentB)];
          vals.forEach((v, i) => {
            const cx = dx + part.columns.length * DAY_W + i * SUM_W;
            const low = i === 0 && sm.avg !== null && sm.avg < LOW_AVG;
            box(cx, y, SUM_W, ROW_H, low ? '#FECACA' : undefined);
            doc
              .font(i === 0 ? 'BodyBold' : 'Body')
              .fontSize(7.5)
              .fillColor('#111827');
            txt(v, cx, y + 4.5, SUM_W);
          });
        }
        y += ROW_H;
      });

      // Pastki qatorlar
      const rows: [string, (d: string) => string, string][] = [
        [
          "Sinf o'rtachasi",
          (d) => fmtAvg(g.summary.perColumn[d].avg),
          fmtAvg(g.summary.classAvg, 2),
        ],
        ['Baholar soni', (d) => String(g.summary.perColumn[d].count), String(g.summary.classCount)],
      ];
      for (const [label, pick, total] of rows) {
        if (y + FOOT_H > bottom) header(false);
        const x0 = M;
        const dx = x0 + NUM_W + NAME_W;
        box(x0, y, NUM_W + NAME_W, FOOT_H, '#F3F4F6');
        doc.font('BodyBold').fontSize(7).fillColor('#111827');
        txt(label, x0 + NUM_W + 3, y + 4, NAME_W - 4, 'left');
        part.columns.forEach((d, i) => {
          const cx = dx + i * DAY_W;
          box(cx, y, DAY_W, FOOT_H, '#F3F4F6');
          doc.font('Body').fontSize(6).fillColor('#111827');
          txt(pick(d.key), cx, y + 4, DAY_W);
        });
        if (lastPart) {
          const cx = dx + part.columns.length * DAY_W;
          box(cx, y, SUM_W, FOOT_H, '#F3F4F6');
          doc.font('BodyBold').fontSize(7).fillColor('#111827');
          txt(total, cx, y + 4, SUM_W);
        }
        y += FOOT_H;
      }
      doc.font('Body').fontSize(6.5).fillColor('#6B7280');
      doc.text(
        '5 — a’lo, 4 — yaxshi, 3 — qoniqarli, 2 — qoniqarsiz.  N — sababsiz yo‘q, B — sababli yo‘q, nuqta — qisman yo‘q.',
        M,
        Math.min(y + 6, pageH - M - 10),
        { lineBreak: false },
      );
    });

    // Sahifa raqamlari
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Pastki chegara ichiga yozilsa pdfkit yangi (bo'sh) sahifa ochadi: vaqtincha 0
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Body').fontSize(7).fillColor('#6B7280');
      doc.text(
        `${fmtDate(g.from)} — ${fmtDate(g.to)}   |   ${i + 1} / ${range.count}`,
        M,
        pageH - M + 2,
        { width: doc.page.width - 2 * M, align: 'right', lineBreak: false },
      );
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
