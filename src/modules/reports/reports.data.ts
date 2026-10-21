import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { BehaviorType } from '../../models/BehaviorType';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { School } from '../../models/School';
import { Score } from '../../models/Score';
import { Student } from '../../models/Student';
import { Subject } from '../../models/Subject';
import { SubjectGrade } from '../../models/SubjectGrade';
import type { AuthUser } from '../../types/express';
import { clock } from '../../utils/clock';
import { round2 } from '../../utils/dayScore';
import { isId } from '../../utils/helpers';
import { allowedClassIds } from '../classes/classes.service';
import { computeLive, loadDayRows, type DayRow } from '../ratings/ratings.service';
import { ATTENDANCE_KEY, type AttendanceSettings } from '../settings/attendance.settings';
import { settingsService } from '../settings/settings.service';
import type { ScoringSettings } from '../settings/scoring.settings';
import type { ReportMeta } from './reports.layout';

export interface ReportCtx {
  actor: AuthUser;
  schoolId: string;
  school: { id: string; name: string };
  from: string;
  to: string;
  scoring: ScoringSettings;
  attendance: AttendanceSettings;
  /** O'qituvchi uchun biriktirilgan sinflar; boshqalar uchun null */
  classScope: string[] | null;
  isTeacher: boolean;
}

const oid = (id: string) => new Types.ObjectId(id);

export async function makeCtx(
  actor: AuthUser,
  schoolId: string,
  from: string,
  to: string,
): Promise<ReportCtx> {
  const school = await School.findById(schoolId).select('name').lean();
  if (!school) throw AppError.notFound('Maktab topilmadi');
  const [scoring, attendance, classScope] = await Promise.all([
    settingsService.getEffectiveScoring(schoolId),
    settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
    allowedClassIds(actor, schoolId),
  ]);
  return {
    actor,
    schoolId,
    school: { id: schoolId, name: school.name },
    from,
    to,
    scoring,
    attendance,
    classScope,
    isTeacher: actor.role === 'teacher',
  };
}

export const metaOf = (
  ctx: Pick<ReportCtx, 'from' | 'to' | 'school'> | null,
  scope: string,
  p: { from: string; to: string },
  school?: { id: string; name: string } | null,
): ReportMeta => ({
  generatedAt: clock.now().toISOString(),
  period: { from: p.from, to: p.to },
  school: school !== undefined ? school : ctx ? ctx.school : null,
  scope,
});

/** Sinf maktabga tegishli va (o'qituvchi uchun) biriktirilgan bo'lishi shart, aks holda 404 */
export async function loadClassOrThrow(ctx: ReportCtx, classId: string): Promise<ClassDoc> {
  const notFound = AppError.notFound('Sinf topilmadi');
  if (!isId(classId) || (ctx.classScope && !ctx.classScope.includes(classId))) throw notFound;
  const cls = await ClassModel.findOne({ _id: classId, schoolId: ctx.schoolId });
  if (!cls) throw notFound;
  return cls;
}

export const mean = (xs: number[]): number | null =>
  xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

