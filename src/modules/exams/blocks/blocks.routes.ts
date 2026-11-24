import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { getCtx } from '../../../core/context';
import { created, ok } from '../../../core/response';
import { objectIdSchema } from '../../../core/validators';
import { examImportLimiter, examPasteLimiter } from '../../../middlewares/rateLimiters';
import { validate } from '../../../middlewares/validate';
import { pasteCommitBody, pastePreviewBody } from '../import/import.paste.service';
import { commitBody, uploadDocxFile, uploadXlsxFile } from '../import/import.service';
import {
  availabilityBody,
  previewBody,
  randomService,
  replaceBody,
  rulePatchBody,
  ruleBody,
} from './blocks.random';
import { addQuestionsBody, blocksService, readyBody } from './blocks.service';
import { fileTestRouter } from '../filetest/filetest.routes';

/**
 * Blokli imtihon: biriktirilgan o'qituvchi (/my-blocks) va tuzuvchi (/sessions/:id/blocks) endpointlari.
 * exams.routes.ts darvoza zanjiridan KEYIN ulanadi (authenticate -> tenant -> requireExamsEnabled -> ruxsat).
 * Doira servislarda: o'qituvchi faqat o'z blokini ko'radi (boshqasi 404), muddat/tayyorlik/holat qulfi.
 */
export const blocksRouter = Router();
blocksRouter.use(fileTestRouter);

const sid = (req: { schoolId?: string }) => req.schoolId as string;
const blockId = z.string().regex(/^[0-9a-f]{24}$/);
const mine = z.object({ sessionId: objectIdSchema, blockId });
const mineQ = mine.extend({ qid: objectIdSchema });
const mineRule = mine.extend({ ruleId: z.string().regex(/^[0-9a-f]{24}$/) });
const mineImport = mine.extend({ importId: objectIdSchema });
const comp = z.object({ id: objectIdSchema, blockId });
const compQ = comp.extend({ qid: objectIdSchema });
const compRule = comp.extend({ ruleId: z.string().regex(/^[0-9a-f]{24}$/) });

const P = (req: { params: unknown }) => req.params as Record<string, string>;

// ---------- Biriktirilgan o'qituvchi ----------
blocksRouter.get(
  '/my-blocks/summary',
  asyncHandler(async (req, res) => {
    ok(res, await blocksService.mySummary(getCtx(req), sid(req)));
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/ready',
  validate({ params: mine, body: readyBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await blocksService.markReady(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.get(
  '/my-blocks',
  asyncHandler(async (req, res) => {
    ok(res, await blocksService.myBlocks(getCtx(req), sid(req)));
  }),
);
blocksRouter.get(
  '/my-blocks/:sessionId/:blockId',
  validate({ params: mine }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await blocksService.myBlock(getCtx(req), sid(req), p.sessionId!, p.blockId!));
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/questions',
  validate({ params: mine, body: addQuestionsBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await blocksService.addFromBank(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/questions/new',
  validate({ params: mine, body: z.record(z.string(), z.unknown()) }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    created(
      res,
      await blocksService.createInBlock(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.delete(
  '/my-blocks/:sessionId/:blockId/questions/:qid',
  validate({ params: mineQ }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await blocksService.removeOwn(getCtx(req), sid(req), p.sessionId!, p.blockId!, p.qid!));
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/paste/preview',
  examPasteLimiter,
  validate({ params: mine, body: pastePreviewBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await blocksService.pastePreview(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/paste/commit',
  examPasteLimiter,
  validate({ params: mine, body: pasteCommitBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    created(
      res,
      await blocksService.pasteCommit(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/import/word',
  examImportLimiter,
  uploadDocxFile,
  validate({ params: mine }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    created(
      res,
      await blocksService.importPreview(
        getCtx(req),
        sid(req),
        p.sessionId!,
        p.blockId!,
        'word',
        req.file,
      ),
    );
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/import/excel',
  examImportLimiter,
  uploadXlsxFile,
  validate({ params: mine }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    created(
      res,
      await blocksService.importPreview(
        getCtx(req),
        sid(req),
        p.sessionId!,
        p.blockId!,
        'excel',
        req.file,
      ),
    );
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/import/:importId/commit',
  validate({ params: mineImport, body: commitBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await blocksService.importCommit(
        getCtx(req),
        sid(req),
        p.sessionId!,
        p.blockId!,
        p.importId!,
        req.body,
      ),
    );
  }),
);

// ---------- Daraja bo'yicha tasodifiy tanlash (E8) ----------
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/random/availability',
  validate({ params: mine, body: availabilityBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await randomService.availability(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/random/preview',
  validate({ params: mine, body: previewBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await randomService.preview(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body));
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/random/replace',
  validate({ params: mine, body: replaceBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await randomService.replace(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body));
  }),
);
blocksRouter.post(
  '/my-blocks/:sessionId/:blockId/rules',
  validate({ params: mine, body: ruleBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    created(
      res,
      await randomService.addRule(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
blocksRouter.patch(
  '/my-blocks/:sessionId/:blockId/rules/:ruleId',
  validate({ params: mineRule, body: rulePatchBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await randomService.updateRule(
        getCtx(req),
        sid(req),
        p.sessionId!,
        p.blockId!,
        p.ruleId!,
        req.body,
      ),
    );
  }),
);
blocksRouter.delete(
  '/my-blocks/:sessionId/:blockId/rules/:ruleId',
  validate({ params: mineRule }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await randomService.removeRule(getCtx(req), sid(req), p.sessionId!, p.blockId!, p.ruleId!),
    );
  }),
);

// ---------- Tuzuvchi ----------
blocksRouter.get(
  '/sessions/:id/blocks/:blockId/questions',
  validate({ params: comp }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await blocksService.composerBlock(getCtx(req), sid(req), p.id!, p.blockId!));
  }),
);
blocksRouter.delete(
  '/sessions/:id/blocks/:blockId/questions/:qid',
  validate({ params: compQ }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await blocksService.composerRemove(getCtx(req), sid(req), p.id!, p.blockId!, p.qid!));
  }),
);
blocksRouter.delete(
  '/sessions/:id/blocks/:blockId/rules/:ruleId',
  validate({ params: compRule }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await randomService.composerRemoveRule(getCtx(req), sid(req), p.id!, p.blockId!, p.ruleId!),
    );
  }),
);
blocksRouter.post(
  '/sessions/:id/remind',
  validate({ params: z.object({ id: objectIdSchema }) }),
  asyncHandler(async (req, res) => {
    ok(res, await blocksService.remind(getCtx(req), sid(req), P(req).id!));
  }),
);
blocksRouter.post(
  '/sessions/:id/blocks/:blockId/ready',
  validate({ params: comp, body: readyBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await blocksService.setReady(getCtx(req), sid(req), p.id!, p.blockId!, req.body));
  }),
);
