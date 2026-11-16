import crypto from 'crypto';
import { env } from '../../../config/env';
import { AppError } from '../../../core/errors';

/**
 * PIN dizayni (qaror):
 *  - 6 belgi, bir xil o'qiladigan alifbo (0/O, 1/I/L yo'q): 31^6 ~ 887 mln variant;
 *  - `pinHash` = sha256(pinSalt:PIN), pinSalt har sessiyada alohida: kirishni tekshirish uchun (E4);
 *  - `pinEnc` = AES-256-GCM, kalit EXAM_PIN_SECRET dan HKDF bilan (JWT_ACCESS_SECRET DAN ALOHIDA, Y3 xavfi),
 *    AAD = sessiya id: PIN varaqasini qayta chop etish uchun. Hech qachon API javobiga/auditga chiqmaydi;
 *  - EXAM_PIN_SECRET yo'q bo'lsa PIN yaratish 503 (modul qolgan qismi ishlayveradi);
 *  - kalit almashsa eski pinEnc o'qilmaydi: PIN "qayta yaratiladi" (regenerate).
 */
export const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PIN_LENGTH = 6;
const IV_LEN = 12;
const TAG_LEN = 16;

export const pinSecretConfigured = (): boolean => !!env.EXAM_PIN_SECRET;

function key(): Buffer {
  if (!env.EXAM_PIN_SECRET) {
    throw AppError.unavailable('EXAM_PIN_SECRET sozlanmagan: PIN yaratib bo‘lmaydi');
  }
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      env.EXAM_PIN_SECRET,
      Buffer.from('yuksalish/exam-pin/v1/salt'),
      Buffer.from('yuksalish/exam-pin/v1'),
      32,
    ),
  );
}

export function randomPin(): string {
  let s = '';
  for (let i = 0; i < PIN_LENGTH; i++) s += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)];
  return s;
}

export const newPinSalt = (): string => crypto.randomBytes(16).toString('hex');
export const newParticipantKey = (): string => crypto.randomBytes(9).toString('base64url');

export const normalizePin = (pin: string): string => pin.trim().toUpperCase().replace(/\s+/g, '');

export const hashPin = (salt: string, pin: string): string =>
  crypto
    .createHash('sha256')
    .update(`${salt}:${normalizePin(pin)}`)
    .digest('hex');

export function encryptPin(pin: string, sessionId: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(sessionId));
  const ct = Buffer.concat([c.update(pin, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Dekodlab bo'lmasa (kalit almashgan/buzilgan) null */
export function decryptPin(enc: string, sessionId: string): string | null {
  try {
    const buf = Buffer.from(enc, 'base64');
    if (buf.length <= IV_LEN + TAG_LEN) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, IV_LEN));
    d.setAAD(Buffer.from(sessionId));
    d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
    return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Sessiya ichida noyob PIN (takror bo'lsa qayta tanlanadi) */
export function uniquePin(salt: string, taken: Set<string>): { pin: string; hash: string } {
  for (let i = 0; i < 50; i++) {
    const pin = randomPin();
    const hash = hashPin(salt, pin);
    if (!taken.has(hash)) {
      taken.add(hash);
      return { pin, hash };
    }
  }
  throw AppError.unavailable('PIN yaratib bo‘lmadi, qayta urinib ko‘ring');
}
