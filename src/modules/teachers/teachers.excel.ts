import ExcelJS from 'exceljs';
import { AppError } from '../../core/errors';
import { headerKeyOf } from '../../utils/text';
import { cellRaw, type RawCell } from '../students/students.excel';

export const MAX_TEACHER_ROWS = 500;
const SHEET_MAX_ROWS = MAX_TEACHER_ROWS + 4000;

export const TEACHER_COLUMNS = {
  fullName: 'F.I.Sh.',
  phone: 'Telefon',
  login: 'Login',
  password: 'Parol',
} as const;
export type TeacherColumnKey = keyof typeof TEACHER_COLUMNS;

// headerKeyOf natijasi: kichik harf, apostrof/bo'sh joy/nuqta/tire olib tashlangan
const ALIASES: Record<TeacherColumnKey, string[]> = {
  fullName: [
    'fish',
    'fio',
    'fullname',
    'name',
    'ism',
    'ismfamiliya',
    'ismvafamiliya',
    'ismfamiliyasi',
    'ismsharif',
    'familiyaism',
    'familiyavaism',
    'oqituvchi',
    'oqituvchifish',
    'oqituvchiningfish',
    'oqituvchiningismi',
    'oqituvchiningismivafamiliyasi',
    'oqituvchiningismfamiliyasi',
    'ustoz',
  ],
  phone: ['telefon', 'tel', 'telefonraqami', 'telefonraqam', 'telraqami', 'telraqam', 'phone'],
  login: ['login', 'username', 'foydalanuvchinomi', 'logini'],
  password: ['parol', 'password', 'paroli', 'parolu'],
};

export async function buildTeachersTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("O'qituvchilar");
  ws.columns = [
    { header: 'T/r', width: 6 },
    { header: TEACHER_COLUMNS.fullName, width: 38 },
    { header: TEACHER_COLUMNS.phone, width: 20 },
    { header: TEACHER_COLUMNS.login, width: 20 },
    { header: TEACHER_COLUMNS.password, width: 20 },
  ];
  ws.addRow([1, 'Raxmanova Zilola Shuxrat qizi', '93 944 00 89', null, null]);
  ws.addRow([2, "Jo'rayev Sardorbek Ravshan o'g'li", '90 123 45 67', 'sardor.j', 'Parol12345']);
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };

  const notes = wb.addWorksheet('Izoh');
  notes.getColumn(1).width = 120;
  [
    "1-qatordagi sarlavhalarni o'zgartirmang. Namuna qatorlarni o'chirib, o'z ma'lumotlaringizni kiriting.",
    "F.I.Sh. — majburiy, familiya birinchi (masalan: Raxmanova Zilola Shuxrat qizi). T/r ustuni e'tiborga olinmaydi.",
    "Telefon — ixtiyoriy. 93 944 00 89 yoki +998 93 944 00 89 ko'rinishida; tizim +998 XX XXX XX XX ga keltiradi.",
    "Login — ixtiyoriy. Bo'sh qolsa ism (F.I.Sh.dagi 2-so'z) lotin harflarida olinadi (O‘g‘ilhon -> ogilhon).",
    "Ismlari bir xil o'qituvchilarga familiya bosh harfi qo'shiladi (sardorbek.j, sardorbek.r).",
    "Parol — ixtiyoriy (kamida 8 belgi, harf va raqam). Bo'sh qolsa: login (nuqtasiz) + 12345 (masalan umida12345).",
    'Cheklov: faqat .xlsx, 5 MB gacha, 500 tagacha qator.',
  ].forEach((t) => notes.addRow([t]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface RawTeacherRow {
  row: number;
  cells: Record<TeacherColumnKey, RawCell>;
}

function matchColumns(ws: ExcelJS.Worksheet): Map<TeacherColumnKey, number> {
  const colOf = new Map<TeacherColumnKey, number>();
  const cols: { col: number; key: string }[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    const raw = cellRaw(cell.value);
    if (raw !== null) cols.push({ col, key: headerKeyOf(String(raw)) });
  });
  const claimed = new Set<number>();
  // 1) aniq sinonimlar
  for (const { col, key } of cols) {
    for (const [k, aliases] of Object.entries(ALIASES) as [TeacherColumnKey, string[]][]) {
      if (!colOf.has(k) && aliases.includes(key)) {
        colOf.set(k, col);
        claimed.add(col);
      }
    }
  }
  // 2) F.I.Sh. uchun yumshoq moslik: sarlavhada ism/familiya/F.I.Sh. bo'lsa
  if (!colOf.has('fullName')) {
    const soft = cols.find(
      (c) => !claimed.has(c.col) && /(ism|familiya|fish|fio|oqituvchi|ustoz)/.test(c.key),
    );
    if (soft) colOf.set('fullName', soft.col);
  }
  return colOf;
}

/** Birinchi varaqni o'qiydi (hujayralar matn/son sifatida, formulalar bajarilmaydi) */
export async function parseTeachersSheet(buffer: Buffer): Promise<RawTeacherRow[]> {
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
  if (ws.rowCount > SHEET_MAX_ROWS || ws.columnCount > 60) {
    throw AppError.validation('Fayl juda katta', [
      { path: 'file', message: "Qatorlar yoki ustunlar soni juda ko'p" },
    ]);
  }
  const colOf = matchColumns(ws);
  if (!colOf.has('fullName')) {
    throw AppError.validation("Faylda 'F.I.Sh.' ustuni topilmadi", [
      {
        path: 'file',
        message: "1-qatorda 'F.I.Sh.' (o'qituvchining ismi va familiyasi) sarlavhasi kerak",
      },
    ]);
  }

  const rows: RawTeacherRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const cells = {} as Record<TeacherColumnKey, RawCell>;
    let any = false;
    for (const k of Object.keys(TEACHER_COLUMNS) as TeacherColumnKey[]) {
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
  if (rows.length > MAX_TEACHER_ROWS) {
    throw AppError.validation(`Qatorlar soni ${MAX_TEACHER_ROWS} tadan oshmasligi kerak`, [
      { path: 'file', message: `Maksimum ${MAX_TEACHER_ROWS} ta qator` },
    ]);
  }
  return rows;
}

export interface CredentialRow {
  fullName: string;
  phone: string | null;
  login: string | null;
  password: string | null;
  status: 'created' | 'skipped' | 'failed';
}

const STATUS_LABEL = {
  created: 'Yaratildi',
  skipped: "Mavjud — o'tkazildi",
  failed: 'Xato',
} as const;

/** Tarqatish uchun login-parollar fayli. Parollar saqlanmaydi: so'rov tanasidan yasalib qaytariladi. */
export async function buildCredentialsFile(rows: CredentialRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Login-parollar');
  ws.columns = [
    { header: 'F.I.Sh.', width: 38 },
    { header: 'Telefon', width: 20 },
    { header: 'Login', width: 22 },
    { header: 'Parol', width: 22 },
    { header: 'Holat', width: 22 },
  ];
  for (const r of rows) {
    ws.addRow([r.fullName, r.phone ?? '', r.login ?? '', r.password ?? '', STATUS_LABEL[r.status]]);
  }
  // Hujayralar har doim matn (formula emas)
  ws.eachRow((row) => row.eachCell((c) => (c.numFmt = '@')));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
