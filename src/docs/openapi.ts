// OpenAPI 3 tavsifi (Swagger UI: /api/docs)
import { buildPhase2 } from './openapi.phase2';
import { buildPhase3 } from './openapi.phase3';
import { buildPhase4 } from './openapi.phase4';
import { buildPhase5 } from './openapi.phase5';
import { buildPhase6 } from './openapi.phase6';
import { buildPhase7 } from './openapi.phase7';
import { buildPhase8 } from './openapi.phase8';

type Obj = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Obj) => ({ content: { 'application/json': { schema } } });
const okRes = (schema: Obj, description = 'Muvaffaqiyatli') => ({
  description,
  ...json({
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: schema,
      meta: ref('PageMeta'),
    },
  }),
});
const errRes = (description: string) => ({ description, ...json(ref('Error')) });
const errors = {
  '400': errRes('VALIDATION_ERROR'),
  '401': errRes('UNAUTHORIZED'),
  '403': errRes('FORBIDDEN'),
  '404': errRes('NOT_FOUND'),
  '409': errRes('CONFLICT'),
};
const body = (schema: Obj) => ({ required: true, ...json(schema) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const listParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
  { name: 'search', in: 'query', schema: { type: 'string' } },
  { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
];
const schoolHeader = {
  name: 'X-School-Id',
  in: 'header',
  required: false,
  description: 'Faqat superadmin uchun: maktab-doirali endpointlarda majburiy',
  schema: { type: 'string' },
};
const secured = [{ bearerAuth: [] }];
const phase2 = buildPhase2({ ref, okRes, errors, body, secured, idParam, schoolHeader });
const phase3 = buildPhase3({ ref, okRes, errors, body, secured, idParam, schoolHeader });
const phase4 = buildPhase4({ ref, okRes, errors, body, secured, idParam, schoolHeader });
const phase5 = buildPhase5({ ref, okRes, errors, body, secured, idParam, schoolHeader });
const phase6 = buildPhase6({ ref, okRes, errors, body, secured, idParam, schoolHeader });
const phase7 = buildPhase7({ ref, okRes, errors, body, secured, idParam, schoolHeader });
const phase8 = buildPhase8({ ref, okRes, errors, body, secured, idParam, schoolHeader });

const crudUser = (
  tag: string,
  base: string,
  extraParams: Obj[] = [],
  extraHeaders: Obj[] = [],
) => ({
  [base]: {
    get: {
      tags: [tag],
      summary: "Ro'yxat",
      security: secured,
      parameters: [...listParams, ...extraParams, ...extraHeaders],
      responses: { '200': okRes({ type: 'array', items: ref('User') }), ...errors },
    },
    post: {
      tags: [tag],
      summary: 'Yaratish',
      security: secured,
      parameters: extraHeaders,
      requestBody: body(ref(tag === 'Teachers' ? 'TeacherCreate' : 'SchoolAdminCreate')),
      responses: { '201': okRes(ref('User'), 'Yaratildi'), ...errors },
    },
  },
  [`${base}/{id}`]: {
    get: {
      tags: [tag],
      summary: 'Bitta yozuv',
      security: secured,
      parameters: [idParam, ...extraHeaders],
      responses: { '200': okRes(ref('User')), ...errors },
    },
    patch: {
      tags: [tag],
      summary: 'Tahrirlash',
      security: secured,
      parameters: [idParam, ...extraHeaders],
      requestBody: body({
        type: 'object',
        properties: {
          fullName: { type: 'string' },
          phone: { type: 'string', nullable: true },
          isActive: { type: 'boolean' },
        },
      }),
      responses: { '200': okRes(ref('User')), ...errors },
    },
  },
  [`${base}/{id}/permissions`]: {
    put: {
      tags: [tag],
      summary: 'Ruxsatlarni almashtirish',
      security: secured,
      parameters: [idParam, ...extraHeaders],
      requestBody: body({
        type: 'object',
        required: ['permissions'],
        properties: { permissions: { type: 'array', items: { type: 'string' } } },
      }),
      responses: { '200': okRes(ref('User')), ...errors },
    },
  },
  [`${base}/{id}/reset-password`]: {
    post: {
      tags: [tag],
      summary: 'Parolni tiklash',
      security: secured,
      parameters: [idParam, ...extraHeaders],
      requestBody: body({
        type: 'object',
        required: ['newPassword'],
        properties: { newPassword: { type: 'string', minLength: 8 } },
      }),
      responses: {
        '200': okRes({ type: 'object', properties: { reset: { type: 'boolean' } } }),
        ...errors,
      },
    },
  },
});

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: "O'quvchilar intizomi reytingi — API",
    version: '0.1.0',
    description:
      'Javob formati: `{success:true,data,meta?}` yoki `{success:false,error:{code,message,details?}}`. Refresh token — httpOnly cookie `refreshToken` (path /api/v1/auth).',
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Auth' },
    { name: 'Schools', description: 'Faqat superadmin' },
    { name: 'School admins', description: 'Faqat superadmin' },
    {
      name: 'Teachers',
      description: 'superadmin (X-School-Id) yoki teachers.manage ruxsatli maktab admini',
    },
    { name: 'Meta' },
    { name: 'Health' },
    ...phase2.tags,
    ...phase3.tags,
    ...phase4.tags,
    ...phase5.tags,
    ...phase6.tags,
    ...phase7.tags,
    ...phase8.tags,
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      PageMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_ERROR',
                  'UNAUTHORIZED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'CONFLICT',
                  'RATE_LIMITED',
                  'INTERNAL',
                ],
              },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { path: { type: 'string' }, message: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          fullName: { type: 'string' },
          username: { type: 'string' },
          role: { type: 'string', enum: ['superadmin', 'school_admin', 'teacher'] },
          schoolId: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          permissions: { type: 'array', items: { type: 'string' } },
          isActive: { type: 'boolean' },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      School: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          slug: { type: 'string' },
          address: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          logoUrl: { type: 'string', nullable: true },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SchoolCreate: {
        type: 'object',
        required: ['name', 'slug'],
        properties: {
          name: { type: 'string' },
          slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
          address: { type: 'string' },
          phone: { type: 'string' },
          logoUrl: { type: 'string' },
        },
      },
      TeacherCreate: {
        type: 'object',
        required: ['fullName', 'username', 'password'],
        properties: {
          fullName: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string', minLength: 8 },
          phone: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
      SchoolAdminCreate: {
        type: 'object',
        required: ['schoolId', 'fullName', 'username', 'password'],
        properties: {
          schoolId: { type: 'string' },
          fullName: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string', minLength: 8 },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
      ...phase2.schemas,
      ...phase3.schemas,
      ...phase4.schemas,
      ...phase5.schemas,
      ...phase6.schemas,
      ...phase7.schemas,
      ...phase8.schemas,
      AuthResult: {
        type: 'object',
        properties: { accessToken: { type: 'string' }, user: ref('User') },
      },
    },
  },
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Kirish (refresh token cookie ga yoziladi)',
        requestBody: body({
          type: 'object',
          required: ['username', 'password'],
          properties: { username: { type: 'string' }, password: { type: 'string' } },
        }),
        responses: {
          '200': okRes(ref('AuthResult')),
          ...errors,
          '429': errRes("RATE_LIMITED (5 xato urinishdan so'ng 15 daqiqa blok)"),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Access tokenni yangilash (cookie, rotatsiya)',
        responses: { '200': okRes(ref('AuthResult')), '401': errRes('UNAUTHORIZED') },
      },
    },
    '/auth/logout': {
      post: { tags: ['Auth'], summary: 'Chiqish', responses: { '200': okRes({ type: 'object' }) } },
    },
    '/auth/logout-all': {
      post: {
        tags: ['Auth'],
        summary: 'Barcha qurilmalardan chiqish',
        security: secured,
        responses: { '200': okRes({ type: 'object' }), '401': errRes('UNAUTHORIZED') },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Joriy foydalanuvchi',
        security: secured,
        responses: { '200': okRes(ref('User')), '401': errRes('UNAUTHORIZED') },
      },
    },
    '/auth/password': {
      patch: {
        tags: ['Auth'],
        summary: "Parolni o'zgartirish (min 8, harf+raqam). Yangi accessToken qaytaradi",
        security: secured,
        requestBody: body({
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } },
        }),
        responses: {
          '200': okRes({ type: 'object', properties: { accessToken: { type: 'string' } } }),
          ...errors,
        },
      },
    },
    '/schools': {
      get: {
        tags: ['Schools'],
        summary: "Maktablar ro'yxati",
        security: secured,
        parameters: listParams,
        responses: { '200': okRes({ type: 'array', items: ref('School') }), ...errors },
      },
      post: {
        tags: ['Schools'],
        summary: 'Maktab yaratish',
        security: secured,
        requestBody: body(ref('SchoolCreate')),
        responses: { '201': okRes(ref('School'), 'Yaratildi'), ...errors },
      },
    },
    '/schools/{id}': {
      get: {
        tags: ['Schools'],
        summary: 'Maktab',
        security: secured,
        parameters: [idParam],
        responses: { '200': okRes(ref('School')), ...errors },
      },
      patch: {
        tags: ['Schools'],
        summary: 'Maktabni tahrirlash (isActive ham)',
        security: secured,
        parameters: [idParam],
        requestBody: body({
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: { type: 'string', nullable: true },
            phone: { type: 'string', nullable: true },
            logoUrl: { type: 'string', nullable: true },
            isActive: { type: 'boolean' },
          },
        }),
        responses: { '200': okRes(ref('School')), ...errors },
      },
    },
    ...crudUser('School admins', '/school-admins', [
      { name: 'schoolId', in: 'query', schema: { type: 'string' } },
    ]),
    ...crudUser('Teachers', '/teachers', [], [schoolHeader]),
    '/meta/permissions': {
      get: {
        tags: ['Meta'],
        summary: 'Ruxsatlar katalogi',
        security: secured,
        responses: {
          '200': okRes({ type: 'array', items: { type: 'object' } }),
          '401': errRes('UNAUTHORIZED'),
        },
      },
    },
    ...phase2.paths,
    ...phase3.paths,
    ...phase4.paths,
    ...phase5.paths,
    ...phase6.paths,
    ...phase7.paths,
    ...phase8.paths,
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Holat (DB bilan)',
        responses: { '200': okRes({ type: 'object' }) },
      },
    },
  },
};
