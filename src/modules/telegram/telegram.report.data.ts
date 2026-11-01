import { Types } from 'mongoose';
import { AcademicYear } from '../../models/AcademicYear';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { BehaviorType } from '../../models/BehaviorType';
import { ClassModel } from '../../models/Class';
import { Score } from '../../models/Score';
import { Student } from '../../models/Student';
import { round2 } from '../../utils/dayScore';
import { dayStatus } from '../attendance/attendance.stats';
import type { AttendanceCategory } from '../settings/attendance.settings';
import { findClassRatings, getSnapshot } from '../ratings/ratings.service';

const oid = (id: string) => new Types.ObjectId(id);
const idStr = (v: unknown) => String(v);

/** Sinf nomlarini tabiiy tartiblash: 5-A, 6-A, 10-B */
export const cmpClassName = (a: string, b: string): number =>
  a.localeCompare(b, 'uz', { numeric: true });

interface Scope {
  classes: { id: string; name: string }[];
  students: { id: string; fullName: string; classId: string }[];
}

/** Faol o'quv yilidagi arxivlanmagan sinflar va ulardagi faol o'quvchilar (dashboard bilan bir xil doira) */
async function loadScope(schoolId: string): Promise<Scope> {
  const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id').lean();
  if (!year) return { classes: [], students: [] };
  const classes = (
    await ClassModel.find({ schoolId, academicYearId: year._id, isArchived: false })
      .select('name')
      .lean()
  )
    .map((c) => ({ id: idStr(c._id), name: c.name }))
    .sort((a, b) => cmpClassName(a.name, b.name));
  const students = (
    await Student.find({
      schoolId,
      classId: { $in: classes.map((c) => c.id) },
      isDeleted: false,
      status: 'active',
    })
      .select('fullName classId')
      .sort({ fullName: 1, _id: 1 })
      .lean()
  ).map((s) => ({ id: idStr(s._id), fullName: s.fullName, classId: idStr(s.classId) }));
  return { classes, students };
}

export interface AbsentStudent {
  fullName: string;
  /** Hamma yo'qlik yozuvi sababli */
  excused: boolean;
}

export interface ClassAttendanceRow {
  classId: string;
  name: string;
  /** Davomat yozuvi bor o'quvchilar */
  marked: number;
  /** Faol o'quvchilar soni */
  total: number;
  /** Kelgan + kechikkan + qisman (marked bo'yicha), % */
  rate: number | null;
}

export interface DayAttendance {
  /** Maktabda shu kuni kamida bitta davomat yozuvi bor */
  takenAny: boolean;
  /** Davomat yozuvi bor o'quvchilar soni (foiz maxraji) */
  marked: number;
  present: number;
  late: number;
  /** Dars rejimi: bir qism darsda yo'q, qolganida bor */
  partial: number;
  absentExcused: number;
  absentUnexcused: number;
  /** (present + late + partial) / marked * 100 */
  rate: number | null;
  classes: ClassAttendanceRow[];
  /** Kamida bitta faol o'quvchisiga yozuv yo'q sinflar (dashboardToday.unmarkedClasses bilan bir xil ta'rif) */
  unmarkedClasses: string[];
  absentByClass: { className: string; students: AbsentStudent[] }[];
}

const pct = (n: number, d: number): number | null => (d > 0 ? round2((n / d) * 100) : null);

/**
 * Bir kunlik davomat. Ta'rif dashboard (`attendanceStats.dashboardToday`) bilan bir xil: o'quvchi o'sha kundagi
 * yozuvlari bo'yicha bitta guruhga tushadi (`dayStatus`): kelgan / kechikkan / qisman / kelmagan.
 * Dars rejimida "kelmagan" — hamma darsda yo'q; bir qismida yo'q bo'lsa "qisman" (foizda kelgan hisoblanadi).
 */
