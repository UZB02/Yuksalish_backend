import { isValidObjectId } from 'mongoose';

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isId = (v: unknown): v is string =>
  typeof v === 'string' && isValidObjectId(v) && /^[0-9a-f]{24}$/i.test(v);

export const uniq = <T>(arr: T[]): T[] => [...new Set(arr)];

export const isDuplicateKeyError = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
