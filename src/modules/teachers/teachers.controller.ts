import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { teachersService } from './teachers.service';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await teachersService.list(sid(req), req.query as never);
  ok(res, items, meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await teachersService.get(sid(req), id(req)));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await teachersService.create(getCtx(req), sid(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await teachersService.update(getCtx(req), sid(req), id(req), req.body));
});

export const setPhoto = asyncHandler(async (req, res) => {
  ok(res, await teachersService.setPhoto(getCtx(req), sid(req), id(req), req.file));
});

export const removePhoto = asyncHandler(async (req, res) => {
  ok(res, await teachersService.removePhoto(getCtx(req), sid(req), id(req)));
});

export const setPermissions = asyncHandler(async (req, res) => {
  ok(
    res,
    await teachersService.setPermissions(getCtx(req), sid(req), id(req), req.body.permissions),
  );
});

export const setClasses = asyncHandler(async (req, res) => {
  ok(res, await teachersService.setClasses(getCtx(req), sid(req), id(req), req.body.classIds));
});

export const resetPassword = asyncHandler(async (req, res) => {
  await teachersService.resetPassword(getCtx(req), sid(req), id(req), req.body.newPassword);
  ok(res, { reset: true });
});
