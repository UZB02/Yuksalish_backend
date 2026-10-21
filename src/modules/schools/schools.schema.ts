import { z } from 'zod';
import { boolQuery, paginationQuery } from '../../core/pagination';
import { phoneSchema } from '../../core/validators';

export const RESERVED_SLUGS = ['global', 'api', 'admin'];

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .refine((v) => !RESERVED_SLUGS.includes(v), {
    message: 'Bu slug zaxiralangan, boshqasini tanlang',
  })
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Slug faqat kichik lotin harflari, raqamlar va '-' dan iborat bo'lishi kerak",
  );

const name = z.string().trim().min(2).max(150);
const address = z.string().trim().max(300);
const logoUrl = z.string().trim().url("URL formati noto'g'ri").max(500);

export const listQuery = z.object({
  ...paginationQuery,
  search: z.string().trim().max(100).optional(),
  isActive: boolQuery,
});

export const createBody = z.object({
  name,
  slug,
  address: address.nullish(),
  phone: phoneSchema.nullish(),
  logoUrl: logoUrl.nullish(),
});

export const updateBody = z.object({
  name: name.optional(),
  address: address.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  logoUrl: logoUrl.nullable().optional(),
  isActive: z.boolean().optional(),
});
