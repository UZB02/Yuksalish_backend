import { z } from 'zod';
import { fullNameSchema, passwordSchema, usernameSchema } from '../../core/validators';

const currentPassword = z.string().min(1, 'Joriy parolni kiriting').max(128);

export const createBody = z.object({
  fullName: fullNameSchema,
  username: usernameSchema,
  password: passwordSchema,
  currentPassword,
});

export const updateBody = z
  .object({
    isActive: z.boolean().optional(),
    password: passwordSchema.optional(),
    fullName: fullNameSchema.optional(),
    currentPassword,
  })
  .refine((v) => v.isActive !== undefined || v.password !== undefined || v.fullName !== undefined, {
    message: "O'zgartiriladigan maydon ko'rsatilmagan",
  });

export const transferBody = z.object({ currentPassword });
