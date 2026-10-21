import { z } from 'zod';
import { boolQuery, paginationQuery } from '../../core/pagination';
import { objectIdSchema, optionalText } from '../../core/validators';

const name = z.string().trim().min(1).max(30);
const grade = z.number().int().min(1).max(11);
const ids = z.array(objectIdSchema).max(50);
const subjectItem = z.object({ subjectId: objectIdSchema, teacherId: objectIdSchema });
const subjects = z.array(subjectItem).max(40);

export const listQuery = z.object({
  ...paginationQuery,
  academicYearId: objectIdSchema.optional(),
  grade: z.coerce.number().int().min(1).max(11).optional(),
  search: z.string().trim().max(50).optional(),
  isArchived: boolQuery,
});

export const createBody = z.object({
  name,
  grade,
  section: optionalText(10),
  academicYearId: objectIdSchema.optional(),
  homeroomTeacherId: objectIdSchema.nullish(),
  teacherIds: ids.default([]),
  subjects: subjects.optional(),
});

export const updateBody = z.object({
  name: name.optional(),
  grade: grade.optional(),
  section: optionalText(10),
  homeroomTeacherId: objectIdSchema.nullable().optional(),
  teacherIds: ids.optional(),
  subjects: subjects.optional(),
});

export const teachersBody = z.object({
  teacherIds: ids,
  homeroomTeacherId: objectIdSchema.nullable(),
});

export const subjectsBody = z.object({ subjects });
