import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { schoolsService } from './schools.service';

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