export interface DayStats {
  days: DayRow[];
  scoresCount: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

/** DayRow lardan o'quvchi bo'yicha statistika (avgScore = kunlik ballarning arifmetik o'rtachasi) */
export function groupDays(rows: DayRow[]): Map<string, DayStats> {
  const out = new Map<string, DayStats>();
  for (const r of rows) {
    const cur = out.get(r.studentId) ?? {
      days: [],
      scoresCount: 0,
      avg: null,
      min: null,
      max: null,
    };
    cur.days.push(r);
    cur.scoresCount += r.n;
    out.set(r.studentId, cur);
  }
  for (const st of out.values()) {
    const vals = st.days.map((d) => d.day);
    st.avg = mean(vals);
    st.min = Math.min(...vals);
    st.max = Math.max(...vals);
    st.days.sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

export const loadDays = (ctx: ReportCtx, studentIds?: Types.ObjectId[]) =>
  loadDayRows(ctx.schoolId, { from: ctx.from, to: ctx.to }, ctx.scoring, studentIds);

export interface AttCounts {
  present: number;
  late: number;
  absentExcused: number;
  absentUnexcused: number;
  total: number;
  rate: number | null;
}

export const emptyAtt = (): AttCounts => ({
  present: 0,
  late: 0,
  absentExcused: 0,
  absentUnexcused: 0,
  total: 0,
  rate: null,
});

export function finishAtt(c: AttCounts): AttCounts {
  c.total = c.present + c.late + c.absentExcused + c.absentUnexcused;
  c.rate = c.total > 0 ? round2(((c.present + c.late) / c.total) * 100) : null;
  return c;
}

export function addAtt(c: AttCounts, category: string, n: number) {
  if (category === 'present') c.present += n;
  else if (category === 'late') c.late += n;
  else if (category === 'absent_excused') c.absentExcused += n;
  else if (category === 'absent_unexcused') c.absentUnexcused += n;
}

/** Davomat: o'quvchi bo'yicha kategoriya sonlari (davr ichida) */
export async function loadAttendance(
  ctx: ReportCtx,
  studentIds?: Types.ObjectId[],
): Promise<Map<string, AttCounts>> {
  const match: Record<string, unknown> = {
    schoolId: oid(ctx.schoolId),
    isDeleted: false,
    date: { $gte: ctx.from, $lte: ctx.to },
  };
  if (studentIds) match.studentId = { $in: studentIds };
  const rows = await AttendanceRecord.aggregate<{
    _id: { s: Types.ObjectId; c: string };
    n: number;
  }>([{ $match: match }, { $group: { _id: { s: '$studentId', c: '$category' }, n: { $sum: 1 } } }]);
  const out = new Map<string, AttCounts>();
  for (const r of rows) {
    const key = String(r._id.s);
    const c = out.get(key) ?? emptyAtt();
    addAtt(c, r._id.c, r.n);
    out.set(key, c);
  }
  for (const c of out.values()) finishAtt(c);
  return out;
}

export interface BehaviorRow {
  studentId: string;
  typeId: string | null;
  n: number;
}

/** Baholarning xulq turi bo'yicha sonlari (o'quvchi x tur) */
export async function loadBehavior(
  ctx: ReportCtx,
  studentIds?: Types.ObjectId[],
): Promise<BehaviorRow[]> {
  const match: Record<string, unknown> = {
    schoolId: oid(ctx.schoolId),
    isDeleted: false,
    date: { $gte: ctx.from, $lte: ctx.to },
  };
  if (studentIds) match.studentId = { $in: studentIds };
  const rows = await Score.aggregate<{
    _id: { s: Types.ObjectId; b: Types.ObjectId | null };
    n: number;
  }>([
    { $match: match },
    { $group: { _id: { s: '$studentId', b: '$behaviorTypeId' }, n: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({
    studentId: String(r._id.s),
    typeId: r._id.b ? String(r._id.b) : null,
    n: r.n,
  }));
}

export interface TypeInfo {
  id: string | null;
  name: string;
  kind: 'positive' | 'negative' | 'neutral';
  color: string;
}

export const UNTYPED: TypeInfo = {
  id: null,
  name: 'Xulq turisiz',
  kind: 'neutral',
  color: '#9CA3AF',
};

export async function loadTypeInfo(ids: (string | null)[]): Promise<Map<string | null, TypeInfo>> {
  const real = [...new Set(ids.filter((x): x is string => !!x))];
  const docs = real.length ? await BehaviorType.find({ _id: { $in: real } }).lean() : [];
  const map = new Map<string | null, TypeInfo>([[null, UNTYPED]]);
  for (const d of docs)
    map.set(String(d._id), { id: String(d._id), name: d.name, kind: d.kind, color: d.color });
  return map;
}

export interface BehaviorDistItem {
  behaviorTypeId: string | null;
  name: string;
  kind: string;
  color: string;
  count: number;
}

export function distribution(
  rows: BehaviorRow[],
  types: Map<string | null, TypeInfo>,
): BehaviorDistItem[] {
  const counts = new Map<string | null, number>();
  for (const r of rows) counts.set(r.typeId, (counts.get(r.typeId) ?? 0) + r.n);
  return [...counts.entries()]
    .map(([id, count]) => {
      const t = types.get(id) ?? UNTYPED;
      return { behaviorTypeId: id, name: t.name, kind: t.kind, color: t.color, count };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface GradeStats {
  count: number;
  average: number | null;
  bySubject: { subjectId: string; name: string; count: number; average: number }[];
}

/** Fan baholari: o'quvchi bo'yicha umumiy va fanlar kesimidagi o'rtacha (2–5), davr ichida */
export async function loadGradeStats(
  ctx: ReportCtx,
  studentIds?: Types.ObjectId[],
): Promise<Map<string, GradeStats>> {
  const match: Record<string, unknown> = {
    schoolId: oid(ctx.schoolId),
    isDeleted: false,
    date: { $gte: ctx.from, $lte: ctx.to },
  };
  if (studentIds) match.studentId = { $in: studentIds };
  const rows = await SubjectGrade.aggregate<{
    _id: { s: Types.ObjectId; sub: Types.ObjectId };
    sum: number;
    n: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { s: '$studentId', sub: '$subjectId' },
        sum: { $sum: '$value' },
        n: { $sum: 1 },
      },
    },
  ]);
  const subjects = rows.length
    ? await Subject.find({ _id: { $in: [...new Set(rows.map((r) => String(r._id.sub)))] } })
        .select('name')
        .lean()
    : [];
  const names = new Map(subjects.map((s) => [String(s._id), s.name]));
  const raw = new Map<string, { sum: number; n: number; by: GradeStats['bySubject'] }>();
  for (const r of rows) {
    const key = String(r._id.s);
    const cur = raw.get(key) ?? { sum: 0, n: 0, by: [] };
    cur.sum += r.sum;
    cur.n += r.n;
    cur.by.push({
      subjectId: String(r._id.sub),
      name: names.get(String(r._id.sub)) ?? '',
      count: r.n,
      average: round2(r.sum / r.n),
    });
    raw.set(key, cur);
  }
  const out = new Map<string, GradeStats>();
  for (const [k, v] of raw) {
    out.set(k, {
      count: v.n,
      average: round2(v.sum / v.n),
      bySubject: v.by.sort((a, b) => a.name.localeCompare(b.name, 'uz')),
    });
  }
  return out;
}

/** Faol o'quvchilar (sinflar bo'yicha cheklangan bo'lishi mumkin) */
export async function loadStudents(ctx: ReportCtx, classIds?: string[]) {
  const filter: Record<string, unknown> = {
    schoolId: ctx.schoolId,
    isDeleted: false,
    status: 'active',
  };
  if (classIds) filter.classId = { $in: classIds };
  else if (ctx.classScope) filter.classId = { $in: ctx.classScope };
  return Student.find(filter)
    .select('fullName studentCode classId')
    .sort({ fullName: 1, _id: 1 })
    .lean();
}

/** Reyting dvigatelining shu davr uchun jonli hisobi (rating sozlamasi + davomat jarimasi) */
export async function liveRating(ctx: ReportCtx) {
  const live = await computeLive(ctx.schoolId, ctx.from, ctx.to);
  return {
    byStudent: new Map(live.data.students.map((r) => [r.studentId, r])),
    byClass: new Map(live.data.classes.map((c) => [c.classId, c])),
    classNames: live.classNames,
  };
}

/** O'qituvchi roli uchun boshqa o'qituvchining izohi yashiriladi */
export const commentFor = (
  ctx: ReportCtx,
  teacherId: string,
  comment: string | null | undefined,
): string | null => (ctx.isTeacher && teacherId !== ctx.actor.id ? null : (comment ?? null));

export { oid };
