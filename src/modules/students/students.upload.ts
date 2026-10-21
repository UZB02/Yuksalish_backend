import path from 'path';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../core/errors';
import { MAX_FILE_BYTES } from './students.excel';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 },
  fileFilter: (_req, file, cb) => {
    const okExt = path.extname(file.originalname).toLowerCase() === '.xlsx';
    if (!okExt || file.mimetype !== XLSX_MIME) {
      return cb(
        AppError.validation('Faqat .xlsx fayl yuklash mumkin', [
          { path: 'file', message: 'Faqat .xlsx fayl' },
        ]),
      );
    }
    cb(null, true);
  },
}).single('file');

/** multipart `file` maydonini req.file ga yuklaydi (xotirada, 5 MB gacha) */
export const uploadXlsx: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Fayl hajmi 5 MB dan oshmasligi kerak'
          : "Fayl yuklashda xatolik: so'rov noto'g'ri";
      return next(AppError.validation(msg, [{ path: 'file', message: msg }]));
    }
    next(err);
  });
};
