import { z } from 'zod';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Ro'yxat so'rovlari uchun umumiy query maydonlari
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export function buildMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export const skipOf = (page: number, limit: number) => (page - 1) * limit;
