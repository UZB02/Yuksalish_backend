export type Absence = 'N' | 'B' | 'partial';

export interface JournalCell {
  grade?: number;
  gradeId?: string;
  absence?: Absence;
}

/**
 * Jurnal ustuni. Kalit: `YYYY-MM-DD#lessonNo` (dars ustuni) yoki `YYYY-MM-DD` (ish kuni ustuni, lessonNo 0).
 * source: timetable — jadval darsi; workday — jadval qamramagan ish kuni; record — ustun yo'q, lekin baho/yozuv bor.
 */
export interface JournalColumn {
  key: string;
  date: string;
  weekday: number;
  lessonNo: number;
  source: 'timetable' | 'workday' | 'record';
  cancelled: boolean;
}

export interface JournalStudent {
  id: string;
  fullName: string;
  studentCode: string | null;
  photo: string | null;
  /** Hozir bu sinfda emas (boshqa sinfga o'tgan / arxivlangan), lekin davrda bahosi bor */
  transferred: boolean;
}

export interface JournalSummaryRow {
  avg: number | null;
  count: number;
  absentN: number;
  absentB: number;
}

export interface JournalGrid {
  class: { id: string; name: string };
  subject: { id: string; name: string };
  teacher: { id: string; fullName: string } | null;
  school: { id: string; name: string };
  from: string;
  to: string;
  columns: JournalColumn[];
  students: JournalStudent[];
  cells: Record<string, Record<string, JournalCell>>;
  summary: {
    perStudent: Record<string, JournalSummaryRow>;
    perColumn: Record<string, { avg: number | null; count: number }>;
    classAvg: number | null;
    classCount: number;
  };
}
