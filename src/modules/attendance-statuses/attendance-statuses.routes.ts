import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { boolQuery } from '../../core/pagination';
import { created, ok } from '../../core/response';
import { objectIdSchema } from '../../core/validators';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { tenantOptional } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { ATTENDANCE_CATEGORIES } from '../settings/attendance.settings';
import { attendanceStatusesService as s } from './attendance-statuses.service';

export const attendanceStatusesRouter = Router();

const name = z.string().trim().min(2).max(40);
const shortName = z.string().trim().min(1).max(3);
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Rang #RRGGBB formatida bo'lishi kerak")
  .transform((v) => v.toUpperCase());
const category = z.enum(ATTENDANCE_CATEGORIES);
const order = z.number().int().min(0).max(10000);

const listQuery = z.object({
  isActive: boolQuery,
  scope: z.enum(['global', 'school', 'all']).optional(),
});
const createBody = z.object({
  schoolId: objectIdSchema.nullish(),
  name,
  shortName,
  color,
  category,
  isDefault: z.boolean().optional(),
  order: order.optional(),
});
const updateBody = z.object({
  name: name.optional(),
  shortName: shortName.optional(),
  color: color.optional(),
  category: category.optional(),
  isDefault: z.boolean().optional(),
  order: order.optional(),
});

const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

attendanceStatusesRouter.use(authenticate);

// O'qish: barcha maktab rollari (global + o'z maktabi); superadmin headersiz hammasini ko'radi
attendanceStatusesRouter.get(
  '/',
  tenantOptional,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as { isActive?: boolean; scope?: 'global' | 'school' | 'all' };
    ok(res, await s.list({ ...q, schoolId: req.schoolId }));
  }),
);

// Yozish: faqat superadmin (o'chirish yo'q — nofaol qilinadi)
attendanceStatusesRouter.use(authorize('superadmin'));
attendanceStatusesRouter.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => created(res, await s.create(getCtx(req), req.body))),
);
attendanceStatusesRouter.patch(
  '/:id',
  validate({ body: updateBody }),
  asyncHandler(async (req, res) => ok(res, await s.update(getCtx(req), id(req), req.body))),
);
attendanceStatusesRouter.post(
  '/:id/activate',
  asyncHandler(async (req, res) => ok(res, await s.setActive(getCtx(req), id(req), true))),
);
attendanceStatusesRouter.post(
  '/:id/deactivate',
  asyncHandler(async (req, res) => ok(res, await s.setActive(getCtx(req), id(req), false))),
);
