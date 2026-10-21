import type { Types } from 'mongoose';
import { AcademicYear } from '../../../models/AcademicYear';
import { AttendanceRecord } from '../../../models/AttendanceRecord';
import { ClassModel } from '../../../models/Class';
import { Score } from '../../../models/Score';
import { User } from '../../../models/User';
import { objectIdSchema } from '../../../core/validators';
import { addDaysStr } from '../../../utils/clock';
import { isoWeekday } from '../../../utils/dates';
import { round2 } from '../../../utils/dayScore';
import { loadClassOrThrow, metaOf, oid, type ReportCtx } from '../reports.data';
import type { ReportLayout } from '../reports.layout';
import { fmtDateTime } from '../reports.labels';
import { assertRowLimit, reportQuery } from '../reports.params';

export const teachersQuery = reportQuery({ classId: objectIdSchema.optional() });

/** Davr ichidagi ish kunlari soni (workingWeekdays bo'yicha) */
function countWorkingDays(from: string, to: string, weekdays: number[]): number {
  let n = 0;
  for (let d = from; d <= to; d = addDaysStr(d, 1)) if (weekdays.includes(isoWeekday(d))) n++;
  return n;
}

/**
 * Qamrov: kutilgan (ish kunlari x o'qituvchining hozirgi sinflari) to'plami va uning ichidagi baholangan
 * (sinf, kun) juftliklari. Dam olish kuni, davrdan tashqari yoki boshqa sinfga qo'yilgan baholar qamrovga kirmaydi;
 * takror juftliklar bir marta sanaladi. Shuning uchun scored <= expected, rate <= 100 (expected = 0 bo'lsa null).
 */
export function computeCoverage(input: {
  from: string;
  to: string;
  workingWeekdays: number[];
  classIds: string[];
  scored: { classId: string; date: string }[];
}) {
  const classSet = new Set(input.classIds);
  const expected = countWorkingDays(input.from, input.to, input.workingWeekdays) * classSet.size;
  const pairs = new Set<string>();
  for (const r of input.scored) {
    if (!classSet.has(r.classId)) continue;
    if (r.date < input.from || r.date > input.to) continue;
    if (!input.workingWeekdays.includes(isoWeekday(r.date))) continue;
    pairs.add(`${r.classId}|${r.date}`);
  }
  return {
    expectedClassDays: expected,
    scoredClassDays: pairs.size,
    rate: expected > 0 ? round2((pairs.size / expected) * 100) : null,
  };
}

export async function buildTeachersReport(ctx: ReportCtx, q: { classId?: string }) {
  if (q.classId) await loadClassOrThrow(ctx, q.classId);

  // Faol o'quv yilidagi sinflar
  const year = await AcademicYear.findOne({ schoolId: ctx.schoolId, isActive: true })
    .select('_id')
    .lean();
  const classFilter: Record<string, unknown> = { schoolId: ctx.schoolId, isArchived: false };
  if (year) classFilter.academicYearId = year._id;
  else classFilter.academicYearId = null;
  if (q.classId) classFilter._id = q.classId;
  const classes = await ClassModel.find(classFilter).select('name teacherIds').lean();

  const teacherFilter: Record<string, unknown> = { schoolId: ctx.schoolId, role: 'teacher' };
  if (q.classId) teacherFilter._id = { $in: classes.flatMap((c) => c.teacherIds) };
  const teachers = await User.find(teacherFilter)
    .select('fullName username isActive')
    .sort({ fullName: 1 })
    .lean();
  assertRowLimit(teachers.length);
  const tIds = teachers.map((t) => t._id as Types.ObjectId);

  const range = { $gte: ctx.from, $lte: ctx.to };
  const scoreMatch: Record<string, unknown> = {
    schoolId: oid(ctx.schoolId),
    isDeleted: false,
    date: range,
    teacherId: { $in: tIds },
  };
  const attMatch: Record<string, unknown> = {
    schoolId: oid(ctx.schoolId),
    isDeleted: false,
    date: range,
    markedBy: { $in: tIds },
  };
  if (q.classId) {
    scoreMatch.classId = oid(q.classId);
    attMatch.classId = oid(q.classId);
  }
  const [scoreRows, attRows] = await Promise.all([
    Score.aggregate<{
      _id: { t: Types.ObjectId; d: string; c: Types.ObjectId };
      n: number;
      students: Types.ObjectId[];
      last: Date;
    }>([
      { $match: scoreMatch },
      {
        $group: {
          _id: { t: '$teacherId', d: '$date', c: '$classId' },
          n: { $sum: 1 },
          students: { $addToSet: '$studentId' },
          last: { $max: '$createdAt' },
        },
      },
    ]),
    AttendanceRecord.aggregate<{ _id: { t: Types.ObjectId; d: string }; n: number; last: Date }>([
      { $match: attMatch },
      {
        $group: {
          _id: { t: '$markedBy', d: '$date' },
          n: { $sum: 1 },
          last: { $max: '$createdAt' },
        },
      },
    ]),
  ]);

  const rows = teachers.map((t) => {
    const id = String(t._id);
    const tClasses = classes.filter((c) => c.teacherIds.some((x) => String(x) === id));
    const sc = scoreRows.filter((r) => String(r._id.t) === id);
    const at = attRows.filter((r) => String(r._id.t) === id);
    const students = new Set<string>();
    for (const r of sc) for (const s of r.students) students.add(String(s));
    const coverage = computeCoverage({
      from: ctx.from,
      to: ctx.to,
      workingWeekdays: ctx.attendance.workingWeekdays,
      classIds: tClasses.map((c) => String(c._id)),
      scored: sc.map((r) => ({ classId: String(r._id.c), date: r._id.d })),
    });
    const last = [...sc.map((r) => r.last), ...at.map((r) => r.last)].sort((a, b) => +b - +a)[0];
    return {
      teacherId: id,
      fullName: t.fullName,
      username: t.username,
      isActive: t.isActive,
      classes: tClasses.map((c) => ({ id: String(c._id), name: c.name })),
      scoresCount: sc.reduce((s, r) => s + r.n, 0),
      daysActive: new Set(sc.map((r) => r._id.d)).size,
      studentsScored: students.size,
      attendanceUnits: at.reduce((s, r) => s + r.n, 0),
      attendanceDays: new Set(at.map((r) => r._id.d)).size,
      lastActivityAt: last ? new Date(last).toISOString() : null,
      coverage,
    };
  });
  return { meta: metaOf(ctx, 'teachers', ctx), teachers: rows };
}

