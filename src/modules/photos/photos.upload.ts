import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../core/errors';
import { ALLOWED_PHOTO_MIMES, MAX_PHOTO_BYTES } from './photos.process';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 2, parts: 4 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
      return cb(
        AppError.validation('Faqat JPG, PNG yoki WebP rasm yuklash mumkin', [
          { path: 'photo', message: 'Faqat JPG, PNG yoki WebP' },
        ]),
      );
    }
    cb(null, true);
  },
}).single('photo');

/** multipart `photo` maydonini req.file ga yuklaydi (xotirada, 5 MB gacha) */
export const uploadPhoto: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Rasm hajmi 5 MB dan oshmasligi kerak'
          : "Rasm yuklashda xatolik: so'rov noto'g'ri";
      return next(AppError.validation(msg, [{ path: 'photo', message: msg }]));
    }
    next(err);
  });
};
