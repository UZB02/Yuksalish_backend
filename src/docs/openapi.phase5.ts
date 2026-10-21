// 5-bosqich OpenAPI qismi: davomat, davomat holatlari, settings/attendance
import type { DocHelpers } from './openapi.phase2';

type Obj = Record<string, unknown>;

export function buildPhase5(h: DocHelpers) {
  const { ref, okRes, errors, body, secured, idParam, schoolHeader } = h;
  const q = (name: string, type = 'string', description?: string) => ({
    name,
    in: 'query',
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
  const date = { type: 'string', format: 'date', example: '2026-10-14' };
  const dateTime = { type: 'string', format: 'date-time' };
  const idp = [idParam];
  const category = {
    type: 'string',
    enum: ['present', 'late', 'absent_excused', 'absent_unexcused'],
  };

  const op = (
    tag: string,
    summary: string,
    responses: Obj,
    opts: { params?: Obj[]; body?: Obj; header?: boolean } = {},
  ) => ({
    tags: [tag],
    summary,
    security: secured,
    parameters: [...(opts.header === false ? [] : [schoolHeader]), ...(opts.params ?? [])],
    ...(opts.body ? { requestBody: body(opts.body) } : {}),
    responses: { ...responses, ...errors },
  });

  const tags = [
    {
      name: 'Attendance',
      description:
        'Davomat. Kunlik yoki dars rejimi (settings/attendance). Birlik: kunlik rejimda lessonNo=0',
    },
    {
      name: 'Attendance statuses',
      description: "Davomat holatlari. Yozish faqat superadmin; o'chirish yo'q",
    },
  ];

  const settings = {
    mode: { type: 'string', enum: ['daily', 'lesson'] },
    lessonsPerDay: { type: 'integer', minimum: 1, maximum: 12 },
    workingWeekdays: { type: 'array', items: int, description: 'ISO hafta kunlari, 1 = dushanba' },
    editWindowHours: int,
    backdateDays: int,
    noteRequiredCategories: { type: 'array', items: category },
    ratingImpact: o({
      enabled: bool,
      penaltyLate: num,
      penaltyAbsentExcused: num,
      penaltyAbsentUnexcused: num,
    }),
  };
  const statusRef = o({ id: str, name: str, shortName: str, color: str, category });
  const schemas: Obj = {
    AttendanceSettings: o(settings),
    AttendanceSettingsResult: o({
      effective: ref('AttendanceSettings'),
      global: { ...ref('AttendanceSettings'), nullable: true },
      override: { type: 'object', nullable: true },
    }),
    AttendanceStatus: o({
      id: str,
      schoolId: strNull,
      name: str,
      shortName: str,
      color: str,
      category,
      isDefault: bool,
      order: int,
      isActive: bool,
      createdAt: dateTime,
    }),
    AttendanceRecord: o({
      id: str,
      schoolId: str,
      studentId: str,
      student: o({ id: str, fullName: str }),
      classId: str,
      class: o({ id: str, name: str }),
      academicYearId: str,
      date,
      lessonNo: int,
      statusId: str,
      status: statusRef,
      minutesLate: intNull,
      note: strNull,
      markedBy: o({ id: str, fullName: str }),
      updatedBy: o({ id: str, fullName: str }),
      editable: bool,
      createdAt: dateTime,
      updatedAt: dateTime,
    }),
  };

  const statusFields = {
    name: str,
    shortName: { type: 'string', minLength: 1, maxLength: 3 },
    color: str,
    category,
    isDefault: bool,
    order: int,
  };
  const statusRes = { '200': okRes(ref('AttendanceStatus')) };
  const counts = { present: int, late: int, absentExcused: int, absentUnexcused: int };

  const paths: Obj = {
    '/settings/attendance': {
      get: op(
        'Settings',
        'Davomat sozlamalari: effective hamma rolga; global/override faqat superadmin va attendance.settings li admin',
        {
          '200': okRes(ref('AttendanceSettingsResult')),
        },
      ),
      put: op(
        'Settings',
        "Saqlash: superadmin (global yoki school) yoki attendance.settings li school_admin (faqat scope=school, o'z maktabi). ratingImpact to'liq obyekt sifatida almashtiriladi",
        { '200': okRes(ref('AttendanceSettingsResult')) },
        {
          body: o(
            {
              scope: { type: 'string', enum: ['global', 'school'] },
              schoolId: str,
              values: { type: 'object', nullable: true, properties: settings },
            },
            ['scope', 'values'],
          ),
        },
      ),
    },
    '/attendance-statuses': {
      get: op(
        'Attendance statuses',
        "Holatlar (global + maktab, order bo'yicha)",
        { '200': okRes({ type: 'array', items: ref('AttendanceStatus') }) },
        {
          params: [q('isActive', 'boolean'), q('scope', 'string', 'global | school | all')],
        },
      ),
      post: op(
        'Attendance statuses',
        "Yaratish (superadmin; schoolId yo'q = global)",
        { '201': okRes(ref('AttendanceStatus')) },
        {
          header: false,
          body: o({ ...statusFields, schoolId: strNull }, [
            'name',
            'shortName',
            'color',
            'category',
          ]),
        },
      ),
    },
    '/attendance-statuses/{id}': {
      patch: op(
        'Attendance statuses',
        "Tahrirlash (superadmin). Yozuvlari bor holat kategoriyasi o'zgarmaydi (409)",
        statusRes,
        {
          params: idp,
          header: false,
          body: o(statusFields),
        },
      ),
    },
    '/attendance-statuses/{id}/activate': {
      post: op('Attendance statuses', 'Faollashtirish', statusRes, { params: idp, header: false }),
    },
    '/attendance-statuses/{id}/deactivate': {
      post: op('Attendance statuses', "Nofaol qilish (standart holat bo'lmasa)", statusRes, {
        params: idp,
        header: false,
      }),
    },
    '/classes/{id}/attendance-sheet': {
      get: op(
        'Attendance',
        "Davomat varag'i (attendance.take | view | edit; o'qituvchi faqat biriktirilgan sinf)",
        {
          '200': okRes(
            o({
              class: o({ id: str, name: str }),
              date,
              mode: { type: 'string', enum: ['daily', 'lesson'] },
              lessonNo: intNull,
              lessonsPerDay: int,
              isWorkingDay: bool,
              settings: ref('AttendanceSettings'),
              statuses: { type: 'array', items: ref('AttendanceStatus') },
              students: {
                type: 'array',
                items: o({
                  studentId: str,
                  fullName: str,
                  studentCode: strNull,
                  record: { nullable: true, ...ref('AttendanceRecord') },
                }),
              },
              summary: o({ total: int, marked: int, ...counts }),
            }),
          ),
        },
        {
          params: [
            ...idp,
            q('date', 'string', 'YYYY-MM-DD, default bugun'),
            q('lessonNo', 'integer', 'dars rejimida, default 1'),
          ],
        },
      ),
    },
    '/attendance/bulk': {
      post: op(
        'Attendance',
        'Ommaviy davomat (UPSERT, max 200, qisman muvaffaqiyat). Kunlik rejimda lessonNo berilmaydi, dars rejimida majburiy',
        {
          '200': okRes(
            o({
              created: int,
              updated: int,
              failed: { type: 'array', items: o({ studentId: str, code: str, message: str }) },
            }),
          ),
        },
        {
          body: o(
            {
              classId: str,
              date,
              lessonNo: int,
              items: {
                type: 'array',
                items: o({ studentId: str, statusId: str, minutesLate: intNull, note: strNull }, [
                  'studentId',
                  'statusId',
                ]),
              },
            },
            ['classId', 'items'],
          ),
        },
      ),
    },
    '/attendance': {
      get: op(
        'Attendance',
        "Tarix. O'qituvchi o'z sinflari (barcha yozuvlar); admin: attendance.view | edit | take",
        { '200': okRes({ type: 'array', items: ref('AttendanceRecord') }) },
        {
          params: [
            q('classId'),
            q('studentId'),
            q('statusId'),
            q('category'),
            q('from', 'string', 'YYYY-MM-DD'),
            q('to', 'string', 'YYYY-MM-DD'),
            q('lessonNo', 'integer'),
            q('page', 'integer'),
            q('limit', 'integer'),
            q('sort', 'string', 'date | -date'),
          ],
        },
      ),
    },
    '/attendance/summary': {
      get: op(
        'Attendance',
        "Sinf/o'quvchilar statistikasi (o'qituvchi: o'z sinflari; admin: attendance.view). Davr <= 366 kun",
        {
          '200': okRes(
            o({
              from: date,
              to: date,
              unit: { type: 'string', enum: ['day', 'lesson', 'mixed'] },
              class: o({ ...counts, total: int, rate: numNull }),
              students: {
                type: 'array',
                items: o({ studentId: str, fullName: str, ...counts, total: int, rate: numNull }),
              },
            }),
          ),
        },
        {
          params: [
            q('classId'),
            q('from', 'string', 'YYYY-MM-DD'),
            q('to', 'string', 'YYYY-MM-DD'),
          ],
        },
      ),
    },
    '/attendance/today-progress': {
      get: op('Attendance', "Bugungi davomat olish jarayoni (ish kuni bo'lmasa bo'sh massiv)", {
        '200': okRes({
          type: 'array',
          items: o({
            classId: str,
            className: str,
            markedUnits: int,
            totalUnits: int,
            markedStudents: int,
            totalStudents: int,
          }),
        }),
      }),
    },
    '/attendance/{id}': {
      patch: op(
        'Attendance',
        "Tahrirlash: o'z yozuvi tahrir oynasida, yoki attendance.edit",
        { '200': okRes(ref('AttendanceRecord')) },
        {
          params: idp,
          body: o({ statusId: str, minutesLate: intNull, note: strNull }),
        },
      ),
      delete: op(
        'Attendance',
        "O'chirish (soft delete)",
        { '200': okRes(o({ deleted: bool })) },
        { params: idp },
      ),
    },
    '/students/{id}/attendance-summary': {
      get: op(
        'Attendance',
        "O'quvchi davomat xulosasi (default: oxirgi 30 kun)",
        {
          '200': okRes(
            o({
              studentId: str,
              from: date,
              to: date,
              total: int,
              ...counts,
              rate: numNull,
              byStatus: {
                type: 'array',
                items: o({ statusId: str, name: str, color: str, category, count: int }),
              },
              days: {
                type: 'array',
                items: o({
                  date,
                  category,
                  lessons: int,
                  records: { type: 'array', items: o({ lessonNo: int, statusId: str, category }) },
                }),
              },
              recent: { type: 'array', items: ref('AttendanceRecord') },
            }),
          ),
        },
        { params: [...idp, q('from', 'string', 'YYYY-MM-DD'), q('to', 'string', 'YYYY-MM-DD')] },
      ),
    },
  };

  return { tags, schemas, paths };
}
