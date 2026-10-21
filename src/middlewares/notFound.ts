import type { RequestHandler } from 'express';
import { AppError } from '../core/errors';

export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Yo'l topilmadi: ${req.method} ${req.path}`));
};
