import { Router, type RequestHandler } from 'express';
import { AppError } from '../../core/errors';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requireAnyPermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './attendance.controller';
import { bulkBody, listQuery, summaryQuery, updateBody } from './attendance.schema';

export const attendanceRouter = Router();

attendanceRouter.use(authenticate, authorize('superadmin', 'school_admin', 'teacher'));

/**
 * O'qituvchi o'z sinflari doirasida doim ko'ra oladi (attendance.take unda doim bor);
 * maktab admini uchun ko'rsatilgan ruxsatlardan biri kerak.
 */
const teacherOr =
  (...perms: string[]): RequestHandler =>
  (req, _res, next) => {
    const u = req.user;
    if (u?.role !== 'school_admin') return next();
    return perms.some((p) => u.permissions.includes(p)) ? next() : next(AppError.forbidden());
  };

const take = [requireAnyPermission('attendance.take'), tenant];
const change = [requireAnyPermission('attendance.take', 'attendance.edit'), tenant];

attendanceRouter.get(
  '/today-progress',
  requireAnyPermission('attendance.take', 'attendance.view', 'attendance.edit'),
  tenant,
  c.todayProgress,
);
// Statistika: o'qituvchi — o'z sinflari (attendance.view siz ham); admin — attendance.view
attendanceRouter.get(
  '/summary',
  teacherOr('attendance.view'),
  tenant,
  validate({ query: summaryQuery }),
  c.summary,
);
// Tarix: admin uchun attendance.view | attendance.edit | attendance.take
attendanceRouter.get(
  '/',
  teacherOr('attendance.view', 'attendance.edit', 'attendance.take'),
  tenant,
  validate({ query: listQuery }),
  c.list,
);
attendanceRouter.post('/bulk', ...take, validate({ body: bulkBody }), c.bulk);
attendanceRouter.patch('/:id', ...change, validate({ body: updateBody }), c.update);
attendanceRouter.delete('/:id', ...change, c.remove);