export async function loadDayAttendance(schoolId: string, date: string): Promise<DayAttendance> {
  const { classes, students } = await loadScope(schoolId);
  const records = students.length
    ? await AttendanceRecord.find({
        schoolId,
        date,
        isDeleted: false,
        studentId: { $in: students.map((s) => s.id) },
      })
        .select('studentId category')
        .lean()
    : [];
  const cats = new Map<string, AttendanceCategory[]>();
  for (const r of records) {
    const k = idStr(r.studentId);
    cats.set(k, [...(cats.get(k) ?? []), r.category]);
  }

  const out: DayAttendance = {
    takenAny: records.length > 0,
    marked: 0,
    present: 0,
    late: 0,
    partial: 0,
    absentExcused: 0,
    absentUnexcused: 0,
    rate: null,
    classes: [],
    unmarkedClasses: [],
    absentByClass: [],
  };
  const perClass = new Map<string, { marked: number; ok: number; total: number }>();
  const absent = new Map<string, AbsentStudent[]>();
  for (const s of students) {
    const c = perClass.get(s.classId) ?? { marked: 0, ok: 0, total: 0 };
    c.total++;
    const list = cats.get(s.id);
    if (list) {
      const st = dayStatus(list);
      c.marked++;
      out.marked++;
      if (st === 'present') out.present++;
      else if (st === 'late') out.late++;
      else if (st === 'partial') out.partial++;
      else if (st === 'absent_excused') out.absentExcused++;
      else out.absentUnexcused++;
      if (st === 'present' || st === 'late' || st === 'partial') c.ok++;
      if (st === 'absent_excused' || st === 'absent_unexcused') {
        const a = absent.get(s.classId) ?? [];
        a.push({ fullName: s.fullName, excused: st === 'absent_excused' });
        absent.set(s.classId, a);
      }
    }
    perClass.set(s.classId, c);
  }
  out.rate = pct(out.present + out.late + out.partial, out.marked);
  for (const cl of classes) {
    const c = perClass.get(cl.id);
    if (!c) continue; // o'quvchisi yo'q sinf
    out.classes.push({
      classId: cl.id,
      name: cl.name,
      marked: c.marked,
      total: c.total,
      rate: pct(c.ok, c.marked),
    });
    if (c.marked < c.total) out.unmarkedClasses.push(cl.name);
    const a = absent.get(cl.id);
    if (a) out.absentByClass.push({ className: cl.name, students: a });
  }
  return out;
}

/**
 * Davr (from..to) uchun umumiy davomat foizi: (o'quvchi, kun) juftlari `dayStatus` bo'yicha sanaladi,
 * kelgan + kechikkan + qisman / hamma juftlar.
 */
export async function loadRangeAttendanceRate(
  schoolId: string,
  from: string,
  to: string,
): Promise<{ rate: number | null; days: number }> {
  const { students } = await loadScope(schoolId);
  if (!students.length) return { rate: null, days: 0 };
  const rows = await AttendanceRecord.aggregate<{ _id: unknown; cats: AttendanceCategory[] }>([
    {
      $match: {
        schoolId: oid(schoolId),
        isDeleted: false,
        date: { $gte: from, $lte: to },
        studentId: { $in: students.map((s) => oid(s.id)) },
      },
    },
    { $group: { _id: { s: '$studentId', d: '$date' }, cats: { $push: '$category' } } },
  ]);
  let ok = 0;
  for (const r of rows) {
    const st = dayStatus(r.cats);
    if (st === 'present' || st === 'late' || st === 'partial') ok++;
  }
  return { rate: pct(ok, rows.length), days: rows.length };
}

export interface DisciplineSummary {
  total: number;
  negative: number;
  positive: number;
  topNegativeTypes: { name: string; count: number }[];
  topStudents: { fullName: string; className: string; count: number }[];
}

