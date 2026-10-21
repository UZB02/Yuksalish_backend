import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { paginationQuery } from '../../core/pagination';
import { ok } from '../../core/response';
import { dateStrSchema, objectIdSchema } from '../../core/validators';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { auditReadService } from './audit.read.service';

/** Audit log faqat o'qiladi: o'zgartirish/o'chirish endpointi yo'q */
export const auditRouter = Router();

auditRouter.use(
  authenticate,
  authorize('superadmin', 'school_admin'),
  requirePermission('audit.view'),
);

const listQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
  userId: objectIdSchema.optional(),
  action: z.string().trim().max(100).optional(),
  entity: z.string().trim().max(100).optional(),
  schoolId: objectIdSchema.optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['createdAt', '-createdAt']).default('-createdAt'),
});

auditRouter.get(
  '/filters',
  validate({ query: z.object({ schoolId: objectIdSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { schoolId } = req.query as { schoolId?: string };
    ok(res, await auditReadService.filters(getCtx(req).actor, schoolId));
  }),
);

auditRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await auditReadService.list(getCtx(req).actor, req.query as never);
    ok(res, items, meta);
  }),
);
