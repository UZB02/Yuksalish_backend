import { z } from 'zod';
import { boolQuery } from '../../core/pagination';
import { objectIdSchema } from '../../core/validators';

const name = z.string().trim().min(2).max(60);

export const listQuery = z.object({
  isActive: boolQuery,
  scope: z.enum(['global', 'school', 'all']).optional(),
});

export const createBody = z.object({
  schoolId: objectIdSchema.nullish(),
  name,
  order: z.number().int().min(0).max(10000).optional(),
});

export const updateBody = z.object({
  name: name.optional(),
  order: z.number().int().min(0).max(10000).optional(),
});
