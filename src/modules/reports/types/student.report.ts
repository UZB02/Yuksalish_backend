import { AttendanceRecord } from '../../../models/AttendanceRecord';
import { ClassModel } from '../../../models/Class';
import { Score } from '../../../models/Score';
import { SubjectGrade } from '../../../models/SubjectGrade';
import { Subject } from '../../../models/Subject';
import { Student } from '../../../models/Student';
import { User } from '../../../models/User';
import { AppError } from '../../../core/errors';
import { isId } from '../../../utils/helpers';
import {
  commentFor,
  distribution,
  emptyAtt,
  finishAtt,
  addAtt,
  groupDays,
  liveRating,
  loadBehavior,
  loadDays,
  loadGradeStats,
  loadTypeInfo,
  metaOf,
  type ReportCtx,
} from '../reports.data';
import { fmtNum, type ReportLayout } from '../reports.layout';
import { reportQuery } from '../reports.params';
import { categoryLabel, fmtDateShort } from '../reports.labels';
import { dayStatus, worstCategory } from '../../attendance/attendance.stats';
import type { AttendanceCategory } from '../../settings/attendance.settings';

export const studentQuery = reportQuery({});

const ENTRIES_LIMIT = 200;

export async function buildStudentReport(ctx: ReportCtx, studentId: string) {
  const notFound = AppError.notFound("O'quvchi topilmadi");
  if (!isId(studentId)) throw notFound;
  const st = await Student.findOne({ _id: studentId, schoolId: ctx.schoolId, isDeleted: false });
  if (!st) throw notFound;
  if (ctx.classScope && !ctx.classScope.includes(String(st.classId))) throw notFound;
  const cls = await ClassModel.findById(st.classId).select('name').lean();

  const sid = [st._id];
  const [dayRows, beh, live, attRecords, scores, gradeStats, gradeDocs] = await Promise.all([
    loadDays(ctx, sid),
    loadBehavior(ctx, sid),
    liveRating(ctx),
    AttendanceRecord.find({
      schoolId: ctx.schoolId,
      studentId: st._id,
      isDeleted: false,
      date: { $gte: ctx.from, $lte: ctx.to },
    })
      .sort({ date: 1, lessonNo: 1 })
      .lean(),
    Score.find({
      schoolId: ctx.schoolId,
      studentId: st._id,
      isDeleted: false,
      date: { $gte: ctx.from, $lte: ctx.to },
    })
      .sort({ date: -1, createdAt: -1 })
      .limit(ENTRIES_LIMIT)
      .lean(),
    loadGradeStats(ctx, sid),
    SubjectGrade.find({
      schoolId: ctx.schoolId,
      studentId: st._id,
      isDeleted: false,
      date: { $gte: ctx.from, $lte: ctx.to },
    })
      .sort({ date: -1, createdAt: -1 })
      .limit(ENTRIES_LIMIT)
      .lean(),
  ]);
  const gStats = gradeStats.get(String(st._id));
  const gradeSubjects = gradeDocs.length
    ? await Subject.find({ _id: { $in: [...new Set(gradeDocs.map((g) => String(g.subjectId)))] } })
        .select('name')
        .lean()
    : [];
  const gradeSubjectName = new Map(gradeSubjects.map((s) => [String(s._id), s.name]));
  const stats = groupDays(dayRows).get(String(st._id));
  const rt = live.byStudent.get(String(st._id));
  const eligible = !!rt?.eligible;
  // Sinfdoshlar maktab o'rni (tie-break bilan) tartibida -> sinf ichidagi o'rin
  const classPeers = [...live.byStudent.values()]
    .filter((r) => r.eligible && r.classId === String(st.classId))
    .sort((a, b) => (a.rank as number) - (b.rank as number));
  const ratedInClass = classPeers.length;
  const classRank = classPeers.findIndex((r) => r.studentId === String(st._id)) + 1;

  const types = await loadTypeInfo([
    ...beh.map((b) => b.typeId),
    ...scores.map((s) => (s.behaviorTypeId ? String(s.behaviorTypeId) : null)),
  ]);
  const teacherIds = [...new Set([...scores, ...gradeDocs].map((s) => String(s.teacherId)))];
  const teachers = teacherIds.length
    ? await User.find({ _id: { $in: teacherIds } })
        .select('fullName')
        .lean()
    : [];
  const tMap = new Map(teachers.map((t) => [String(t._id), t.fullName]));

  const att = emptyAtt();
  const byDate = new Map<string, AttendanceCategory[]>();
  for (const r of attRecords) {
    addAtt(att, r.category, 1);
    byDate.set(r.date, [...(byDate.get(r.date) ?? []), r.category]);
  }
  finishAtt(att);

  const showPrivate = !ctx.isTeacher;
  return {
    meta: metaOf(ctx, 'student', ctx),
    student: {
      id: st.id as string,
      fullName: st.fullName,
      studentCode: st.studentCode ?? null,
      birthDate: st.birthDate ? st.birthDate.toISOString().slice(0, 10) : null,
      gender: st.gender ?? null,
      class: { id: String(st.classId), name: cls?.name ?? '' },
      status: st.status,
      ...(showPrivate ? { parentPhone: st.parentPhone ?? null } : {}),
    },
    score: {
      avgScore: stats?.avg ?? null,
      minScore: stats?.min ?? null,
      maxScore: stats?.max ?? null,
      daysCount: stats?.days.length ?? 0,
      scoresCount: stats?.scoresCount ?? 0,
      rank: eligible ? (rt?.rank ?? null) : null,
      ratingScore: eligible ? (rt?.score ?? null) : null,
      classRank: eligible && classRank > 0 ? classRank : null,
      ratedStudentsInClass: ratedInClass,
    },
    subjectGrades: {
      average: gStats?.average ?? null,
      count: gStats?.count ?? 0,
      bySubject: gStats?.bySubject ?? [],
      entries: gradeDocs.map((g) => ({
        date: g.date,
        value: g.value,
        subject: { id: String(g.subjectId), name: gradeSubjectName.get(String(g.subjectId)) ?? '' },
        comment: commentFor(ctx, String(g.teacherId), g.comment),
        teacher: { id: String(g.teacherId), fullName: tMap.get(String(g.teacherId)) ?? '' },
      })),
    },
    trend: (stats?.days ?? []).map((d) => ({ date: d.date, dayScore: d.day })),
    behaviorDistribution: distribution(beh, types),
    attendance: {
      total: att.total,
      present: att.present,
      late: att.late,
      absentExcused: att.absentExcused,
      absentUnexcused: att.absentUnexcused,
      rate: att.rate,
      penalty: rt?.penalty ?? 0,
      days: [...byDate.entries()].map(([date, cats]) => ({
        date,
        category: worstCategory(cats),
        status: dayStatus(cats),
      })),
    },
    entries: scores.map((s) => {
      const t = s.behaviorTypeId ? types.get(String(s.behaviorTypeId)) : undefined;
      return {
        date: s.date,
        value: s.value,
        behaviorType: t ? { name: t.name, kind: t.kind, color: t.color } : null,
        comment: commentFor(ctx, String(s.teacherId), s.comment),
        teacher: { id: String(s.teacherId), fullName: tMap.get(String(s.teacherId)) ?? '' },
      };
    }),
  };
}

