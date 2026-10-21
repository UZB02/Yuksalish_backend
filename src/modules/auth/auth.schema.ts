import { z } from 'zod';
import { passwordSchema } from '../../core/validators';

export const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
