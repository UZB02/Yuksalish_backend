import { z } from 'zod';
import { boolQuery, paginationQuery } from '../../core/pagination';
import {
  fullNameSchema,
  objectIdSchema,
  passwordSchema,
  permissionsSchema,
  phoneSchema,
  usernameSchema,
} from '../../core/validators';

export const listQuery = z.object({
  ...paginationQuery,
  search: z.string().trim().max(100).optional(),
  isActive: boolQuery,
});

export const createBody = z.object({
  fullName: fullNameSchema,
  username: usernameSchema,
  password: passwordSchema,
  phone: phoneSchema.nullish(),
  permissions: permissionsSchema.default([]),
});

export const updateBody = z.object({
  fullName: fullNameSchema.optional(),
  phone: phoneSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const permissionsBody = z.object({ permissions: permissionsSchema });

export const classesBody = z.object({ classIds: z.array(objectIdSchema).max(100) });

export const resetPasswordBody = z.object({ newPassword: passwordSchema });

const cell = (max: number) => z.string().max(max).nullable().optional();

export const credentialsBody = z.object({
  rows: z
    .array(
      z.object({
        fullName: z.string().trim().min(1).max(150),
        phone: cell(40),
        login: cell(80),
        password: cell(128),
        status: z.enum(['created', 'skipped', 'failed']),
      }),
    )
    .min(1)
    .max(500),
});