export type StudentReport = Awaited<ReturnType<typeof buildStudentReport>>;

export function studentLayout(d: StudentReport): ReportLayout {
  return {
    title: `O'quvchi hisoboti: ${d.student.fullName}`,
    fileBase: `oquvchi-${d.student.fullName}`,
    orientation: 'portrait',
    meta: d.meta,
    kpis: [
      { label: 'Sinf', value: d.student.class.name },
      { label: 'ID', value: d.student.studentCode ?? '—' },
      { label: "O'rtacha ball", value: fmtNum(d.score.avgScore) },
      { label: 'Min / Maks', value: `${d.score.minScore ?? '—'} / ${d.score.maxScore ?? '—'}` },
      { label: 'Baholangan kunlar', value: d.score.daysCount },
      { label: 'Baholar soni', value: d.score.scoresCount },
      { label: "Fan baholari o'rtachasi", value: fmtNum(d.subjectGrades.average) },
      { label: 'Fan baholari soni', value: d.subjectGrades.count },
      { label: "Sinfda o'rin", value: d.score.classRank ?? '—' },
      { label: "Maktabda o'rin", value: d.score.rank ?? '—' },
      { label: 'Reyting bali', value: fmtNum(d.score.ratingScore) },
      { label: 'Davomat, %', value: fmtNum(d.attendance.rate) },
      {
        label: 'Kechikish / Sababli / Sababsiz',
        value: `${d.attendance.late} / ${d.attendance.absentExcused} / ${d.attendance.absentUnexcused}`,
      },
      { label: 'Davomat jarimasi', value: fmtNum(d.attendance.penalty) },
    ],
    chart: {
      title: 'Kunlik ball dinamikasi',
      points: d.trend.map((t) => ({ label: fmtDateShort(t.date), value: t.dayScore })),
      yMin: 0,
      yMax: 100,
    },
    tables: [
      {
        title: 'Kunlik ballar',
        columns: [
          { header: 'Sana', key: 'date', width: 14, type: 'date' },
          { header: 'Kunlik ball', key: 'dayScore', width: 14, type: 'number', align: 'right' },
        ],
        rows: d.trend.map((t) => ({ ...t })),
      },
      {
        title: 'Baholar',
        colorKey: 'color',
        colorColumn: 'behavior',
        columns: [
          { header: 'Sana', key: 'date', width: 12, type: 'date' },
          { header: 'Ball', key: 'value', width: 7, type: 'int', align: 'right' },
          { header: 'Xulq turi', key: 'behavior', width: 24 },
          { header: "O'qituvchi", key: 'teacher', width: 26 },
          { header: 'Izoh', key: 'comment', width: 40 },
        ],
        rows: d.entries.map((e) => ({
          date: e.date,
          value: e.value,
          behavior: e.behaviorType?.name ?? '',
          color: e.behaviorType?.color ?? null,
          teacher: e.teacher.fullName,
          comment: e.comment ?? '',
        })),
      },
      {
        title: "Fanlar bo'yicha o'rtacha baho",
        columns: [
          { header: 'Fan', key: 'name', width: 28 },
          { header: "O'rtacha", key: 'average', width: 12, type: 'number', align: 'right' },
          { header: 'Baholar soni', key: 'count', width: 14, type: 'int', align: 'right' },
        ],
        rows: d.subjectGrades.bySubject.map((b) => ({ ...b })),
      },
      {
        title: 'Fan baholari',
        columns: [
          { header: 'Sana', key: 'date', width: 12, type: 'date' },
          { header: 'Fan', key: 'subject', width: 24 },
          { header: 'Baho', key: 'value', width: 7, type: 'int', align: 'right' },
          { header: "O'qituvchi", key: 'teacher', width: 26 },
          { header: 'Izoh', key: 'comment', width: 40 },
        ],
        rows: d.subjectGrades.entries.map((e) => ({
          date: e.date,
          subject: e.subject.name,
          value: e.value,
          teacher: e.teacher.fullName,
          comment: e.comment ?? '',
        })),
      },
      {
        title: 'Davomat',
        columns: [
          { header: 'Sana', key: 'date', width: 14, type: 'date' },
          { header: 'Holat', key: 'category', width: 22 },
        ],
        rows: d.attendance.days.map((x) => ({
          date: x.date,
          category: categoryLabel(x.status),
        })),
      },
    ],
  };
}
