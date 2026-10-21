import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { asyncHandler } from '../core/asyncHandler';
import { AppError } from '../core/errors';
import { School } from '../models/School';
import { User } from '../models/User';
import { effectivePermissions } from '../modules/users/user.dto';

export interface AccessPayload extends jwt.JwtPayload {
  role: string;
  schoolId: string | null;
  pv: number;
}

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();

  let payload: AccessPayload;
  try {
    payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    }) as AccessPayload;
  } catch (e) {
    const expired = e instanceof jwt.TokenExpiredError;
    throw AppError.unauthorized(expired ? 'Token muddati tugagan' : 'Token yaroqsiz');
  }

  // Joriy holat DB dan olinadi: ruxsat/faollik o'zgarishi darhol ta'sir qiladi
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw AppError.unauthorized('Hisob topilmadi yoki nofaol');

  if (payload.pv !== (user.passwordChangedAt?.getTime() ?? 0)) {
    throw AppError.unauthorized("Parol o'zgargan, qayta kiring");
  }
  if (user.schoolId) {
    const school = await School.findById(user.schoolId).select('isActive');
    if (!school?.isActive) throw AppError.unauthorized('Maktab nofaol');
  }

  req.user = {
    id: user.id,
    role: user.role,
    schoolId: user.schoolId ? String(user.schoolId) : null,
    fullName: user.fullName,
    username: user.username,
    permissions: effectivePermissions(user.role, user.permissions),
  };
  next();
});
