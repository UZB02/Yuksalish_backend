import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import {
  activateBody,
  activateBulkBody,
  bulkPreviewBody,
  classIdParams,
  correctBody,
  createVersionBody,
  dayQuery,
  lessonsQuery,
  optionsQuery,
  teacherIdParams,
  updateVersionBody,
  versionIdParams,
  versionQuery,
  weekQuery,
} from './timetable.schema';
import { timetableService, type ActivateOpts } from './timetable.service';

export const timetableRouter = Router();

timetableRouter.use(authenticate, authorize('superadmin', 'school_admin', 'teacher'), tenant);

/**
 * O'qish: ruxsat/o'qituvchi doirasi servisda tekshiriladi
 * (timetable.view|manage — hammasi; o'qituvchi — o'z haftasi va o'z sinflari jadvali).
 */
const read = (fn: (req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) => Promise<unknown>) =>
  asyncHandler(async (req, res) => {
    ok(res, await fn(req));
  });

timetableRouter.get(
  '/me/week',
  validate({ query: weekQuery }),
  read((req) => {
    const ctx = getCtx(req);
    return timetableService.teacherWeek(
      ctx.actor,
      req.schoolId as string,
      ctx.actor.id,
      (req.query as { date?: string }).date,
    );
  }),
);

timetableRouter.get(
  '/teachers/:teacherId/week',
  validate({ params: teacherIdParams, query: weekQuery }),
  read((req) =>
    timetableService.teacherWeek(
      getCtx(req).actor,
      req.schoolId as string,
      req.params.teacherId as string,
      (req.query as { date?: string }).date,
    ),
  ),
);

timetableRouter.get(
  '/day',
  validate({ query: dayQuery }),
  read((req) =>
    timetableService.day(
      getCtx(req).actor,
      req.schoolId as string,
      (req.query as { date?: string }).date,
    ),
  ),
);

timetableRouter.get(
  '/lessons',
  validate({ query: lessonsQuery }),
  read((req) => {
    const q = req.query as unknown as { classId: string; date: string };
    return timetableService.lessons(getCtx(req).actor, req.schoolId as string, q.classId, q.date);
  }),
);

timetableRouter.get(
  '/options',
  validate({ query: optionsQuery }),
  read((req) =>
    timetableService.options(
      getCtx(req).actor,
      req.schoolId as string,
      (req.query as { classId?: string }).classId,
    ),
  ),
);

timetableRouter.get(
  '/classes',
  read((req) => timetableService.overview(getCtx(req).actor, req.schoolId as string)),
);

timetableRouter.get(
  '/classes/:classId/versions',
  validate({ params: classIdParams }),
  read((req) =>
    timetableService.listVersions(
      getCtx(req).actor,
      req.schoolId as string,
      req.params.classId as string,
    ),
  ),
);

timetableRouter.get(
  '/versions/:id',
  validate({ params: versionIdParams, query: versionQuery }),
  read((req) =>
    timetableService.getVersion(
      getCtx(req).actor,
      req.schoolId as string,
      req.params.id as string,
      (req.query as { validFrom?: string }).validFrom,
    ),
  ),
);

// --- Yozish: timetable.manage ---
const manage = [authorize('superadmin', 'school_admin'), requirePermission('timetable.manage')];

timetableRouter.post(
  '/classes/:classId/versions',
  ...manage,
  validate({ params: classIdParams, body: createVersionBody }),
  asyncHandler(async (req, res) => {
    created(
      res,
      await timetableService.createVersion(
        getCtx(req),
        req.schoolId as string,
        req.params.classId as string,
        req.body,
      ),
    );
  }),
);

timetableRouter.put(
  '/versions/:id',
  ...manage,
  validate({ params: versionIdParams, body: updateVersionBody }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await timetableService.updateDraft(
        getCtx(req),
        req.schoolId as string,
        req.params.id as string,
        req.body,
      ),
    );
  }),
);

timetableRouter.delete(
  '/versions/:id',
  ...manage,
  validate({ params: versionIdParams }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await timetableService.deleteVersion(
        getCtx(req),
        req.schoolId as string,
        req.params.id as string,
      ),
    );
  }),
);

timetableRouter.post(
  '/versions/:id/activate',
  ...manage,
  validate({ params: versionIdParams, body: activateBody }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await timetableService.activate(
        getCtx(req),
        req.schoolId as string,
        req.params.id as string,
        req.body,
      ),
    );
  }),
);

timetableRouter.post(
  '/activate-bulk',
  ...manage,
  validate({ body: activateBulkBody }),
  asyncHandler(async (req, res) => {
    const { versionIds, ...opts } = req.body as { versionIds: string[] } & ActivateOpts;
    ok(
      res,
      await timetableService.activateBulk(getCtx(req), req.schoolId as string, versionIds, opts),
    );
  }),
);

timetableRouter.post(
  '/activate-bulk/preview',
  ...manage,
  validate({ body: bulkPreviewBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as { versionIds: string[]; validFrom: string };
    ok(res, await timetableService.bulkPreview(req.schoolId as string, b.versionIds, b.validFrom));
  }),
);

timetableRouter.post(
  '/versions/:id/correct',
  ...manage,
  validate({ params: versionIdParams, body: correctBody }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await timetableService.correct(
        getCtx(req),
        req.schoolId as string,
        req.params.id as string,
        req.body,
      ),
    );
  }),
);
