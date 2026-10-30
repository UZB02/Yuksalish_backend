import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../core/errors';
import { MAX_LOGO_BYTES } from './branding.process';

const MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 2, parts: 4 },
  fileFilter: (_req, file, cb) => {
    if (!MIMES.includes(file.mimetype)) {
      return cb(
        AppError.validation('Faqat PNG, JPG yoki WebP logo yuklash mumkin', [
          { path: 'file', message: 'Faqat PNG, JPG yoki WebP' },
        ]),
      );
    }
    cb(null, true);
  },
}).single('file');

/** multipart `file` maydonini req.file ga yuklaydi (xotirada, 2 MB gacha) */
export const uploadLogo: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Logo hajmi 2 MB dan oshmasligi kerak'
          : "Logo yuklashda xatolik: so'rov noto'g'ri";
      return next(AppError.validation(msg, [{ path: 'file', message: msg }]));
    }
    next(err);
  });
};
