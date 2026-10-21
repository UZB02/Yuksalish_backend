import { AcademicYear } from '../../../models/AcademicYear';
import { AttendanceRecord } from '../../../models/AttendanceRecord';
import { ClassModel } from '../../../models/Class';
import { Student } from '../../../models/Student';
import { User } from '../../../models/User';
import { round2 } from '../../../utils/dayScore';
import {
  distribution,
  emptyAtt,
  finishAtt,
  liveRating,
  loadAttendance,
  loadBehavior,
  loadDays,
  loadTypeInfo,
  mean,
  metaOf,
  oid,
  type ReportCtx,
} from '../reports.data';
import { fmtNum, type ReportLayout } from '../reports.layout';
import { fmtDateShort, kindLabel } from '../reports.labels';
import { assertRowLimit, reportQuery } from '../reports.params';

export const schoolQuery = reportQuery({});

export async function buildSchoolReport(ctx: ReportCtx) {
  const year = await AcademicYear.findOne({ schoolId: ctx.schoolId, isActive: true })
    .select('_id')
    .lean();
  const classes = year
    ? await ClassModel.find({ schoolId: ctx.schoolId, academicYearId: year._id, isArchived: false })
        .sort({ grade: 1, name: 1 })
        .lean()
    : [];
  assertRowLimit(classes.length);
  const students = await Student.find({
    schoolId: ctx.schoolId,
    isDeleted: false,
    status: 'active',
  })
    .select('classId')
    .lean();
  const classOf = new Map(students.map((s) => [String(s._id), String(s.classId)]));
  const teachersCount = await User.countDocuments({
    schoolId: ctx.schoolId,
    role: 'teacher',
    isActive: true,
  });

  const [dayRows, att, beh, live, attDaily] = await Promise.all([
    loadDays(ctx),
    loadAttendance(ctx),
    loadBehavior(ctx),
    liveRating(ctx),
    AttendanceRecord.aggregate<{ _id: { d: string; c: string }; n: number }>([
      {
        $match: {
          schoolId: oid(ctx.schoolId),
          isDeleted: false,
          date: { $gte: ctx.from, $lte: ctx.to },
        },
      },
      { $group: { _id: { d: '$date', c: '$category' }, n: { $sum: 1 } } },
    ]),
  ]);
  const types = await loadTypeInfo(beh.map((b) => b.typeId));

  // Sinf bo'yicha kunlik ball birliklari va baholar soni
  const perClass = new Map<string, { days: number[]; scores: number }>();
  for (const r of dayRows) {
    const cid = classOf.get(r.studentId);
    if (!cid) continue;
    const cur = perClass.get(cid) ?? { days: [], scores: 0 };
    cur.days.push(r.day);
    cur.scores += r.n;
    perClass.set(cid, cur);
  }
  const attPerClass = new Map<string, ReturnType<typeof emptyAtt>>();
  for (const [sid, a] of att) {
    const cid = classOf.get(sid);
    if (!cid) continue;
    const cur = attPerClass.get(cid) ?? emptyAtt();
    cur.present += a.present;
    cur.late += a.late;
    cur.absentExcused += a.absentExcused;
    cur.absentUnexcused += a.absentUnexcused;
    attPerClass.set(cid, cur);
  }
  const studentsPerClass = new Map<string, number>();
  for (const cid of classOf.values())
    studentsPerClass.set(cid, (studentsPerClass.get(cid) ?? 0) + 1);

  const classRows = classes.map((c) => {
    const id = String(c._id);
    const pc = perClass.get(id);
    const rc = live.byClass.get(id);
    const a = finishAtt(attPerClass.get(id) ?? emptyAtt());
    return {
      classId: id,
      className: c.name,
      grade: c.grade,
      studentsCount: studentsPerClass.get(id) ?? 0,
      ratedStudents: rc?.ratedStudents ?? 0,
      avgScore: mean(pc?.days ?? []),
      ratingScore: rc ? rc.score : null,
      rank: rc?.rank ?? null,
      attendanceRate: a.rate,
      scoresCount: pc?.scores ?? 0,
    };
  });

  // Kunlik dinamika (faqat ma'lumot bor kunlar)
  const daily = new Map<
    string,
    { days: number[]; scores: number; present: number; total: number }
  >();
  const slot = (d: string) => daily.get(d) ?? { days: [], scores: 0, present: 0, total: 0 };
  for (const r of dayRows) {
    const cur = slot(r.date);
    cur.days.push(r.day);
    cur.scores += r.n;
    daily.set(r.date, cur);
  }
  for (const r of attDaily) {
    const cur = slot(r._id.d);
    cur.total += r.n;
    if (r._id.c === 'present' || r._id.c === 'late') cur.present += r.n;
    daily.set(r._id.d, cur);
  }
  const dailyTrend = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      avgScore: mean(v.days),
      attendanceRate: v.total > 0 ? round2((v.present / v.total) * 100) : null,
      scoresCount: v.scores,
    }));
  assertRowLimit(classRows.length + dailyTrend.length);

  const attTotal = emptyAtt();
  for (const a of att.values()) {
    attTotal.present += a.present;
    attTotal.late += a.late;
    attTotal.absentExcused += a.absentExcused;
    attTotal.absentUnexcused += a.absentUnexcused;
  }
  finishAtt(attTotal);

  return {
    meta: metaOf(ctx, 'school', ctx),
    totals: {
      students: students.length,
      classes: classes.length,
      teachers: teachersCount,
      scoresCount: dayRows.reduce((s, d) => s + d.n, 0),
      avgScore: mean(dayRows.map((d) => d.day)),
      attendanceRate: attTotal.rate,
      penaltyTotal: round2([...live.byStudent.values()].reduce((s, r) => s + r.penalty, 0)),
    },
    classes: classRows,
    behaviorDistribution: distribution(beh, types),
    dailyTrend,
  };
}

