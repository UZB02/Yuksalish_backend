import { Router, type RequestHandler } from 'express';
import { AppError } from '../../core/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requireAnyPermission, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './grades.controller';
import { bulkBody, createBody, listQuery, sheetQuery, updateBody } from './grades.schema';

export const gradesRouter = Router();

gradesRouter.use(authenticate, authorize('superadmin', 'school_admin', 'teacher'));

/**
 * Baholarni o'qish: o'qituvchi (doim, faqat o'z baholari);
 * maktab admini uchun reports.view, grades.edit, grades.create yoki students.view dan biri kerak.
 */
const readGuard: RequestHandler = (req, _res, next) => {
  const u = req.user;
  if (u?.role !== 'school_admin') return next();
  const ok = ['reports.view', 'grades.edit', 'grades.create', 'students.view'].some((p) =>
    u.permissions.includes(p),
  );
  return ok ? next() : next(AppError.forbidden());
};

// Baho qo'yish: grades.create (o'qituvchida doim bor; faqat o'z biriktirilgan sinf/fani)
const create = [requirePermission('grades.create'), tenant];
// O'zgartirish/o'chirish: o'z bahosi (grades.create) yoki grades.edit
const change = [requireAnyPermission('grades.create', 'grades.edit'), tenant];

gradesRouter.get('/my-assignments', requirePermission('grades.create'), tenant, c.myAssignments);
gradesRouter.get('/sheet', ...create, validate({ query: sheetQuery }), c.sheet);
gradesRouter.get('/', readGuard, tenant, validate({ query: listQuery }), c.list);
gradesRouter.post('/', ...create, validate({ body: createBody }), c.create);
gradesRouter.post('/bulk', ...create, validate({ body: bulkBody }), c.bulk);
gradesRouter.patch('/:id', ...change, validate({ body: updateBody }), c.update);
gradesRouter.delete('/:id', ...change, c.remove);
