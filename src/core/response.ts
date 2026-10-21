import type { Response } from 'express';
import type { PageMeta } from './pagination';

export function ok<T>(res: Response, data: T, meta?: PageMeta, status = 200): Response {
  return res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
}

export function created<T>(res: Response, data: T): Response {
  return ok(res, data, undefined, 201);
}