export type TeachersReport = Awaited<ReturnType<typeof buildTeachersReport>>;

export function teachersLayout(d: TeachersReport): ReportLayout {
  return {
    title: "O'qituvchilar faolligi hisoboti",
    fileBase: 'oqituvchilar',
    orientation: 'landscape',
    meta: d.meta,
    kpis: [
      { label: "O'qituvchilar", value: d.teachers.length },
      { label: 'Baholar jami', value: d.teachers.reduce((s, t) => s + t.scoresCount, 0) },
      { label: 'Davomat birliklari', value: d.teachers.reduce((s, t) => s + t.attendanceUnits, 0) },
      {
        label: "Faol o'qituvchilar",
        value: d.teachers.filter((t) => t.scoresCount > 0 || t.attendanceUnits > 0).length,
      },
    ],
    tables: [
      {
        title: "O'qituvchilar",
        columns: [
          { header: 'F.I.Sh.', key: 'fullName', width: 30 },
          { header: 'Login', key: 'username', width: 16 },
          { header: 'Holati', key: 'status', width: 10 },
          { header: 'Sinflar', key: 'classes', width: 22 },
          { header: 'Baholar', key: 'scoresCount', width: 9, type: 'int', align: 'right' },
          { header: 'Faol kunlar', key: 'daysActive', width: 10, type: 'int', align: 'right' },
          {
            header: "Baholangan o'quvchilar",
            key: 'studentsScored',
            width: 13,
            type: 'int',
            align: 'right',
          },
          {
            header: 'Davomat birliklari',
            key: 'attendanceUnits',
            width: 12,
            type: 'int',
            align: 'right',
          },
          {
            header: 'Davomat kunlari',
            key: 'attendanceDays',
            width: 11,
            type: 'int',
            align: 'right',
          },
          { header: 'Kutilgan sinf-kun', key: 'expected', width: 11, type: 'int', align: 'right' },
          { header: 'Baholangan sinf-kun', key: 'scored', width: 12, type: 'int', align: 'right' },
          { header: 'Qamrov, %', key: 'rate', width: 10, type: 'percent', align: 'right' },
          { header: 'Oxirgi faollik', key: 'lastActivityAt', width: 18 },
        ],
        rows: d.teachers.map((t) => ({
          ...t,
          status: t.isActive ? 'Faol' : 'Nofaol',
          classes: t.classes.map((c) => c.name).join(', '),
          expected: t.coverage.expectedClassDays,
          scored: t.coverage.scoredClassDays,
          rate: t.coverage.rate,
          lastActivityAt: fmtDateTime(t.lastActivityAt),
        })),
      },
    ],
  };
}
