import { z } from 'zod';
import { paginationQuery } from '../../core/pagination';
import { dateStrSchema, objectIdSchema } from '../../core/validators';

const value = z.number("Ball butun son bo'lishi kerak").int("Ball butun son bo'lishi kerak");
/** null/yo'q = faqat jarima qaydi; shartli qoida servisda (scores.rules checkValues) */
const optionalValue = value.nullish();
const comment = z
  .string()
  .trim()
  .max(500)
  .transform((v) => v || null)
  .nullish();
const behaviorTypeId = objectIdSchema.nullish();

export const createBody = z.object({
  studentId: objectIdSchema,
  date: dateStrSchema.optional(),
  value: optionalValue,
  behaviorTypeId,
  comment,
});

export const updateBody = z.object({
  value: optionalValue,
  behaviorTypeId,
  comment,
});

export const bulkBody = z.object({
  classId: objectIdSchema,
  date: dateStrSchema.optional(),
  items: z
    .array(
      z.object({
        studentId: objectIdSchema,
        value: optionalValue,
        behaviorTypeId,
        comment,
      }),
    )
    .min(1)
    .max(200),
});

export const listQuery = z.object({
  ...paginationQuery,
  classId: objectIdSchema.optional(),
  studentId: objectIdSchema.optional(),
  teacherId: objectIdSchema.optional(),
  behaviorTypeId: objectIdSchema.optional(),
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
  sort: z.enum(['date', '-date']).default('-date'),
});

export const sheetQuery = z.object({ date: dateStrSchema.optional() });

export const summaryQuery = z.object({
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
});
