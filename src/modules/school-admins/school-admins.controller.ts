import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { schoolAdminsService } from './school-admins.service';

const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await schoolAdminsService.list(req.query as never);
  ok(res, items, meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await schoolAdminsService.get(id(req)));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await schoolAdminsService.create(getCtx(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await schoolAdminsService.update(getCtx(req), id(req), req.body));
});

export const setPermissions = asyncHandler(async (req, res) => {
  ok(res, await schoolAdminsService.setPermissions(getCtx(req), id(req), req.body.permissions));
});

export const resetPassword = asyncHandler(async (req, res) => {
  await schoolAdminsService.resetPassword(getCtx(req), id(req), req.body.newPassword);
  ok(res, { reset: true });
});
