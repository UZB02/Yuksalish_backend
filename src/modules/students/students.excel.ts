import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AppError } from '../../core/errors';
import type { ImportRow } from '../../models/ImportSession';
import { buildUtcDate, excelSerialToDate, fmtDate } from '../../utils/dates';
import { cleanText, headerKeyOf } from '../../utils/text';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 1000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export const COLUMNS = {
  fullName: 'F.I.Sh.',
  className: 'Sinf',
  birthDate: "Tug'ilgan sana",
  gender: 'Jinsi',
  studentCode: 'ID',
  parentPhone: 'Ota-ona telefoni',
} as const;
export type ColumnKey = keyof typeof COLUMNS;

// Sarlavha sinonimlari (headerKeyOf natijasi bo'yicha)
const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  fullName: ['fish', 'fio', 'fullname', 'ism', 'ismfamiliya', 'ismfamiliyasharif'],
  className: ['sinf', 'class'],
  birthDate: ['tugilgansana', 'tugilganyil', 'birthdate', 'tugilgan'],
  gender: ['jinsi', 'jins', 'gender'],
  studentCode: ['id', 'idraqami', 'studentcode', 'kod'],
  parentPhone: ['otaonatelefoni', 'telefon', 'parentphone', 'otaonatel'],
};

export type RawCell = string | number | Date | null;
export type RawRow = { row: number; cells: Record<ColumnKey, RawCell> };

const sheetName = "O'quvchilar";

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
}

const GENDER_LABEL = { male: 'Erkak', female: 'Ayol' } as const;

function toDisplayDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = Object.values(COLUMNS).map((h) => ({ header: h, width: h === 'F.I.Sh.' ? 36 : 20 }));
  ws.addRow(['Aliyev Vali Karimovich', '7-A', '15.03.2013', 'Erkak', 'S-1001', '+998901234567']);
  styleHeader(ws);

  const notes = wb.addWorksheet('Izoh');
  notes.getColumn(1).width = 110;
  [
    "1-qatordagi sarlavhalarni o'zgartirmang. Namuna qatorni o'chirib, o'z ma'lumotlaringizni kiriting.",
    'F.I.Sh. — majburiy. Sinf — sinf sahifasidan yuklanganda ixtiyoriy, aks holda majburiy (masalan 7-A).',
    "Tug'ilgan sana — kk.oo.yyyy (masalan 15.03.2013) yoki Excel sana. Jinsi — Erkak yoki Ayol.",
    'ID — maktab ichida takrorlanmas raqam/kod (ixtiyoriy). Ota-ona telefoni — +998901234567 (ixtiyoriy).',
    'Cheklov: faqat .xlsx, 5 MB gacha, 1000 tagacha qator.',
  ].forEach((t) => notes.addRow([t]));
  return toBuffer(wb);
}

export interface ExportStudent {
  fullName: string;
  className: string;
  birthDate: string | null;
  gender: 'male' | 'female' | null;
  studentCode: string | null;
  parentPhone: string | null;
}

export async function buildExport(students: ExportStudent[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = Object.values(COLUMNS).map((h) => ({ header: h, width: h === 'F.I.Sh.' ? 36 : 20 }));
  for (const s of students) {
    ws.addRow([
      s.fullName,
      s.className,
      toDisplayDate(s.birthDate),
      s.gender ? GENDER_LABEL[s.gender] : '',
      s.studentCode ?? '',
      s.parentPhone ?? '',
    ]);
  }
  styleHeader(ws);
  return toBuffer(wb);
}

export async function buildErrorsFile(rows: ImportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Xatolar');
  ws.columns = [
    { header: 'Qator', width: 8 },
    ...Object.values(COLUMNS).map((h) => ({ header: h, width: h === 'F.I.Sh.' ? 36 : 20 })),
    { header: 'Xato sababi', width: 60 },
  ];
  for (const r of rows.filter((x) => x.status !== 'valid')) {
    ws.addRow([
      r.row,
      r.data.fullName,
      r.data.className,
      toDisplayDate(r.data.birthDate),
      r.data.gender ? GENDER_LABEL[r.data.gender] : '',
      r.data.studentCode ?? '',
      r.data.parentPhone ?? '',
      r.errors.join('; '),
    ]);
  }
  styleHeader(ws);
  return toBuffer(wb);
}

/** Fayl haqiqatan ham (kichik) xlsx ekanini tekshiradi: ZIP magic bytes va ochilgandagi hajm */
export async function assertSafeXlsx(buffer: Buffer): Promise<void> {
  const bad = (msg: string) => AppError.validation(msg, [{ path: 'file', message: msg }]);
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw bad('Fayl .xlsx formatida emas');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw bad('Fayl buzilgan yoki .xlsx formatida emas');
  }
  if (!zip.file('xl/workbook.xml')) throw bad('Fayl Excel (.xlsx) hujjati emas');
  const entries = Object.values(zip.files);
  if (entries.length > 300) throw bad('Fayl tuzilishi juda murakkab');
  // Zip-bomba himoyasi: ochilgandagi umumiy hajm
  const total = entries.reduce(
    (sum, f) =>
      sum +
      ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    0,
  );
  if (total > MAX_UNCOMPRESSED_BYTES) throw bad('Fayl hajmi juda katta');
}

