import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { AppError } from '../core/errors';

const make = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    handler: (_req, _res, next) => next(AppError.rateLimited(message)),
  });

/** Umumiy API: daqiqasiga 300 ta */
export const apiLimiter = make(60_000, 300, "So'rovlar juda ko'p. Birozdan so'ng urinib ko'ring");

/** Login/refresh: 15 daqiqada 30 ta */
export const loginLimiter = make(
  15 * 60_000,
  30,
  "Kirish urinishlari juda ko'p. Keyinroq urinib ko'ring",
);

/** Public API: daqiqasiga PUBLIC_RATE_LIMIT_PER_MIN (default 120) ta, IP bo'yicha */
export const publicLimiter = make(
  60_000,
  env.PUBLIC_RATE_LIMIT_PER_MIN,
  "So'rovlar juda ko'p. Birozdan so'ng urinib ko'ring",
);
