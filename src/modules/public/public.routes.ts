import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { objectIdSchema } from '../../core/validators';
import { paginationQuery } from '../../core/pagination';
import { publicLimiter } from '../../middlewares/rateLimiters';
import { validate } from '../../middlewares/validate';
import { publicCache } from './public.cache';
import { publicService } from './public.service';

/** Autentifikatsiyasiz, faqat o'qish. Alohida rate limit, kesh va ETag. */
export const publicRouter = Router();

publicRouter.use(publicLimiter);
publicRouter.use(((_req, res, next) => {
  // Boshqa originlardagi public frontend o'qiy olishi uchun
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}) as RequestHandler);

async function respond(
  req: Request,
  res: Response,
  compute: () => Promise<{ data: unknown; meta?: unknown }>,
) {
  const entry = await publicCache.getOrCompute(req.originalUrl, async () => {
    const r = await compute();
    return { body: { success: true, data: r.data, ...(r.meta ? { meta: r.meta } : {}) } };
  });
  res.set({
    'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
    ETag: entry.etag,
  });
  if (req.headers['if-none-match'] === entry.etag) {
    res.status(304).end();
    return;
  }
  res.status(entry.status).json(entry.body);
}

const slug = (req: Request) => String(req.params.slug);

publicRouter.get(
  '/schools',
  asyncHandler((req, res) => respond(req, res, () => publicService.schools())),
);

// "global" — zaxiralangan slug (maktab uchun ishlatib bo'lmaydi)
publicRouter.get(
  '/global/rating',
  asyncHandler((req, res) => respond(req, res, () => publicService.globalRating())),
);

publicRouter.get(
  '/:slug/config',
  asyncHandler((req, res) => respond(req, res, () => publicService.config(slug(req)))),
);

publicRouter.get(
  '/:slug/rating/classes',
  validate({ query: z.object({ grade: z.coerce.number().int().min(1).max(11).optional() }) }),
  asyncHandler((req, res) =>
    respond(req, res, () => publicService.classes(slug(req), req.query as never)),
  ),
);

publicRouter.get(
  '/:slug/rating/students',
  validate({
    query: z.object({
      ...paginationQuery,
      limit: z.coerce.number().int().min(1).max(200).default(50),
      classId: objectIdSchema.optional(),
      grade: z.coerce.number().int().min(1).max(11).optional(),
      search: z.string().trim().max(100).optional(),
    }),
  }),
  asyncHandler((req, res) =>
    respond(req, res, () => publicService.students(slug(req), req.query as never)),
  ),
);

// Rasm: binar javob, shuning uchun publicCache dan o'tmaydi; ETag = mazmun xeshi
publicRouter.get(
  '/:slug/photos/:photoId',
  asyncHandler(async (req, res) => {
    const photo = await publicService.photo(slug(req), String(req.params.photoId));
    const etag = `"${photo.hash}"`;
    res.set({
      'Content-Type': photo.contentType,
      ETag: etag,
      'Cache-Control': 'public, max-age=3600',
    });
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.set('Content-Length', String(photo.data.length));
    res.status(200).end(photo.data);
  }),
);
