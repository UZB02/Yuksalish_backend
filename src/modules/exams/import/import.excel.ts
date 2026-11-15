import ExcelJS from 'exceljs';
import {
  MAX_DATA_ROWS,
  assertSafeXlsx,
  cellRaw,
  type RawCell,
} from '../../students/students.excel';
import { headerKeyOf } from '../../../utils/text';
import { importError, parseType, type Block, type RawItem, type RawOption } from './import.common';

export const EXCEL_COLS = {
  subject: 'Fan',
  topic: 'Mavzu',
  difficulty: 'Qiyinlik',
  type: 'Tur',
  question: 'Savol',
  correct: "To'g'ri javob",
  points: 'Ball',
  partial: 'Qisman ball',
} as const;
const OPTION_LETTERS = 'ABCDEFGHIJ'.split('');

const ALIASES: Record<string, string[]> = {
  subject: ['fan', 'fanlar', 'subject'],
  topic: ['mavzu', 'topic'],
  difficulty: ['qiyinlik', 'qiyinlik13', 'difficulty'],
  type: ['tur', 'savolturi', 'type'],
  question: ['savol', 'savolmatni', 'question'],
  correct: ['togrijavob', 'javob', 'togri', 'correct', 'answer'],
  points: ['ball', 'points'],
  partial: ['qismanball', 'qisman', 'qismanballhayoq', 'partial'],
};

