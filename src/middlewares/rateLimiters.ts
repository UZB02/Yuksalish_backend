import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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

/**
 * Rasmlar (imzolangan havola): ro'yxatda o'nlab avatar bir vaqtda yuklanadi, shuning uchun
 * umumiy apiLimiter dan alohida, yuqoriroq chegara (daqiqasiga 1500). Brauzer keshi (1 kun) bor.
 */
export const photoLimiter = make(
  60_000,
  1500,
  "So'rovlar juda ko'p. Birozdan so'ng urinib ko'ring",
);

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

/** Telegram ulash havolasi: soatiga 10 ta, foydalanuvchi bo'yicha (authenticate dan keyin) */
export const telegramLinkLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !env.RATE_LIMIT_ENABLED,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: (_req, _res, next) =>
    next(AppError.rateLimited("Havola so'rovlari juda ko'p. Keyinroq urinib ko'ring")),
});

/**
 * Profil tahriri va login bandligini tekshirish: foydalanuvchi bo'yicha (authenticate dan keyin).
 * Parolni taxmin qilish va login ro'yxatini skanerlashga qarshi.
 */
const perUser = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    handler: (_req, _res, next) => next(AppError.rateLimited(message)),
  });

/** Profil tahriri: 15 daqiqada 20 ta */
export const profileUpdateLimiter = perUser(
  15 * 60_000,
  20,
  "Profilni o'zgartirish urinishlari juda ko'p. Keyinroq urinib ko'ring",
);

/** Login bandligini tekshirish: daqiqasiga 30 ta */
export const usernameCheckLimiter = perUser(
  60_000,
  30,
  "Tekshiruvlar juda ko'p. Birozdan so'ng urinib ko'ring",
);

/** Superadminlarni boshqarish (parol talab qiladi): 15 daqiqada 30 ta */
export const superadminActionLimiter = perUser(
  15 * 60_000,
  30,
  "Urinishlar juda ko'p. Keyinroq urinib ko'ring",
);

/** Parolni tiklash (ommaviy): IP bo'yicha, 15 daqiqada */
const RESET_MSG = "Urinishlar juda ko'p. Keyinroq urinib ko'ring";
export const passwordResetRequestIpLimiter = make(15 * 60_000, 5, RESET_MSG);
export const passwordResetVerifyLimiter = make(15 * 60_000, 20, RESET_MSG);
export const passwordResetCompleteLimiter = make(15 * 60_000, 20, RESET_MSG);
export const passwordResetInfoLimiter = make(60_000, 60, RESET_MSG);

/** Kod so'rash: login bo'yicha, 15 daqiqada 5 ta (validate dan keyin, body.username normallashgan) */
export const passwordResetRequestUserLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !env.RATE_LIMIT_ENABLED,
  keyGenerator: (req) => `pr:${String(req.body?.username ?? '')}`,
  handler: (_req, _res, next) => next(AppError.rateLimited(RESET_MSG)),
});
