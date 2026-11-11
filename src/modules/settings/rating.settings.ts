import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../core/errors';
import { dateStrSchema } from '../../core/validators';

export const RATING_KEY = 'rating';

export const PERIOD_TYPES = ['week', 'month', 'quarter', 'academic_year', 'custom'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];
export type TieBreak = 'daysCount' | 'scoresCount' | 'alphabetical';

/** Reyting tarkibi: xulq bahosi (0–100) va fan baholari (2–5, ×20) ulushlari, yig'indisi 100 */
export interface RatingWeights {
  conduct: number;
  subjects: number;
}

export interface RatingSettings {
  periodType: PeriodType;
  customFrom: string | null;
  customTo: string | null;
  method: 'average' | 'sum';
  /** Reytingga kirish uchun kamida N ta baholangan KUN */
  minScoresCount: number;
  /** Teng ballarda tartiblash; 'alphabetical' doim oxirida */
  tieBreak: TieBreak[];
  refreshMode: 'realtime' | 'nightly';
  weights: RatingWeights;
  /** Davr yakuniy natijasini e'lon qilish (muzlatib arxivlash). Standart: o'chiq */
  resultsEnabled: boolean;
  /** Faqat periodType=week uchun: e'lon kuni (ISO 1=Du..7=Ya). Boshqa turlarda davrning oxirgi kuni */
  resultsWeekday: number;
  /** E'lon vaqti "HH:mm" (Asia/Tashkent) */
  resultsTime: string;
  /** Faqat month: e'lon kuni 1–31; 0 = oyning oxirgi kuni (oyda kun yetmasa ham oxirgi kun) */
  resultsMonthDay: number;
  /** quarter/academic_year/custom: aniq e'lon sanasi (YYYY-MM-DD). null yoki davrdan tashqarida bo'lsa davrning oxirgi kuni */
  resultsDate: string | null;
}

export const RATING_DEFAULTS: RatingSettings = {
  periodType: 'month',
  customFrom: null,
  customTo: null,
  method: 'average',
  minScoresCount: 3,
  tieBreak: ['daysCount', 'alphabetical'],
  refreshMode: 'realtime',
  weights: { conduct: 50, subjects: 50 },
  resultsEnabled: false,
  resultsWeekday: 6,
  resultsTime: '18:00',
  resultsMonthDay: 0,
  resultsDate: null,
};

/** Qayta hisoblashni talab qilmaydigan (faqat e'lon jadvaliga tegishli) sozlama kalitlari */
export const RATING_RESULTS_KEYS = [
  'resultsEnabled',
  'resultsWeekday',
  'resultsTime',
  'resultsMonthDay',
  'resultsDate',
] as const;

export const ratingValuesSchema = z.object({
  periodType: z.enum(PERIOD_TYPES).optional(),
  customFrom: dateStrSchema.nullable().optional(),
  customTo: dateStrSchema.nullable().optional(),
  method: z.enum(['average', 'sum']).optional(),
  minScoresCount: z.number().int().min(1).max(366).optional(),
  tieBreak: z
    .array(z.enum(['daysCount', 'scoresCount', 'alphabetical']))
    .max(3)
    .refine((a) => new Set(a).size === a.length, {
      message: 'tieBreak qiymatlari takrorlanmasligi kerak',
    })
    .optional(),
  refreshMode: z.enum(['realtime', 'nightly']).optional(),
  weights: z
    .object({
      conduct: z.number("Ulush butun son bo'lishi kerak").int().min(0).max(100),
      subjects: z.number("Ulush butun son bo'lishi kerak").int().min(0).max(100),
    })
    .optional(),
  resultsEnabled: z.boolean().optional(),
  resultsWeekday: z.number().int().min(1).max(7).optional(),
  resultsMonthDay: z.number().int().min(0).max(31).optional(),
  resultsDate: dateStrSchema.nullable().optional(),
  resultsTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Vaqt HH:mm ko‘rinishida bo‘lishi kerak (00:00–23:59)')
    .optional(),
});

/** tieBreak: 'alphabetical' doim oxirida */
export function normalizeRating(values: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(values.tieBreak)) return values;
  const tb = (values.tieBreak as TieBreak[]).filter((t) => t !== 'alphabetical');
  return { ...values, tieBreak: [...tb, 'alphabetical'] };
}

export function validateRating(s: RatingSettings): void {
  const errs: ErrorDetail[] = [];
  if (s.periodType === 'custom') {
    if (!s.customFrom || !s.customTo) {
      errs.push({
        path: 'values.customFrom',
        message: 'Erkin davr uchun customFrom va customTo majburiy',
      });
    } else if (s.customFrom > s.customTo) {
      errs.push({
        path: 'values.customTo',
        message: "customTo customFrom dan oldin bo'lmasligi kerak",
      });
    }
  }
  if (s.weights.conduct + s.weights.subjects !== 100) {
    errs.push({
      path: 'values.weights',
      message: "Xulq va fan baholari ulushlari yig'indisi 100 bo'lishi kerak",
    });
  }
  if (errs.length) throw AppError.validation("Sozlamalar noto'g'ri", errs);
}
