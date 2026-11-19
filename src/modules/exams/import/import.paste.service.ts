import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import { Question } from '../../../models/Question';
import { auditService } from '../../audit/audit.service';
import { resolveExamScope } from '../exams.scope';
import { loadTopic } from '../topics.service';
import { loadResolveCtx, validateItemFull, type ImportItem } from './import.common';
import { hasBlocking, parsePasteText, type PasteQuestion } from './import.paste';

/**
 * "Matnni joylash": oldindan ko'rish (DB ga tegmaydi) va saqlash (qayta tahlil qilinadi: yagona haqiqat manbai).
 * Matn hajmi UTF-8 baytda cheklanadi (umumiy JSON limiti 100 KB, shundan zaxira bilan).
 */
export const PASTE_MAX_QUESTIONS = 200;
export const PASTE_MAX_BYTES = 70_000;

const textField = z
  .string()
  .max(
    PASTE_MAX_BYTES,
    `Matn ${Math.round(PASTE_MAX_BYTES / 1000)} KB dan oshmasligi kerak: kichikroq bo'laklarga bo'lib joylang`,
  );

export const pastePreviewBody = z.object({ text: textField }).strict();

const pick = z
  .object({
    idx: z.number().int().min(1).max(PASTE_MAX_QUESTIONS),
    answer: z
      .array(z.string().regex(/^[A-F]$/))
      .min(1)
      .max(6),
  })
  .strict();

export const pasteCommitBody = z
  .object({
    text: textField,
    /** Mavzu: savollar banki importida majburiy; vazifada ixtiyoriy (bo'lmasa "Imtihon: ‹nomi›") */
    topicId: objectIdSchema.optional(),
    difficulty: z.number().int().min(1).max(3).default(2),
    points: z.number().gt(0).max(100).default(1),
    /** Javobsiz/noaniq savollarga foydalanuvchi tanlagan javob (idx bo'yicha) */
    picks: z.array(pick).max(PASTE_MAX_QUESTIONS).default([]),
    /** Saqlanmaydigan savollar (idx) */
    exclude: z.array(z.number().int()).max(PASTE_MAX_QUESTIONS).default([]),
    status: z.enum(['draft', 'active']).default('draft'),
  })
  .strict();
export type PasteCommitBody = z.infer<typeof pasteCommitBody>;

const tooMany = (n: number) =>
  AppError.validation(`Savollar juda ko'p: bir martada ${PASTE_MAX_QUESTIONS} tagacha`, [
    {
      path: 'text',
      message: `${n} ta savol topildi, bir martada ${PASTE_MAX_QUESTIONS} tadan ko'p qo'shib bo'lmaydi`,
    },
  ]);

/** Hajm tekshiruvi (UTF-8 bayt) va tahlil */
function parseLimited(text: string) {
  if (Buffer.byteLength(text, 'utf8') > PASTE_MAX_BYTES) {
    throw AppError.validation('Matn juda uzun', [
      {
        path: 'text',
        message: `Matn ${Math.round(PASTE_MAX_BYTES / 1000)} KB dan oshmasligi kerak: kichikroq bo'laklarga bo'lib joylang`,
      },
    ]);
  }
  const r = parsePasteText(text);
  if (r.questions.length > PASTE_MAX_QUESTIONS) throw tooMany(r.questions.length);
  return r;
}

/** Foydalanuvchi tanlagan javobni qo'llaydi (idx bo'yicha). Variantlarda bo'lmagan harf e'tiborsiz */
function applyPicks(q: PasteQuestion, picks: Map<number, string[]>): PasteQuestion {
  const p = picks.get(q.idx);
  if (!p) return q;
  const ids = new Set(q.options.map((o) => o.id));
  const answer = [...new Set(p)].filter((x) => ids.has(x)).sort();
  if (!answer.length) return q;
  return {
    ...q,
    correct: answer,
    type: answer.length > 1 ? 'multi' : 'single',
    warnings: q.warnings.filter((w) => !['noAnswer', 'badAnswer', 'conflict'].includes(w.code)),
    pickable: false,
  };
}

