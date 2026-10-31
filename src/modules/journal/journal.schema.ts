import { z } from 'zod';
import { dateStrSchema, objectIdSchema } from '../../core/validators';

/** Jurnal davrining eng ko'p kalendar kuni */
export const JOURNAL_MAX_DAYS = 93;

export const gridQuery = z.object({
  classId: objectIdSchema,
  subjectId: objectIdSchema,
  /**
   * Fanning bir nechta o'qituvchisi bo'lsa: jurnal (fan, o'qituvchi) juftligi bo'yicha.
   * Berilmasa: o'qituvchi uchun — o'zi, admin uchun — barcha o'qituvchilar birga.
   */
  teacherId: objectIdSchema.optional(),
  from: dateStrSchema,
  to: dateStrSchema,
});
export type GridQuery = z.infer<typeof gridQuery>;
