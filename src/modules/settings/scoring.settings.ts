import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../core/errors';
import type { DailyAggregation } from '../../utils/dayScore';

export const SCORING_KEY = 'scoring';

export interface ScoringSettings {
  minScore: number;
  maxScore: number;
  requireBehaviorType: boolean;
  /** null = hech qachon majburiy emas */
  commentRequiredBelow: number | null;
  editWindowHours: number;
  backdateDays: number;
  dailyAggregation: DailyAggregation;
}

export const SCORING_DEFAULTS: ScoringSettings = {
  minScore: 0,
  maxScore: 100,
  requireBehaviorType: true,
  commentRequiredBelow: null,
  editWindowHours: 24,
  backdateDays: 3,
  dailyAggregation: 'average',
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Qisman qiymatlar (override yoki global) */
export const scoringValuesSchema = z.object({
  minScore: int(0, 100).optional(),
  maxScore: int(0, 100).optional(),
  requireBehaviorType: z.boolean().optional(),
  commentRequiredBelow: int(0, 100).nullable().optional(),
  editWindowHours: int(0, 720).optional(),
  backdateDays: int(0, 30).optional(),
  dailyAggregation: z.enum(['average', 'min', 'last']).optional(),
});
export type ScoringValues = z.infer<typeof scoringValuesSchema>;

/** Ustma-ust qo'yish: defaults <- global <- override */
export function mergeScoring(...layers: (ScoringValues | null | undefined)[]): ScoringSettings {
  const out: ScoringSettings = { ...SCORING_DEFAULTS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Yakuniy (birlashgan) sozlamalar mantiqan to'g'ri ekanini tekshiradi */
export function validateScoring(s: ScoringSettings, prefix = 'values'): void {
  const errs: ErrorDetail[] = [];
  if (s.minScore >= s.maxScore) {
    errs.push({
      path: `${prefix}.maxScore`,
      message: "Maksimal ball minimal balldan katta bo'lishi kerak",
    });
  }
  if (errs.length) throw AppError.validation("Sozlamalar noto'g'ri", errs);
}
