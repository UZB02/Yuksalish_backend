import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import type { UserDoc } from '../../models/User';

export function signAccessToken(user: UserDoc): string {
  return jwt.sign(
    {
      role: user.role,
      schoolId: user.schoolId ? String(user.schoolId) : null,
      // parol versiyasi: parol o'zgarsa/tiklansa eski access tokenlar yaroqsiz bo'ladi
      pv: user.passwordChangedAt?.getTime() ?? 0,
    },
    env.JWT_ACCESS_SECRET,
    {
      subject: user.id,
      algorithm: 'HS256',
      expiresIn: Math.round(env.ACCESS_TOKEN_TTL_MINUTES * 60),
    },
  );
}

/** Refresh token — tasodifiy (opaque) qiymat; DB da faqat sha256 xeshi saqlanadi */
export const generateRefreshToken = () => crypto.randomBytes(48).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
