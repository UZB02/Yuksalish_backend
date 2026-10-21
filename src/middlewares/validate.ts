import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError, type ErrorDetail } from '../core/errors';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/** Zod sxema bilan body/query/params ni tekshiradi va tozalangan qiymatni qayta yozadi */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    const details: ErrorDetail[] = [];
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        (req as unknown as Record<string, unknown>)[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({ path: issue.path.join('.'), message: issue.message });
        }
      }
    }
    if (details.length) return next(AppError.validation("Ma'lumotlar noto'g'ri", details));
    next();
  };
