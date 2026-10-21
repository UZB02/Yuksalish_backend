import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { subjectsService as s } from './subjects.service';

const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const q = req.query as { isActive?: boolean; scope?: 'global' | 'school' | 'all' };
  ok(res, await s.list({ ...q, schoolId: req.schoolId }));
});
export const create = asyncHandler(async (req, res) => {
  created(res, await s.create(getCtx(req), req.body));
});
export const update = asyncHandler(async (req, res) => {
  ok(res, await s.update(getCtx(req), id(req), req.body));
});
export const activate = asyncHandler(async (req, res) => {
  ok(res, await s.setActive(getCtx(req), id(req), true));
});
export const deactivate = asyncHandler(async (req, res) => {
  ok(res, await s.setActive(getCtx(req), id(req), false));
});
export const remove = asyncHandler(async (req, res) => {
  await s.remove(getCtx(req), id(req));
  ok(res, { deleted: true });
});
