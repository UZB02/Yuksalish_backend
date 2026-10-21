import { Router, type RequestHandler } from 'express';
import { AppError } from '../../core/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requireAnyPermission, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './scores.controller';
import { bulkBody, createBody, listQuery, updateBody } from './scores.schema';

export const scoresRouter = Router();

scoresRouter.use(authenticate, authorize('superadmin', 'school_admin', 'teacher'));

/**
 * Baholarni o'qish: o'qituvchi (doim, faqat o'z baholari);
 * maktab admini uchun reports.view, scores.edit yoki students.view ruxsatidan biri kerak.
 */
const readGuard: RequestHandler = (req, res, next) => {
  const u = req.user;
  if (u?.role !== 'school_admin') return next();
  const ok = ['reports.view', 'scores.edit', 'students.view'].some((p) =>
    u.permissions.includes(p),
  );
  return ok ? next() : next(AppError.forbidden());
};

// Baho qo'yish: scores.create (o'qituvchida doim bor)
const create = [requirePermission('scores.create'), tenant];
// O'zgartirish/o'chirish: o'z bahosi (scores.create) yoki scores.edit
const change = [requireAnyPermission('scores.create', 'scores.edit'), tenant];

scoresRouter.get(
  '/today-progress',
  requireAnyPermission('scores.create', 'scores.edit'),
  tenant,
  c.todayProgress,
);
scoresRouter.get('/', readGuard, tenant, validate({ query: listQuery }), c.list);
scoresRouter.post('/', ...create, validate({ body: createBody }), c.create);
scoresRouter.post('/bulk', ...create, validate({ body: bulkBody }), c.bulk);
scoresRouter.patch('/:id', ...change, validate({ body: updateBody }), c.update);
scoresRouter.delete('/:id', ...change, c.remove);
