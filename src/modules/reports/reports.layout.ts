// Hisobot -> chop etish tuzilmasi. Excel va PDF render shu umumiy tuzilmadan foydalanadi.
export interface ReportMeta {
  generatedAt: string;
  period: { from: string; to: string };
  school: { id: string; name: string } | null;
  scope: string;
}

export type ColumnType = 'text' | 'int' | 'number' | 'percent' | 'date';

export interface Column {
  header: string;
  key: string;
  /** Nisbiy kenglik (Excel belgi birligi ~ PDF proporsiya) */
  width: number;
  type?: ColumnType;
  align?: 'left' | 'right' | 'center';
  /** Tor joyda PDF sarlavhasi uchun qisqartma (Excelda to'liq sarlavha); legend bilan birga */
  short?: string;
}

export interface Table {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  /** Qator ichidagi HEX rang kaliti (xulq turi rangi) — PDFda rangli belgi sifatida chiziladi */
  colorKey?: string;
  /** Bu jadval qaysi ustun bo'yicha rangli belgi ko'rsatadi (odatda nom ustuni) */
  colorColumn?: string;
  /** Qisqartmalar ishlatilsa jadval ostida chiqadigan izoh */
  legend?: string;
}

export interface Chart {
  title: string;
  points: { label: string; value: number }[];
  yMin?: number;
  yMax?: number;
}

export interface ReportLayout {
  title: string;
  /** Fayl nomi asosi (kengaytma va davrsiz) */
  fileBase: string;
  orientation: 'portrait' | 'landscape';
  meta: ReportMeta;
  kpis: { label: string; value: string | number | null }[];
  tables: Table[];
  chart?: Chart;
}

export const fmtNum = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined ? '—' : v.toFixed(digits);

/** Jadval qatorlarining umumiy soni (qator cheklovi uchun) */
export const countRows = (l: ReportLayout): number =>
  l.tables.reduce((s, t) => s + t.rows.length, 0);
