import crypto from 'crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import { ExamSession } from '../../../models/ExamSession';
import { Question } from '../../../models/Question';
import { clock } from '../../../utils/clock';
import { resolveExamScope } from '../exams.scope';
import { toAnswerDto, toBlockDto } from '../questions.dto';
import { MAX_POOL } from '../sessions/templates.service';
import { findSession, isCreator } from '../sessions/sessions.service';
import { blockQuestionCount, normalizeBlocks } from './blocks.core';
import {
  DIFFICULTIES,
  availabilityOf,
  cryptoShuffle,
  examManualIds,
  hasTopicSel,
  poolBase,
  poolRows,
  resolveTopics,
  TOPIC_SEL_MSG,
  topicSelFields,
} from './blocks.pool';
import { assertUnlocked, audit, contribAccess, writeGuard } from './blocks.service';

/**
 * Daraja bo'yicha tasodifiy tanlash (E8). Ikki rejim:
 *  1) bir marta tanlab qo'shish: availability -> preview (server tasodifiy tanlaydi) -> replace (bittasini almashtirish)
 *     -> mavjud "bankdan qo'shish" (addFromBank) bilan qat'iy savollar sifatida qo'shiladi (qulf/muddat/egalik qoidalari
 *     o'sha yo'lda);
 *  2) har o'quvchiga boshqacha: blokda `contribRules` qoidasi saqlanadi; rejalashtirilganda hovuz muzlatiladi va har
 *     o'quvchiga shu hovuzdan alohida tasodifiy savollar beriladi (mavjud selection.ts).
 * Savollar manbai: foydalanuvchiga KO'RINADIGAN FAOL savollar, blok fanidan, tanlangan mavzulardan. Imtihonning
 * hamma bloklaridagi qo'lda tanlangan savollar chiqarib tashlanadi.
 */
export const MAX_RULES_PER_BLOCK = 20;

const countField = z.number().int().min(0).max(100);
const selSchema = z.object(topicSelFields);

export const availabilityBody = selSchema.strict().refine(hasTopicSel, TOPIC_SEL_MSG);
export const previewBody = selSchema
  .extend({ counts: z.object({ easy: countField, medium: countField, hard: countField }).strict() })
  .strict()
  .refine(hasTopicSel, TOPIC_SEL_MSG)
  .refine((v) => v.counts.easy + v.counts.medium + v.counts.hard >= 1, {
    message: 'Kamida bitta savol tanlang',
    path: ['counts'],
  })
  .refine((v) => v.counts.easy + v.counts.medium + v.counts.hard <= 100, {
    message: 'Bir martada 100 tadan oshmasin',
    path: ['counts'],
  });
export const replaceBody = selSchema
  .extend({
    difficulty: z.number().int().min(1).max(3),
    exclude: z.array(objectIdSchema).max(300),
  })
  .strict()
  .refine(hasTopicSel, TOPIC_SEL_MSG);
export const ruleBody = selSchema
  .extend({
    difficulty: z.number().int().min(1).max(3),
    count: z.number().int().min(1).max(200),
  })
  .strict()
  .refine(hasTopicSel, TOPIC_SEL_MSG);
export const rulePatchBody = z.object({ count: z.number().int().min(1).max(200) }).strict();

const oid = (s: string) => new Types.ObjectId(s);
const DIFF_KEY = { 1: 'easy', 2: 'medium', 3: 'hard' } as const;

/** Tanlangan savolning ko'rinishi (tuzuvchi/o'qituvchi uchun): matn, variantlar va to'g'ri javob belgisi bilan */
function previewDto(q: {
  _id: unknown;
  difficulty: number;
  type: string;
  points: number;
  content: never[];
  options: { id: string; content: never[] }[];
  answer?: never;
}) {
  const key = toAnswerDto(q.type, q.answer);
  const correct = new Set(
    'optionId' in key && key.optionId
      ? [String(key.optionId)]
      : 'optionIds' in key
        ? (key.optionIds ?? []).map(String)
        : [],
  );
  return {
    id: String(q._id),
    difficulty: q.difficulty,
    type: q.type,
    points: q.points,
    content: q.content.map(toBlockDto),
    options: q.options.map((o) => ({
      id: o.id,
      content: o.content.map(toBlockDto),
      correct: correct.has(o.id),
    })),
    ...('acceptedAnswers' in key ? { acceptedAnswers: key.acceptedAnswers } : {}),
    ...('rubric' in key ? { rubric: key.rubric } : {}),
  };
}

