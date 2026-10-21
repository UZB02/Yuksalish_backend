// 7-bosqich OpenAPI qismi: fanlar, sinf-fan biriktirish, fan baholari
import type { DocHelpers } from './openapi.phase2';

type Obj = Record<string, unknown>;

export function buildPhase7(h: DocHelpers) {
  const { ref, okRes, errors, body, secured, idParam, schoolHeader } = h;
  const q = (name: string, type = 'string', description?: string) => ({
    name,
    in: 'query',
    schema: { type },
    ...(description ? { description } : {}),
  });
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
  const o = (properties: Obj, required?: string[]) => ({
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  });
  const str = { type: 'string' };
  const strNull = { type: 'string', nullable: true };
  const int = { type: 'integer' };
  const num = { type: 'number' };
  const bool = { type: 'boolean' };
  const date = { type: 'string', format: 'date', example: '2026-10-14' };
  const dateTime = { type: 'string', format: 'date-time' };
  const grade = { type: 'integer', minimum: 2, maximum: 5 };
  const idp = [idParam];

  const tags = [
    {
      name: 'Subjects',
      description:
        "Fanlar (global schoolId=null — superadmin; maktab fanlari — subjects.manage li maktab admini). O'chirish faqat ishlatilmagan fan uchun, aks holda nofaol qilinadi",
    },
    {
      name: 'Grades',
      description:
        "Fan baholari (2–5). Bir o'quvchiga bir fandan kuniga bitta baho. O'qituvchi faqat o'zi biriktirilgan sinf+fanda baholaydi",
    },
  ];

  const schemas: Obj = {
    Subject: o({
      id: str,
      schoolId: strNull,
      name: str,
      order: int,
      isActive: bool,
      createdAt: dateTime,
    }),
    ClassSubject: o({
      subjectId: str,
      subject: { nullable: true, ...o({ id: str, name: str }) },
      teacherId: str,
      teacher: { nullable: true, ...o({ id: str, fullName: str }) },
    }),
    SubjectGrade: o({
      id: str,
      schoolId: str,
      studentId: str,
      student: o({ id: str, fullName: str }),
      classId: str,
      class: o({ id: str, name: str }),
      subjectId: str,
      subject: o({ id: str, name: str }),
      teacherId: str,
      teacher: o({ id: str, fullName: str }),
      academicYearId: str,
      value: grade,
      comment: strNull,
      date,
      editable: bool,
      createdAt: dateTime,
      updatedAt: dateTime,
    }),
  };

  const gradeRes = (code = '200') => ({ [code]: okRes(ref('SubjectGrade')) });
  const subRes = { '200': okRes(ref('Subject')) };
  const items = {
    type: 'array',
    items: o({ studentId: str, value: grade, comment: strNull }, ['studentId', 'value']),
  };

  const paths: Obj = {
    '/subjects': {
      get: op(
        'Subjects',
        "Fanlar (global + maktabniki; order bo'yicha)",
        { '200': okRes({ type: 'array', items: ref('Subject') }) },
        { params: [q('isActive', 'boolean'), q('scope', 'string', 'global | school | all')] },
      ),
      post: op(
        'Subjects',
        "Yaratish: superadmin (schoolId yo'q = global) yoki subjects.manage li admin (faqat o'z maktabi)",
        { '201': okRes(ref('Subject')) },
        { body: o({ name: str, order: int, schoolId: strNull }, ['name']), header: false },
      ),
    },
    '/subjects/{id}': {
      patch: op('Subjects', 'Tahrirlash', subRes, {
        params: idp,
        body: o({ name: str, order: int }),
        header: false,
      }),
      delete: op(
        'Subjects',
        "O'chirish (ishlatilmagan bo'lsa); ishlatilgan bo'lsa 409",
        { '200': okRes(o({ deleted: bool })) },
        { params: idp, header: false },
      ),
    },
    '/subjects/{id}/activate': {
      post: op('Subjects', 'Faollashtirish', subRes, { params: idp, header: false }),
    },
    '/subjects/{id}/deactivate': {
      post: op('Subjects', 'Nofaol qilish', subRes, { params: idp, header: false }),
    },
    '/classes/{id}/subjects': {
      put: op(
        'Classes',
        "Sinfning fan-o'qituvchi ro'yxatini to'liq almashtirish (classes.manage). O'qituvchi sinf teacherIds ga avtomatik qo'shiladi",
        { '200': okRes(ref('Class')) },
        {
          params: idp,
          body: o(
            {
              subjects: {
                type: 'array',
                items: o({ subjectId: str, teacherId: str }, ['subjectId', 'teacherId']),
              },
            },
            ['subjects'],
          ),
        },
      ),
    },
    '/grades': {
      get: op(
        'Grades',
        "Fan baholari ro'yxati. O'qituvchi faqat o'z baholarini ko'radi",
        { '200': okRes({ type: 'array', items: ref('SubjectGrade') }) },
        {
          params: [
            q('page', 'integer'),
            q('limit', 'integer'),
            q('classId'),
            q('subjectId'),
            q('studentId'),
            q('teacherId'),
            q('from', 'string', 'YYYY-MM-DD'),
            q('to', 'string', 'YYYY-MM-DD'),
            q('sort', 'string', 'date | -date'),
          ],
        },
      ),
      post: op('Grades', "Baho qo'yish (grades.create). Mavjud bo'lsa 409", gradeRes('201'), {
        body: o({ studentId: str, subjectId: str, date, value: grade, comment: strNull }, [
          'studentId',
          'subjectId',
          'value',
        ]),
      }),
    },
    '/grades/bulk': {
      post: op(
        'Grades',
        'Ommaviy baholash: sinf + fan + sana (UPSERT, max 200, qisman muvaffaqiyat)',
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
          body: o({ classId: str, subjectId: str, date, items }, ['classId', 'subjectId', 'items']),
        },
      ),
    },
    '/grades/my-assignments': {
      get: op(
        'Grades',
        "O'qituvchining biriktirilgan sinf+fan juftliklari (admin uchun mode=all)",
        {
          '200': okRes(
            o({
              mode: { type: 'string', enum: ['assigned', 'all'] },
              assignments: {
                type: 'array',
                items: o({
                  classId: str,
                  className: str,
                  grade: int,
                  subjectId: str,
                  subjectName: str,
                }),
              },
            }),
          ),
        },
      ),
    },
    '/grades/sheet': {
      get: op(
        'Grades',
        "Baholash varag'i: sinf o'quvchilari + shu fan/kun bahosi (alreadyGraded)",
        {
          '200': okRes(
            o({
              class: o({ id: str, name: str }),
              subject: o({ id: str, name: str }),
              date,
              students: {
                type: 'array',
                items: o({
                  studentId: str,
                  fullName: str,
                  studentCode: strNull,
                  grade: { nullable: true, ...ref('SubjectGrade') },
                  alreadyGraded: bool,
                }),
              },
            }),
          ),
        },
        { params: [q('classId'), q('subjectId'), q('date', 'string', 'YYYY-MM-DD')] },
      ),
    },
    '/grades/{id}': {
      patch: op(
        'Grades',
        "Tahrirlash (o'z bahosi — tahrir oynasida, yoki grades.edit)",
        gradeRes(),
        { params: idp, body: o({ value: grade, comment: strNull }) },
      ),
      delete: op(
        'Grades',
        "O'chirish (soft delete)",
        { '200': okRes(o({ deleted: bool })) },
        { params: idp },
      ),
    },
    '/students/{id}/grade-summary': {
      get: op(
        'Grades',
        "O'quvchi fan baholari xulosasi (default: oxirgi 30 kun): fanlar bo'yicha o'rtacha, ×20 shkala",
        {
          '200': okRes(
            o({
              studentId: str,
              from: date,
              to: date,
              average: { ...num, nullable: true },
              average100: { ...num, nullable: true },
              gradesCount: int,
              bySubject: {
                type: 'array',
                items: o({
                  subjectId: str,
                  name: str,
                  average: num,
                  count: int,
                  lastValue: int,
                  lastDate: date,
                }),
              },
              recent: { type: 'array', items: ref('SubjectGrade') },
            }),
          ),
        },
        { params: [...idp, q('from', 'string', 'YYYY-MM-DD'), q('to', 'string', 'YYYY-MM-DD')] },
      ),
    },
  };

  return { tags, schemas, paths };
}
