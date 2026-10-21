// 4-bosqich OpenAPI qismi: reyting sozlamalari, ichki reyting endpointlari, PUBLIC API
import type { DocHelpers } from './openapi.phase2';

type Obj = Record<string, unknown>;

export function buildPhase4(h: DocHelpers) {
  const { ref, okRes, errors, body, secured, schoolHeader } = h;
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
  const bool = { type: 'boolean' };
  const date = { type: 'string', format: 'date' };
  const dateTime = { type: 'string', format: 'date-time' };

  const internal = (
    summary: string,
    responses: Obj,
    opts: { params?: Obj[]; body?: Obj; header?: boolean; tag?: string } = {},
  ) => ({
    tags: [opts.tag ?? 'Ratings'],
    summary,
    security: secured,
    parameters: [...(opts.header === false ? [] : [schoolHeader]), ...(opts.params ?? [])],
    ...(opts.body ? { requestBody: body(opts.body) } : {}),
    responses: { ...responses, ...errors },
  });
  const pub = (summary: string, data: Obj, params: Obj[] = [], withMeta = false) => ({
    tags: ['Public'],
    summary,
    security: [],
    parameters: params,
    responses: {
      '200': {
        description:
          "Cache-Control: public, max-age=30, stale-while-revalidate=60; ETag (304 qo'llanadi)",
        content: {
          'application/json': {
            schema: o({ success: bool, data, ...(withMeta ? { meta: ref('PageMeta') } : {}) }),
          },
        },
      },
      '304': { description: "O'zgarmagan (If-None-Match)" },
      '404': {
        description:
          'NOT_FOUND "Reyting topilmadi" (maktab yo\'q, nofaol yoki public o\'chiq — bir xil javob)',
      },
      '429': { description: 'RATE_LIMITED' },
    },
  });

  const tags = [
    {
      name: 'Ratings',
      description:
        "Ichki reyting (snapshot). reports.view; o'qituvchi faqat o'z sinflari, rank butun maktab bo'yicha",
    },
    {
      name: 'Public',
      description:
        "Autentifikatsiyasiz, faqat GET. Izoh, xulq turi, o'qituvchi, telefon, studentCode, tug'ilgan sana, jins, photoUrl va ichki id lar hech qachon chiqmaydi",
    },
  ];

  const rating = {
    periodType: { type: 'string', enum: ['week', 'month', 'quarter', 'academic_year', 'custom'] },
    customFrom: { ...date, nullable: true },
    customTo: { ...date, nullable: true },
    method: { type: 'string', enum: ['average', 'sum'] },
    minScoresCount: int,
    tieBreak: {
      type: 'array',
      items: { type: 'string', enum: ['daysCount', 'scoresCount', 'alphabetical'] },
      description: "'alphabetical' doim oxirida",
    },
    refreshMode: { type: 'string', enum: ['realtime', 'nightly'] },
  };
  const pubSettings = {
    enabled: bool,
    showScope: { type: 'string', enum: ['own', 'global'] },
    includeInGlobal: bool,
    showClasses: bool,
    showStudents: bool,
    topStudents: { type: 'integer', nullable: true, minimum: 1, maximum: 500 },
    showScores: bool,
    showMedals: bool,
    showTrend: bool,
    title: { type: 'string', nullable: true, maxLength: 80 },
    subtitle: { type: 'string', nullable: true, maxLength: 160 },
    primaryColor: { type: 'string', nullable: true, example: '#16A34A' },
    autoRefreshSeconds: { type: 'integer', minimum: 30, maximum: 3600 },
    tvSlideSeconds: { type: 'integer', minimum: 5, maximum: 120 },
    globalRatingEnabled: { ...bool, description: "Faqat scope=global da o'rnatiladi" },
  };
  const period = o({ type: str, from: strNull, to: strNull, key: str, label: str, fallback: bool });
  const publicPeriod = o({ type: str, from: strNull, to: strNull, label: str });

  const schemas: Obj = {
    RatingSettings: o(rating),
    PublicSettings: o(pubSettings),
    RatingSettingsResult: o({
      effective: ref('RatingSettings'),
      global: ref('RatingSettings'),
      override: { type: 'object', nullable: true },
    }),
    PublicSettingsResult: o({
      effective: ref('PublicSettings'),
      global: ref('PublicSettings'),
      override: { type: 'object', nullable: true },
    }),
  };

  const settingPut = (key: string, schemaName: string, resultName: string) => ({
    tags: ['Settings'],
    summary: `${key} sozlamasini saqlash (superadmin; scope=school uchun values=null overrideni olib tashlaydi)`,
    security: secured,
    requestBody: body(
      o(
        {
          scope: { type: 'string', enum: ['global', 'school'] },
          schoolId: str,
          values: { nullable: true, ...ref(schemaName) },
        },
        ['scope', 'values'],
      ),
    ),
    responses: { '200': okRes(ref(resultName)), ...errors },
  });
  const settingGet = (key: string, resultName: string) => ({
    tags: ['Settings'],
    summary: `${key} sozlamasi: effective = defaults <- global <- maktab override`,
    security: secured,
    parameters: [schoolHeader],
    responses: { '200': okRes(ref(resultName)), ...errors },
  });

  const studentItem = o({
    rank: intNull,
    previousRank: intNull,
    rankChange: intNull,
    studentId: str,
    fullName: str,
    classId: strNull,
    className: strNull,
    score: num,
    daysCount: int,
    scoresCount: int,
    eligible: bool,
  });

  const paths: Obj = {
    '/settings/rating': {
      get: settingGet('rating', 'RatingSettingsResult'),
      put: settingPut('rating', 'RatingSettings', 'RatingSettingsResult'),
    },
    '/settings/public': {
      get: settingGet('public', 'PublicSettingsResult'),
      put: settingPut('public', 'PublicSettings', 'PublicSettingsResult'),
    },
    '/ratings/config': {
      get: internal('Joriy davr va reyting sozlamalari', {
        '200': okRes(
          o({
            period,
            settings: ref('RatingSettings'),
            calculatedAt: { ...dateTime, nullable: true },
          }),
        ),
      }),
    },
    '/ratings/students': {
      get: internal(
        "O'quvchilar reytingi (snapshot). from+to berilsa — maxsus davr, jonli hisob (<=366 kun)",
        {
          '200': okRes(
            o({ period, calculatedAt: dateTime, items: { type: 'array', items: studentItem } }),
          ),
        },
        {
          params: [
            q('classId'),
            q('grade', 'integer'),
            q('search'),
            q('includeIneligible', 'boolean'),
            q('page', 'integer'),
            q('limit', 'integer'),
            q('from', 'string', 'YYYY-MM-DD'),
            q('to', 'string', 'YYYY-MM-DD'),
          ],
        },
      ),
    },
    '/ratings/classes': {
      get: internal(
        'Sinflar reytingi',
        {
          '200': okRes(
            o({
              period,
              calculatedAt: dateTime,
              items: {
                type: 'array',
                items: o({
                  rank: intNull,
                  previousRank: intNull,
                  rankChange: intNull,
                  classId: str,
                  className: str,
                  grade: int,
                  score: num,
                  ratedStudents: int,
                  totalStudents: int,
                }),
              },
            }),
          ),
        },
        {
          params: [
            q('grade', 'integer'),
            q('from', 'string', 'YYYY-MM-DD'),
            q('to', 'string', 'YYYY-MM-DD'),
          ],
        },
      ),
    },
    '/ratings/schools': {
      get: internal(
        "Maktablar reytingi (superadmin). Davr turi GLOBAL rating sozlamasidan; maktab balli = barcha eligible o'quvchilar o'rtachasi",
        {
          '200': okRes(
            o({
              period: o({ type: str, from: strNull, to: strNull, label: str }),
              calculatedAt: dateTime,
              items: {
                type: 'array',
                items: o({
                  rank: intNull,
                  previousRank: intNull,
                  rankChange: intNull,
                  schoolId: str,
                  name: str,
                  slug: str,
                  score: num,
                  ratedStudents: int,
                  totalStudents: int,
                  enabled: bool,
                }),
              },
            }),
          ),
        },
        { header: false },
      ),
    },
    '/ratings/recalculate': {
      post: internal(
        "Qo'lda qayta hisoblash (superadmin: X-School-Id yo'q bo'lsa barcha maktablar; school_admin: reports.export)",
        {
          '200': okRes(o({ recalculatedAt: dateTime })),
        },
      ),
    },
    '/public/schools': {
      get: pub('Ochiq reytingi yoqilgan maktablar', {
        type: 'array',
        items: o({ name: str, slug: str, logoUrl: strNull }),
      }),
    },
    '/public/{schoolSlug}/config': {
      get: pub(
        'Ochiq reyting sozlamalari',
        o({
          school: o({ name: str, slug: str, logoUrl: strNull }),
          title: strNull,
          subtitle: strNull,
          primaryColor: strNull,
          showClasses: bool,
          showStudents: bool,
          showScores: bool,
          showMedals: bool,
          showTrend: bool,
          topStudents: intNull,
          autoRefreshSeconds: int,
          tvSlideSeconds: int,
          period: publicPeriod,
          calculatedAt: dateTime,
          globalAvailable: bool,
        }),
        [{ name: 'schoolSlug', in: 'path', required: true, schema: str }],
      ),
    },
    '/public/{schoolSlug}/rating/classes': {
      get: pub(
        'Sinflar reytingi (showClasses=false -> 404). score faqat showScores=true, rankChange faqat showTrend=true',
        o({
          period: publicPeriod,
          calculatedAt: dateTime,
          items: {
            type: 'array',
            items: o({
              rank: int,
              rankChange: intNull,
              classId: str,
              className: str,
              grade: int,
              score: num,
              ratedStudents: int,
            }),
          },
        }),
        [{ name: 'schoolSlug', in: 'path', required: true, schema: str }, q('grade', 'integer')],
      ),
    },
    '/public/{schoolSlug}/rating/students': {
      get: pub(
        "O'quvchilar reytingi (showStudents=false -> 404; topStudents bilan cheklangan; faqat eligible)",
        o({
          period: publicPeriod,
          calculatedAt: dateTime,
          items: {
            type: 'array',
            items: o({
              rank: int,
              rankChange: intNull,
              studentKey: str,
              fullName: str,
              className: strNull,
              score: num,
            }),
          },
        }),
        [
          { name: 'schoolSlug', in: 'path', required: true, schema: str },
          q('classId'),
          q('grade', 'integer'),
          q('search'),
          q('page', 'integer'),
          q('limit', 'integer'),
        ],
        true,
      ),
    },
    '/public/global/rating': {
      get: pub(
        "Umumiy (maktablar) reyting — faqat platformada globalRatingEnabled=true bo'lsa, aks holda 404",
        o({
          period: publicPeriod,
          calculatedAt: dateTime,
          items: {
            type: 'array',
            items: o({
              rank: int,
              rankChange: intNull,
              schoolName: str,
              slug: str,
              logoUrl: strNull,
              score: num,
              ratedStudents: int,
            }),
          },
        }),
      ),
    },
  };

  return { tags, schemas, paths };
}
