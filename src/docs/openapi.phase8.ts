// 8-bosqich OpenAPI qismi: dars jadvali (P1)
import type { DocHelpers } from './openapi.phase2';

type Obj = Record<string, unknown>;

export function buildPhase8(h: DocHelpers) {
  const { ref, okRes, errors, body, secured, idParam, schoolHeader } = h;
  const q = (name: string, description?: string) => ({
    name,
    in: 'query',
    schema: { type: 'string' },
    ...(description ? { description } : {}),
  });
  const op = (summary: string, responses: Obj, opts: { params?: Obj[]; body?: Obj } = {}) => ({
    tags: ['Timetable'],
    summary,
    security: secured,
    parameters: [schoolHeader, ...(opts.params ?? [])],
    ...(opts.body ? { requestBody: body(opts.body) } : {}),
    responses: { ...responses, ...errors },
  });
  const o = (properties: Obj, required?: string[]) => ({
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  });
  const str = { type: 'string' };
  const int = { type: 'integer' };
  const bool = { type: 'boolean' };
  const date = { type: 'string', format: 'date', example: '2026-11-02' };
  const arr = (items: Obj) => ({ type: 'array', items });
  const classIdParam = { name: 'classId', in: 'path', required: true, schema: { type: 'string' } };
  const teacherIdParam = {
    name: 'teacherId',
    in: 'path',
    required: true,
    schema: { type: 'string' },
  };

  const tags = [
    {
      name: 'Timetable',
      description:
        "Dars jadvali (P1): sinf bo'yicha versiyalar (qoralama, faol, almashtirilgan), to'qnashuv ogohlantirishlari, resolver. " +
        "Yozish: timetable.manage. O'qish: timetable.view yoki o'qituvchi uchun o'z sinflari va o'z haftasi",
    },
  ];

  const schemas: Obj = {
    TimetableEntry: o(
      {
        weekday: { ...int, minimum: 1, maximum: 7 },
        lessonNo: { ...int, minimum: 1, maximum: 12 },
        subjectId: str,
        teacherId: str,
        groupKey: { type: 'string', nullable: true, description: 'Hozircha doim null' },
        room: { type: 'string', nullable: true },
        subject: { nullable: true, ...o({ id: str, name: str }) },
        teacher: { nullable: true, ...o({ id: str, fullName: str }) },
        outOfRange: {
          ...bool,
          description: 'Sozlamalar (ish kunlari yoki darslar soni) dan tashqarida',
        },
      },
      ['weekday', 'lessonNo', 'subjectId', 'teacherId'],
    ),
    TimetableVersionSummary: o({
      id: str,
      classId: str,
      status: { type: 'string', enum: ['draft', 'active', 'superseded'] },
      phase: { type: 'string', enum: ['draft', 'past', 'current', 'future'] },
      validFrom: date,
      validTo: { ...date, nullable: true },
      entryCount: int,
      note: { type: 'string', nullable: true },
      forced: bool,
      activatedAt: { type: 'string', format: 'date-time', nullable: true },
      updatedAt: { type: 'string', format: 'date-time' },
    }),
    TimetableWarning: o({
      code: {
        type: 'string',
        enum: [
          'teacher_double_booked',
          'teacher_not_assigned',
          'subject_inactive',
          'teacher_inactive',
          'out_of_range',
        ],
      },
      severity: { type: 'string', enum: ['error', 'warning'] },
      weekday: int,
      lessonNo: int,
      subjectId: str,
      teacherId: str,
      message: str,
      other: {
        nullable: true,
        ...o({
          classId: str,
          className: str,
          versionId: str,
          validFrom: date,
          validTo: date,
          versions: arr(o({ versionId: str, validFrom: date, validTo: date })),
        }),
      },
    }),
    ResolvedLesson: o({
      classId: str,
      date,
      weekday: int,
      lessonNo: int,
      groupKey: { type: 'string', nullable: true },
      subjectId: str,
      teacherId: str,
      room: { type: 'string', nullable: true },
      source: { type: 'string', enum: ['timetable', 'override'] },
      cancelled: bool,
      versionId: { type: 'string', nullable: true },
      class: { nullable: true, ...o({ id: str, name: str, grade: int }) },
      subject: o({ id: str, name: str }),
      teacher: o({ id: str, fullName: str }),
    }),
  };
  schemas.TimetableVersion = {
    allOf: [
      ref('TimetableVersionSummary'),
      o({ academicYearId: str, weekPattern: str, entries: arr(ref('TimetableEntry')) }),
    ],
  };
  const versionWithWarnings = o({
    version: ref('TimetableVersion'),
    warnings: arr(ref('TimetableWarning')),
  });
  const entriesBody = {
    entries: arr(
      o(
        {
          weekday: int,
          lessonNo: int,
          subjectId: str,
          teacherId: str,
          room: { type: 'string', nullable: true },
        },
        ['weekday', 'lessonNo', 'subjectId', 'teacherId'],
      ),
    ),
  };
  const activateProps = {
    validFrom: date,
    force: { ...bool, description: "To'qnashuv (teacher_double_booked) bo'lsa ham; note majburiy" },
    note: { type: 'string', nullable: true },
    syncAssignments: {
      ...bool,
      description: "Yetishmayotgan ClassSubject biriktirishlarini qo'shadi",
    },
    confirmPast: { ...bool, description: "O'tmish sanadan faollashtirishni tasdiqlash" },
  };
  const dateQ = q('date', 'YYYY-MM-DD (sukut: bugun)');
  const anyObj = { type: 'object' };

  const paths: Obj = {
    '/timetable/options': {
      get: op(
        "Muharrir tanlovlari: faol fanlar va o'qituvchilar, sinf biriktirishlari, fan -> o'qituvchilar",
        { '200': okRes(anyObj) },
        { params: [q('classId')] },
      ),
    },
    '/timetable/classes': {
      get: op("Sinflar bo'yicha jadval holati: joriy, kelgusi, qoralama, ogohlantirishlar soni", {
        '200': okRes(
          o({
            today: date,
            classes: arr(
              o({
                classId: str,
                name: str,
                grade: int,
                current: { nullable: true, ...ref('TimetableVersionSummary') },
                upcoming: { nullable: true, ...ref('TimetableVersionSummary') },
                draft: { nullable: true, ...ref('TimetableVersionSummary') },
                warningsCount: int,
                errorsCount: int,
              }),
            ),
          }),
        ),
      }),
    },
    '/timetable/classes/{classId}/versions': {
      get: op(
        "Sinf versiyalari (qoralamalar faqat timetable.manage uchun), sinf, o'quv yili va sozlamalar",
        {
          '200': okRes(
            o({
              class: o({ id: str, name: str, grade: int, isArchived: bool }),
              academicYear: o({ id: str, name: str, startDate: date, endDate: date }),
              settings: o({ workingWeekdays: arr(int), lessonsPerDay: int }),
              today: date,
              versions: arr(ref('TimetableVersionSummary')),
            }),
          ),
        },
        { params: [classIdParam] },
      ),
      post: op(
        "Qoralama yaratish (bo'sh yoki nusxa: 'active', versiya id yoki {classId})",
        { '201': okRes(versionWithWarnings) },
        {
          params: [classIdParam],
          body: o({
            validFrom: date,
            copyFrom: { description: "'active', versiya id yoki {classId}" },
            note: { type: 'string', nullable: true },
          }),
        },
      ),
    },
    '/timetable/versions/{id}/busy-teachers': {
      get: op(
        "Katak (hafta kuni + dars) uchun boshqa sinflarda band o'qituvchilar (timetable.manage)",
        {
          '200': okRes(o({ items: arr(o({ teacherId: str, classId: str, className: str })) })),
        },
        { params: [idParam, q('weekday'), q('lessonNo'), q('validFrom', 'YYYY-MM-DD')] },
      ),
    },
    '/timetable/versions/{id}': {
      get: op(
        "Versiya va ogohlantirishlar (validFrom so'rovi: taxminiy davr uchun)",
        { '200': okRes(versionWithWarnings) },
        { params: [idParam, q('validFrom', 'YYYY-MM-DD')] },
      ),
      put: op(
        "Qoralamani saqlash (butun yozuvlar ro'yxati, atomik). Javob: version va warnings",
        { '200': okRes(versionWithWarnings) },
        {
          params: [idParam],
          body: o({ ...entriesBody, validFrom: date, note: { type: 'string', nullable: true } }, [
            'entries',
          ]),
        },
      ),
      delete: op(
        "Qoralamani yoki kelajakdagi faol versiyani o'chirish (so'ng zanjir qayta hisoblanadi)",
        { '200': okRes(o({ deleted: bool })) },
        { params: [idParam] },
      ),
    },
    '/timetable/versions/{id}/activate': {
      post: op(
        "Faollashtirish. To'qnashuvda 409 (force va note bilan o'tadi), o'tmish sana uchun confirmPast",
        {
          '200': okRes(
            o({
              version: ref('TimetableVersion'),
              warnings: arr(ref('TimetableWarning')),
              syncedAssignments: arr(o({ subjectId: str, teacherId: str })),
            }),
          ),
        },
        { params: [idParam], body: o(activateProps, ['validFrom']) },
      ),
    },
    '/timetable/activate-bulk': {
      post: op(
        'Bir nechta sinf qoralamasini bir sanadan faollashtirish (hammasi oldindan tekshiriladi)',
        {
          '200': okRes(o({ activated: arr(o({ versionId: str, classId: str, className: str })) })),
        },
        { body: o({ ...activateProps, versionIds: arr(str) }, ['validFrom', 'versionIds']) },
      ),
    },
    '/timetable/activate-bulk/preview': {
      post: op(
        "Ommaviy faollashtirish ogohlantirishlari (o'zgartirmaydi): sinflar bo'yicha",
        { '200': okRes(anyObj) },
        { body: o({ versionIds: arr(str), validFrom: date }, ['versionIds', 'validFrom']) },
      ),
    },
    '/timetable/versions/{id}/correct': {
      post: op(
        "Faol versiyani joyida tuzatish (audit: timetable.version_correct). To'liq o'tgan davr tuzatilmaydi",
        { '200': okRes(versionWithWarnings) },
        {
          params: [idParam],
          body: o(
            {
              ...entriesBody,
              force: bool,
              note: { type: 'string', nullable: true },
              syncAssignments: bool,
            },
            ['entries'],
          ),
        },
      ),
    },
    '/timetable/me/week': {
      get: op("Mening haftam (o'qituvchi)", { '200': okRes(anyObj) }, { params: [dateQ] }),
    },
    '/timetable/teachers/{teacherId}/week': {
      get: op(
        "O'qituvchi haftasi (dushanba..yakshanba, ish kunlari) va haftalik darslar soni",
        { '200': okRes(anyObj) },
        { params: [teacherIdParam, dateQ] },
      ),
    },
    '/timetable/day': {
      get: op(
        'Bir kun uchun barcha sinflar jadvali',
        { '200': okRes(anyObj) },
        { params: [dateQ] },
      ),
    },
    '/timetable/lessons': {
      get: op(
        "Resolver natijasi: sinfning sana bo'yicha darslari",
        { '200': okRes(o({ classId: str, date, lessons: arr(ref('ResolvedLesson')) })) },
        { params: [q('classId'), q('date', 'YYYY-MM-DD')] },
      ),
    },
  };

  return { tags, schemas, paths };
}
