import { z } from 'zod';

export const TIMETABLE_KEY = 'timetable';

export const ENFORCEMENT_MODES = ['off', 'suggest', 'strict'] as const;
export type TimetableEnforcement = (typeof ENFORCEMENT_MODES)[number];

export interface TimetableSettings {
  /** off: jadval davomatga ta'sir qilmaydi; suggest: fan avtomatik, admin/sinf rahbari o'zgartira oladi; strict: qat'iy */
  enforcement: TimetableEnforcement;
  /** Sinf rahbari o'z sinfining istalgan darsiga davomat ola oladimi */
  homeroomCanTakeAnyLesson: boolean;
  /** strict rejimda jadvali yo'q sinf: qo'lda (manual) yoki bloklash (block) */
  strictNoTimetable: 'manual' | 'block';
}

export const TIMETABLE_DEFAULTS: TimetableSettings = {
  enforcement: 'suggest',
  homeroomCanTakeAnyLesson: true,
  strictNoTimetable: 'manual',
};

export const timetableValuesSchema = z.object({
  enforcement: z.enum(ENFORCEMENT_MODES).optional(),
  homeroomCanTakeAnyLesson: z.boolean().optional(),
  strictNoTimetable: z.enum(['manual', 'block']).optional(),
});
