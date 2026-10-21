import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { gradesService as s } from './grades.service';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.list(getCtx(req).actor, sid(req), req.query as never);
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => {
  created(res, await s.create(getCtx(req), sid(req), req.body));
});
export const update = asyncHandler(async (req, res) => {
  ok(res, await s.update(getCtx(req), sid(req), id(req), req.body));
});
export const remove = asyncHandler(async (req, res) => {
  await s.remove(getCtx(req), sid(req), id(req));
  ok(res, { deleted: true });
});
export const bulk = asyncHandler(async (req, res) => {
  ok(res, await s.bulk(getCtx(req), sid(req), req.body));
});
export const myAssignments = asyncHandler(async (req, res) => {
  ok(res, await s.myAssignments(getCtx(req).actor, sid(req)));
});
export const sheet = asyncHandler(async (req, res) => {
  ok(res, await s.sheet(getCtx(req).actor, sid(req), req.query as never));
});
export const studentSummary = asyncHandler(async (req, res) => {
  ok(res, await s.studentSummary(getCtx(req).actor, sid(req), id(req), req.query as never));
});
