import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { ok } from '../../core/response';
import { attendanceService as s } from './attendance.service';
import { attendanceStats as stats } from './attendance.stats';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

export const bulk = asyncHandler(async (req, res) => {
  ok(res, await s.bulk(getCtx(req), sid(req), req.body));
});
export const update = asyncHandler(async (req, res) => {
  ok(res, await s.update(getCtx(req), sid(req), id(req), req.body));
});
export const remove = asyncHandler(async (req, res) => {
  await s.remove(getCtx(req), sid(req), id(req));
  ok(res, { deleted: true });
});
export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.list(getCtx(req).actor, sid(req), req.query as never);
  ok(res, items, meta);
});
export const sheet = asyncHandler(async (req, res) => {
  ok(res, await s.sheet(getCtx(req).actor, sid(req), id(req), req.query as never));
});
export const summary = asyncHandler(async (req, res) => {
  ok(res, await stats.summary(getCtx(req).actor, sid(req), req.query as never));
});
export const studentSummary = asyncHandler(async (req, res) => {
  ok(res, await stats.studentSummary(getCtx(req).actor, sid(req), id(req), req.query as never));
});
export const todayProgress = asyncHandler(async (req, res) => {
  ok(res, await stats.todayProgress(getCtx(req).actor, sid(req)));
});
