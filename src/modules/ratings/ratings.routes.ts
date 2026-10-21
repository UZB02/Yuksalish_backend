import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { paginationQuery } from '../../core/pagination';
import { ok } from '../../core/response';
import { dateStrSchema, objectIdSchema } from '../../core/validators';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { tenant, tenantOptional } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { ratingsApi } from './ratings.api';

export const ratingsRouter = Router();

ratingsRouter.use(authenticate);

const sid = (req: Request) => req.schoolId as string;
const grade = z.coerce.number().int().min(1).max(11).optional();
const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

// O'qish: superadmin (X-School-Id), school_admin va o'qituvchi (reports.view)
const read = [
  authorize('superadmin', 'school_admin', 'teacher'),
  requirePermission('reports.view'),
  tenant,
];

ratingsRouter.get(
  '/config',
  ...read,
  asyncHandler(async (req, res) => ok(res, await ratingsApi.config(sid(req)))),
);

ratingsRouter.get(
  '/students',
  ...read,
  validate({
    query: z.object({
      ...paginationQuery,
      limit: z.coerce.number().int().min(1).max(200).default(50),
      classId: objectIdSchema.optional(),
      grade,
      search: z.string().trim().max(100).optional(),
      includeIneligible: flag,
      from: dateStrSchema.optional(),
      to: dateStrSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await ratingsApi.students(
      getCtx(req).actor,
      sid(req),
      req.query as never,
    );
    ok(res, data, meta);
  }),
);

ratingsRouter.get(
  '/classes',
  ...read,
  validate({
    query: z.object({ grade, from: dateStrSchema.optional(), to: dateStrSchema.optional() }),
  }),
  asyncHandler(async (req, res) => {
    ok(res, await ratingsApi.classes(getCtx(req).actor, sid(req), req.query as never));
  }),
);

// Maktablar reytingi — faqat superadmin, X-School-Id shart emas
ratingsRouter.get(
  '/schools',
  authorize('superadmin'),
  asyncHandler(async (_req, res) => ok(res, await ratingsApi.schools())),
);

// Qo'lda qayta hisoblash: superadmin (header bo'lmasa — barcha maktablar) yoki reports.export li school_admin
ratingsRouter.post(
  '/recalculate',
  authorize('superadmin', 'school_admin'),
  requirePermission('reports.export'),
  tenantOptional,
  asyncHandler(async (req, res) => {
    if (!req.schoolId && req.user?.role !== 'superadmin') throw AppError.forbidden();
    ok(res, await ratingsApi.recalculate(getCtx(req), req.schoolId));
  }),
);
