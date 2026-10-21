import type { RequestHandler } from 'express';
import { asyncHandler } from '../core/asyncHandler';
import { AppError } from '../core/errors';
import { School } from '../models/School';
import { isId } from '../utils/helpers';

const make = (optional: boolean): RequestHandler =>
  asyncHandler(async (req, _res, next) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();

    if (user.role !== 'superadmin') {
      if (!user.schoolId) throw AppError.forbidden();
      req.schoolId = user.schoolId;
      return next();
    }

    const header = req.get('x-school-id');
    if (!header) {
      if (optional) return next();
      throw AppError.validation('Maktab tanlanmagan', [
        { path: 'X-School-Id', message: 'X-School-Id sarlavhasi majburiy' },
      ]);
    }
    if (!isId(header)) {
      throw AppError.validation("Maktab identifikatori noto'g'ri", [
        { path: 'X-School-Id', message: "Identifikator noto'g'ri" },
      ]);
    }
    if (!(await School.exists({ _id: header }))) throw AppError.notFound('Maktab topilmadi');
    req.schoolId = header;
    next();
  });

/**
 * req.schoolId ni aniqlaydi.
 * - school_admin/teacher: faqat o'z maktabi (header e'tiborga olinmaydi)
 * - superadmin: X-School-Id header majburiy
 */
export const tenant = make(false);

/** Superadmin uchun header ixtiyoriy (bo'lmasa req.schoolId aniqlanmaydi — global rejim) */
export const tenantOptional = make(true);
