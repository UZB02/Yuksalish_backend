import { round2 } from '../../utils/dayScore';
import type { RatingWeights, TieBreak } from '../settings/rating.settings';

/** Fan bahosi (2–5) ni 100 ballik shkalaga o'tkazish koeffitsienti: 5→100, 4→80 */
export const GRADE_TO_100 = 20;

// ---- Toza hisoblash funksiyalari (DB ga bog'liq emas) ----

export interface StudentInfo {
  id: string;
  fullName: string;
  classId: string;
}

export interface StudentAgg {
  /** Xulq bahosi (Score) berilgan kunlar soni */
  daysCount: number;
  /** Xulq baholari soni */
  scoresCount: number;
  /** Kunlik ballar yig'indisi */
  sumDays: number;
  /** Fan baholari (2–5) soni */
  gradesCount?: number;
  /** Fan baholari (2–5) yig'indisi (xom qiymatlar) */
  gradesSum?: number;
  /** Xulq yoki fan bahosi berilgan kunlar soni (birlashma); yo'q bo'lsa daysCount */
  activeDays?: number;
}

export interface StudentRow {
  studentId: string;
  fullName: string;
  classId: string;
  score: number;
  daysCount: number;
  scoresCount: number;
  eligible: boolean;
  /** Davomat jarimasi (ball shkalasida); score allaqachon jarimani hisobga olgan */
  penalty: number;
  rank: number | null;
}

export const DEFAULT_WEIGHTS: RatingWeights = { conduct: 50, subjects: 50 };

/**
 * Ikki komponentni ulushlar bo'yicha birlashtiradi. Faqat bittasida ma'lumot bo'lsa — o'sha komponent
 * o'zi (ulushlar qayta normallashtiriladi); ikkalasi ham bo'sh bo'lsa 0.
 */
export function blendComponents(
  conduct: number | null,
  subjects: number | null,
  w: RatingWeights,
): number {
  if (conduct === null && subjects === null) return 0;
  if (subjects === null) return round2(conduct as number);
  if (conduct === null) return round2(subjects);
  const total = w.conduct + w.subjects;
  if (total <= 0) return round2((conduct + subjects) / 2);
  return round2((conduct * w.conduct + subjects * w.subjects) / total);
}

/** method=average: kunlik ballar o'rtachasi; sum: yig'indisi (2 xona) */
export function scoreOf(sumDays: number, daysCount: number, method: 'average' | 'sum'): number {
  if (daysCount <= 0) return 0;
  return round2(method === 'sum' ? sumDays : sumDays / daysCount);
}

const cmpName = (a: string, b: string) => a.localeCompare(b, 'uz');

/** Teng ballarda: tieBreak ketma-ketligi, oxirida alifbo va id (to'liq aniq tartib) */
function compareStudents(tieBreak: TieBreak[]) {
  return (a: StudentRow, b: StudentRow): number => {
    if (b.score !== a.score) return b.score - a.score;
    for (const t of tieBreak) {
      if (t === 'daysCount' && a.daysCount !== b.daysCount) return b.daysCount - a.daysCount;
      if (t === 'scoresCount' && a.scoresCount !== b.scoresCount)
        return b.scoresCount - a.scoresCount;
      if (t === 'alphabetical') {
        const c = cmpName(a.fullName, b.fullName);
        if (c !== 0) return c;
      }
    }
    return cmpName(a.fullName, b.fullName) || a.studentId.localeCompare(b.studentId);
  };
}

export function buildStudentRows(
  students: StudentInfo[],
  aggs: Map<string, StudentAgg>,
  s: { method: 'average' | 'sum'; minScoresCount: number; weights?: RatingWeights },
): StudentRow[] {
  const weights = s.weights ?? DEFAULT_WEIGHTS;
  return students.map((st) => {
    const a = aggs.get(st.id);
    const conductDays = a?.daysCount ?? 0;
    const grades = a?.gradesCount ?? 0;
    const days = a?.activeDays ?? conductDays;
    // Komponentlar: xulq (0–100) va fan baholari (2–5 → ×20); sum usulida yig'indilar
    const conduct = a && conductDays > 0 ? scoreOf(a.sumDays, conductDays, s.method) : null;
    const subjects =
      a && grades > 0
        ? round2(
            s.method === 'sum'
              ? (a.gradesSum ?? 0) * GRADE_TO_100
              : ((a.gradesSum ?? 0) / grades) * GRADE_TO_100,
          )
        : null;
    return {
      studentId: st.id,
      fullName: st.fullName,
      classId: st.classId,
      score: blendComponents(conduct, subjects, weights),
      daysCount: days,
      scoresCount: (a?.scoresCount ?? 0) + grades,
      eligible: days >= s.minScoresCount && days > 0,
      penalty: 0,
      rank: null,
    };
  });
}