const str = (v: RawCell): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};
const num = (v: RawCell): number | null => {
  const s = str(v).replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

export async function buildExcelTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Savollar');
  const headers = [
    EXCEL_COLS.difficulty,
    EXCEL_COLS.type,
    EXCEL_COLS.question,
    ...OPTION_LETTERS,
    EXCEL_COLS.correct,
    EXCEL_COLS.points,
    EXCEL_COLS.partial,
  ];
  ws.columns = headers.map((h) => ({
    header: h,
    width: h === 'Savol' ? 44 : h.length > 3 ? 18 : 12,
  }));
  ws.addRow([
    2,
    'single',
    '2 + 2 nechiga teng?',
    '3',
    '4',
    '5',
    '6',
    '',
    '',
    '',
    '',
    '',
    '',
    'B',
    1,
    '',
  ]);
  ws.addRow([
    3,
    'multi',
    'Qaysilari tub sonlar?',
    '2',
    '4',
    '7',
    '9',
    '',
    '',
    '',
    '',
    '',
    '',
    'A,C',
    2,
    'ha',
  ]);
  ws.addRow([
    1,
    'short',
    '5 / 2 nechiga teng?',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '2,5|2.5',
    1,
    '',
  ]);
  ws.addRow([
    2,
    'essay',
    'Bahor haqida insho yozing.',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    5,
    '',
  ]);
  const h = ws.getRow(1);
  h.font = { bold: true };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  const help = wb.addWorksheet('Qo‘llanma');
  help.columns = [{ width: 110 }];
  [
    'Har bir qator bitta savol. 1-qatordagi sarlavhalarni o‘zgartirmang.',
    'Savollar import oynasida tanlangan MAVZUGA qo‘shiladi (fan va mavzu shu mavzudan olinadi). Faylda "Fan" va "Mavzu" ustunlari kerak emas, bo‘lsa e’tiborsiz qoldiriladi.',
    'Tur: single (bitta to‘g‘ri), multi (bir nechta to‘g‘ri), short (qisqa javob), essay (ochiq javob). Bo‘sh bo‘lsa avtomatik aniqlanadi.',
    'Variantlar: A dan J gacha ketma-ket to‘ldiriladi (bo‘sh joy qoldirmang), ko‘pi bilan 10 ta.',
    'To‘g‘ri javob: single uchun "B"; multi uchun "A,C"; short uchun javoblar "|" bilan ajratiladi ("2,5|2.5"); essay uchun mezon (ixtiyoriy).',
    'Ball: son (standart 1). Qisman ball: faqat multi uchun, "ha" yoki "yo‘q".',
    'Formula uchun TeX yozing: bir hujayraga $ belgisisiz, masalan \\frac{1}{2}. Rasm Excel orqali qo‘shilmaydi: savolni import qilgach tahrirlang.',
    'Savollar qoralama sifatida qo‘shiladi. Bir faylda ko‘pi bilan 1000 qator.',
  ].forEach((t) => help.addRow([t]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseExcel(buffer: Buffer, deadline: number): Promise<RawItem[]> {
  await assertSafeXlsx(buffer);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as never);
  } catch {
    throw importError("Faylni o'qib bo'lmadi");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw importError('Faylda varaq topilmadi');
  if (ws.rowCount > MAX_DATA_ROWS + 4000 || ws.columnCount > 60)
    throw importError('Fayl juda katta');

  const col = new Map<string, number>();
  const optCol = new Map<string, number>();
  ws.getRow(1).eachCell((cell, c) => {
    const raw = cellRaw(cell.value);
    if (raw === null) return;
    const key = headerKeyOf(String(raw));
    if (/^[a-j]$/.test(key)) {
      if (!optCol.has(key)) optCol.set(key, c);
      return;
    }
    for (const [k, al] of Object.entries(ALIASES))
      if (!col.has(k) && al.includes(key)) col.set(k, c);
  });
  if (!col.has('question'))
    throw importError(
      "Faylda 'Savol' ustuni topilmadi (1-qator sarlavhalari shablondagidek bo'lsin)",
    );

  const items: RawItem[] = [];
  const rows: { n: number; row: ExcelJS.Row }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n > 1) rows.push({ n, row });
  });
  for (const { n, row } of rows) {
    if (Date.now() > deadline) throw importError('Import vaqti tugadi');
    const get = (k: string): RawCell =>
      col.has(k) ? cellRaw(row.getCell(col.get(k)!).value) : null;
    const question = str(get('question'));
    const optTexts = OPTION_LETTERS.map((L) => {
      const c = optCol.get(L.toLowerCase());
      return c ? str(cellRaw(row.getCell(c).value)) : '';
    });
    if (!question && !optTexts.some(Boolean) && !str(get('correct'))) continue;
    if (items.length >= MAX_DATA_ROWS)
      throw importError(`Qatorlar soni ${MAX_DATA_ROWS} tadan oshmasligi kerak`);

    const r: RawItem = {
      row: n,
      subjectName: str(get('subject')) || null,
      topic: str(get('topic')).slice(0, 200) || null,
      difficulty: null,
      type: str(get('type')) || null,
      points: null,
      partialCredit: false,
      content: question ? [{ type: 'text', text: question.slice(0, 5000) } as Block] : [],
      options: [],
      correctIds: [],
      accepted: [],
      rubric: '',
      warnings: [],
      errors: [],
    };
    const d = num(get('difficulty'));
    if (d !== null) {
      if (Number.isNaN(d)) r.errors.push("Qiyinlik raqam bo'lishi kerak");
      else r.difficulty = d;
    }
    const p = num(get('points'));
    if (p !== null) {
      if (Number.isNaN(p)) r.errors.push("Ball raqam bo'lishi kerak");
      else r.points = p;
    }
    r.partialCredit = /^(ha|yes|true|1|da|\+)$/i.test(str(get('partial')));

    // Variantlar ketma-ket bo'lishi shart (A, B, C ...), bo'shliq xato
    let last = -1;
    optTexts.forEach((t, i) => {
      if (t) last = i;
    });
    for (let i = 0; i <= last; i++) {
      if (!optTexts[i]) {
        r.errors.push(`Variantlar ketma-ket bo'lishi kerak: ${OPTION_LETTERS[i]} bo'sh`);
        break;
      }
      const opt: RawOption = {
        id: OPTION_LETTERS[i]!.toLowerCase(),
        content: [{ type: 'text', text: optTexts[i]!.slice(0, 5000) }],
      };
      r.options.push(opt);
    }

    const correct = str(get('correct'));
    const hasOptions = r.options.length > 0;
    if (hasOptions) {
      const letters = correct
        .toUpperCase()
        .split(/[\s,;/]+/)
        .filter(Boolean);
      const bad = letters.filter((l) => !/^[A-J]$/.test(l));
      if (bad.length) r.errors.push(`To'g'ri javob harf bo'lishi kerak (A-J): "${correct}"`);
      else r.correctIds = [...new Set(letters.map((l) => l.toLowerCase()))];
      const ids = new Set(r.options.map((o) => o.id));
      const missing = r.correctIds.filter((c) => !ids.has(c));
      if (missing.length)
        r.errors.push(
          `To'g'ri javob variantlar orasida yo'q: ${missing.map((m) => m.toUpperCase()).join(', ')}`,
        );
    } else if (parseType(r.type) === 'essay') {
      r.rubric = correct.slice(0, 5000);
    } else {
      r.accepted = correct
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    items.push(r);
  }
  if (!items.length) throw importError("Faylda ma'lumot qatorlari yo'q");
  return items;
}
