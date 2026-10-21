import { z } from 'zod';
import { round2 } from '../../utils/dayScore';

export const ATTENDANCE_KEY = 'attendance';

export const ATTENDANCE_CATEGORIES = [
  'present',
  'late',
  'absent_excused',
  'absent_unexcused',
] as const;
export type AttendanceCategory = (typeof ATTENDANCE_CATEGORIES)[number];

export interface RatingImpact {
  enabled: boolean;
  penaltyLate: number;
  penaltyAbsentExcused: number;
  penaltyAbsentUnexcused: number;
}

export interface AttendanceSettings {
  mode: 'daily' | 'lesson';
  lessonsPerDay: number;
  /** ISO hafta kunlari: 1 = dushanba */
  workingWeekdays: number[];
  editWindowHours: number;
  backdateDays: number;
  noteRequiredCategories: AttendanceCategory[];
  /** Ichma-ich qisman override yo'q: to'liq obyekt sifatida almashtiriladi */
  ratingImpact: RatingImpact;
}

export const RATING_IMPACT_DEFAULTS: RatingImpact = {
  enabled: false,
  penaltyLate: 0,
  penaltyAbsentExcused: 0,
  penaltyAbsentUnexcused: 0,
};

export const ATTENDANCE_DEFAULTS: AttendanceSettings = {
  mode: 'daily',
  lessonsPerDay: 6,
  workingWeekdays: [1, 2, 3, 4, 5, 6],
  editWindowHours: 24,
  backdateDays: 3,
  noteRequiredCategories: [],
  ratingImpact: RATING_IMPACT_DEFAULTS,
};

const penalty = z
  .number()
  .min(0)
  .max(100)
  .transform((v) => round2(v));

export const attendanceValuesSchema = z.object({
  mode: z.enum(['daily', 'lesson']).optional(),
  lessonsPerDay: z.number().int().min(1).max(12).optional(),
  workingWeekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1, "Kamida bitta ish kuni bo'lishi kerak")
    .max(7)
    .refine((a) => new Set(a).size === a.length, {
      message: 'Hafta kunlari takrorlanmasligi kerak',
    })
    .optional(),
  editWindowHours: z.number().int().min(0).max(720).optional(),
  backdateDays: z.number().int().min(0).max(30).optional(),
  noteRequiredCategories: z
    .array(z.enum(ATTENDANCE_CATEGORIES))
    .refine((a) => new Set(a).size === a.length, {
      message: 'Kategoriyalar takrorlanmasligi kerak',
    })
    .optional(),
  ratingImpact: z
    .object({
      enabled: z.boolean().optional(),
      penaltyLate: penalty.optional(),
      penaltyAbsentExcused: penalty.optional(),
      penaltyAbsentUnexcused: penalty.optional(),
    })
    .optional(),
});

/** Hafta kunlari tartiblanadi; ratingImpact standart qiymatlar bilan to'ldirilib to'liq obyekt bo'ladi */
export function normalizeAttendance(values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  if (Array.isArray(out.workingWeekdays)) {
    out.workingWeekdays = [...(out.workingWeekdays as number[])].sort((a, b) => a - b);
  }
  if (out.ratingImpact && typeof out.ratingImpact === 'object') {
    out.ratingImpact = { ...RATING_IMPACT_DEFAULTS, ...(out.ratingImpact as object) };
  }
  return out;
}