/**
 * Davr xulq qaydlari. Ball 0..100 shkalada (±emas), shuning uchun "salbiy/ijobiy" — xulq turining `kind` i.
 * O'quvchilar tartibi: salbiy qaydlar soni (kamayish), teng bo'lsa o'rtacha ball pastroq, keyin alifbo.
 */
export async function loadDiscipline(
  schoolId: string,
  from: string,
  to: string,
  topN = { types: 3, students: 5 },
): Promise<DisciplineSummary> {
  const scores = await Score.find({
    schoolId,
    isDeleted: false,
    date: { $gte: from, $lte: to },
  })
    .select('studentId behaviorTypeId value')
    .lean();
  const out: DisciplineSummary = {
    total: scores.length,
    negative: 0,
    positive: 0,
    topNegativeTypes: [],
    topStudents: [],
  };
  if (!scores.length) return out;
  const typeIds = [
    ...new Set(scores.flatMap((s) => (s.behaviorTypeId ? [idStr(s.behaviorTypeId)] : []))),
  ];
  const types = new Map(
    (typeIds.length
      ? await BehaviorType.find({ _id: { $in: typeIds } })
          .select('name kind')
          .lean()
      : []
    ).map((t) => [idStr(t._id), t]),
  );
  const byType = new Map<string, number>();
  const byStudent = new Map<string, { count: number; sum: number }>();
  for (const s of scores) {
    const t = s.behaviorTypeId ? types.get(idStr(s.behaviorTypeId)) : undefined;
    if (t?.kind === 'positive') out.positive++;
    else if (t?.kind === 'negative') {
      out.negative++;
      byType.set(t.name, (byType.get(t.name) ?? 0) + 1);
      const k = idStr(s.studentId);
      const cur = byStudent.get(k) ?? { count: 0, sum: 0 };
      cur.count++;
      cur.sum += s.value;
      byStudent.set(k, cur);
    }
  }
  out.topNegativeTypes = [...byType.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'uz'))
    .slice(0, topN.types);

  if (byStudent.size) {
    const students = await Student.find({ _id: { $in: [...byStudent.keys()] } })
      .select('fullName classId')
      .lean();
    const classes = await ClassModel.find({ _id: { $in: students.map((s) => s.classId) } })
      .select('name')
      .lean();
    const cName = new Map(classes.map((c) => [idStr(c._id), c.name]));
    out.topStudents = students
      .map((s) => {
        const a = byStudent.get(idStr(s._id)) as { count: number; sum: number };
        return {
          fullName: s.fullName,
          className: cName.get(idStr(s.classId)) ?? '?',
          count: a.count,
          avg: a.sum / a.count,
        };
      })
      .sort(
        (a, b) => b.count - a.count || a.avg - b.avg || a.fullName.localeCompare(b.fullName, 'uz'),
      )
      .slice(0, topN.students)
      .map(({ fullName, className, count }) => ({ fullName, className, count }));
  }
  return out;
}

export interface ClassRatingExtremes {
  periodLabel: string;
  top: { rank: number; name: string; score: number }[];
  bottom: { rank: number; name: string; score: number }[];
}

/**
 * Sinflar reytingi: maktabning faol reyting davri snapshoti (admin panel/ochiq reyting sahifasi bilan bir xil
 * `getSnapshot` + `findClassRatings`). Faqat o'rin (rank) berilgan sinflar. Top-3 va oxirgi 3 kesishmaydi.
 */
export async function loadClassRatingExtremes(
  schoolId: string,
  n = 3,
): Promise<ClassRatingExtremes | null> {
  const snap = await getSnapshot(schoolId);
  const docs = await findClassRatings(schoolId, snap.calcId, {});
  const ranked = docs
    .filter((d) => d.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .map((d) => ({ rank: d.rank as number, name: d.name, score: d.score }));
  if (!ranked.length) return null;
  const top = ranked.slice(0, n);
  const bottom = ranked.slice(top.length).slice(-n).reverse();
  return { periodLabel: snap.period.label, top, bottom };
}
