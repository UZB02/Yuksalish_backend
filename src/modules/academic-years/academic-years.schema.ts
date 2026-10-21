import { z } from 'zod';
import { dateOnlySchema, objectIdSchema } from '../../core/validators';

const name = z.string().trim().min(1).max(50);

const period = z.object({
  id: objectIdSchema.optional(),
  name,
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
});

export const createBody = z.object({
  name,
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
  periods: z.array(period).max(12).default([]),
});

export const updateBody = z.object({
  name: name.optional(),
  startDate: dateOnlySchema.optional(),
  endDate: dateOnlySchema.optional(),
  periods: z.array(period).max(12).optional(),
});
