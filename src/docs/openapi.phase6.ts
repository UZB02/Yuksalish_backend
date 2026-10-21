// 6-bosqich OpenAPI qismi: hisobotlar (JSON + Excel/PDF eksport) va audit log
import type { DocHelpers } from './openapi.phase2';

type Obj = Record<string, unknown>;

export function buildPhase6(h: DocHelpers) {
  const { ref, okRes, errors, secured, schoolHeader } = h;
  const q = (name: string, type = 'string', description?: string, required = false) => ({
    name,
    in: 'query',
    required,
    schema: { type },
    ...(description ? { description } : {}),
  });
  const o = (properties: Obj, required?: string[]) => ({
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  });
  const str = { type: 'string' };
  const strNull = { type: 'string', nullable: true };
  const int = { type: 'integer' };
  const intNull = { type: 'integer', nullable: true };
  const num = { type: 'number' };
  const numNull = { type: 'number', nullable: true };
  const bool = { type: 'boolean' };
  const dateTime = { type: 'string', format: 'date-time' };

  const from = q('from', 'string', 'YYYY-MM-DD (majburiy)', true);
  const to = q('to', 'string', 'YYYY-MM-DD (majburiy, kelajak emas, davr <= 366 kun)', true);
  const format = q('format', 'string', 'xlsx (default) | pdf');

  const meta = o({
    generatedAt: dateTime,
    period: o({ from: str, to: str }),
    school: { nullable: true, ...o({ id: str, name: str }) },
    scope: str,
  });
  const att = o({
    present: int,
    late: int,
    absentExcused: int,
    absentUnexcused: int,
    total: int,
    rate: numNull,
  });
  const dist = {
    type: 'array',
    items: o({ behaviorTypeId: strNull, name: str, kind: str, color: str, count: int }),
  };

  const json = (
    summary: string,
    data: Obj,
    params: Obj[],
    opts: { header?: boolean; teacher?: boolean } = {},
  ) => ({
    tags: ['Reports'],
    summary: `${summary}${opts.teacher ? " (o'qituvchi: faqat o'z sinflari)" : " (o'qituvchiga 403)"}`,
    security: secured,
    parameters: [...(opts.header === false ? [] : [schoolHeader]), ...params, from, to],
    responses: { '200': okRes(o({ meta, ...(data.properties as Obj) })), ...errors },
  });
  const file = (summary: string, params: Obj[], opts: { header?: boolean } = {}) => ({
    tags: ['Reports'],
    summary: `${summary} — Excel/PDF fayl. reports.export (va reports.view) kerak; audit: reports.export; max qator REPORTS_MAX_ROWS`,
    security: secured,
    parameters: [...(opts.header === false ? [] : [schoolHeader]), ...params, from, to, format],
    responses: {
      '200': {
        description: 'Fayl (attachment, Cache-Control: no-store)',
        content: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
            schema: { type: 'string', format: 'binary' },
          },
          'application/pdf': { schema: { type: 'string', format: 'binary' } },
        },
      },
      ...errors,
    },
  });
  const classId = q('classId', 'string', 'Sinf identifikatori', true);
  const classIdOpt = q('classId');
  const idp = { name: 'id', in: 'path', required: true, schema: str };

  const tags = [
    {
      name: 'Reports',
      description: 'Hisobotlar (reports.view / reports.export). Davr: from, to majburiy',
    },
    { name: 'Audit' },
  ];

  const schemas: Obj = {
    AuditLogEntry: o({
      id: str,
      createdAt: dateTime,
      user: { nullable: true, ...o({ id: str, fullName: str, username: str, role: str }) },
      schoolId: strNull,
      school: { nullable: true, ...o({ id: str, name: str }) },
      action: str,
      entity: strNull,
      entityId: strNull,
      before: { nullable: true },
      after: { nullable: true },
      truncated: bool,
      ip: strNull,
    }),
  };

  const classData = o({
    class: o({
      id: str,
      name: str,
      grade: int,
      homeroomTeacher: { nullable: true, ...o({ id: str, fullName: str }) },
    }),
    summary: o({
      students: int,
      ratedStudents: int,
      avgScore: numNull,
      daysScored: int,
      scoresCount: int,
      attendanceRate: numNull,
      penaltyTotal: num,
    }),
    students: {
      type: 'array',
      items: o({
        studentId: str,
        fullName: str,
        studentCode: strNull,
        rank: intNull,
        ratingScore: numNull,
        avgScore: numNull,
        minScore: intNull,
        maxScore: intNull,
        daysCount: int,
        scoresCount: int,
        attendance: att,
        penalty: num,
        topBehavior: { nullable: true, ...o({ name: str, count: int }) },
      }),
    },
    behaviorDistribution: dist,
  });

  const paths: Obj = {
    '/reports/class': { get: json('Sinf hisoboti', classData, [classId], { teacher: true }) },
    '/reports/class/export': { get: file('Sinf hisoboti', [classId]) },
    '/reports/student/{id}': {
      get: json(
        "O'quvchi hisoboti (parentPhone faqat admin/superadmin; boshqa o'qituvchi izohi null)",
        o({
          student: o({
            id: str,
            fullName: str,
            studentCode: strNull,
            birthDate: strNull,
            gender: strNull,
            class: o({ id: str, name: str }),
            status: str,
            parentPhone: strNull,
          }),
          score: o({
            avgScore: numNull,
            minScore: intNull,
            maxScore: intNull,
            daysCount: int,
            scoresCount: int,
            rank: intNull,
            ratingScore: numNull,
            ratedStudentsInClass: int,
          }),
          trend: { type: 'array', items: o({ date: str, dayScore: num }) },
          behaviorDistribution: dist,
          attendance: o({
            total: int,
            present: int,
            late: int,
            absentExcused: int,
            absentUnexcused: int,
            rate: numNull,
            penalty: num,
            days: { type: 'array', items: o({ date: str, category: str }) },
          }),
          entries: {
            type: 'array',
            items: o({
              date: str,
              value: int,
              behaviorType: { nullable: true, ...o({ name: str, kind: str, color: str }) },
              comment: strNull,
              teacher: o({ id: str, fullName: str }),
            }),
          },
        }),
        [idp],
        { teacher: true },
      ),
    },
    '/reports/student/{id}/export': { get: file("O'quvchi hisoboti", [idp]) },
    '/reports/teachers': {
      get: json(
        "O'qituvchilar faolligi",
        o({
          teachers: {
            type: 'array',
            items: o({
              teacherId: str,
              fullName: str,
              username: str,
              isActive: bool,
              classes: { type: 'array', items: o({ id: str, name: str }) },
              scoresCount: int,
              daysActive: int,
              studentsScored: int,
              attendanceUnits: int,
              attendanceDays: int,
              lastActivityAt: { type: 'string', nullable: true },
              coverage: o({ expectedClassDays: int, scoredClassDays: int, rate: numNull }),
            }),
          },
        }),
        [classIdOpt],
      ),
    },
    '/reports/teachers/export': { get: file("O'qituvchilar faolligi", [classIdOpt]) },
    '/reports/school': {
      get: json(
        'Maktab hisoboti',
        o({
          totals: o({
            students: int,
            classes: int,
            teachers: int,
            scoresCount: int,
            avgScore: numNull,
            attendanceRate: numNull,
            penaltyTotal: num,
          }),
          classes: {
            type: 'array',
            items: o({
              classId: str,
              className: str,
              grade: int,
              studentsCount: int,
              ratedStudents: int,
              avgScore: numNull,
              ratingScore: numNull,
              rank: intNull,
              attendanceRate: numNull,
              scoresCount: int,
            }),
          },
          behaviorDistribution: dist,
          dailyTrend: {
            type: 'array',
            items: o({ date: str, avgScore: numNull, attendanceRate: numNull, scoresCount: int }),
          },
        }),
        [],
      ),
    },
    '/reports/school/export': { get: file('Maktab hisoboti', []) },
    '/reports/behavior': {
      get: json(
        'Xulq hisoboti',
        o({
          byType: {
            type: 'array',
            items: o({
              behaviorTypeId: strNull,
              name: str,
              kind: str,
              color: str,
              count: int,
              studentsCount: int,
            }),
          },
          byKind: o({ positive: int, negative: int, neutral: int }),
          byClass: {
            type: 'array',
            items: o({
              classId: str,
              className: str,
              positive: int,
              negative: int,
              neutral: int,
              total: int,
            }),
          },
          topStudents: o({
            positive: {
              type: 'array',
              items: o({ studentId: str, fullName: str, className: str, count: int }),
            },
            negative: {
              type: 'array',
              items: o({ studentId: str, fullName: str, className: str, count: int }),
            },
          }),
        }),
        [classIdOpt],
      ),
    },
    '/reports/behavior/export': { get: file('Xulq hisoboti', [classIdOpt]) },
    '/reports/schools': {
      get: json(
        'Maktablar solishtiruvi (faqat superadmin; X-School-Id shart emas)',
        o({
          schools: {
            type: 'array',
            items: o({
              schoolId: str,
              name: str,
              slug: str,
              enabled: bool,
              students: int,
              classes: int,
              teachers: int,
              scoresCount: int,
              avgScore: numNull,
              ratingScore: numNull,
              attendanceRate: numNull,
              activeTeachers: int,
            }),
          },
        }),
        [],
        { header: false },
      ),
    },
    '/reports/schools/export': { get: file('Maktablar solishtiruvi', [], { header: false }) },
    '/audit-logs': {
      get: {
        tags: ['Audit'],
        summary:
          "Audit log (audit.view). school_admin faqat o'z maktabi; superadmin hammasi. Faqat o'qiladi",
        security: secured,
        parameters: [
          q('from', 'string', 'YYYY-MM-DD (Asia/Tashkent kun boshi)'),
          q('to', 'string', 'YYYY-MM-DD (Asia/Tashkent kun oxiri)'),
          q('userId'),
          q('action', 'string', "Aniq qiymat yoki prefiks ('scores.')"),
          q('entity'),
          q('schoolId', 'string', 'Faqat superadmin uchun'),
          q('search', 'string', 'action / entity / foydalanuvchi ismi yoki username'),
          q('page', 'integer'),
          q('limit', 'integer', 'default 50, max 200'),
          q('sort', 'string', '-createdAt (default) | createdAt'),
        ],
        responses: { '200': okRes({ type: 'array', items: ref('AuditLogEntry') }), ...errors },
      },
    },
    '/audit-logs/filters': {
      get: {
        tags: ['Audit'],
        summary: 'Filtr qiymatlari: actions, entities, users (doira ichida)',
        security: secured,
        parameters: [q('schoolId', 'string', 'Faqat superadmin uchun')],
        responses: {
          '200': okRes(
            o({
              actions: { type: 'array', items: str },
              entities: { type: 'array', items: str },
              users: {
                type: 'array',
                items: o({ id: str, fullName: str, username: str, role: str }),
              },
            }),
          ),
          ...errors,
        },
      },
    },
  };

  return { tags, schemas, paths };
}
