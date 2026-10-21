import { z } from 'zod';
import { boolQuery, paginationQuery } from '../../core/pagination';
import {
  fullNameSchema,
  objectIdSchema,
  passwordSchema,
  permissionsSchema,
  usernameSchema,
} from '../../core/validators';

export const listQuery = z.object({
  ...paginationQuery,
  schoolId: objectIdSchema.optional(),
  search: z.string().trim().max(100).optional(),
  isActive: boolQuery,
});

export const createBody = z.object({
  schoolId: objectIdSchema,
  fullName: fullNameSchema,
  username: usernameSchema,
  password: passwordSchema,
  permissions: permissionsSchema.default([]),
});

export const updateBody = z.object({
  fullName: fullNameSchema.optional(),
  isActive: z.boolean().optional(),
});

export const permissionsBody = z.object({ permissions: permissionsSchema });

export const resetPasswordBody = z.object({ newPassword: passwordSchema });