export type SchoolReport = Awaited<ReturnType<typeof buildSchoolReport>>;

export function schoolLayout(d: SchoolReport): ReportLayout {
  return {
    title: 'Maktab hisoboti',
    fileBase: 'maktab',
    orientation: 'landscape',
    meta: d.meta,
    kpis: [
      { label: "O'quvchilar", value: d.totals.students },
      { label: 'Sinflar', value: d.totals.classes },
      { label: "O'qituvchilar", value: d.totals.teachers },
      { label: 'Baholar soni', value: d.totals.scoresCount },
      { label: "O'rtacha ball", value: fmtNum(d.totals.avgScore) },
      { label: 'Davomat, %', value: fmtNum(d.totals.attendanceRate) },
      { label: 'Jarima jami', value: fmtNum(d.totals.penaltyTotal) },
    ],
    chart: {
      title: "Kunlik o'rtacha ball",
      points: d.dailyTrend
        .filter((t) => t.avgScore !== null)
        .map((t) => ({ label: fmtDateShort(t.date), value: t.avgScore as number })),
      yMin: 0,
      yMax: 100,
    },
    tables: [
      {
        title: 'Sinflar',
        columns: [
          { header: 'Sinf', key: 'className', width: 12 },
          { header: 'Parallel', key: 'grade', width: 9, type: 'int', align: 'center' },
          { header: "O'quvchilar", key: 'studentsCount', width: 11, type: 'int', align: 'right' },
          { header: 'Reytingda', key: 'ratedStudents', width: 10, type: 'int', align: 'right' },
          { header: "O'rtacha ball", key: 'avgScore', width: 12, type: 'number', align: 'right' },
          { header: 'Reyting bali', key: 'ratingScore', width: 12, type: 'number', align: 'right' },
          { header: "O'rin", key: 'rank', width: 7, type: 'int', align: 'center' },
          {
            header: 'Davomat, %',
            key: 'attendanceRate',
            width: 11,
            type: 'percent',
            align: 'right',
          },
          { header: 'Baholar', key: 'scoresCount', width: 9, type: 'int', align: 'right' },
        ],
        rows: d.classes.map((c) => ({ ...c })),
      },
      {
        title: 'Xulq turlari',
        colorKey: 'color',
        colorColumn: 'name',
        columns: [
          { header: 'Xulq turi', key: 'name', width: 30 },
          { header: 'Turi', key: 'kind', width: 12 },
          { header: 'Soni', key: 'count', width: 10, type: 'int', align: 'right' },
        ],
        rows: d.behaviorDistribution.map((b) => ({ ...b, kind: kindLabel(b.kind) })),
      },
      {
        title: 'Kunlik dinamika',
        columns: [
          { header: 'Sana', key: 'date', width: 14, type: 'date' },
          { header: "O'rtacha ball", key: 'avgScore', width: 14, type: 'number', align: 'right' },
          {
            header: 'Davomat, %',
            key: 'attendanceRate',
            width: 14,
            type: 'percent',
            align: 'right',
          },
          { header: 'Baholar', key: 'scoresCount', width: 10, type: 'int', align: 'right' },
        ],
        rows: d.dailyTrend.map((t) => ({ ...t })),
      },
    ],
  };
}
