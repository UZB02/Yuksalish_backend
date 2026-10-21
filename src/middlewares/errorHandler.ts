import type { ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../core/errors';
import { logger } from '../core/logger';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;

  if (err instanceof AppError) {
    appErr = err;
  } else if (err?.type === 'entity.parse.failed') {
    appErr = AppError.validation("So'rov JSON formati noto'g'ri");
  } else if (err?.type === 'entity.too.large') {
    appErr = AppError.validation("So'rov hajmi juda katta");
  } else if (err instanceof mongoose.Error.ValidationError) {
    appErr = AppError.validation(
      "Ma'lumotlar noto'g'ri",
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  } else if (err instanceof mongoose.Error.CastError) {
    appErr = AppError.validation("Qiymat formati noto'g'ri", [
      { path: err.path, message: "Format noto'g'ri" },
    ]);
  } else if (err?.code === 11000) {
    appErr = AppError.conflict('Bunday yozuv allaqachon mavjud');
  } else {
    (req.log ?? logger).error({ err }, 'Kutilmagan xato');
    appErr = new AppError('INTERNAL', 'Serverda xatolik yuz berdi');
  }

  res.status(appErr.status).json({
    success: false,
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details?.length ? { details: appErr.details } : {}),
    },
  });
};
