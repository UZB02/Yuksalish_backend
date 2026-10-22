import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { AppError } from '../../core/errors';
import { Photo } from '../../models/Photo';
import { isId } from '../../utils/helpers';
import { verifyPhotoSignature } from './photos.url';

/**
 * Imzolangan havola orqali rasm berish: GET /api/v1/photos/:id?exp=&sig=
 * Access token URL ga qo'yilmaydi; havolani faqat ruxsati bor foydalanuvchining DTO si beradi.
 */
export const photosRouter = Router();

photosRouter.use(((_req, res, next) => {
  // Admin frontend boshqa originda bo'lishi mumkin (helmet default: same-origin)
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}) as RequestHandler);

photosRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!isId(id)) throw AppError.notFound('Rasm topilmadi');
    if (!verifyPhotoSignature(id, req.query.exp, req.query.sig)) {
      throw AppError.unauthorized('Rasm havolasi yaroqsiz yoki muddati tugagan');
    }
    const meta = await Photo.findById(id).select('hash contentType').lean();
    if (!meta) throw AppError.notFound('Rasm topilmadi');
    const etag = `"${meta.hash}"`;
    res.set({
      'Content-Type': meta.contentType,
      ETag: etag,
      'Cache-Control': 'private, max-age=86400',
    });
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const full = await Photo.findById(id).select('+data');
    if (!full) throw AppError.notFound('Rasm topilmadi');
    const buf = full.data;
    res.set('Content-Length', String(buf.length));
    res.status(200).end(buf);
  }),
);
