// 3-bosqich OpenAPI qismi: xulq turlari, sozlamalar, baholar
import type { DocHelpers } from './openapi.phase2';

type Obj = Record<string, unknown>;

export function buildPhase3(h: DocHelpers) {
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
  const bool = { type: 'boolean' };
  const date = { type: 'string', format: 'date', example: '2026-10-14' };
  const dateTime = { type: 'string', format: 'date-time' };
  const idp = [idParam];

  const tags = [
    {
      name: 'Behavior types',
      description: "Xulq turlari. Yozish faqat superadmin; o'chirish yo'q (nofaol qilinadi)",
    },
    { name: 'Settings', description: 'Sozlamalar (hozircha baholash qoidalari)' },
    {
      name: 'Scores',
      description:
        "Kunlik baholar. \"Bugun\" Asia/Tashkent bo'yicha. Bir o'qituvchi bir o'quvchiga kuniga bitta baho",
    },
  ];

  const scoring = {
    minScore: int,
    maxScore: int,
    requireBehaviorType: bool,
    commentRequiredBelow: { type: 'integer', nullable: true },
    editWindowHours: int,
    backdateDays: int,
    dailyAggregation: { type: 'string', enum: ['average', 'min', 'last'] },
  };

  const schemas: Obj = {
    BehaviorType: o({
      id: str,
      schoolId: strNull,
      name: str,
      kind: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      color: { type: 'string', example: '#16A34A' },
      order: int,
      minScore: { type: 'integer', nullable: true },
      maxScore: { type: 'integer', nullable: true },
      isActive: bool,
      createdAt: dateTime,
    }),
    ScoringSettings: o(scoring),
    ScoringSettingsResult: o({
      effective: ref('ScoringSettings'),
      global: ref('ScoringSettings'),
      override: {
        nullable: true,
        type: 'object',
        description: 'Qisman qiymatlar; faqat superadmin',
      },
    }),
    Score: o({
      id: str,
      schoolId: str,
      studentId: str,
      student: o({ id: str, fullName: str }),
      classId: str,
      class: o({ id: str, name: str }),
      teacherId: str,
      teacher: o({ id: str, fullName: str }),
      academicYearId: str,
      behaviorTypeId: strNull,
      behaviorType: { nullable: true, ...o({ id: str, name: str, kind: str, color: str }) },
      value: int,
      comment: strNull,
      date,
      editable: bool,
      createdAt: dateTime,
      updatedAt: dateTime,
    }),
  };

  const scoreRes = (code = '200') => ({ [code]: okRes(ref('Score')) });
  const behRes = { '200': okRes(ref('BehaviorType')) };
  const behFields = {
    name: str,
    kind: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    color: str,
    order: int,
    minScore: { type: 'integer', nullable: true },
    maxScore: { type: 'integer', nullable: true },
  };
  const itemFields = { studentId: str, value: int, behaviorTypeId: strNull, comment: strNull };

  const paths: Obj = {
    '/behavior-types': {
      get: op(
        'Behavior types',
        "Xulq turlari (global + maktabniki; order bo'yicha)",
        { '200': okRes({ type: 'array', items: ref('BehaviorType') }) },
        {
          params: [q('isActive', 'boolean'), q('scope', 'string', 'global | school | all')],
        },
      ),
      post: op(
        'Behavior types',
        "Yaratish (superadmin). schoolId yo'q/null = global",
        { '201': okRes(ref('BehaviorType')) },
        {
          body: o({ ...behFields, schoolId: strNull }, ['name', 'kind', 'color']),
          header: false,
        },
      ),
    },
    '/behavior-types/{id}': {
      patch: op('Behavior types', 'Tahrirlash (superadmin)', behRes, {
        params: idp,
        body: o(behFields),
        header: false,
      }),
    },
    '/behavior-types/{id}/activate': {
      post: op('Behavior types', 'Faollashtirish (superadmin)', behRes, {
        params: idp,
        header: false,
      }),
    },
    '/behavior-types/{id}/deactivate': {
      post: op('Behavior types', 'Nofaol qilish (superadmin)', behRes, {
        params: idp,
        header: false,
      }),
    },
    '/settings/scoring': {
      get: op('Settings', 'Baholash sozlamalari: effective = global + maktab override', {
        '200': okRes(ref('ScoringSettingsResult')),
      }),
      put: op(
        'Settings',
        'Sozlamani saqlash (superadmin). scope=school: values=null overrideni olib tashlaydi',
        { '200': okRes(ref('ScoringSettingsResult')) },
        {
          header: false,
          body: o(
            {
              scope: { type: 'string', enum: ['global', 'school'] },
              schoolId: str,
              values: { type: 'object', nullable: true, properties: scoring },
            },
            ['scope', 'values'],
          ),
        },
      ),
    },
    '/classes/{id}/scoring-sheet': {
      get: op(
        'Scores',
        "Baholash varag'i (scores.create yoki scores.edit; o'qituvchi faqat biriktirilgan sinf)",
        {
          '200': okRes(
            o({
              class: o({ id: str, name: str }),
              date,
              settings: ref('ScoringSettings'),
              students: {
                type: 'array',
                items: o({
                  studentId: str,
                  fullName: str,
                  studentCode: strNull,
                  myScore: { nullable: true, ...ref('Score') },
                  dayScore: { type: 'number', nullable: true },
                  scoresCount: int,
                }),
              },
            }),
          ),
        },
        { params: [...idp, q('date', 'string', 'YYYY-MM-DD, default bugun')] },
      ),
    },
    '/scores': {
      get: op(
        'Scores',
        "Baholar ro'yxati. O'qituvchi faqat o'z baholari; maktab admini uchun reports.view | scores.edit | students.view kerak",
        {
          '200': okRes({ type: 'array', items: ref('Score') }),
        },
        {
          params: [
            q('classId'),
            q('studentId'),
            q('teacherId'),
            q('behaviorTypeId'),
            q('from', 'string', 'YYYY-MM-DD'),
            q('to', 'string', 'YYYY-MM-DD'),
            q('page', 'integer'),
            q('limit', 'integer'),
            q('sort', 'string', 'date | -date (default -date)'),
          ],
        },
      ),
      post: op('Scores', "Baho qo'yish (scores.create). Mavjud bo'lsa 409", scoreRes('201'), {
        body: o({ studentId: str, date, value: int, behaviorTypeId: strNull, comment: strNull }, [
          'studentId',
          'value',
        ]),
      }),
    },
    '/scores/bulk': {
      post: op(
        'Scores',
        'Ommaviy baholash (UPSERT, max 200, qisman muvaffaqiyat)',
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
              items: { type: 'array', items: o(itemFields, ['studentId', 'value']) },
            },
            ['classId', 'items'],
          ),
        },
      ),
    },
    '/scores/today-progress': {
      get: op('Scores', "Bugungi baholash jarayoni (joriy foydalanuvchi sinflari bo'yicha)", {
        '200': okRes({
          type: 'array',
          items: o({ classId: str, className: str, scored: int, total: int }),
        }),
      }),
    },
    '/scores/{id}': {
      patch: op(
        'Scores',
        "Tahrirlash (o'z bahosi — tahrir oynasida, yoki scores.edit)",
        scoreRes(),
        {
          params: idp,
          body: o({ value: int, behaviorTypeId: strNull, comment: strNull }),
        },
      ),
      delete: op(
        'Scores',
        "O'chirish (soft delete)",
        { '200': okRes(o({ deleted: bool })) },
        { params: idp },
      ),
    },
    '/students/{id}/score-summary': {
      get: op(
        'Scores',
        "O'quvchi ball xulosasi (default: oxirgi 30 kun). O'qituvchiga boshqalarning izohlari ko'rinmaydi",
        {
          '200': okRes(
            o({
              studentId: str,
              from: date,
              to: date,
              average: { type: 'number', nullable: true },
              daysCount: int,
              scoresCount: int,
              trend: { type: 'array', items: o({ date, dayScore: { type: 'number' } }) },
              byBehaviorType: {
                type: 'array',
                items: o({ behaviorTypeId: strNull, name: str, kind: str, color: str, count: int }),
              },
              recent: { type: 'array', items: ref('Score') },
            }),
          ),
        },
        { params: [...idp, q('from', 'string', 'YYYY-MM-DD'), q('to', 'string', 'YYYY-MM-DD')] },
      ),
    },
  };

  return { tags, schemas, paths };
}
