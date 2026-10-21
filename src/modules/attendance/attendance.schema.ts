import { z } from 'zod';
import { paginationQuery } from '../../core/pagination';
import { dateStrSchema, objectIdSchema } from '../../core/validators';
import { ATTENDANCE_CATEGORIES } from '../settings/attendance.settings';

const lessonNo = z.number().int().min(0).max(12);
const minutesLate = z
  .number("Daqiqa son bo'lishi kerak")
  .int("Daqiqa butun son bo'lishi kerak")
  .nullish();
const note = z
  .string()
  .trim()
  .max(300)
  .transform((v) => v || null)
  .nullish();

export const bulkBody = z.object({
  classId: objectIdSchema,
  date: dateStrSchema.optional(),
  lessonNo: lessonNo.optional(),
  items: z
    .array(z.object({ studentId: objectIdSchema, statusId: objectIdSchema, minutesLate, note }))
    .min(1)
    .max(200),
});

export const updateBody = z.object({
  statusId: objectIdSchema.optional(),
  minutesLate,
  note,
});

export const listQuery = z.object({
  ...paginationQuery,
  classId: objectIdSchema.optional(),
  studentId: objectIdSchema.optional(),
  statusId: objectIdSchema.optional(),
  category: z.enum(ATTENDANCE_CATEGORIES).optional(),
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
  lessonNo: z.coerce.number().int().min(0).max(12).optional(),
  sort: z.enum(['date', '-date']).default('-date'),
});

export const sheetQuery = z.object({
  date: dateStrSchema.optional(),
  lessonNo: z.coerce.number().int().min(0).max(12).optional(),
});

export const summaryQuery = z.object({
  classId: objectIdSchema.optional(),
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
});

export const rangeQuery = z.object({
  from: dateStrSchema.optional(),
  to: dateStrSchema.optional(),
});
