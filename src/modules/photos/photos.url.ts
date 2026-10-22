import crypto from 'crypto';
import type { Types } from 'mongoose';
import { env } from '../../config/env';

/**
 * Imzolangan rasm havolalari. <img src> Authorization sarlavhasini yubora olmaydi va access token
 * hech qachon URL ga qo'yilmaydi, shuning uchun DTO larda `?exp=&sig=` bilan imzolangan havola
 * qaytariladi (HMAC-SHA256, JWT_ACCESS_SECRET dan hosil qilingan alohida kalit).
 *
 * exp sutka chegarasiga yaxlitlanadi — havola kun davomida o'zgarmaydi, brauzer keshi ishlaydi.
 * Rasm almashtirilsa yangi _id olinadi, shuning uchun havola ham yangilanadi.
 */
const DAY = 86_400;
const API_PREFIX = '/api/v1/photos';

const key = () =>
  crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update('photo-url-signing').digest();

export const signPhoto = (id: string, exp: number): string =>
  crypto.createHmac('sha256', key()).update(`${id}:${exp}`).digest('base64url');

/** Joriy kundan keyingi 2-3 sutka amal qiladigan, kun davomida o'zgarmas exp (soniya) */
export const photoExpiry = (nowMs = Date.now()): number =>
  (Math.floor(nowMs / 1000 / DAY) + 3) * DAY;

export function verifyPhotoSignature(
  id: string,
  exp: unknown,
  sig: unknown,
  nowMs = Date.now(),
): boolean {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
  const expN = Number(exp);
  if (expN * 1000 < nowMs) return false;
  const expected = Buffer.from(signPhoto(id, expN));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** DTO uchun imzolangan havola (rasm yo'q bo'lsa null) */
export function photoUrl(photoId: Types.ObjectId | string | null | undefined): string | null {
  if (!photoId) return null;
  const id = String(photoId);
  const exp = photoExpiry();
  return `${API_PREFIX}/${id}?exp=${exp}&sig=${signPhoto(id, exp)}`;
}
