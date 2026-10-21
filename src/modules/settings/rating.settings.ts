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
};

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
