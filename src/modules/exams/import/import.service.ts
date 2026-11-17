import path from 'path';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import { ExamImportSession } from '../../../models/ExamImportSession';
import { Question } from '../../../models/Question';
import { isId } from '../../../utils/helpers';
import { Subject } from '../../../models/Subject';
import { auditService } from '../../audit/audit.service';
import { MAX_FILE_BYTES } from '../../students/students.excel';
import { assetsService } from '../assets.service';
import { resolveExamScope } from '../exams.scope';
import { loadTopic } from '../topics.service';
import { ExamTopic } from '../../../models/ExamTopic';
import {
  finalizeRaw,
  importError,
  loadResolveCtx,
  validateItemFull,
  type ImportAnswer,
  type ImportItem,
} from './import.common';
import { DOCX_LIMITS, parseDocx } from './import.docx';
import { parseExcel } from './import.excel';

export const SESSION_TTL_MS = 30 * 60_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ---------- Global semafor: serverda bir vaqtda faqat BITTA import tahlil qilinadi ----------
let busy = false;
export const importBusy = () => busy;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw AppError.rateLimited("Import band, keyinroq urinib ko'ring");
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

// ---------- Yuklash (multer): faqat .xlsx / .docx, 5 MB ----------
const make = (ext: '.xlsx' | '.docx', mime: string) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 },
    fileFilter: (_req, file, cb) => {
      const okExt = path.extname(file.originalname).toLowerCase() === ext;
      const okMime = file.mimetype === mime || file.mimetype === 'application/octet-stream';
      if (!okExt || !okMime) {
        const m = `Faqat ${ext} fayl yuklash mumkin`;
        return cb(AppError.validation(m, [{ path: 'file', message: m }]));
      }
      cb(null, true);
    },
  }).single('file');

const wrap =
  (upload: ReturnType<typeof make>): RequestHandler =>
  (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Fayl hajmi 5 MB dan oshmasligi kerak'
            : "Fayl yuklashda xatolik: so'rov noto'g'ri";
        return next(AppError.validation(msg, [{ path: 'file', message: msg }]));
      }
      next(err);
    });
  };
export const uploadXlsxFile = wrap(make('.xlsx', XLSX_MIME));
export const uploadDocxFile = wrap(make('.docx', DOCX_MIME));

// ---------- Tekshiruv sxemalari ----------
export const uploadBody = z.object({ topicId: objectIdSchema });

