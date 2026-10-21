import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { requirePermission } from '../../middlewares/authorize';
import { tenantOptional } from '../../middlewares/tenant';
import { dashboardService } from './dashboard.service';

export const dashboardRouter = Router();

// Superadmin X-School-Id bermasa — global hisob
dashboardRouter.get(
  '/summary',
  authenticate,
  requirePermission('dashboard.view'),
  tenantOptional,
  asyncHandler(async (req, res) => {
    ok(res, await dashboardService.summary(getCtx(req).actor, req.schoolId));
  }),
);
