import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { telegramLinkLimiter } from '../../middlewares/rateLimiters';
import { validate } from '../../middlewares/validate';
import { telegramService } from './telegram.service';

export const telegramRouter = Router();

telegramRouter.use(authenticate);

const configBody = z
  .object({
    token: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => b.token !== undefined || b.enabled !== undefined, {
    message: 'token yoki enabled berilishi kerak',
  });

// ---- Platforma sozlamasi (faqat superadmin) ----
telegramRouter.get(
  '/config',
  authorize('superadmin'),
  asyncHandler(async (_req, res) => ok(res, await telegramService.getConfig())),
);
telegramRouter.put(
  '/config',
  authorize('superadmin'),
  validate({ body: configBody }),
  asyncHandler(async (req, res) =>
    ok(res, await telegramService.updateConfig(getCtx(req), req.body)),
  ),
);
telegramRouter.delete(
  '/config',
  authorize('superadmin'),
  asyncHandler(async (req, res) => ok(res, await telegramService.deleteConfig(getCtx(req)))),
);

// ---- Joriy foydalanuvchi ----
telegramRouter.get(
  '/me',
  asyncHandler(async (req, res) => ok(res, await telegramService.me(getCtx(req).actor.id))),
);
telegramRouter.post(
  '/me/link',
  telegramLinkLimiter,
  asyncHandler(async (req, res) => ok(res, await telegramService.issueLink(getCtx(req).actor.id))),
);
telegramRouter.delete(
  '/me/link',
  asyncHandler(async (req, res) => ok(res, await telegramService.unlinkMe(getCtx(req)))),
);
