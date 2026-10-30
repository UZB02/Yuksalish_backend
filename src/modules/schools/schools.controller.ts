import type { RequestHandler } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { AppError } from '../../core/errors';
import { brandingService } from '../branding/branding.service';
import { schoolsService, toSchoolDto } from './schools.service';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await schoolsService.list(req.query as never);
  ok(res, items, meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await schoolsService.get(String(req.params.id)));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await schoolsService.create(getCtx(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await schoolsService.update(getCtx(req), String(req.params.id), req.body));
});

/** school_admin faqat o'z maktabi logosini boshqaradi (boshqasi uchun 403) */
export const ownSchoolOnly: RequestHandler = (req, _res, next) => {
  const user = req.user;
  if (!user) return next(AppError.unauthorized());
  if (user.role !== 'superadmin' && user.schoolId !== String(req.params.id)) {
    return next(AppError.forbidden());
  }
  next();
};

export const setLogo = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw AppError.validation('Logo fayli yuborilmagan', [
      { path: 'file', message: 'Logo fayli majburiy' },
    ]);
  }
  const school = await brandingService.setSchoolLogo(
    getCtx(req),
    String(req.params.id),
    req.file.buffer,
  );
  ok(res, toSchoolDto(school));
});

export const deleteLogo = asyncHandler(async (req, res) => {
  ok(res, toSchoolDto(await brandingService.deleteSchoolLogo(getCtx(req), String(req.params.id))));
});
