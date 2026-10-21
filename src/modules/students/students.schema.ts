import { z } from 'zod';
import { paginationQuery } from '../../core/pagination';
import { dateOnlySchema, objectIdSchema, optionalText, phoneSchema } from '../../core/validators';
import { GENDERS, STUDENT_STATUSES } from '../../models/Student';

const fullName = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .transform((v) => v.replace(/\s+/g, ' '));
const phone = z
  .string()
  .trim()
  .transform((v) => v || null)
  .pipe(phoneSchema.nullable())
  .nullish();
const photoUrl = z
  .string()
  .trim()
  .transform((v) => v || null)
  .pipe(z.string().url("URL formati noto'g'ri").max(500).nullable())
  .nullish();
const gender = z.enum(GENDERS).nullish();
const birthDate = dateOnlySchema.nullish();

export const listQuery = z.object({
  ...paginationQuery,
  classId: objectIdSchema.optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
});

export const createBody = z.object({
  fullName,
  studentCode: optionalText(50),
  birthDate,
  gender,
  classId: objectIdSchema,
  parentPhone: phone,
  photoUrl,
  status: z.enum(STUDENT_STATUSES).optional(),
});

export const updateBody = z.object({
  fullName: fullName.optional(),
  studentCode: optionalText(50),
  birthDate,
  gender,
  parentPhone: phone,
  photoUrl,
  status: z.enum(STUDENT_STATUSES).optional(),
});

export const transferBody = z.object({ classId: objectIdSchema });

export const exportQuery = z.object({ classId: objectIdSchema.optional() });

export const previewBody = z.object({
  classId: z.preprocess((v) => (v === '' ? undefined : v), objectIdSchema.optional()),
});

export const confirmBody = z.object({
  importId: z.string().min(1).max(64),
  onDuplicate: z.enum(['skip', 'update']).default('skip'),
});
