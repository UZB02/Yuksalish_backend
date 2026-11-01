import crypto from 'crypto';
import { env } from '../../config/env';

const SALT = Buffer.from('yuksalish/telegram-token/v1/salt');
const INFO = Buffer.from('yuksalish/telegram-token/v1');
const IV_LEN = 12;
const TAG_LEN = 16;

/** HKDF-SHA256 bilan JWT_ACCESS_SECRET dan 32 baytlik kalit */
export function deriveKey(secret: string = env.JWT_ACCESS_SECRET): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, SALT, INFO, 32));
}

/** base64(iv + tag + ciphertext) */
export function encryptToken(plain: string, secret?: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Kalit noto'g'ri yoki ma'lumot buzilgan bo'lsa xato tashlaydi */
export function decryptToken(enc: string, secret?: string): string {
  const buf = Buffer.from(enc, 'base64');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('Shifrlangan token formati noto‘g‘ri');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(secret),
    buf.subarray(0, IV_LEN),
  );
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([
    decipher.update(buf.subarray(IV_LEN + TAG_LEN)),
    decipher.final(),
  ]).toString('utf8');
}
