import crypto from 'crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import type { ExamSessionDoc } from '../../../models/ExamSession';
import { ExamTopic } from '../../../models/ExamTopic';
import { QUESTION_TYPES } from '../../../models/Question';
import { Question } from '../../../models/Question';
import { uniq } from '../../../utils/helpers';
import type { ExamScope } from '../exams.scope';
import { visibilityFilter } from '../exams.visibility';
import { effectiveItems, normalizeBlocks, type NBlock } from './blocks.core';

/**
 * Daraja bo'yicha tasodifiy tanlash (E8) uchun umumiy yordamchilar: mavzular, ko'rinadigan FAOL savollar hovuzi,
 * imtihonda allaqachon bor savollar, kriptografik tasodifiy aralashtirish. Hech qanday yozuv qilmaydi.
 */
const oid = (s: string) => new Types.ObjectId(s);

export const DIFFICULTIES = [1, 2, 3] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Mavzu tanlovi: aniq mavzular yoki blok fanidagi barcha mavzular */
export const topicSelFields = {
  topicIds: z.array(objectIdSchema).min(1).max(50).optional(),
  allTopics: z.boolean().optional(),
  type: z.enum(QUESTION_TYPES).nullish(),
};
export const hasTopicSel = (v: { topicIds?: string[]; allTopics?: boolean }) =>
  v.allTopics === true || !!v.topicIds?.length;
export const TOPIC_SEL_MSG = {
  message: 'Mavzu tanlang yoki "barcha mavzular"ni belgilang',
  path: ['topicIds'],
};

export interface TopicSel {
  topicIds?: string[];
  allTopics?: boolean;
  type?: string | null;
}

/** Tanlangan mavzularni tekshiradi: blok fanidagi, o'chirilmagan. Qaytaradi: id lar va nomlar */
export async function resolveTopics(schoolId: string, subjectId: string, sel: TopicSel) {
  const ids = uniq(sel.topicIds ?? []);
  const topics = await ExamTopic.find({
    schoolId,
    subjectId: oid(subjectId),
    isDeleted: { $ne: true },
    ...(sel.allTopics ? {} : { _id: { $in: ids.map(oid) } }),
  })
    .select('name')
    .lean();
  if (!topics.length || (!sel.allTopics && topics.length !== ids.length)) {
    throw AppError.validation('Mavzu topilmadi', [
      { path: 'topicIds', message: 'Mavzular shu blok fanidagi bo‘lishi kerak' },
    ]);
  }
  return {
    ids: topics.map((t) => t._id as Types.ObjectId),
    names: topics.map((t) => t.name),
    byId: new Map(topics.map((t) => [String(t._id), t.name])),
  };
}

/** Foydalanuvchiga ko'rinadigan FAOL savollar (blok fani, tanlangan mavzular, ixtiyoriy tur) */
export const poolBase = (
  ctx: Ctx,
  schoolId: string,
  scope: ExamScope,
  subjectId: string,
  topicIds: Types.ObjectId[],
  type?: string | null,
): Record<string, unknown>[] => [
  ...visibilityFilter(ctx.actor, schoolId, scope),
  { status: 'active' },
  { subjectId: oid(subjectId) },
  { topicId: { $in: topicIds } },
  ...(type ? [{ type }] : []),
];

/** Imtihonning BARCHA bloklaridagi qo'lda tanlangan (qat'iy) savollar: qayta tanlanmaydi */
export function examManualIds(s: Pick<ExamSessionDoc, 'blocks' | 'sections' | 'subjectId'>) {
  const out = new Set<string>();
  for (const b of normalizeBlocks(s as never)) {
    for (const it of effectiveItems(b)) {
      if (it.kind === 'manual') for (const q of it.questionIds ?? []) out.add(String(q));
    }
  }
  return out;
}

/** Kriptografik tasodifiy aralashtirish (Fisher-Yates, crypto.randomInt) */
export function cryptoShuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface PoolRow {
  id: string;
  difficulty: number;
}

/** Hovuz qatorlari (id + daraja), BARCHASI: hovuz hajmi ko'pi bilan minglab */
export async function poolRows(base: Record<string, unknown>[]): Promise<PoolRow[]> {
  const rows = await Question.find({ $and: base }).select('_id difficulty').limit(20_000).lean();
  return rows.map((r) => ({ id: String(r._id), difficulty: r.difficulty as number }));
}

/** Daraja bo'yicha hisob: bankda jami, imtihonda allaqachon bor, tanlash mumkin */
export function availabilityOf(rows: PoolRow[], inExam: Set<string>) {
  const out: Record<string, { total: number; inExam: number; available: number }> = {};
  for (const d of DIFFICULTIES) {
    const of = rows.filter((r) => r.difficulty === d);
    const used = of.filter((r) => inExam.has(r.id)).length;
    out[String(d)] = { total: of.length, inExam: used, available: of.length - used };
  }
  return out;
}

/** Qoida uchun mos savollar soni (har o'quvchi shundan tanlaydi): tuzuvchi/o'qituvchi ko'rinishida */
export async function rulePoolSize(
  ctx: Ctx,
  schoolId: string,
  scope: ExamScope,
  b: Pick<NBlock, 'subjectId'>,
  rule: { topicIds: string[]; allTopics: boolean; difficulty: number | null; type: string | null },
  manual: Set<string>,
): Promise<number> {
  if (!b.subjectId) return 0;
  const topics = await ExamTopic.find({
    schoolId,
    subjectId: oid(b.subjectId),
    isDeleted: { $ne: true },
    ...(rule.allTopics ? {} : { _id: { $in: rule.topicIds.filter(Boolean).map(oid) } }),
  })
    .select('_id')
    .lean();
  if (!topics.length) return 0;
  const base = poolBase(
    ctx,
    schoolId,
    scope,
    b.subjectId,
    topics.map((t) => t._id as Types.ObjectId),
    rule.type,
  );
  if (rule.difficulty) base.push({ difficulty: rule.difficulty });
  const rows = await poolRows(base);
  return rows.filter((r) => !manual.has(r.id)).length;
}
