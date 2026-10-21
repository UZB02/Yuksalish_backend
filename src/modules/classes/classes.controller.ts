import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { classesService as s } from './classes.service';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.list(getCtx(req).actor, sid(req), req.query as never);
  ok(res, items, meta);
});
export const get = asyncHandler(async (req, res) => {
  ok(res, await s.get(getCtx(req).actor, sid(req), id(req)));
});
export const create = asyncHandler(async (req, res) => {
  created(res, await s.create(getCtx(req), sid(req), req.body));
});
export const update = asyncHandler(async (req, res) => {
  ok(res, await s.update(getCtx(req), sid(req), id(req), req.body));
});
export const archive = asyncHandler(async (req, res) => {
  ok(res, await s.setArchived(getCtx(req), sid(req), id(req), true));
});
export const unarchive = asyncHandler(async (req, res) => {
  ok(res, await s.setArchived(getCtx(req), sid(req), id(req), false));
});
export const setSubjects = asyncHandler(async (req, res) => {
  ok(res, await s.setSubjects(getCtx(req), sid(req), id(req), req.body.subjects));
});
export const setTeachers = asyncHandler(async (req, res) => {
  ok(res, await s.setTeachers(getCtx(req), sid(req), id(req), req.body));
});
