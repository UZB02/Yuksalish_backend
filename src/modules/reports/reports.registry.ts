import type { ZodType } from 'zod';
import type { AuthUser } from '../../types/express';
import { makeCtx } from './reports.data';
import { countRows, type ReportLayout, type ReportMeta } from './reports.layout';
import { assertRowLimit } from './reports.params';
import { behaviorLayout, behaviorQuery, buildBehaviorReport } from './types/behavior.report';
import { buildClassReport, classLayout, classQuery } from './types/class.report';
import { buildSchoolReport, schoolLayout, schoolQuery } from './types/school.report';
import { buildSchoolsReport, schoolsLayout, schoolsQuery } from './types/schools.report';
import { buildStudentReport, studentLayout, studentQuery } from './types/student.report';
import { buildTeachersReport, teachersLayout, teachersQuery } from './types/teachers.report';

export interface ReportResult {
  data: { meta: ReportMeta };
  layout: ReportLayout;
  /** Audit uchun parametrlar */
  params: Record<string, unknown>;
  rowCount: number;
}

export interface ReportDef {
  key: string;
  /** Express yo'li (prefikssiz) */
  path: string;
  schema: ZodType;
  /** O'qituvchi (reports.view bilan, faqat o'z sinflari) ko'ra oladimi */
  teacherAllowed: boolean;
  /** Maktab konteksti kerakmi (X-School-Id / user.schoolId) */
  schoolScoped: boolean;
  /** Faqat superadmin */
  superOnly?: boolean;
  run(
    actor: AuthUser,
    schoolId: string | null,
    q: Record<string, string>,
    id?: string,
  ): Promise<ReportResult>;
}

async function finish(
  data: { meta: ReportMeta },
  layout: ReportLayout,
  params: Record<string, unknown>,
): Promise<ReportResult> {
  const rowCount = countRows(layout);
  assertRowLimit(rowCount);
  return { data, layout, params, rowCount };
}

export const REPORTS: ReportDef[] = [
  {
    key: 'class',
    path: '/class',
    schema: classQuery,
    teacherAllowed: true,
    schoolScoped: true,
    async run(actor, schoolId, q) {
      const ctx = await makeCtx(actor, schoolId as string, q.from, q.to);
      const data = await buildClassReport(ctx, { classId: q.classId });
      return finish(data, classLayout(data), { classId: q.classId, from: q.from, to: q.to });
    },
  },
  {
    key: 'student',
    path: '/student/:id',
    schema: studentQuery,
    teacherAllowed: true,
    schoolScoped: true,
    async run(actor, schoolId, q, id) {
      const ctx = await makeCtx(actor, schoolId as string, q.from, q.to);
      const data = await buildStudentReport(ctx, id as string);
      return finish(data, studentLayout(data), { studentId: id, from: q.from, to: q.to });
    },
  },
  {
    key: 'teachers',
    path: '/teachers',
    schema: teachersQuery,
    teacherAllowed: false,
    schoolScoped: true,
    async run(actor, schoolId, q) {
      const ctx = await makeCtx(actor, schoolId as string, q.from, q.to);
      const data = await buildTeachersReport(ctx, { classId: q.classId });
      return finish(data, teachersLayout(data), {
        classId: q.classId ?? null,
        from: q.from,
        to: q.to,
      });
    },
  },
  {
    key: 'school',
    path: '/school',
    schema: schoolQuery,
    teacherAllowed: false,
    schoolScoped: true,
    async run(actor, schoolId, q) {
      const ctx = await makeCtx(actor, schoolId as string, q.from, q.to);
      const data = await buildSchoolReport(ctx);
      return finish(data, schoolLayout(data), { from: q.from, to: q.to });
    },
  },
  {
    key: 'behavior',
    path: '/behavior',
    schema: behaviorQuery,
    teacherAllowed: false,
    schoolScoped: true,
    async run(actor, schoolId, q) {
      const ctx = await makeCtx(actor, schoolId as string, q.from, q.to);
      const data = await buildBehaviorReport(ctx, { classId: q.classId });
      return finish(data, behaviorLayout(data), {
        classId: q.classId ?? null,
        from: q.from,
        to: q.to,
      });
    },
  },
  {
    key: 'schools',
    path: '/schools',
    schema: schoolsQuery,
    teacherAllowed: false,
    schoolScoped: false,
    superOnly: true,
    async run(actor, _schoolId, q) {
      const data = await buildSchoolsReport(actor, { from: q.from, to: q.to });
      return finish(data, schoolsLayout(data), { from: q.from, to: q.to });
    },
  },
];
