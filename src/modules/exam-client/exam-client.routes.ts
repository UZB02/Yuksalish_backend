import { Router } from 'express';
import { AppError } from '../../core/errors';

/**
 * Imtihon topshiruvchi (o'quvchi) API'si: /api/v1/exam-client/*.
 *
 * E0 holati: faqat joy band qilingan (placeholder). Hech narsa ochilmaydi, har qanday so'rov 404.
 * Haqiqiy endpointlar (kirish, boshlash, autosave, topshirish) E4 bosqichida qo'shiladi.
 *
 * Muhim (E4 uchun):
 *  - app.ts da apiLimiter DAN OLDIN ulangan, o'z limiterlari bilan (urinish tokeni xeshi bo'yicha;
 *    token yo'q so'rov uchun IP + sessiya kodi, saxiy chegara) - maktab NAT'i uchun.
 *  - Admin CORS (credentials) ostiga tushmaydi: SPA va API bir originda (Caddy) bo'ladi.
 *  - pino-http bu yo'l uchun faqat xatolarni loglaydi (autosave hajmi).
 *  - Autentifikatsiya: opaque urinish tokeni (bazada sha256), admin JWT emas.
 */
export const examClientRouter = Router();

examClientRouter.use((_req, _res, next) => next(AppError.notFound('Topilmadi')));
