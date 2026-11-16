import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { getCtx } from '../../../core/context';
import { created, ok } from '../../../core/response';
import { objectIdSchema } from '../../../core/validators';
import { validate } from '../../../middlewares/validate';
import { contentDisposition } from '../../reports/reports.files';
import {
  candidateBody,
  candidateListQuery,
  candidatePatchBody,
  candidatesService,
} from './candidates.service';
import {
  extendBody,
  reopenBody,
  grantBody,
  optionalReasonBody,
  participantsBody,
  reasonBody,
  sessionBody,
  sessionListQuery,
  sessionPatchBody,
  sessionsService,
} from './sessions.service';
import { renderPinSheet } from './sessions.pdf';
import { exportQuery, gradeBody, publishBody, resultsService } from '../results/results.service';
import {
  previewBody,
  templateBody,
  templatePatchBody,
  templatesService,
} from './templates.service';

/**
 * Imtihonlar, shablonlar va nomzodlar (admin API). exams.routes.ts dagi darvoza zanjiridan KEYIN ulanadi:
 * authenticate -> tenant -> requireExamsEnabled -> ruxsat. Doira (o'qituvchi/ma'muriyat) servislarda tekshiriladi.
 */
export const sessionsRouter = Router();

const sid = (req: { schoolId?: string }) => req.schoolId as string;
const idParams = z.object({ id: objectIdSchema });
const keyParams = z.object({ id: objectIdSchema, key: z.string().min(6).max(24) });

// ---------- Shablonlar ----------
sessionsRouter.post(
  '/templates/preview',
  validate({ body: previewBody }),
  asyncHandler(async (req, res) => {
    ok(res, await templatesService.preview(getCtx(req), sid(req), req.body));
  }),
);
sessionsRouter.get(
  '/templates',
  asyncHandler(async (req, res) => {
    ok(res, await templatesService.list(getCtx(req), sid(req)));
  }),
);
sessionsRouter.post(
  '/templates',
  validate({ body: templateBody }),
  asyncHandler(async (req, res) => {
    created(res, await templatesService.create(getCtx(req), sid(req), req.body));
  }),
);
sessionsRouter.get(
  '/templates/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await templatesService.get(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.patch(
  '/templates/:id',
  validate({ params: idParams, body: templatePatchBody }),
  asyncHandler(async (req, res) => {
    ok(res, await templatesService.update(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
sessionsRouter.delete(
  '/templates/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await templatesService.remove(getCtx(req), sid(req), String(req.params.id)));
  }),
);

// ---------- Nomzodlar ----------
sessionsRouter.get(
  '/candidates',
  validate({ query: candidateListQuery }),
  asyncHandler(async (req, res) => {
    const r = await candidatesService.list(getCtx(req), sid(req), req.query as never);
    ok(res, r.items, r.meta);
  }),
);
sessionsRouter.post(
  '/candidates',
  validate({ body: candidateBody }),
  asyncHandler(async (req, res) => {
    created(res, await candidatesService.create(getCtx(req), sid(req), req.body));
  }),
);
sessionsRouter.get(
  '/candidates/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await candidatesService.get(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.patch(
  '/candidates/:id',
  validate({ params: idParams, body: candidatePatchBody }),
  asyncHandler(async (req, res) => {
    ok(res, await candidatesService.update(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
sessionsRouter.delete(
  '/candidates/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await candidatesService.remove(getCtx(req), sid(req), String(req.params.id)));
  }),
);

// ---------- Imtihonlar ----------
// Statik yo'llar :id dan OLDIN
sessionsRouter.get(
  '/sessions/meta',
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.meta(getCtx(req), sid(req)));
  }),
);
sessionsRouter.get(
  '/sessions/class-options',
  validate({ query: z.object({ subjectId: objectIdSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as { subjectId?: string };
    ok(res, await sessionsService.classOptions(getCtx(req), sid(req), q.subjectId));
  }),
);
sessionsRouter.get(
  '/sessions/class-students/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.classStudents(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.get(
  '/sessions',
  validate({ query: sessionListQuery }),
  asyncHandler(async (req, res) => {
    const r = await sessionsService.list(getCtx(req), sid(req), req.query as never);
    ok(res, r.items, r.meta);
  }),
);
sessionsRouter.post(
  '/sessions',
  validate({ body: sessionBody }),
  asyncHandler(async (req, res) => {
    created(res, await sessionsService.create(getCtx(req), sid(req), req.body));
  }),
);
sessionsRouter.get(
  '/sessions/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.get(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.patch(
  '/sessions/:id',
  validate({ params: idParams, body: sessionPatchBody }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.update(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
sessionsRouter.delete(
  '/sessions/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.remove(getCtx(req), sid(req), String(req.params.id)));
  }),
);

// Ishtirokchilar
sessionsRouter.post(
  '/sessions/:id/participants',
  validate({ params: idParams, body: participantsBody }),
  asyncHandler(async (req, res) => {
    created(
      res,
      await sessionsService.addParticipants(getCtx(req), sid(req), String(req.params.id), req.body),
    );
  }),
);
sessionsRouter.delete(
  '/sessions/:id/participants/:key',
  validate({ params: keyParams }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await sessionsService.removeParticipant(
        getCtx(req),
        sid(req),
        String(req.params.id),
        String(req.params.key),
      ),
    );
  }),
);
sessionsRouter.post(
  '/sessions/:id/participants/:key/regenerate-pin',
  validate({ params: keyParams }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await sessionsService.regeneratePin(
        getCtx(req),
        sid(req),
        String(req.params.id),
        String(req.params.key),
      ),
    );
  }),
);
sessionsRouter.post(
  '/sessions/:id/participants/:key/allow-reentry',
  validate({ params: keyParams }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await sessionsService.allowReentry(
        getCtx(req),
        sid(req),
        String(req.params.id),
        String(req.params.key),
      ),
    );
  }),
);
sessionsRouter.get(
  '/sessions/:id/attempts',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.attempts(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.post(
  '/sessions/:id/participants/:key/grant',
  validate({ params: keyParams, body: grantBody }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await sessionsService.grant(
        getCtx(req),
        sid(req),
        String(req.params.id),
        String(req.params.key),
        req.body,
      ),
    );
  }),
);

