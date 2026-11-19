import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { created, ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import {
  examAssetUploadLimiter,
  examImportLimiter,
  examPasteLimiter,
} from '../../middlewares/rateLimiters';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { objectIdSchema } from '../../core/validators';
import { assetsService, uploadExamImage } from './assets.service';
import { buildExcelTemplate } from './import/import.excel';
import {
  commitBody,
  importService,
  uploadBody,
  uploadDocxFile,
  uploadXlsxFile,
} from './import/import.service';
import { pasteCommitBody, pasteService, pastePreviewBody } from './import/import.paste.service';
import { buildWordTemplate } from './import/import.template';
import { requireExamsEnabled, requireQuestionsAccess } from './exams.gate';
import { bulkStatusBody, listQuery, updateBody, type ListQuery } from './questions.schema';
import { reorderBody, topicBody, topicPatchBody, topicsService } from './topics.service';
import { questionsService } from './questions.service';
import { blocksRouter } from './blocks/blocks.routes';
import { sessionsRouter } from './sessions/sessions.routes';

/**
 * Imtihon moduli (admin API): /api/v1/exams/*
 * Zanjir (har endpoint): authenticate -> tenant -> requireExamsEnabled (maktab uchun yoqilgan bo'lsa)
 * -> ruxsat (exams.questions yoki exams.manage) -> validate -> servis (doira: fan/muallif).
 */
export const examsRouter = Router();

examsRouter.use(authenticate, tenant, requireExamsEnabled, requireQuestionsAccess);

const idParams = z.object({ id: objectIdSchema });
const sid = (req: { schoolId?: string }) => req.schoolId as string;

// ---------- Fanlar (savollar bankida ishlatilishi mumkin bo'lganlar) ----------
examsRouter.get(
  '/subjects',
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.subjects(getCtx(req), sid(req)));
  }),
);

// ---------- Mavzular (Fan -> Mavzu -> Savol) ----------
examsRouter.get(
  '/subjects/:subjectId/topics',
  validate({ params: z.object({ subjectId: objectIdSchema }) }),
  asyncHandler(async (req, res) => {
    ok(res, await topicsService.list(getCtx(req), sid(req), String(req.params.subjectId)));
  }),
);
examsRouter.post(
  '/subjects/:subjectId/topics',
  validate({ params: z.object({ subjectId: objectIdSchema }), body: topicBody }),
  asyncHandler(async (req, res) => {
    created(
      res,
      await topicsService.create(getCtx(req), sid(req), String(req.params.subjectId), req.body),
    );
  }),
);
// /topics/reorder :id dan OLDIN
examsRouter.post(
  '/topics/reorder',
  validate({ body: reorderBody }),
  asyncHandler(async (req, res) => {
    ok(res, await topicsService.reorder(getCtx(req), sid(req), req.body));
  }),
);
examsRouter.get(
  '/topics/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await topicsService.get(getCtx(req), sid(req), String(req.params.id)));
  }),
);
examsRouter.patch(
  '/topics/:id',
  validate({ params: idParams, body: topicPatchBody }),
  asyncHandler(async (req, res) => {
    ok(res, await topicsService.update(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);
examsRouter.delete(
  '/topics/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await topicsService.remove(getCtx(req), sid(req), String(req.params.id)));
  }),
);

// ---------- Ulashish uchun o'qituvchilar ----------
examsRouter.get(
  '/teachers',
  validate({ query: z.object({ subjectId: objectIdSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await questionsService.teachers(
        getCtx(req),
        sid(req),
        req.query.subjectId as string | undefined,
      ),
    );
  }),
);

// ---------- Savollar ----------
examsRouter.get(
  '/questions',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const r = await questionsService.list(getCtx(req), sid(req), req.query as unknown as ListQuery);
    ok(res, r.items, r.meta);
  }),
);

examsRouter.post(
  '/questions/bulk-status',
  validate({ body: bulkStatusBody }),
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.bulkStatus(getCtx(req), sid(req), req.body));
  }),
);

