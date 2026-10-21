import { z } from 'zod';
import { boolQuery } from '../../core/pagination';
import { objectIdSchema } from '../../core/validators';
import { BEHAVIOR_KINDS } from '../../models/BehaviorType';

const name = z.string().trim().min(2).max(60);
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Rang #RRGGBB formatida bo'lishi kerak")
  .transform((v) => v.toUpperCase());
const score = z.number().int().min(0).max(100);

export const listQuery = z.object({
  isActive: boolQuery,
  scope: z.enum(['global', 'school', 'all']).optional(),
});

export const createBody = z.object({
  schoolId: objectIdSchema.nullish(),
  name,
  kind: z.enum(BEHAVIOR_KINDS),
  color,
  order: z.number().int().min(0).max(10000).optional(),
  minScore: score.nullish(),
  maxScore: score.nullish(),
});

export const updateBody = z.object({
  name: name.optional(),
  kind: z.enum(BEHAVIOR_KINDS).optional(),
  color: color.optional(),
  order: z.number().int().min(0).max(10000).optional(),
  minScore: score.nullable().optional(),
  maxScore: score.nullable().optional(),
});
