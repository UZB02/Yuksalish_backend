import { ClassModel } from '../../../models/Class';
import { Student } from '../../../models/Student';
import { objectIdSchema } from '../../../core/validators';
import {
  loadBehavior,
  loadClassOrThrow,
  loadTypeInfo,
  metaOf,
  UNTYPED,
  type BehaviorRow,
  type ReportCtx,
} from '../reports.data';
import type { ReportLayout } from '../reports.layout';
import { kindLabel } from '../reports.labels';
import { assertRowLimit, reportQuery } from '../reports.params';

export const behaviorQuery = reportQuery({ classId: objectIdSchema.optional() });

const TOP = 10;

export async function buildBehaviorReport(ctx: ReportCtx, q: { classId?: string }) {
  if (q.classId) await loadClassOrThrow(ctx, q.classId);
  const studentFilter: Record<string, unknown> = { schoolId: ctx.schoolId, isDeleted: false };
  if (q.classId) studentFilter.classId = q.classId;
  const students = await Student.find(studentFilter).select('fullName classId').lean();
  assertRowLimit(students.length);
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const rows: BehaviorRow[] = await loadBehavior(
    ctx,
    q.classId ? students.map((s) => s._id) : undefined,
  );
  const types = await loadTypeInfo(rows.map((r) => r.typeId));
  const classes = await ClassModel.find({ schoolId: ctx.schoolId }).select('name').lean();
  const className = new Map(classes.map((c) => [String(c._id), c.name]));

  // Tur bo'yicha
  const typeAgg = new Map<string | null, { count: number; students: Set<string> }>();
  for (const r of rows) {
    const cur = typeAgg.get(r.typeId) ?? { count: 0, students: new Set<string>() };
    cur.count += r.n;
    cur.students.add(r.studentId);
    typeAgg.set(r.typeId, cur);
  }
  const byType = [...typeAgg.entries()]
    .map(([id, v]) => {
      const t = types.get(id) ?? UNTYPED;
      return {
        behaviorTypeId: id,
        name: t.name,
        kind: t.kind,
        color: t.color,
        count: v.count,
        studentsCount: v.students.size,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Turlar (kind) bo'yicha — turi yo'q baholar kind hisobiga kirmaydi
  const byKind = { positive: 0, negative: 0, neutral: 0 };
  for (const t of byType) if (t.behaviorTypeId) byKind[t.kind as keyof typeof byKind] += t.count;

  // Sinf bo'yicha (o'quvchining hozirgi sinfi)
  const classAgg = new Map<
    string,
    { positive: number; negative: number; neutral: number; total: number }
  >();
  // O'quvchilar bo'yicha eng ko'p ijobiy/salbiy
  const perStudent = { positive: new Map<string, number>(), negative: new Map<string, number>() };
  for (const r of rows) {
    const st = byId.get(r.studentId);
    if (!st) continue;
    const cid = String(st.classId);
    const cur = classAgg.get(cid) ?? { positive: 0, negative: 0, neutral: 0, total: 0 };
    cur.total += r.n;
    const kind = r.typeId ? types.get(r.typeId)?.kind : undefined;
    if (kind) cur[kind] += r.n;
    classAgg.set(cid, cur);
    if (kind === 'positive' || kind === 'negative') {
      perStudent[kind].set(r.studentId, (perStudent[kind].get(r.studentId) ?? 0) + r.n);
    }
  }
  const byClass = [...classAgg.entries()]
    .map(([id, v]) => ({ classId: id, className: className.get(id) ?? '', ...v }))
    .sort((a, b) => a.className.localeCompare(b.className, 'uz', { numeric: true }));

  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          (byId.get(a[0])?.fullName ?? '').localeCompare(byId.get(b[0])?.fullName ?? ''),
      )
      .slice(0, TOP)
      .map(([id, count]) => {
        const st = byId.get(id);
        return {
          studentId: id,
          fullName: st?.fullName ?? '',
          className: className.get(String(st?.classId)) ?? '',
          count,
        };
      });

  return {
    meta: metaOf(ctx, 'behavior', ctx),
    byType,
    byKind,
    byClass,
    topStudents: { positive: top(perStudent.positive), negative: top(perStudent.negative) },
  };
}

export type BehaviorReport = Awaited<ReturnType<typeof buildBehaviorReport>>;

export function behaviorLayout(d: BehaviorReport): ReportLayout {
  const topCols = [
    { header: 'F.I.Sh.', key: 'fullName', width: 30 },
    { header: 'Sinf', key: 'className', width: 12 },
    { header: 'Soni', key: 'count', width: 8, type: 'int' as const, align: 'right' as const },
  ];
  return {
    title: 'Xulq hisoboti',
    fileBase: 'xulq',
    orientation: 'portrait',
    meta: d.meta,
    kpis: [
      { label: 'Ijobiy', value: d.byKind.positive },
      { label: 'Salbiy', value: d.byKind.negative },
      { label: 'Neytral', value: d.byKind.neutral },
    ],
    tables: [
      {
        title: 'Xulq turlari',
        colorKey: 'color',
        colorColumn: 'name',
        columns: [
          { header: 'Xulq turi', key: 'name', width: 30 },
          { header: 'Turi', key: 'kind', width: 12 },
          { header: 'Soni', key: 'count', width: 9, type: 'int', align: 'right' },
          { header: "O'quvchilar", key: 'studentsCount', width: 11, type: 'int', align: 'right' },
        ],
        rows: d.byType.map((t) => ({ ...t, kind: kindLabel(t.kind) })),
      },
      {
        title: 'Sinflar',
        columns: [
          { header: 'Sinf', key: 'className', width: 14 },
          { header: 'Ijobiy', key: 'positive', width: 9, type: 'int', align: 'right' },
          { header: 'Salbiy', key: 'negative', width: 9, type: 'int', align: 'right' },
          { header: 'Neytral', key: 'neutral', width: 9, type: 'int', align: 'right' },
          { header: 'Jami', key: 'total', width: 9, type: 'int', align: 'right' },
        ],
        rows: d.byClass.map((c) => ({ ...c })),
      },
      {
        title: "Eng ko'p ijobiy (top 10)",
        columns: topCols,
        rows: d.topStudents.positive.map((s) => ({ ...s })),
      },
      {
        title: "Eng ko'p salbiy (top 10)",
        columns: topCols,
        rows: d.topStudents.negative.map((s) => ({ ...s })),
      },
    ],
  };
}
