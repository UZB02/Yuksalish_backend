import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { superadminsService } from './superadmins.service';

const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (_req, res) => {
  ok(res, await superadminsService.list());
});

export const create = asyncHandler(async (req, res) => {
  created(res, await superadminsService.create(getCtx(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await superadminsService.update(getCtx(req), id(req), req.body));
});

export const transferOwnership = asyncHandler(async (req, res) => {
  ok(
    res,
    await superadminsService.transferOwnership(getCtx(req), id(req), req.body.currentPassword),
  );
});
