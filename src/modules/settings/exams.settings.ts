import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { AuthUser } from '../../types/express';
import { settingsStore } from './settings.store';

export const EXAMS_KEY = 'exams';

export interface ExamsSettings {
  /** Imtihon moduli maktab uchun yoqilganmi (standart: o'chiq). Faqat superadmin o'zgartiradi */
  enabled: boolean;
  /** O'qituvchilar o'z sinfi va fani uchun nazorat ishi yarata oladi (faqat enabled bo'lsa ahamiyatli) */
  teachersCanCreateQuizzes: boolean;
  /** Yoqilsa, o'qituvchi yaratgan nazorat ishi ma'muriyat tasdig'ini kutadi (pending_approval) */
  teacherQuizNeedsApproval: boolean;
  /** Nomzodlarning shaxsiy ma'lumotlarini (telefon, tug'ilgan sana) saqlash muddati, kun */
  candidateRetentionDays: number;
}

export const EXAMS_DEFAULTS: ExamsSettings = {
  enabled: false,
  teachersCanCreateQuizzes: true,
  teacherQuizNeedsApproval: false,
  candidateRetentionDays: 365,
};

export const examsValuesSchema = z.object({
  enabled: z.boolean().optional(),
  teachersCanCreateQuizzes: z.boolean().optional(),
  teacherQuizNeedsApproval: z.boolean().optional(),
  candidateRetentionDays: z
    .number()
    .int("Butun son bo'lishi kerak")
    .min(1, "Kamida 1 kun bo'lishi kerak")
    .max(3650, '3650 kundan oshmasligi kerak')
    .optional(),
});

/**
 * Yozish ruxsati:
 * - superadmin: hamma narsa (global yoki istalgan maktab), jumladan `enabled`;
 * - school_admin (exams.manage): faqat o'z maktabi override i, `enabled` dan tashqari.
 *   Maktab admini `enabled` ni yubora olmaydi (403), lekin override ni almashtirganda superadmin
 *   qo'ygan `enabled` qiymati saqlanib qoladi.
 */
export async function guardExamsWrite(
  actor: AuthUser,
  body: { scope: 'global' | 'school'; schoolId?: string; values: Record<string, unknown> | null },
) {
  if (actor.role === 'superadmin') return body;
  if (!actor.permissions.includes('exams.manage')) throw AppError.forbidden();
  if (body.scope !== 'school')
    throw AppError.forbidden("Umumiy sozlamani faqat superadmin o'zgartiradi");
  if (body.schoolId && body.schoolId !== actor.schoolId) throw AppError.forbidden();
  if (body.values && 'enabled' in body.values) {
    throw AppError.forbidden("Imtihon modulini yoqish/o'chirishni faqat superadmin bajaradi");
  }
  const schoolId = actor.schoolId as string;
  const stored = await settingsStore.get<Record<string, unknown>>('school', schoolId, EXAMS_KEY);
  const keepEnabled = stored && 'enabled' in stored ? { enabled: stored.enabled } : null;
  if (!body.values) {
    // "Standartga qaytarish": superadmin qo'ygan `enabled` o'chib ketmasin
    return { ...body, schoolId, values: keepEnabled };
  }
  return { ...body, schoolId, values: { ...body.values, ...keepEnabled } };
}
