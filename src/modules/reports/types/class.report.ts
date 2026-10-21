import { User } from '../../../models/User';
import { objectIdSchema } from '../../../core/validators';
import {
  distribution,
  finishAtt,
  emptyAtt,
  groupDays,
  liveRating,
  loadAttendance,
  loadBehavior,
  loadClassOrThrow,
  loadDays,
  loadGradeStats,
  loadStudents,
  loadTypeInfo,
  mean,
  metaOf,
  type ReportCtx,
} from '../reports.data';
import { fmtNum, type ReportLayout } from '../reports.layout';
import { kindLabel } from '../reports.labels';
import { assertRowLimit, reportQuery } from '../reports.params';
import { round2 } from '../../../utils/dayScore';

export const classQuery = reportQuery({ classId: objectIdSchema });

export async function buildClassReport(ctx: ReportCtx, q: { classId: string }) {
  const cls = await loadClassOrThrow(ctx, q.classId);
  const students = await loadStudents(ctx, [q.classId]);
  assertRowLimit(students.length);
  const ids = students.map((s) => s._id);

  const [dayRows, att, beh, live, homeroom, grades] = await Promise.all([
    loadDays(ctx, ids),
    loadAttendance(ctx, ids),
    loadBehavior(ctx, ids),
    liveRating(ctx),
    cls.homeroomTeacherId ? User.findById(cls.homeroomTeacherId).select('fullName').lean() : null,
    loadGradeStats(ctx, ids),
  ]);
  const days = groupDays(dayRows);
  const types = await loadTypeInfo(beh.map((b) => b.typeId));

  const rows = students.map((s) => {
    const id = String(s._id);
    const st = days.get(id);
    const rt = live.byStudent.get(id);
    const eligible = !!rt?.eligible;
    const a = att.get(id) ?? finishAtt(emptyAtt());
    const own = beh.filter((b) => b.studentId === id && b.typeId);
    const top = own.sort((x, y) => y.n - x.n)[0];
    return {
      studentId: id,
      fullName: s.fullName,
      studentCode: s.studentCode ?? null,
      rank: eligible ? (rt?.rank ?? null) : null,
      classRank: null as number | null,
      ratingScore: eligible ? (rt?.score ?? null) : null,
      avgScore: st?.avg ?? null,
      minScore: st?.min ?? null,
      maxScore: st?.max ?? null,
      daysCount: st?.days.length ?? 0,
      scoresCount: st?.scoresCount ?? 0,
      subjectAvg: grades.get(id)?.average ?? null,
      gradesCount: grades.get(id)?.count ?? 0,
      attendance: {
        present: a.present,
        late: a.late,
        absentExcused: a.absentExcused,
        absentUnexcused: a.absentUnexcused,
        total: a.total,
        rate: a.rate,
      },
      penalty: rt?.penalty ?? 0,
      topBehavior: top ? { name: types.get(top.typeId)?.name ?? '', count: top.n } : null,
    };
  });

  // Sinf ichidagi o'rin: maktab o'rni (tie-break bilan) tartibida
  rows
    .filter((r) => r.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .forEach((r, i) => (r.classRank = i + 1));

  const attTotal = emptyAtt();
  for (const a of att.values()) {
    attTotal.present += a.present;
    attTotal.late += a.late;
    attTotal.absentExcused += a.absentExcused;
    attTotal.absentUnexcused += a.absentUnexcused;
  }
  finishAtt(attTotal);

  return {
    meta: metaOf(ctx, 'class', ctx),
    class: {
      id: cls.id as string,
      name: cls.name,
      grade: cls.grade,
      homeroomTeacher: homeroom ? { id: String(homeroom._id), fullName: homeroom.fullName } : null,
    },
    summary: {
      students: rows.length,
      ratedStudents: rows.filter((r) => r.rank !== null).length,
      avgScore: mean(dayRows.map((d) => d.day)),
      daysScored: new Set(dayRows.map((d) => d.date)).size,
      scoresCount: dayRows.reduce((s, d) => s + d.n, 0),
      subjectAvg: mean([...grades.values()].flatMap((g) => Array(g.count).fill(g.average))),
      gradesCount: [...grades.values()].reduce((s, g) => s + g.count, 0),
      attendanceRate: attTotal.rate,
      penaltyTotal: round2(rows.reduce((s, r) => s + r.penalty, 0)),
    },
    students: rows,
    behaviorDistribution: distribution(beh, types),
  };
}

export type ClassReport = Awaited<ReturnType<typeof buildClassReport>>;

export function classLayout(d: ClassReport): ReportLayout {
  return {
    title: `Sinf hisoboti: ${d.class.name}`,
    fileBase: `sinf-${d.class.name}`,
    orientation: 'landscape',
    meta: d.meta,
    kpis: [
      { label: "O'quvchilar", value: d.summary.students },
      { label: 'Reytingda', value: d.summary.ratedStudents },
      { label: "O'rtacha ball", value: fmtNum(d.summary.avgScore) },
      { label: 'Baholangan kunlar', value: d.summary.daysScored },
      { label: 'Baholar soni', value: d.summary.scoresCount },
      { label: 'Davomat, %', value: fmtNum(d.summary.attendanceRate) },
      { label: 'Jarima jami', value: fmtNum(d.summary.penaltyTotal) },
      { label: 'Sinf rahbari', value: d.class.homeroomTeacher?.fullName ?? '—' },
    ],
    tables: [
      {
        title: "O'quvchilar",
        columns: [
          { header: 'F.I.Sh.', key: 'fullName', width: 30 },
          { header: 'ID', key: 'studentCode', width: 10 },
          { header: 'Sinfda', key: 'classRank', width: 7, type: 'int', align: 'center' },
          { header: 'Maktabda', key: 'rank', width: 8, type: 'int', align: 'center' },
          {
            header: 'Reyting bali',
            key: 'ratingScore',
            width: 10,
            type: 'number',
            align: 'right',
            short: 'Reyting',
          },
          { header: "O'rtacha", key: 'avgScore', width: 9, type: 'number', align: 'right' },
          { header: 'Min', key: 'minScore', width: 6, type: 'int', align: 'right' },
          { header: 'Maks', key: 'maxScore', width: 6, type: 'int', align: 'right' },
          { header: 'Kunlar', key: 'daysCount', width: 7, type: 'int', align: 'right' },
          { header: 'Baholar', key: 'scoresCount', width: 8, type: 'int', align: 'right' },
          {
            header: "Fan o'rtachasi",
            key: 'subjectAvg',
            width: 9,
            type: 'number',
            align: 'right',
            short: 'Fan',
          },
          { header: 'Keldi', key: 'present', width: 7, type: 'int', align: 'right' },
          {
            header: 'Kechikdi',
            key: 'late',
            width: 8,
            type: 'int',
            align: 'right',
            short: 'Kech.',
          },
          {
            header: 'Sababli',
            key: 'absentExcused',
            width: 8,
            type: 'int',
            align: 'right',
            short: 'Sab.',
          },
          {
            header: 'Sababsiz',
            key: 'absentUnexcused',
            width: 8,
            type: 'int',
            align: 'right',
            short: 'Sabs.',
          },
          {
            header: 'Davomat, %',
            key: 'rate',
            width: 10,
            type: 'percent',
            align: 'right',
            short: 'Dav. %',
          },
          { header: 'Jarima', key: 'penalty', width: 8, type: 'number', align: 'right' },
          { header: 'Ko‘p uchragan xulq', key: 'topBehavior', width: 22, short: 'Xulq' },
        ],
        legend: "Sinfda — sinf ichidagi o'rin, Maktabda — butun maktab bo'yicha o'rin.",
        rows: d.students.map((s) => ({
          ...s,
          ...s.attendance,
          topBehavior: s.topBehavior ? `${s.topBehavior.name} (${s.topBehavior.count})` : '',
        })),
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
    ],
  };
}