const overrideSchema = z
  .object({
    row: z.number().int(),
    type: z.enum(['single', 'multi', 'short', 'essay']).optional(),
    difficulty: z.number().optional(),
    points: z.number().optional(),
    answer: z
      .object({
        optionId: z.string().max(16).optional(),
        optionIds: z.array(z.string().max(16)).max(10).optional(),
        partialCredit: z.boolean().optional(),
        acceptedAnswers: z.array(z.string().max(200)).max(40).optional(),
        rubric: z.string().max(5000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const commitBody = z
  .object({
    /** Import qilinmaydigan (chiqarib tashlangan) qatorlar */
    exclude: z.array(z.number().int()).max(1000).default([]),
    /** Qatorlar bo'yicha tuzatishlar (fan, tur, javob...) */
    overrides: z.array(overrideSchema).max(1000).default([]),
    /** Import qilingan savollar holati: standart qoralama */
    status: z.enum(['draft', 'active']).default('draft'),
  })
  .strict();
export type CommitBody = z.infer<typeof commitBody>;

// ---------- Oldindan ko'rish ----------
async function buildPreview(
  ctx: Ctx,
  schoolId: string,
  kind: 'excel' | 'word',
  fileName: string,
  buffer: Buffer,
  topicId: string,
) {
  const scope = await resolveExamScope(ctx.actor, schoolId);
  // Boshqa maktab mavzusi, o'chirilgan mavzu yoki o'qituvchi o'qitmaydigan fan mavzusi: 404
  const topic = await loadTopic(schoolId, scope, topicId);
  const rctx = await loadResolveCtx(schoolId, scope, String(topic.subjectId), topic.id as string);
  const deadline = Date.now() + DOCX_LIMITS.timeoutMs;
  const { items, warnings } = await exclusive(async () => {
    if (kind === 'excel')
      return { items: await parseExcel(buffer, deadline), warnings: [] as string[] };
    return parseDocx(buffer, {
      deadline,
      saveImage: async (bytes) =>
        (await assetsService.upload(ctx, schoolId, bytes, { audit: false })).asset.id,
    });
  });
  const finalized: ImportItem[] = items.map((r) => finalizeRaw(r, rctx));
  if (items.some((r) => r.subjectName || r.topic)) {
    warnings.push(
      "Fayldagi 'Fan' va 'Mavzu' qiymatlari e'tiborsiz qoldirildi: barcha savollar tanlangan mavzuga qo'shiladi",
    );
  }
  const session = await ExamImportSession.create({
    schoolId,
    userId: ctx.actor.id,
    kind,
    topicId: topic.id,
    fileName: fileName.slice(0, 200),
    items: finalized,
    warnings,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return toPreviewDto(session, finalized, {
    id: topic.id as string,
    name: topic.name,
    subjectName: rctx.subjectNames.get(String(topic.subjectId)) ?? null,
  });
}

function toPreviewDto(
  s: {
    id: string;
    kind: string;
    fileName: string;
    expiresAt: Date;
    warnings: string[];
    consumed: boolean;
  },
  items: ImportItem[],
  topic: { id: string; name: string; subjectName: string | null },
) {
  return {
    id: s.id,
    kind: s.kind,
    fileName: s.fileName,
    expiresAt: s.expiresAt,
    consumed: s.consumed,
    warnings: s.warnings,
    topic,
    stats: {
      total: items.length,
      valid: items.filter((i) => !i.errors.length).length,
      invalid: items.filter((i) => i.errors.length).length,
    },
    items,
  };
}

async function findSession(ctx: Ctx, schoolId: string, id: string) {
  const s = isId(id)
    ? await ExamImportSession.findOne({
        _id: id,
        schoolId,
        userId: ctx.actor.id,
        expiresAt: { $gt: new Date() },
      })
    : null;
  if (!s) throw AppError.notFound('Import sessiyasi topilmadi yoki muddati tugagan');
  return s;
}

const applyOverride = (item: ImportItem, o: CommitBody['overrides'][number]): ImportItem => {
  const next: ImportItem = { ...item };
  if (o.type) {
    next.type = o.type;
    if (!o.answer) next.answer = {};
  }
  if (o.difficulty !== undefined) next.difficulty = o.difficulty;
  if (o.points !== undefined) next.points = o.points;
  if (o.answer) next.answer = o.answer as ImportAnswer;
  return next;
};

export const importService = {
  async preview(
    ctx: Ctx,
    schoolId: string,
    kind: 'excel' | 'word',
    file: { originalname: string; buffer: Buffer } | undefined,
    topicId: string,
  ) {
    if (!file) throw importError('Fayl yuborilmadi');
    return buildPreview(ctx, schoolId, kind, file.originalname, file.buffer, topicId);
  },

  async get(ctx: Ctx, schoolId: string, id: string) {
    const s = await findSession(ctx, schoolId, id);
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const topic = await loadTopic(schoolId, scope, String(s.topicId));
    const subject = await Subject.findById(topic.subjectId).select('name').lean();
    return toPreviewDto(s, s.items as ImportItem[], {
      id: topic.id as string,
      name: topic.name,
      subjectName: subject?.name ?? null,
    });
  },

  /**
   * Import qilish: tuzatishlar qo'llanadi, HAR BIR qator qayta tekshiriladi (fan doirasi ham),
   * to'g'rilari QORALAMA sifatida (muallif = import qiluvchi, ulashish private) bitta insertMany bilan
   * yangi `questions` kolleksiyasiga yoziladi. `consumed` atomik: qayta chaqirilsa avvalgi natija qaytadi.
   */
  async commit(ctx: Ctx, schoolId: string, id: string, body: CommitBody) {
    const claimed = isId(id)
      ? await ExamImportSession.findOneAndUpdate(
          {
            _id: id,
            schoolId,
            userId: ctx.actor.id,
            consumed: false,
            expiresAt: { $gt: new Date() },
          },
          { $set: { consumed: true } },
          { new: true },
        )
      : null;
    if (!claimed) {
      const prev = await findSession(ctx, schoolId, id); // yo'q/eskirgan: 404
      if (prev.consumed && prev.result) return { ...(prev.result as object), replay: true };
      throw AppError.conflict('Bu import allaqachon bajarilmoqda yoki bajarilgan');
    }
    const scope = await resolveExamScope(ctx.actor, schoolId);
    // Nishon mavzu hali mavjud va foydalanuvchiga ruxsat etilgan bo'lishi shart (aks holda sessiya qayta ochiladi)
    const topic = await ExamTopic.findOne({
      _id: claimed.topicId,
      schoolId,
      isDeleted: { $ne: true },
    });
    if (!topic || (!scope.all && !scope.subjectIds.includes(String(topic.subjectId)))) {
      await ExamImportSession.updateOne({ _id: claimed._id }, { $set: { consumed: false } });
      throw AppError.notFound('Mavzu topilmadi');
    }
    const rctx = await loadResolveCtx(schoolId, scope, String(topic.subjectId), topic.id as string);
    const exclude = new Set(body.exclude);
    const overrides = new Map(body.overrides.map((o) => [o.row, o]));
    const docs: Record<string, unknown>[] = [];
    const failed: { row: number; errors: string[] }[] = [];
    for (const base of claimed.items as ImportItem[]) {
      if (exclude.has(base.row)) continue;
      const ov = overrides.get(base.row);
      const item = ov ? applyOverride(base, ov) : base;
      const { item: checked, parsed } = validateItemFull(item, rctx);
      if (!parsed) {
        failed.push({ row: base.row, errors: checked.errors });
        continue;
      }
      docs.push({
        ...parsed,
        status: body.status,
        sharing: { mode: 'private', userIds: [] },
        schoolId,
        scope: 'school',
        authorId: ctx.actor.id,
        version: 1,
      });
    }
    const inserted = docs.length ? await Question.insertMany(docs, { ordered: false }) : [];
    const created = inserted.length;
    const result = {
      created,
      /** Yaratilgan savollar id lari (blokka qo'shish uchun) */
      ids: inserted.map((d) => String(d._id)),
      failed,
      excluded: exclude.size,
      total: (claimed.items as ImportItem[]).length,
    };
    await ExamImportSession.updateOne({ _id: claimed._id }, { $set: { result } });
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'exam.question.import',
      entity: 'exam_import',
      entityId: claimed.id,
      after: { kind: claimed.kind, ...result, failed: failed.length, status: body.status },
      ip: ctx.ip,
    });
    return result;
  },
};
