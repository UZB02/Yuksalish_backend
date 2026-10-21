import type { ZodType } from 'zod';
import { AppError } from '../../core/errors';
import type { AuthUser } from '../../types/express';
import {
  ATTENDANCE_DEFAULTS,
  ATTENDANCE_KEY,
  attendanceValuesSchema,
  normalizeAttendance,
} from './attendance.settings';
import {
  PUBLIC_DEFAULTS,
  PUBLIC_KEY,
  assertPublicScope,
  publicValuesSchema,
} from './public.settings';
import {
  RATING_DEFAULTS,
  RATING_KEY,
  normalizeRating,
  ratingValuesSchema,
  validateRating,
  type RatingSettings,
} from './rating.settings';
import {
  SCORING_DEFAULTS,
  SCORING_KEY,
  scoringValuesSchema,
  validateScoring,
  type ScoringSettings,
} from './scoring.settings';

type Obj = Record<string, unknown>;

/** Sozlama turi tavsifi. Yangi tur qo'shish uchun shu ro'yxatga yozing. */
export interface SettingDef {
  key: string;
  defaults: Obj;
  valuesSchema: ZodType;
  /** Saqlashdan oldin qiymatlarni normallashtirish */
  normalize?: (values: Obj) => Obj;
  /** Birlashgan (defaults <- global <- override) qiymat mantiqan to'g'rimi */
  validateMerged: (merged: Obj) => void;
  /** Scope bo'yicha qo'shimcha qoidalar */
  validateScope?: (scope: 'global' | 'school', values: Obj | null) => void;
  /** Yozish ruxsati (default: faqat superadmin) */
  writeRoles?: ('superadmin' | 'school_admin')[];
  /**
   * writeRoles da school_admin bo'lsa: ruxsat va doirani tekshiradi, to'g'rilangan body qaytaradi
   * (faqat o'z maktabi, scope=school)
   */
  guardWrite?: (actor: AuthUser, body: WriteBody) => WriteBody;
  /** global/override ni kim ko'ra oladi (default: override — superadmin, global — hamma) */
  detailAccess?: (actor: AuthUser) => boolean;
}

export interface WriteBody {
  scope: 'global' | 'school';
  schoolId?: string;
  values: Obj | null;
}

export const SETTING_DEFS: Record<string, SettingDef> = {
  [SCORING_KEY]: {
    key: SCORING_KEY,
    defaults: SCORING_DEFAULTS as unknown as Obj,
    valuesSchema: scoringValuesSchema,
    validateMerged: (m) => validateScoring(m as unknown as ScoringSettings),
  },
  [RATING_KEY]: {
    key: RATING_KEY,
    defaults: RATING_DEFAULTS as unknown as Obj,
    valuesSchema: ratingValuesSchema,
    normalize: normalizeRating,
    validateMerged: (m) => validateRating(m as unknown as RatingSettings),
  },
  [PUBLIC_KEY]: {
    key: PUBLIC_KEY,
    defaults: PUBLIC_DEFAULTS as unknown as Obj,
    valuesSchema: publicValuesSchema,
    validateMerged: () => undefined,
    validateScope: assertPublicScope,
  },
  [ATTENDANCE_KEY]: {
    key: ATTENDANCE_KEY,
    defaults: ATTENDANCE_DEFAULTS as unknown as Obj,
    valuesSchema: attendanceValuesSchema,
    normalize: normalizeAttendance,
    validateMerged: () => undefined,
    // Superadmin (global yoki maktab) va attendance.settings li maktab admini (faqat o'z maktabi)
    writeRoles: ['superadmin', 'school_admin'],
    guardWrite: (actor, body) => {
      if (actor.role === 'superadmin') return body;
      if (!actor.permissions.includes('attendance.settings')) throw AppError.forbidden();
      if (body.scope !== 'school')
        throw AppError.forbidden("Umumiy sozlamani faqat superadmin o'zgartiradi");
      if (body.schoolId && body.schoolId !== actor.schoolId) throw AppError.forbidden();
      return { ...body, schoolId: actor.schoolId as string };
    },
    detailAccess: (actor) =>
      actor.role === 'superadmin' || actor.permissions.includes('attendance.settings'),
  },
};

export function mergeLayers(defaults: Obj, ...layers: (Obj | null | undefined)[]): Obj {
  const out: Obj = { ...defaults };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) out[k] = v;
  }
  return out;
}
