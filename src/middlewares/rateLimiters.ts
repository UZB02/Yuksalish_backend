import crypto from 'crypto';
import type { Request } from 'express';
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

/** Faqat login: 15 daqiqada 30 ta (IP bo'yicha). /auth/refresh uchun ISHLATILMAYDI, pastdagi refresh limiterlarga qarang */
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

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

// ---------------------------------------------------------------------------------------------
// /auth/refresh: bitta maktab NAT'i orqasidagi hamma foydalanuvchi bir IP dan chiqadi, shuning uchun
// loginLimiter (30/15 daq/IP) dan ajratilgan. Ikki qatlam: (1) IP bo'yicha saxiy chegara,
// (2) refresh token xeshi bo'yicha qattiq chegara (bitta tokenni takror urish / taxmin qilishga qarshi).
// ---------------------------------------------------------------------------------------------
export interface RefreshLimiterOptions {
  /** Limiter yoqilganmi (default: env.RATE_LIMIT_ENABLED) */
  enabled?: () => boolean;
  ipLimit?: number;
  ipWindowMs?: number;
  tokenLimit?: number;
  tokenWindowMs?: number;
}

const REFRESH_MSG = "Sessiyani yangilash urinishlari juda ko'p. Birozdan so'ng urinib ko'ring";

export function createRefreshLimiters(o: RefreshLimiterOptions = {}) {
  const enabled = o.enabled ?? (() => env.RATE_LIMIT_ENABLED);
  const ip = rateLimit({
    windowMs: o.ipWindowMs ?? 15 * 60_000,
    limit: o.ipLimit ?? 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !enabled(),
    handler: (_req, _res, next) => next(AppError.rateLimited(REFRESH_MSG)),
  });
  const token = rateLimit({
    windowMs: o.tokenWindowMs ?? 60_000,
    limit: o.tokenLimit ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    // Cookie yo'q so'rov (login sahifasi ochilganda SPA shunday yuboradi) bu chegaraga tushmaydi:
    // u faqat IP limiter bilan cheklanadi, aks holda NAT orqasidagi hamma bitta chelakda qolardi
    skip: (req) => !enabled() || !refreshCookie(req),
    keyGenerator: (req) => 'rt:' + sha256(refreshCookie(req) as string),
    handler: (_req, _res, next) => next(AppError.rateLimited(REFRESH_MSG)),
  });
  return { ip, token };
}

const refreshCookie = (req: Request): string | undefined => {
  const v = req.cookies?.refreshToken;
  return typeof v === 'string' && v ? v : undefined;
};

export const { ip: refreshIpLimiter, token: refreshTokenLimiter } = createRefreshLimiters();

// ---------------------------------------------------------------------------------------------
// Exam-client (/api/v1/exam-client): apiLimiter DAN OLDIN ulanadi (photos kabi). Maktab NAT'i
// orqasida 300-500 o'quvchi bitta IP dan ishlaydi, shuning uchun IP bo'yicha qattiq chegara YO'Q.
// Kalit: urinish tokeni xeshi ("Authorization: Bearer <opaque>"); token yo'q so'rov (kirish) uchun
// IP + sessiya kodi, saxiy chegara bilan. Qo'shimcha: IP bo'yicha juda baland "xavfsizlik to'ri".
// ---------------------------------------------------------------------------------------------
export interface ExamClientLimiterOptions {
  enabled?: () => boolean;
  windowMs?: number;
  /** Bitta urinish tokeni uchun (autosave/heartbeat) */
  tokenLimit?: number;
  /** Tokensiz so'rovlar (kirish): IP + kod uchun */
  joinLimit?: number;
  /** IP bo'yicha umumiy xavfsizlik to'ri */
  ipLimit?: number;
}

const EXAM_MSG = "So'rovlar juda ko'p. Birozdan so'ng urinib ko'ring";

export const examClientTokenOf = (req: Request): string | undefined => {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return undefined;
  const t = h.slice(7).trim();
  return t || undefined;
};

/** Sessiya kodi (body.code yoki query.code), kalit uchun normallashgan va qisqartirilgan */
const examCodeOf = (req: Request): string => {
  const raw = req.body?.code ?? req.query?.code;
  return typeof raw === 'string' ? raw.trim().toUpperCase().slice(0, 16) : '-';
};

export function createExamClientLimiters(o: ExamClientLimiterOptions = {}) {
  const enabled = o.enabled ?? (() => env.RATE_LIMIT_ENABLED);
  const windowMs = o.windowMs ?? 60_000;
  const main = rateLimit({
    windowMs,
    limit: (req) => (examClientTokenOf(req) ? (o.tokenLimit ?? 120) : (o.joinLimit ?? 1500)),
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !enabled(),
    keyGenerator: (req) => {
      const t = examClientTokenOf(req);
      return t ? 'at:' + sha256(t) : 'jc:' + ipKeyGenerator(req.ip ?? '') + '|' + examCodeOf(req);
    },
    handler: (_req, _res, next) => next(AppError.rateLimited(EXAM_MSG)),
  });
  const ip = rateLimit({
    windowMs,
    limit: o.ipLimit ?? 20_000,
    standardHeaders: false,
    legacyHeaders: false,
    skip: () => !enabled(),
    keyGenerator: (req) => 'ip:' + ipKeyGenerator(req.ip ?? ''),
    handler: (_req, _res, next) => next(AppError.rateLimited(EXAM_MSG)),
  });
  return { main, ip };
}

export const { main: examClientLimiter, ip: examClientIpLimiter } = createExamClientLimiters();

/** Savol rasmlarini yuklash: foydalanuvchi bo'yicha daqiqasiga 60 ta (authenticate dan keyin) */
export const examAssetUploadLimiter = perUser(
  60_000,
  60,
  "Rasm yuklash juda tez. Birozdan so'ng urinib ko'ring",
);

/** Savollar importi (og'ir): foydalanuvchi bo'yicha daqiqasiga 10 ta (authenticate dan keyin) */
export const examImportLimiter = perUser(
  60_000,
  10,
  "Import so'rovlari juda ko'p. Birozdan so'ng urinib ko'ring",
);

/** "Matnni joylash": jonli ko'rish (debounce ~300 ms) ko'p so'rov yuboradi: minutiga 120 ta */
export const examPasteLimiter = perUser(
  60_000,
  120,
  "Matnni tekshirish so'rovlari juda ko'p. Birozdan so'ng urinib ko'ring",
);
