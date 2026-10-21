import ExcelJS from 'exceljs';
import { fmtDateTime, fmtPeriod, toExcelDate } from './reports.labels';
import type { Column, ReportLayout, Table } from './reports.layout';

/** Excel formula injeksiyasidan himoya: =, +, -, @ (va tab/CR) bilan boshlanuvchi matn apostrof bilan yoziladi */
export function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function cellValue(col: Column, v: unknown): string | number | Date | null {
  if (v === null || v === undefined) return null;
  // Sana ustuni: haqiqiy Excel sana qiymati (dd.mm.yyyy formatida ko'rsatiladi)
  if (col.type === 'date') {
    const d = toExcelDate(v);
    if (d) return d;
  }
  if (typeof v === 'boolean') return v ? 'Ha' : "Yo'q";
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return safeText(String(v));
}

const sheetName = (raw: string, used: Set<string>): string => {
  const base =
    raw
      .replace(/[\\/*?:[\]]/g, ' ')
      .trim()
      .slice(0, 31) || 'Varaq';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
};

const THIN = { style: 'thin', color: { argb: 'FFD1D5DB' } } as const;

function writeTable(ws: ExcelJS.Worksheet, table: Table, startRow: number): number {
  table.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = Math.max(
      ws.getColumn(i + 1).width ?? 0,
      c.width,
      c.header.length + 2,
    );
  });
  const header = ws.getRow(startRow);
  table.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = safeText(c.header);
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  });
  header.height = 30;

  table.rows.forEach((row, r) => {
    const xr = ws.getRow(startRow + 1 + r);
    table.columns.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      cell.value = cellValue(c, row[c.key]);
      if (c.type === 'number' || c.type === 'percent') cell.numFmt = '0.00';
      else if (c.type === 'int') cell.numFmt = '0';
      else if (c.type === 'date') cell.numFmt = 'dd.mm.yyyy';
      cell.alignment = {
        vertical: 'middle',
        horizontal:
          c.align ?? (c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left'),
        wrapText: true,
      };
      cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    });
  });
  const last = startRow + table.rows.length;
  if (table.rows.length) {
    ws.autoFilter = {
      from: { row: startRow, column: 1 },
      to: { row: last, column: table.columns.length },
    };
  }
  return last;
}

/** Hisobotni .xlsx ga aylantiradi (formulasiz; matn/raqam/sana qiymatlar) */
export async function renderExcel(layout: ReportLayout): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yuksalish reyting tizimi';
  wb.created = new Date(layout.meta.generatedAt);
  const used = new Set<string>();

  // 1-varaq: sarlavha bloki + ko'rsatkichlar + asosiy jadval
  const first = layout.tables[0];
  const ws = wb.addWorksheet(sheetName(first?.title ?? 'Hisobot', used));
  let row = 1;
  const put = (a: string, b?: string | number | null, bold = false) => {
    const r = ws.getRow(row++);
    r.getCell(1).value = safeText(a);
    r.getCell(1).font = { bold: true, size: row === 2 ? 14 : 11 };
    if (b !== undefined && b !== null) {
      r.getCell(2).value = typeof b === 'number' ? b : safeText(String(b));
      r.getCell(2).font = { bold };
      r.getCell(2).alignment = { horizontal: 'left' };
    }
  };
  put(layout.title);
  put('Maktab:', layout.meta.school?.name ?? 'Barcha maktablar');
  put('Davr:', fmtPeriod(layout.meta.period));
  put('Yaratilgan:', `${fmtDateTime(layout.meta.generatedAt)} (Asia/Tashkent)`);
  row++;
  for (const k of layout.kpis) {
    const v = k.value;
    put(`${k.label}:`, v === null || v === undefined ? '—' : v, true);
  }
  if (layout.kpis.length) row++;

  const headerRow = row;
  if (first) {
    row = writeTable(ws, first, headerRow) + 1;
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    if (first.legend) {
      ws.getRow(row + 1).getCell(1).value = safeText(first.legend);
      ws.getRow(row + 1).getCell(1).font = { italic: true, color: { argb: 'FF6B7280' } };
    }
  }

  // Qolgan jadvallar — alohida varaqlarda (1-qatorda sarlavha, muzlatilgan)
  for (const t of layout.tables.slice(1)) {
    const sh = wb.addWorksheet(sheetName(t.title, used));
    writeTable(sh, t, 1);
    sh.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