// Holat o'tishlari
const transitions = [
  ['submit', 'submit'],
  ['approve', 'approve'],
  ['open', 'open'],
  ['close', 'close'],
] as const;
for (const [path, fn] of transitions) {
  sessionsRouter.post(
    `/sessions/:id/${path}`,
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      ok(res, await sessionsService[fn](getCtx(req), sid(req), String(req.params.id)));
    }),
  );
}
sessionsRouter.post(
  '/sessions/:id/reject',
  validate({ params: idParams, body: reasonBody }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.reject(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
sessionsRouter.post(
  '/sessions/:id/reopen',
  validate({ params: idParams, body: reopenBody }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.reopen(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
sessionsRouter.post(
  '/sessions/:id/extend',
  validate({ params: idParams, body: extendBody }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.extend(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);

// Natijalar (E6): imtihon ichida
sessionsRouter.get(
  '/sessions/:id/results',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await resultsService.list(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.get(
  '/sessions/:id/results/analysis',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await resultsService.analysis(getCtx(req), sid(req), String(req.params.id)));
  }),
);
sessionsRouter.get(
  '/sessions/:id/results/export',
  validate({ params: idParams, query: exportQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { format: 'xlsx' | 'pdf' };
    const r = await resultsService.export(getCtx(req), sid(req), String(req.params.id), q.format);
    res.set(r.headers);
    res.send(r.buf);
  }),
);
sessionsRouter.post(
  '/sessions/:id/results/publish',
  validate({ params: idParams, body: publishBody }),
  asyncHandler(async (req, res) => {
    ok(res, await resultsService.publish(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
sessionsRouter.get(
  '/sessions/:id/results/:key',
  validate({ params: keyParams }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await resultsService.detail(
        getCtx(req),
        sid(req),
        String(req.params.id),
        String(req.params.key),
      ),
    );
  }),
);
sessionsRouter.put(
  '/sessions/:id/results/:key/essays/:qid',
  validate({ params: keyParams.extend({ qid: z.string().min(1).max(40) }), body: gradeBody }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await resultsService.gradeEssay(
        getCtx(req),
        sid(req),
        String(req.params.id),
        String(req.params.key),
        String(req.params.qid),
        req.body,
      ),
    );
  }),
);

sessionsRouter.post(
  '/sessions/:id/cancel',
  validate({ params: idParams, body: optionalReasonBody }),
  asyncHandler(async (req, res) => {
    ok(res, await sessionsService.cancel(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);

// PIN varaqasi (PDF)
sessionsRouter.get(
  '/sessions/:id/pin-sheet',
  validate({ params: idParams, query: z.object({ class: z.string().trim().max(50).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as { class?: string };
    const data = await sessionsService.printData(
      getCtx(req),
      sid(req),
      String(req.params.id),
      q.class,
    );
    const buf = await renderPinSheet(data);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(`pin-${data.code}.pdf`),
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    });
    res.send(buf);
  }),
);
