import { z } from 'zod';
import { boolQuery, paginationQuery } from '../../core/pagination';
import { objectIdSchema } from '../../core/validators';
import { QUESTION_STATUSES, QUESTION_TYPES, SHARING_MODES } from '../../models/Question';
import { normalizeShortAnswer } from './questions.normalize';

// Limitlar (E1). HTML saqlanmaydi: kontent faqat strukturaviy bloklar, matn oddiy matn sifatida.
export const LIMITS = {
  textChars: 5000,
  texChars: 2000,
  topicChars: 200,
  blocks: 30,
  optionBlocks: 5,
  options: 10,
  acceptedAnswers: 20,
  acceptedAnswerChars: 200,
  rubricChars: 5000,
  maxPoints: 100,
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const plain = (max: number, label: string) =>
  z
    .string()
    .max(max, `${label} ${max} belgidan oshmasligi kerak`)
    .refine((v) => v.trim().length > 0, `${label} bo'sh bo'lmasligi kerak`)
    .refine((v) => !CONTROL.test(v), `${label}da boshqaruv belgilari bo'lmasligi kerak`);

const textBlock = z
  .object({ type: z.literal('text'), text: plain(LIMITS.textChars, 'Matn') })
  .strict();
const mathBlock = z
  .object({ type: z.literal('math'), tex: plain(LIMITS.texChars, 'Formula') })
  .strict();
const imageBlock = z.object({ type: z.literal('image'), assetId: objectIdSchema }).strict();

const block = z.discriminatedUnion('type', [textBlock, mathBlock, imageBlock]);

const optionId = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/, "Variant identifikatori noto'g'ri");
const optionSchema = z
  .object({
    id: optionId,
    content: z.array(block).min(1, "Variant bo'sh bo'lmasligi kerak").max(LIMITS.optionBlocks),
  })
  .strict();

const answerSchema = z
  .object({
    optionId: optionId.optional(),
    optionIds: z.array(optionId).max(LIMITS.options).optional(),
    partialCredit: z.boolean().optional(),
    acceptedAnswers: z
      .array(z.string().max(LIMITS.acceptedAnswerChars))
      .max(LIMITS.acceptedAnswers * 2)
      .optional(),
    rubric: z.string().max(LIMITS.rubricChars).optional(),
  })
  .strict();

export const sharingSchema = z
  .object({
    mode: z.enum(SHARING_MODES),
    userIds: z.array(objectIdSchema).max(100).default([]),
  })
  .strict()
  .transform((s) => ({
    mode: s.mode,
    userIds: s.mode === 'users' ? [...new Set(s.userIds)] : [],
  }))
  .refine((s) => s.mode !== 'users' || s.userIds.length > 0, {
    message: "Kamida bitta o'qituvchini tanlang",
    path: ['userIds'],
  });

