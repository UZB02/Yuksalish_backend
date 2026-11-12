import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { requirePermission } from '../../middlewares/authorize';
import { tenant, tenantOptional } from '../../middlewares/tenant';
import { dashboardService } from './dashboard.service';
import { dashboardWidgets } from './dashboard.widgets';

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

// Quyidagi o'qish endpointlari maktab doirasida (superadmin: X-School-Id majburiy), ruxsat — summary bilan bir xil
const widget = [authenticate, requirePermission('dashboard.view'), tenant];

dashboardRouter.get(
  '/unscored-classes',
  ...widget,
  asyncHandler(async (req, res) => {
    ok(res, await dashboardWidgets.unscoredClasses(getCtx(req).actor, req.schoolId as string));
  }),
);

dashboardRouter.get(
  '/attention-students',
  ...widget,
  asyncHandler(async (req, res) => {
    ok(res, await dashboardWidgets.attentionStudents(getCtx(req).actor, req.schoolId as string));
  }),
);

dashboardRouter.get(
  '/attendance-trend',
  ...widget,
  asyncHandler(async (req, res) => {
    ok(res, await dashboardWidgets.attendanceTrend(getCtx(req).actor, req.schoolId as string));
  }),
);
