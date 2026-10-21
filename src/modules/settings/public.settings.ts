import { z } from 'zod';
import { AppError } from '../../core/errors';

export const PUBLIC_KEY = 'public';

export interface PublicSettings {
  enabled: boolean;
  showScope: 'own' | 'global';
  includeInGlobal: boolean;
  showClasses: boolean;
  showStudents: boolean;
  /** null = hammasi */
  topStudents: number | null;
  showScores: boolean;
  showMedals: boolean;
  showTrend: boolean;
  title: string | null;
  subtitle: string | null;
  primaryColor: string | null;
  autoRefreshSeconds: number;
  tvSlideSeconds: number;
  /** Faqat global scope da o'rnatiladi */
  globalRatingEnabled: boolean;
}

export const PUBLIC_DEFAULTS: PublicSettings = {
  enabled: false,
  showScope: 'own',
  includeInGlobal: true,
  showClasses: true,
  showStudents: true,
  topStudents: 20,
  showScores: true,
  showMedals: true,
  showTrend: true,
  title: null,
  subtitle: null,
  primaryColor: null,
  autoRefreshSeconds: 120,
  tvSlideSeconds: 15,
  globalRatingEnabled: false,
};

export const publicValuesSchema = z.object({
  enabled: z.boolean().optional(),
  showScope: z.enum(['own', 'global']).optional(),
  includeInGlobal: z.boolean().optional(),
  showClasses: z.boolean().optional(),
  showStudents: z.boolean().optional(),
  topStudents: z.number().int().min(1).max(500).nullable().optional(),
  showScores: z.boolean().optional(),
  showMedals: z.boolean().optional(),
  showTrend: z.boolean().optional(),
  title: z
    .string()
    .trim()
    .max(80)
    .transform((v) => v || null)
    .nullable()
    .optional(),
  subtitle: z
    .string()
    .trim()
    .max(160)
    .transform((v) => v || null)
    .nullable()
    .optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Rang #RRGGBB formatida bo'lishi kerak")
    .transform((v) => v.toUpperCase())
    .nullable()
    .optional(),
  autoRefreshSeconds: z.number().int().min(30).max(3600).optional(),
  tvSlideSeconds: z.number().int().min(5).max(120).optional(),
  globalRatingEnabled: z.boolean().optional(),
});

/** globalRatingEnabled faqat global scope uchun */
export function assertPublicScope(
  scope: 'global' | 'school',
  values: Record<string, unknown> | null,
) {
  if (scope === 'school' && values && values.globalRatingEnabled !== undefined) {
    throw AppError.validation("Sozlamalar noto'g'ri", [
      {
        path: 'values.globalRatingEnabled',
        message: "globalRatingEnabled faqat umumiy (global) sozlamada o'rnatiladi",
      },
    ]);
  }
}