export const pasteService = {
  preview(text: string) {
    const r = parseLimited(text);
    const items = r.questions;
    return {
      stats: {
        total: items.length,
        ok: items.filter((q) => !hasBlocking(q)).length,
        problems: items.filter((q) => hasBlocking(q)).length,
      },
      items,
      ignored: r.ignored.slice(0, 20),
      limits: { maxQuestions: PASTE_MAX_QUESTIONS, maxBytes: PASTE_MAX_BYTES },
    };
  },

  /**
   * Saqlash: matn qayta tahlil qilinadi, tuzatishlar (javob tanlash) va chiqarib tashlashlar qo'llanadi, hal
   * qilinmagan ogohlantirishli savollar saqlanmaydi (`skipped`). To'g'rilari FAOL/QORALAMA holatda (muallif =
   * joylovchi, ulashish private) bankka yoziladi. `maxCreate`: blokka sig'ish chegarasi (oldindan tekshiriladi).
   */
  async commit(
    ctx: Ctx,
    schoolId: string,
    topic: { id: string; subjectId: string },
    body: PasteCommitBody,
    opts: { status: 'draft' | 'active'; maxCreate?: number; auditTag: string },
  ) {
    const parsed = parseLimited(body.text);
    const picks = new Map(body.picks.map((p) => [p.idx, p.answer]));
    const exclude = new Set(body.exclude);
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const rctx = await loadResolveCtx(schoolId, scope, topic.subjectId, topic.id);
    const docs: Record<string, unknown>[] = [];
    const skipped: { idx: number; reasons: string[] }[] = [];
    const failed: { idx: number; errors: string[] }[] = [];
    for (const base of parsed.questions) {
      if (exclude.has(base.idx)) continue;
      const q = applyPicks(base, picks);
      if (hasBlocking(q)) {
        skipped.push({
          idx: q.idx,
          reasons: q.warnings.filter((w) => w.blocking).map((w) => w.message),
        });
        continue;
      }
      const item: ImportItem = {
        row: q.idx,
        subjectName: null,
        subjectId: rctx.defaultSubjectId,
        difficulty: body.difficulty,
        type: q.type,
        points: body.points,
        content: q.content,
        options: q.options,
        answer: q.type === 'multi' ? { optionIds: q.correct } : { optionId: q.correct[0] },
        errors: [],
        warnings: [],
      };
      const { item: checked, parsed: ok } = validateItemFull(item, rctx);
      if (!ok) {
        failed.push({ idx: q.idx, errors: checked.errors });
        continue;
      }
      docs.push({
        ...ok,
        status: opts.status,
        sharing: { mode: 'private', userIds: [] },
        schoolId,
        scope: 'school',
        authorId: ctx.actor.id,
        version: 1,
      });
    }
    if (opts.maxCreate !== undefined && docs.length > opts.maxCreate) {
      throw AppError.validation('Savollar juda ko‘p', [
        {
          path: 'text',
          message: `Fanga yana ${Math.max(0, opts.maxCreate)} tagacha savol qo'shish mumkin, siz ${docs.length} ta qo'shmoqchisiz`,
        },
      ]);
    }
    const inserted = docs.length ? await Question.insertMany(docs, { ordered: false }) : [];
    const result = {
      created: inserted.length,
      ids: inserted.map((d) => String(d._id)),
      skipped,
      failed,
      excluded: exclude.size,
      total: parsed.questions.length,
    };
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'exam.question.import',
      entity: 'exam_import',
      entityId: topic.id,
      after: {
        kind: 'paste',
        via: opts.auditTag,
        created: result.created,
        skipped: skipped.length,
        failed: failed.length,
        status: opts.status,
      },
      ip: ctx.ip,
    });
    return result;
  },

  /** Savollar banki: tanlangan mavzuga (doira tekshiriladi: boshqa maktab/begona fan = 404) */
  async commitToTopic(ctx: Ctx, schoolId: string, body: PasteCommitBody) {
    if (!body.topicId) {
      throw AppError.validation('Mavzu tanlanmagan', [
        { path: 'topicId', message: 'Mavzuni tanlang' },
      ]);
    }
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const topic = await loadTopic(schoolId, scope, body.topicId);
    return pasteService.commit(
      ctx,
      schoolId,
      { id: topic.id as string, subjectId: String(topic.subjectId) },
      body,
      { status: body.status, auditTag: 'bank' },
    );
  },
};
