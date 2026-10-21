import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { academicYearsService as s } from './academic-years.service';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  ok(res, await s.list(sid(req)));
});
export const create = asyncHandler(async (req, res) => {
  created(res, await s.create(getCtx(req), sid(req), req.body));
});
export const update = asyncHandler(async (req, res) => {
  ok(res, await s.update(getCtx(req), sid(req), id(req), req.body));
});
export const activate = asyncHandler(async (req, res) => {
  ok(res, await s.activate(getCtx(req), sid(req), id(req)));
});
export const remove = asyncHandler(async (req, res) => {
  await s.remove(getCtx(req), sid(req), id(req));
  ok(res, { deleted: true });
});
