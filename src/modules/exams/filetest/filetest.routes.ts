import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { getCtx } from '../../../core/context';
import { ok } from '../../../core/response';
import { objectIdSchema } from '../../../core/validators';
import { ExamFile } from '../../../models/ExamFile';
import { examAssetUploadLimiter, examPasteLimiter } from '../../../middlewares/rateLimiters';
import { validate } from '../../../middlewares/validate';
import { serveFile, uploadTestFile } from './filetest.storage';
import {
  contentBody,
  fileTestBody,
  fileTestService,
  parseKeyBody,
  variantCorrectBody,
} from './filetest.service';

/**
 * "Fayl + kalit" bloki (§23) endpointlari. blocksRouter ichida ulanadi: authenticate -> tenant -> requireExamsEnabled ->
 * ruxsat zanjiridan KEYIN. Doira servisda: tuzuvchi/yaratuvchi yoki shu blokka biriktirilgan o'qituvchi, aks holda 404.
 */
export const fileTestRouter = Router();

const sid = (req: { schoolId?: string }) => req.schoolId as string;
const blockIdSchema = z.string().regex(/^[0-9a-f]{24}$/);
const mine = z.object({ sessionId: objectIdSchema, blockId: blockIdSchema });
const P = (req: { params: unknown }) => req.params as Record<string, string>;
const uploadPathOf = (req: unknown) => (req as { file?: { path: string } }).file?.path;

export const FILE_EXPIRED_MESSAGE = 'Fayl muddati tugagan';

fileTestRouter.get(
  '/my-blocks/:sessionId/:blockId/file-test',
  validate({ params: mine }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await fileTestService.get(getCtx(req), sid(req), p.sessionId!, p.blockId!));
  }),
);
fileTestRouter.put(
  '/my-blocks/:sessionId/:blockId/file-test',
  validate({ params: mine, body: fileTestBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await fileTestService.put(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body));
  }),
);
fileTestRouter.put(
  '/my-blocks/:sessionId/:blockId/content',
  validate({ params: mine, body: contentBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await fileTestService.setContent(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
fileTestRouter.post(
  '/my-blocks/:sessionId/:blockId/file-test/key/parse',
  examPasteLimiter,
  validate({ params: mine, body: parseKeyBody }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await fileTestService.parseKey(getCtx(req), sid(req), p.sessionId!, p.blockId!, req.body),
    );
  }),
);
fileTestRouter.post(
  '/my-blocks/:sessionId/:blockId/files',
  examAssetUploadLimiter,
  uploadTestFile,
  validate({ params: mine }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await fileTestService.upload(
        getCtx(req),
        sid(req),
        p.sessionId!,
        p.blockId!,
        uploadPathOf(req),
      ),
    );
  }),
);
fileTestRouter.post(
  '/my-blocks/:sessionId/:blockId/files/:fileId/replace',
  examAssetUploadLimiter,
  uploadTestFile,
  validate({ params: mine.extend({ fileId: objectIdSchema }) }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(
      res,
      await fileTestService.replaceExpired(
        getCtx(req),
        sid(req),
        p.sessionId!,
        p.blockId!,
        p.fileId!,
        uploadPathOf(req),
      ),
    );
  }),
);
fileTestRouter.get(
  '/my-blocks/:sessionId/:blockId/files/:fileId',
  validate({ params: mine.extend({ fileId: objectIdSchema }) }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    const doc = await fileTestService.fileFor(
      getCtx(req),
      sid(req),
      p.sessionId!,
      p.blockId!,
      p.fileId!,
    );
    const gone = () =>
      res
        .status(410)
        .json({ success: false, error: { code: 'FILE_EXPIRED', message: FILE_EXPIRED_MESSAGE } });
    if (doc.state !== 'ready') return void gone();
    const r = await serveFile(doc, req.headers['if-none-match'], res);
    if (r === 'missing') {
      // Disk faylida yo'q (qo'lda o'chirilgan): yozuv muddati tugagan deb belgilanadi
      await ExamFile.updateOne(
        { _id: doc._id },
        { $set: { state: 'expired', expiredAt: new Date() } },
      );
      gone();
    }
  }),
);
// Qog'oz yetkazish: o'quvchi tanlagan variantni tuzatish (tuzuvchi/yaratuvchi/nazoratchi), auditga yoziladi
fileTestRouter.put(
  '/sessions/:id/results/:key/variant',
  validate({
    params: z.object({ id: objectIdSchema, key: z.string().min(1).max(64) }),
    body: variantCorrectBody,
  }),
  asyncHandler(async (req, res) => {
    const p = P(req);
    ok(res, await fileTestService.correctVariant(getCtx(req), sid(req), p.id!, p.key!, req.body));
  }),
);
