import { z } from 'zod';
import { paginationQuery } from '../../core/pagination';
import { dateStrSchema, objectIdSchema } from '../../core/validators';

const msg = "Baho 2 dan 5 gacha butun son bo'lishi kerak";
const value = z.number(msg).int(msg).min(2, msg).max(5, msg);
const comment = z
  .string()
  .trim()
  .max(500)
  .transform((v) => v || null)
  .nullish();

export const createBody = z.object({
  studentId: objectIdSchema,
  subjectId: objectIdSchema,
  date: dateStrSchema.optional(),
  value,
  comment,
});

export const updateBody = z.object({
  value: value.optional(),
  comment,
});

export const bulkBody = z.object({
  classId: objectIdSchema,
  subjectId: objectIdSchema,
  date: dateStrSchema.optional(),
  items: z
    .array(
      z.object({
        studentId: objectIdSchema,
        value,
        comment,
      }),
    )
    .min(1)
    .max(200),
});

export const listQuery = z.object({
  ...paginationQuery,
  classId: objectIdSchema.optional(),
  subjectId: objectIdSchema.optional(),
  studentId: objectIdSchema.optional(),
  teacherId: objectIdSchema.optional(),
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
  sort: z.enum(['date', '-date']).default('-date'),
});

export const sheetQuery = z.object({
  classId: objectIdSchema,
  subjectId: objectIdSchema,
  date: dateStrSchema.optional(),
});

export const summaryQuery = z.object({
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
});
