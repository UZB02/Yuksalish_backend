import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requireAnyPermission, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import {
  activateBody,
  activateBulkBody,
  bulkPreviewBody,
  busyTeachersQuery,
  classIdParams,
  correctBody,
  createOverrideBody,
  createVersionBody,
  dayQuery,
  freeTeachersQuery,
  lessonsQuery,
  moveOverrideBody,
  optionsQuery,
  teacherDayQuery,
  overrideDateQuery,
  overrideIdParams,
  teacherIdParams,
  updateVersionBody,
  versionIdParams,
  versionQuery,
  weekQuery,
} from './timetable.schema';
import { overridesService } from './overrides.service';
import { timetableService, type ActivateOpts } from './timetable.service';
import { myTodayLessons } from './timetable.today';

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

// Bugungi darslarim (dashboard va "Mening sinflarim"): har bir dars uchun davomat holati bilan
timetableRouter.get(
  '/me/today',
  read((req) => myTodayLessons(getCtx(req).actor, req.schoolId as string)),
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
  '/teacher-day',
  validate({ query: teacherDayQuery }),
  read((req) => {
    const q = req.query as { date?: string; teacherId?: string };
    return timetableService.teacherDay(
      getCtx(req).actor,
      req.schoolId as string,
      q.date,
      q.teacherId,
    );
  }),
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

timetableRouter.get(
  '/versions/:id/busy-teachers',
  validate({ params: versionIdParams, query: busyTeachersQuery }),
  read((req) => {
    const q = req.query as unknown as { weekday: number; lessonNo: number; validFrom?: string };
    return timetableService.busyTeachers(
      getCtx(req).actor,
      req.schoolId as string,
      req.params.id as string,
      q.weekday,
      q.lessonNo,
      q.validFrom,
    );
  }),
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

// --- Dars almashtirishlari (P4): o'qish view|substitute, yozish substitute ---
const readOverrides = requireAnyPermission('timetable.view', 'timetable.substitute');
const substitute = requirePermission('timetable.substitute');

timetableRouter.get(
  '/overrides',
  readOverrides,
  validate({ query: overrideDateQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { date: string };
    ok(res, await overridesService.list(req.schoolId as string, q.date));
  }),
);

timetableRouter.get(
  '/free-teachers',
  substitute,
  validate({ query: freeTeachersQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { date: string; lessonNo: number; subjectId?: string };
    ok(
      res,
      await overridesService.freeTeachers(req.schoolId as string, q.date, q.lessonNo, q.subjectId),
    );
  }),
);

timetableRouter.post(
  '/overrides',
  substitute,
  validate({ body: createOverrideBody }),
  asyncHandler(async (req, res) => {
    created(res, await overridesService.create(getCtx(req), req.schoolId as string, req.body));
  }),
);

timetableRouter.post(
  '/overrides/move',
  substitute,
  validate({ body: moveOverrideBody }),
  asyncHandler(async (req, res) => {
    created(res, await overridesService.move(getCtx(req), req.schoolId as string, req.body));
  }),
);

timetableRouter.delete(
  '/overrides/:id',
  substitute,
  validate({ params: overrideIdParams }),
  asyncHandler(async (req, res) => {
    await overridesService.remove(getCtx(req), req.schoolId as string, req.params.id as string);
    res.status(204).end();
  }),
);
