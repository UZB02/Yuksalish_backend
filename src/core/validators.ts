import { z } from 'zod';
import { parseDateOnly } from '../utils/dates';

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, "Identifikator noto'g'ri");

export const passwordSchema = z
  .string()
  .min(8, "Parol kamida 8 ta belgidan iborat bo'lishi kerak")
  .max(128, 'Parol 128 ta belgidan oshmasligi kerak')
  .refine((v) => /\p{L}/u.test(v) && /\d/.test(v), {
    message: "Parol kamida bitta harf va bitta raqamdan iborat bo'lishi kerak",
  });

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9._-]+$/,
    "Login faqat lotin harflari, raqam va . _ - belgilaridan iborat bo'lishi kerak",
  );

export const fullNameSchema = z.string().trim().min(2).max(100);

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s()-]{7,20}$/, "Telefon raqami formati noto'g'ri");

/** "YYYY-MM-DD" yoki ISO satr -> Date (UTC) */
export const dateOnlySchema = z
  .string()
  .refine((v) => parseDateOnly(v) !== null, { message: "Sana formati noto'g'ri (YYYY-MM-DD)" })
  .transform((v) => parseDateOnly(v) as Date);

/** Qat'iy "YYYY-MM-DD" satr (Date ga aylantirilmaydi) */
export const dateStrSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Sana formati noto'g'ri (YYYY-MM-DD)")
  .refine((v) => parseDateOnly(v) !== null, { message: "Sana noto'g'ri" });

/** Bo'sh satr null ga aylanadi */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const permissionsSchema = z.array(z.string().min(1).max(64)).max(50);

export const idParams = z.object({ id: z.string().min(1).max(64) });
