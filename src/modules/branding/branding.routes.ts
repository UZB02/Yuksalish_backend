import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { brandingService } from './branding.service';
import { sendLogo } from './branding.send';
import { uploadLogo } from './branding.upload';

export const brandingRouter = Router();

// Rasm/manifest boshqa originlardagi frontendlarda ham ko'rinishi kerak
brandingRouter.use(((_req, res, next) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}) as RequestHandler);

const updateBody = z.object({
  appName: z.string().trim().min(1).max(60),
  shortName: z.string().trim().min(1).max(20),
});

// ---- Ochiq (autentifikatsiyasiz) ----
brandingRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    ok(res, await brandingService.get());
  }),
);

brandingRouter.get(
  '/manifest.webmanifest',
  asyncHandler(async (_req, res) => {
    res.set({
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.status(200).send(JSON.stringify(await brandingService.manifest()));
  }),
);

brandingRouter.get(
  '/logo/:variant',
  asyncHandler(async (req, res) => {
    const { asset, immutable } = await brandingService.platformVariant(
      String(req.params.variant),
      req.query.v,
    );
    sendLogo(req, res, asset, immutable);
  }),
);

// Maktab logosi (admin DTO): id bo'yicha, ochiq
brandingRouter.get(
  '/schools/:id/logo',
  asyncHandler(async (req, res) => {
    const { asset, immutable } = await brandingService.schoolLogoById(
      String(req.params.id),
      req.query.v,
    );
    sendLogo(req, res, asset, immutable);
  }),
);

// ---- Boshqaruv: faqat superadmin ----
brandingRouter.put(
  '/',
  authenticate,
  authorize('superadmin'),
  validate({ body: updateBody }),
  asyncHandler(async (req, res) => {
    ok(res, await brandingService.update(getCtx(req), req.body));
  }),
);

brandingRouter.post(
  '/logo',
  authenticate,
  authorize('superadmin'),
  uploadLogo,
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw AppError.validation('Logo fayli yuborilmagan', [
        { path: 'file', message: 'Logo fayli majburiy' },
      ]);
    }
    ok(res, await brandingService.setLogo(getCtx(req), req.file.buffer));
  }),
);

brandingRouter.delete(
  '/logo',
  authenticate,
  authorize('superadmin'),
  asyncHandler(async (req, res) => {
    ok(res, await brandingService.deleteLogo(getCtx(req)));
  }),
);