export interface AttendanceCounts {
  late: number;
  absentExcused: number;
  absentUnexcused: number;
}

export interface PenaltyRates {
  penaltyLate: number;
  penaltyAbsentExcused: number;
  penaltyAbsentUnexcused: number;
}

/** Davomat jarimasi = kechikish*penaltyLate + sababli*penaltyAbsentExcused + sababsiz*penaltyAbsentUnexcused (2 xona) */
export function penaltyOf(c: AttendanceCounts, rates: PenaltyRates): number {
  return round2(
    c.late * rates.penaltyLate +
      c.absentExcused * rates.penaltyAbsentExcused +
      c.absentUnexcused * rates.penaltyAbsentUnexcused,
  );
}

/** Jarimani ballardan ayiradi; natija 0 dan past tushmaydi. eligible va tie-break maydonlari o'zgarmaydi. */
export function applyPenalties(rows: StudentRow[], penalties: Map<string, number>): StudentRow[] {
  return rows.map((r) => {
    const penalty = penalties.get(r.studentId) ?? 0;
    return penalty > 0 ? { ...r, penalty, score: Math.max(0, round2(r.score - penalty)) } : r;
  });
}

/** Tartiblaydi va noyob rank beradi (1..N); eligible bo'lmaganlar oxirida, rank=null */
export function rankStudents(rows: StudentRow[], tieBreak: TieBreak[]): StudentRow[] {
  const eligible = rows.filter((r) => r.eligible).sort(compareStudents(tieBreak));
  eligible.forEach((r, i) => (r.rank = i + 1));
  const rest = rows
    .filter((r) => !r.eligible)
    .map((r) => ({ ...r, rank: null }))
    .sort((a, b) => cmpName(a.fullName, b.fullName) || a.studentId.localeCompare(b.studentId));
  return [...eligible, ...rest];
}

export interface ClassInfo {
  id: string;
  name: string;
  grade: number;
}

export interface ClassRow {
  classId: string;
  className: string;
  grade: number;
  score: number;
  ratedStudents: number;
  totalStudents: number;
  rank: number | null;
}

const mean = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/** Sinf balli = eligible o'quvchilar ballarining arifmetik o'rtachasi (method qanday bo'lmasin) */
export function buildClassRows(
  rows: StudentRow[],
  classes: Map<string, ClassInfo>,
  totalByClass: Map<string, number>,
): ClassRow[] {
  const byClass = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.eligible) continue;
    byClass.set(r.classId, [...(byClass.get(r.classId) ?? []), r.score]);
  }
  const out: ClassRow[] = [];
  for (const [classId, scores] of byClass) {
    const info = classes.get(classId);
    if (!info) continue;
    out.push({
      classId,
      className: info.name,
      grade: info.grade,
      score: mean(scores),
      ratedStudents: scores.length,
      totalStudents: totalByClass.get(classId) ?? scores.length,
      rank: null,
    });
  }
  return out;
}

export function rankClasses(rows: ClassRow[]): ClassRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      b.score - a.score ||
      b.ratedStudents - a.ratedStudents ||
      cmpName(a.className, b.className) ||
      a.classId.localeCompare(b.classId),
  );
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

export interface SchoolRow {
  schoolId: string;
  name: string;
  slug: string;
  score: number;
  ratedStudents: number;
  totalStudents: number;
  rank: number | null;
}

/** Maktab balli = maktabning BARCHA eligible o'quvchilari ballarining o'rtachasi (sinflar o'rtachasi emas) */
export function buildSchoolRow(
  school: { id: string; name: string; slug: string },
  rows: StudentRow[],
  totalStudents: number,
): SchoolRow {
  const scores = rows.filter((r) => r.eligible).map((r) => r.score);
  return {
    schoolId: school.id,
    name: school.name,
    slug: school.slug,
    score: mean(scores),
    ratedStudents: scores.length,
    totalStudents,
    rank: null,
  };
}

/** ratedStudents=0 bo'lgan maktab reytingga kirmaydi (rank=null, oxirida) */
export function rankSchools(rows: SchoolRow[]): SchoolRow[] {
  const rated = rows
    .filter((r) => r.ratedStudents > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.ratedStudents - a.ratedStudents ||
        cmpName(a.name, b.name) ||
        a.schoolId.localeCompare(b.schoolId),
    );
  rated.forEach((r, i) => (r.rank = i + 1));
  const rest = rows
    .filter((r) => r.ratedStudents === 0)
    .map((r) => ({ ...r, rank: null }))
    .sort((a, b) => cmpName(a.name, b.name));
  return [...rated, ...rest];
}

/** previousRank - rank (musbat = ko'tarildi); previousRank yo'q bo'lsa null */
export const rankChange = (rank: number | null, previousRank: number | null): number | null =>
  rank !== null && previousRank !== null ? previousRank - rank : null;
