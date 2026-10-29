import { z } from 'zod';
import { dateStrSchema, objectIdSchema } from '../../core/validators';

/** Jurnal davrining eng ko'p kalendar kuni */
export const JOURNAL_MAX_DAYS = 93;

export const gridQuery = z.object({
  classId: objectIdSchema,
  subjectId: objectIdSchema,
  from: dateStrSchema,
  to: dateStrSchema,
});
export type GridQuery = z.infer<typeof gridQuery>;
