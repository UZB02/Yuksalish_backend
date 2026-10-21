import type { Request } from 'express';
import type { AuthUser } from '../types/express';
import { AppError } from './errors';

/** Servis chaqiruvlari uchun so'rov konteksti */
export interface Ctx {
  actor: AuthUser;
  ip?: string;
}

export interface ReqMeta {
  ip?: string;
  userAgent?: string;
}

export function getCtx(req: Request): Ctx {
  if (!req.user) throw AppError.unauthorized();
  return { actor: req.user, ip: req.ip };
}

export const reqMeta = (req: Request): ReqMeta => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});