// "Matnni joylash" (savollar banki): jonli ko'rish va saqlash. `/questions/:id` dan OLDIN
examsRouter.post(
  '/questions/paste/preview',
  examPasteLimiter,
  validate({ body: pastePreviewBody }),
  asyncHandler(async (req, res) => {
    ok(res, pasteService.preview(req.body.text));
  }),
);
examsRouter.post(
  '/questions/paste/commit',
  examPasteLimiter,
  validate({ body: pasteCommitBody }),
  asyncHandler(async (req, res) => {
    created(res, await pasteService.commitToTopic(getCtx(req), sid(req), req.body));
  }),
);

examsRouter.post(
  '/questions',
  // Maydonlarni zod (strict) servis ichida tekshiradi: fan mavzudan olinadi
  validate({ body: z.record(z.string(), z.unknown()) }),
  asyncHandler(async (req, res) => {
    created(res, await questionsService.create(getCtx(req), sid(req), req.body));
  }),
);

examsRouter.get(
  '/questions/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.get(getCtx(req), sid(req), String(req.params.id)));
  }),
);

examsRouter.patch(
  '/questions/:id',
  validate({ params: idParams, body: updateBody }),
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.update(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);

examsRouter.post(
  '/questions/:id/archive',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.archive(getCtx(req), sid(req), String(req.params.id)));
  }),
);

examsRouter.post(
  '/questions/:id/restore',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.restore(getCtx(req), sid(req), String(req.params.id)));
  }),
);

examsRouter.post(
  '/questions/:id/duplicate',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    created(res, await questionsService.duplicate(getCtx(req), sid(req), String(req.params.id)));
  }),
);

examsRouter.delete(
  '/questions/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await questionsService.remove(getCtx(req), sid(req), String(req.params.id)));
  }),
);

// ---------- Import (Excel / Word) ----------
const download = (res: import('express').Response, buf: Buffer, name: string, type: string) => {
  res.set({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.status(200).end(buf);
};
examsRouter.get(
  '/import/template/excel',
  asyncHandler(async (_req, res) => {
    download(
      res,
      await buildExcelTemplate(),
      'savollar-shablon.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  }),
);
examsRouter.get(
  '/import/template/word',
  asyncHandler(async (_req, res) => {
    download(
      res,
      await buildWordTemplate(),
      'savollar-shablon.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  }),
);
examsRouter.post(
  '/import/excel',
  examImportLimiter,
  uploadXlsxFile,
  validate({ body: uploadBody }),
  asyncHandler(async (req, res) => {
    created(
      res,
      await importService.preview(getCtx(req), sid(req), 'excel', req.file, req.body.topicId),
    );
  }),
);
examsRouter.post(
  '/import/word',
  examImportLimiter,
  uploadDocxFile,
  validate({ body: uploadBody }),
  asyncHandler(async (req, res) => {
    created(
      res,
      await importService.preview(getCtx(req), sid(req), 'word', req.file, req.body.topicId),
    );
  }),
);
examsRouter.get(
  '/import/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    ok(res, await importService.get(getCtx(req), sid(req), String(req.params.id)));
  }),
);
examsRouter.post(
  '/import/:id/commit',
  validate({ params: idParams, body: commitBody }),
  asyncHandler(async (req, res) => {
    ok(res, await importService.commit(getCtx(req), sid(req), String(req.params.id), req.body));
  }),
);

// ---------- Rasmlar ----------
examsRouter.post(
  '/assets',
  examAssetUploadLimiter,
  uploadExamImage,
  asyncHandler(async (req, res) => {
    const r = await assetsService.upload(getCtx(req), sid(req), req.file?.buffer);
    ok(res, r.asset, undefined, r.created ? 201 : 200);
  }),
);

examsRouter.get(
  '/assets/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const a = await assetsService.read(sid(req), String(req.params.id));
    const etag = `"${a.hash}"`;
    res.set({
      'Content-Type': a.contentType,
      ETag: etag,
      // Autentifikatsiyali javob: umumiy keshlarga tushmasin
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.set('Content-Length', String(a.data.length));
    res.status(200).end(a.data);
  }),
);

// Blokli imtihon: biriktirilgan o'qituvchi va tuzuvchi endpointlari
examsRouter.use(blocksRouter);
// Imtihonlar, shablonlar, nomzodlar (E3)
examsRouter.use(sessionsRouter);