async function context(
  ctx: Ctx,
  schoolId: string,
  sessionId: string,
  blockId: string,
  sel: {
    topicIds?: string[];
    allTopics?: boolean;
    type?: string | null;
  },
) {
  const { s, b, role } = await contribAccess(ctx, schoolId, sessionId, blockId);
  const scope = await resolveExamScope(ctx.actor, schoolId);
  const topics = await resolveTopics(schoolId, b.subjectId!, sel);
  const base = poolBase(ctx, schoolId, scope, b.subjectId!, topics.ids, sel.type);
  return { s, b, role, scope, topics, base, inExam: examManualIds(s) };
}

export const randomService = {
  /** Daraja bo'yicha: bankda jami, imtihonda allaqachon bor, tanlash mumkin (yozmaydi) */
  async availability(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof availabilityBody>,
  ) {
    const c = await context(ctx, schoolId, sessionId, blockId, body);
    const rows = await poolRows(c.base);
    return {
      difficulties: availabilityOf(rows, c.inExam),
      topics: c.topics.names,
    };
  },

  /**
   * Tasodifiy tanlash (kriptografik, takrorsiz): har daraja uchun so'ralgan soncha, yetmasa bor qadar.
   * Faqat ko'rsatadi: hech narsa saqlanmaydi.
   */
  async preview(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof previewBody>,
  ) {
    const c = await context(ctx, schoolId, sessionId, blockId, body);
    const rows = (await poolRows(c.base)).filter((r) => !c.inExam.has(r.id));
    const picked: string[] = [];
    const shortfall: Record<string, number> = {};
    const available: Record<string, number> = {};
    for (const d of DIFFICULTIES) {
      const want = body.counts[DIFF_KEY[d]];
      const of = rows.filter((r) => r.difficulty === d).map((r) => r.id);
      available[String(d)] = of.length;
      const take = cryptoShuffle(of).slice(0, want);
      shortfall[String(d)] = want - take.length;
      picked.push(...take);
    }
    const docs = picked.length
      ? await Question.find({ _id: { $in: picked.map(oid) }, schoolId }).select(
          'difficulty type points content options answer',
        )
      : [];
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return {
      items: picked.flatMap((id) => {
        const d = byId.get(id);
        return d ? [previewDto(d as never)] : [];
      }),
      available,
      shortfall,
    };
  },

  /** Bitta savolni almashtirish: shu daraja va hovuzdan, joriy (exclude) va imtihondagilarsiz */
  async replace(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof replaceBody>,
  ) {
    const c = await context(ctx, schoolId, sessionId, blockId, body);
    const skip = new Set(body.exclude);
    const rows = (await poolRows([...c.base, { difficulty: body.difficulty }])).filter(
      (r) => !c.inExam.has(r.id) && !skip.has(r.id),
    );
    if (!rows.length) {
      throw AppError.conflict('Almashtirish uchun boshqa savol qolmadi');
    }
    const id = rows[crypto.randomInt(rows.length)]!.id;
    const d = await Question.findOne({ _id: id, schoolId }).select(
      'difficulty type points content options answer',
    );
    if (!d) throw AppError.conflict('Almashtirish uchun boshqa savol qolmadi');
    return { item: previewDto(d as never), remaining: rows.length - 1 };
  },

  /** Rejim 2: qoidani saqlash (atomik; qulf/muddat/egalik sharti filtrda) */
  async addRule(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof ruleBody>,
  ) {
    const c = await context(ctx, schoolId, sessionId, blockId, body);
    assertUnlocked(c.s, c.b, c.role);
    if (c.b.contribRules.length >= MAX_RULES_PER_BLOCK) {
      throw AppError.validation('Qoidalar juda ko‘p', [
        { path: 'count', message: `Blokda ${MAX_RULES_PER_BLOCK} tadan ortiq qoida bo'lmasin` },
      ]);
    }
    if (blockQuestionCount(c.b) + body.count > MAX_POOL) {
      throw AppError.validation('Savollar juda ko‘p', [
        { path: 'count', message: `Blokda ${MAX_POOL} tadan ortiq savol bo'lmasin` },
      ]);
    }
    const rows = (await poolRows([...c.base, { difficulty: body.difficulty }])).filter(
      (r) => !c.inExam.has(r.id),
    );
    // Hozirgi hovuz yetarli bo'lishi ko'rsatiladi; rejalashtirishda yana tekshiriladi (yuqori ruxsatda ham)
    const now = clock.now();
    const rule = {
      ruleId: new Types.ObjectId().toHexString(),
      topicIds: body.allTopics ? [] : c.topics.ids,
      allTopics: body.allTopics === true,
      difficulty: body.difficulty,
      type: body.type ?? null,
      count: body.count,
      addedBy: oid(ctx.actor.id),
      addedAt: now,
    };
    const r = await ExamSession.updateOne(
      {
        _id: c.s._id,
        schoolId,
        status: 'draft',
        isDeleted: { $ne: true },
        ...writeGuard(ctx, c.role, c.b.blockId, now),
      },
      { $push: { 'blocks.$.contribRules': rule } },
    );
    if (!r.matchedCount) throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
    await audit(ctx, schoolId, 'exam.block.rule_add', String(c.s._id), null, {
      blockId: c.b.blockId,
      count: body.count,
      difficulty: body.difficulty,
      topics: body.allTopics ? 'all' : c.topics.ids.length,
    });
    return { ruleId: rule.ruleId, poolSize: rows.length, enough: rows.length >= body.count };
  },

  /** Qoida sonini o'zgartirish: tuzuvchi istalganini, o'qituvchi faqat o'zinikini */
  async updateRule(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    ruleId: string,
    body: z.output<typeof rulePatchBody>,
  ) {
    const { s, b, role } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b, role);
    const now = clock.now();
    const rule = b.contribRules.find((x) => x.ruleId === ruleId);
    if (!rule || (role !== 'composer' && rule.addedBy !== ctx.actor.id)) {
      throw AppError.notFound('Qoida topilmadi');
    }
    if (blockQuestionCount(b) - rule.count + body.count > MAX_POOL) {
      throw AppError.validation('Savollar juda ko‘p', [
        { path: 'count', message: `Blokda ${MAX_POOL} tadan ortiq savol bo'lmasin` },
      ]);
    }
    const r = await ExamSession.updateOne(
      {
        _id: s._id,
        schoolId,
        status: 'draft',
        isDeleted: { $ne: true },
        ...writeGuard(ctx, role, blockId, now),
      },
      { $set: { 'blocks.$[b].contribRules.$[r].count': body.count } },
      {
        arrayFilters: [
          { 'b.blockId': blockId },
          {
            'r.ruleId': ruleId,
            ...(role === 'composer' ? {} : { 'r.addedBy': oid(ctx.actor.id) }),
          },
        ],
        strict: false,
      },
    );
    if (!r.matchedCount) throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
    await audit(
      ctx,
      schoolId,
      'exam.block.rule_update',
      String(s._id),
      { count: rule.count },
      {
        blockId,
        count: body.count,
      },
    );
    return { ruleId, count: body.count };
  },

  /** Qoidani olib tashlash: tuzuvchi istalganini, o'qituvchi faqat o'zinikini */
  async removeRule(ctx: Ctx, schoolId: string, sessionId: string, blockId: string, ruleId: string) {
    const { s, b, role } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b, role);
    const rule = b.contribRules.find((x) => x.ruleId === ruleId);
    if (!rule || (role !== 'composer' && rule.addedBy !== ctx.actor.id)) {
      throw AppError.notFound('Qoida topilmadi');
    }
    const now = clock.now();
    const r = await ExamSession.updateOne(
      {
        _id: s._id,
        schoolId,
        status: 'draft',
        isDeleted: { $ne: true },
        ...writeGuard(ctx, role, blockId, now),
      },
      {
        $pull: {
          'blocks.$.contribRules': {
            ruleId,
            ...(role === 'composer' ? {} : { addedBy: oid(ctx.actor.id) }),
          },
        },
      },
    );
    if (!r.matchedCount) throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
    await audit(
      ctx,
      schoolId,
      'exam.block.rule_remove',
      String(s._id),
      { count: rule.count },
      {
        blockId,
      },
    );
    return { removed: true };
  },

  /** Tuzuvchi (yaratuvchi/ma'muriyat) ko'rib chiqish sahifasidan qoidani olib tashlaydi */
  async composerRemoveRule(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    ruleId: string,
  ) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, sessionId);
    if (!scope.all && !isCreator(s, ctx.actor)) throw AppError.forbidden();
    if (s.status !== 'draft') throw AppError.forbidden('Imtihon qoralama holatidan chiqqan');
    const b = normalizeBlocks(s).find((x) => x.blockId === blockId && !x.legacy);
    if (!b) throw AppError.notFound('Blok topilmadi');
    const rule = b.contribRules.find((x) => x.ruleId === ruleId);
    if (!rule) throw AppError.notFound('Qoida topilmadi');
    const r = await ExamSession.updateOne(
      { _id: s._id, schoolId, status: 'draft', isDeleted: { $ne: true } },
      { $pull: { 'blocks.$[b].contribRules': { ruleId } } },
      { arrayFilters: [{ 'b.blockId': blockId }], strict: false },
    );
    if (!r.matchedCount) throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
    await audit(
      ctx,
      schoolId,
      'exam.block.rule_remove',
      String(s._id),
      { count: rule.count },
      {
        blockId,
      },
    );
    return { removed: true };
  },
};
