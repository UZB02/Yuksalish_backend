import type { RequestHandler } from 'express';
import type { Role } from '../constants/roles';
import { AppError } from '../core/errors';

/** Faqat ko'rsatilgan rollarga ruxsat */
export const authorize =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };

/** Ko'rsatilgan ruxsatlardan kamida bittasi kerak; superadmin tekshiruvdan o'tadi */
export const requireAnyPermission =
  (...perms: string[]): RequestHandler =>
  (req, _res, next) => {
    const user = req.user;
    if (!user) return next(AppError.unauthorized());
    if (user.role === 'superadmin') return next();
    if (!perms.some((p) => user.permissions.includes(p))) return next(AppError.forbidden());
    next();
  };

/** Barcha ko'rsatilgan ruxsatlar kerak; superadmin tekshiruvdan o'tadi */
export const requirePermission =
  (...perms: string[]): RequestHandler =>
  (req, _res, next) => {
    const user = req.user;
    if (!user) return next(AppError.unauthorized());
    if (user.role === 'superadmin') return next();
    if (!perms.every((p) => user.permissions.includes(p))) return next(AppError.forbidden());
    next();
  };