/** Savol kiritish shakli (yaratish va tahrirdan keyingi to'liq holat) */
export const questionInput = z
  .object({
    subjectId: objectIdSchema,
    topicId: objectIdSchema,
    difficulty: z
      .number()
      .int()
      .min(1, 'Qiyinlik 1 dan 3 gacha')
      .max(3, 'Qiyinlik 1 dan 3 gacha')
      .transform((v) => v as 1 | 2 | 3)
      .default(2),
    type: z.enum(QUESTION_TYPES),
    content: z
      .array(block)
      .min(1, "Savol matni bo'sh bo'lmasligi kerak")
      .max(LIMITS.blocks, `Bloklar ${LIMITS.blocks} tadan oshmasligi kerak`),
    options: z
      .array(optionSchema)
      .max(LIMITS.options, `Variantlar ${LIMITS.options} tadan oshmasligi kerak`)
      .default([]),
    answer: answerSchema.default({}),
    points: z
      .number()
      .gt(0, "Ball 0 dan katta bo'lishi kerak")
      .max(LIMITS.maxPoints, `Ball ${LIMITS.maxPoints} dan oshmasligi kerak`)
      .default(1),
    status: z.enum(['draft', 'active']).default('draft'),
    sharing: sharingSchema.default({ mode: 'private', userIds: [] }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const ids = v.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      issue(['options'], 'Variant identifikatorlari takrorlanmasligi kerak');
    }

    if (v.type === 'single' || v.type === 'multi') {
      if (v.options.length < 2) issue(['options'], "Kamida 2 ta variant bo'lishi kerak");
    } else if (v.options.length) {
      issue(['options'], "Bu turdagi savolda variantlar bo'lmaydi");
    }

    const a = v.answer;
    if (v.type === 'single') {
      if (!a.optionId) issue(['answer', 'optionId'], "To'g'ri variant tanlanishi kerak");
      else if (!ids.includes(a.optionId)) {
        issue(['answer', 'optionId'], "To'g'ri variant ro'yxatda yo'q");
      }
    } else if (v.type === 'multi') {
      const sel = a.optionIds ?? [];
      if (!sel.length) {
        issue(['answer', 'optionIds'], "Kamida bitta to'g'ri variant tanlanishi kerak");
      } else if (new Set(sel).size !== sel.length) {
        issue(['answer', 'optionIds'], "To'g'ri variantlar takrorlanmasligi kerak");
      } else if (sel.some((s) => !ids.includes(s))) {
        issue(['answer', 'optionIds'], "To'g'ri variant ro'yxatda yo'q");
      }
    } else if (v.type === 'short') {
      const unique = new Set(
        (a.acceptedAnswers ?? [])
          .map((s) => s.trim())
          .filter(Boolean)
          .map(normalizeShortAnswer),
      );
      if (!unique.size) {
        issue(['answer', 'acceptedAnswers'], "Kamida bitta to'g'ri javob kiritilishi kerak");
      } else if (unique.size > LIMITS.acceptedAnswers) {
        issue(
          ['answer', 'acceptedAnswers'],
          `To'g'ri javoblar ${LIMITS.acceptedAnswers} tadan oshmasligi kerak`,
        );
      }
    }
  })
  .transform((v) => {
    // Kalit faqat tur uchun kerakli maydonlardan iborat bo'ladi
    const a = v.answer;
    let answer: Record<string, unknown> = {};
    if (v.type === 'single') answer = { optionId: a.optionId };
    else if (v.type === 'multi') {
      answer = { optionIds: a.optionIds, partialCredit: a.partialCredit ?? false };
    } else if (v.type === 'short') {
      const seen = new Set<string>();
      const list: string[] = [];
      for (const raw of a.acceptedAnswers ?? []) {
        const s = raw.trim();
        const key = normalizeShortAnswer(s);
        if (!s || seen.has(key)) continue;
        seen.add(key);
        list.push(s);
      }
      answer = { acceptedAnswers: list };
    } else if (a.rubric?.trim()) answer = { rubric: a.rubric.trim() };
    return { ...v, answer };
  });
export type QuestionInput = z.output<typeof questionInput>;

/**
 * Tahrir: barcha maydonlar ixtiyoriy; to'liq holat servisda mavjud savol bilan birlashtirilib
 * `questionInput` bilan qayta tekshiriladi (blok ichi qat'iy tekshiruv shu yerda bajariladi).
 */
export const updateBody = z
  .object({
    topicId: objectIdSchema,
    difficulty: z.number(),
    type: z.enum(QUESTION_TYPES),
    content: z.array(z.unknown()),
    options: z.array(z.unknown()),
    answer: z.record(z.string(), z.unknown()),
    points: z.number(),
    status: z.enum(['draft', 'active']),
    sharing: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict();
export type UpdateBody = z.infer<typeof updateBody>;

export const listQuery = z.object({
  ...paginationQuery,
  subjectId: objectIdSchema.optional(),
  topicId: objectIdSchema.optional(),
  difficulty: z.coerce.number().int().min(1).max(3).optional(),
  type: z.enum(QUESTION_TYPES).optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  authorId: objectIdSchema.optional(),
  mine: boolQuery,
  shared: boolQuery,
  search: z.string().trim().max(100).optional(),
});
export type ListQuery = z.output<typeof listQuery>;

/**
 * Ommaviy holat o'zgartirish. `ids` (<=500) yoki `topicId` (+ixtiyoriy `fromStatus`) dan kamida bittasi shart.
 * Faqat foydalanuvchi tahrirlay oladigan savollarga qo'llanadi.
 */
export const bulkStatusBody = z
  .object({
    ids: z.array(objectIdSchema).min(1).max(500).optional(),
    topicId: objectIdSchema.optional(),
    fromStatus: z.enum(QUESTION_STATUSES).optional(),
    toStatus: z.enum(['active', 'draft', 'archived']),
  })
  .strict()
  .refine((v) => !!v.ids || !!v.topicId, {
    message: 'ids yoki topicId berilishi kerak',
    path: ['ids'],
  });
export type BulkStatusBody = z.infer<typeof bulkStatusBody>;
