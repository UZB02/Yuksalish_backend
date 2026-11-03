import { z } from 'zod';
import { fullNameSchema, passwordSchema, phoneSchema, usernameSchema } from '../../core/validators';

export const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

/** O'z profilini tahrirlash. Login o'zgarsa currentPassword majburiy (servisda tekshiriladi) */
export const updateMeBody = z
  .object({
    fullName: fullNameSchema.optional(),
    username: usernameSchema.optional(),
    // Bo'sh satr = telefonni o'chirish
    phone: z.union([phoneSchema, z.literal('').transform(() => null), z.null()]).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
  })
  .strict();

export const usernameAvailableQuery = z.object({ username: usernameSchema });
