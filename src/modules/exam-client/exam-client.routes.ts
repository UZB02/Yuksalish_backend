import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { ok } from '../../core/response';
import { examClientTokenOf } from '../../middlewares/rateLimiters';
import { validate } from '../../middlewares/validate';
import type { ExamAttemptDoc } from '../../models/ExamAttempt';
import {
  answersBody,
  authenticateAttempt,
  eventBody,
  examClientService,
  finishBlockBody,
  joinBody,
  joinCodeBody,
  joinConfirmBody,
} from './exam-client.service';

/**
 * Imtihon topshiruvchi (o'quvchi) API'si: /api/v1/exam-client/*.
 *
 *  - app.ts da apiLimiter DAN OLDIN ulangan, o'z limiterlari bilan (token xeshi bo'yicha; kirish uchun IP + kod).
 *  - Autentifikatsiya: opaque urinish tokeni, faqat `Authorization: Bearer` (admin JWT emas, cookie emas).
 *    schoolId/sessionId klientdan HECH QACHON olinmaydi: faqat token orqali topilgan urinish hujjatidan.
 *  - Barcha javoblar Cache-Control: no-store. Javob kaliti hech qachon chiqmaydi (oq ro'yxatli DTO),
 *    faqat sessiyaning natija rejimi ruxsat bergan natija ko'rinishida.
 *  - pino-http bu yo'l uchun faqat xatolarni loglaydi.
 */
export const examClientRouter = Router();

examClientRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  next();
});

const requireAttempt: RequestHandler = asyncHandler(async (req, res, next) => {
  res.locals.attempt = await authenticateAttempt(examClientTokenOf(req));
  next();
});
const attemptOf = (res: Response) => res.locals.attempt as ExamAttemptDoc;

examClientRouter.post(
  '/join',
  validate({ body: joinBody }),
  asyncHandler(async (req, res) => {
    ok(res, await examClientService.join(req.body, req.ip ?? ''));
  }),
);

// Shaxsiy kod bilan kirish: 1) kod -> "Bu sizmisiz?" ma'lumoti (urinish yaratilmaydi), 2) tasdiqlash -> token
examClientRouter.post(
  '/join-code',
  validate({ body: joinCodeBody }),
  asyncHandler(async (req, res) => {
    ok(res, await examClientService.joinCode(req.body, req.ip ?? ''));
  }),
);

examClientRouter.post(
  '/join-confirm',
  validate({ body: joinConfirmBody }),
  asyncHandler(async (req, res) => {
    ok(res, await examClientService.joinConfirm(req.body));
  }),
);

examClientRouter.post(
  '/start',
  requireAttempt,
  asyncHandler(async (_req, res) => {
    ok(res, await examClientService.start(attemptOf(res)));
  }),
);

examClientRouter.get(
  '/state',
  requireAttempt,
  asyncHandler(async (_req, res) => {
    ok(res, await examClientService.state(attemptOf(res)));
  }),
);

examClientRouter.put(
  '/answers',
  requireAttempt,
  validate({ body: answersBody }),
  asyncHandler(async (req, res) => {
    ok(res, await examClientService.saveAnswers(attemptOf(res), req.body));
  }),
);

examClientRouter.post(
  '/events',
  requireAttempt,
  validate({ body: eventBody }),
  asyncHandler(async (req, res) => {
    ok(res, await examClientService.recordEvent(attemptOf(res), req.body));
  }),
);

examClientRouter.post(
  '/heartbeat',
  requireAttempt,
  asyncHandler(async (_req, res) => {
    ok(res, await examClientService.heartbeat(attemptOf(res)));
  }),
);

examClientRouter.post(
  '/submit',
  requireAttempt,
  asyncHandler(async (_req, res) => {
    ok(res, await examClientService.submit(attemptOf(res)));
  }),
);

examClientRouter.post(
  '/blocks/finish',
  requireAttempt,
  validate({ body: finishBlockBody }),
  asyncHandler(async (req, res) => {
    ok(res, await examClientService.finishBlock(attemptOf(res), req.body));
  }),
);

examClientRouter.get(
  '/result',
  requireAttempt,
  asyncHandler(async (_req, res) => {
    ok(res, await examClientService.result(attemptOf(res)));
  }),
);

examClientRouter.get(
  '/assets/:id',
  requireAttempt,
  validate({ params: z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) }) }),
  asyncHandler(async (req, res) => {
    const a = await examClientService.asset(attemptOf(res), String(req.params.id));
    res.set({ 'Content-Type': a.contentType, 'Content-Length': String(a.data.length) });
    res.status(200).end(a.data);
  }),
);

// Qolgan hamma yo'l: 404
examClientRouter.use((_req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Topilmadi' } });
});
