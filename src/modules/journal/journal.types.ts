export type Absence = 'N' | 'B' | 'partial';

export interface JournalCell {
  grade?: number;
  gradeId?: string;
  absence?: Absence;
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
  dates: { date: string; weekday: number }[];
  students: JournalStudent[];
  cells: Record<string, Record<string, JournalCell>>;
  summary: {
    perStudent: Record<string, JournalSummaryRow>;
    perDate: Record<string, { avg: number | null; count: number }>;
    classAvg: number | null;
    classCount: number;
  };
}