export function cellRaw(v: ExcelJS.CellValue): RawCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    // Formula bajarilmaydi — faqat oxirgi saqlangan natija o'qiladi
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('formula' in v || 'sharedFormula' in v) {
      const r = (v as { result?: ExcelJS.CellValue }).result;
      return r && typeof r !== 'object' ? (r as RawCell) : r instanceof Date ? r : null;
    }
    if ('text' in v) return String((v as { text: unknown }).text ?? '');
  }
  return null;
}

export interface ParsedSheet {
  hasClassColumn: boolean;
  rows: RawRow[];
}

/** xlsx ni o'qiydi (hujayralar matn/son/sana sifatida, hech narsa bajarilmaydi) */
export async function parseStudentsSheet(buffer: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as never);
  } catch {
    throw AppError.validation("Faylni o'qib bo'lmadi", [
      { path: 'file', message: 'Fayl buzilgan' },
    ]);
  }
  const ws = wb.worksheets[0];
  if (!ws)
    throw AppError.validation('Faylda varaq topilmadi', [{ path: 'file', message: "Bo'sh fayl" }]);
  if (ws.rowCount > MAX_DATA_ROWS + 4000 || ws.columnCount > 60) {
    throw AppError.validation('Fayl juda katta', [
      { path: 'file', message: "Qatorlar yoki ustunlar soni juda ko'p" },
    ]);
  }

  const colOf = new Map<ColumnKey, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const raw = cellRaw(cell.value);
    if (raw === null) return;
    const key = headerKeyOf(String(raw));
    for (const [k, aliases] of Object.entries(HEADER_ALIASES) as [ColumnKey, string[]][]) {
      if (!colOf.has(k) && aliases.includes(key)) colOf.set(k, col);
    }
  });
  if (!colOf.has('fullName')) {
    throw AppError.validation("Faylda 'F.I.Sh.' ustuni topilmadi", [
      { path: 'file', message: "1-qatorda 'F.I.Sh.' sarlavhasi bo'lishi kerak" },
    ]);
  }

  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const cells = {} as Record<ColumnKey, RawCell>;
    let any = false;
    for (const k of Object.keys(COLUMNS) as ColumnKey[]) {
      const col = colOf.get(k);
      const v = col ? cellRaw(row.getCell(col).value) : null;
      cells[k] = v;
      if (v !== null && String(v).trim() !== '') any = true;
    }
    if (any) rows.push({ row: n, cells });
  });
  if (rows.length === 0)
    throw AppError.validation("Faylda ma'lumot qatorlari yo'q", [
      { path: 'file', message: "Bo'sh fayl" },
    ]);
  if (rows.length > MAX_DATA_ROWS) {
    throw AppError.validation(`Qatorlar soni ${MAX_DATA_ROWS} tadan oshmasligi kerak`, [
      { path: 'file', message: `Maksimum ${MAX_DATA_ROWS} ta qator` },
    ]);
  }
  return { hasClassColumn: colOf.has('className'), rows };
}

// ---- Hujayra qiymatlarini tahlil qilish ----

export const asText = (v: RawCell, max = 200): string => {
  if (v === null) return '';
  if (v instanceof Date) return fmtDate(v) ?? '';
  return cleanText(String(v)).slice(0, max);
};

export function parseGender(v: RawCell): { value: 'male' | 'female' | null; error?: string } {
  const t = asText(v, 30)
    .toLowerCase()
    .replace(/[.'’ʻ`]/g, '');
  if (!t) return { value: null };
  if (['erkak', 'male', 'e', 'm', 'ogil', 'ogil bola', 'man'].includes(t)) return { value: 'male' };
  if (['ayol', 'female', 'a', 'f', 'qiz', 'qiz bola', 'woman'].includes(t))
    return { value: 'female' };
  return { value: null, error: "Jinsi noto'g'ri (Erkak yoki Ayol bo'lishi kerak)" };
}

export function parseBirthDate(v: RawCell): { value: string | null; error?: string } {
  if (v === null || (typeof v === 'string' && !v.trim())) return { value: null };
  let date: Date | null = null;
  if (v instanceof Date) {
    date = buildUtcDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  } else if (typeof v === 'number') {
    const d = excelSerialToDate(v);
    date = d && buildUtcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  } else {
    const s = v.trim();
    let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
    if (m) date = buildUtcDate(Number(m[3]), Number(m[2]), Number(m[1]));
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)))
      date = buildUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (!date || date.getUTCFullYear() < 1980 || date.getTime() > Date.now()) {
    return { value: null, error: "Tug'ilgan sana noto'g'ri (kk.oo.yyyy)" };
  }
  return { value: fmtDate(date) };
}
