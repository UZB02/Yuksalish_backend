import crypto from 'crypto';
import { env } from '../../../config/env';
import { AppError } from '../../../core/errors';
import { PIN_ALPHABET } from './pin';

/**
 * Shaxsiy kirish kodi (har ishtirokchiga BITTA): imtihonga faqat shu kod bilan kiriladi.
 *  - 9 belgi, bir xil o'qiladigan 31 belgili alifbo (0/O, 1/I/L yo'q): 31^9 ~ 2,6e13 ~ 44,6 bit;
 *    ko'rinishi XXX-XXX-XXX. Taxmin qilish: kirish himoyasi (qurilma + IP + umumiy) bilan birga amaliy emas;
 *  - saqlash: HECH QACHON ochiq emas. Qidirish uchun `codeHash` = HMAC-SHA256(kalit, normallashgan kod)
 *    (kalit EXAM_PIN_SECRET dan HKDF, info alohida: PIN kalitidan farqli), chop etish uchun AES-256-GCM nusxa
 *    (AAD = sessiya id), tasdiqlash tokeni (stateless) ham shu kalitdan HMAC;
 *  - EXAM_PIN_SECRET yo'q bo'lsa 503.
 */
export const ENTRY_CODE_LENGTH = 9;
export const ENTRY_CODE_GROUP = 3;
const IV_LEN = 12;
const TAG_LEN = 16;

function derive(info: string): Buffer {
  if (!env.EXAM_PIN_SECRET) {
    throw AppError.unavailable('EXAM_PIN_SECRET sozlanmagan: kirish kodi yaratib bo‘lmaydi');
  }
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      env.EXAM_PIN_SECRET,
      Buffer.from('yuksalish/exam-entry/v1/salt'),
      Buffer.from(info),
      32,
    ),
  );
}

export function randomEntryCode(): string {
  let s = '';
  for (let i = 0; i < ENTRY_CODE_LENGTH; i++)
    s += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)];
  return s;
}

/** Kirill harflari lotinga o'xshash bo'lganlari: А В Е К М Н О Р С Т Х У (kichik harflar ham) */
const CYRILLIC: Record<string, string> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  У: 'Y',
};

/**
 * Kiritilgan kodni normallashtiradi: kattalashtiradi, kirillcha o'xshash harflarni lotinga o'tkazadi,
 * bo'shliq/chiziqcha/nuqta va boshqa belgilarni olib tashlaydi. Bo'sh/yaroqsiz bo'lsa ham xato tashlamaydi.
 */
export function normalizeEntryCode(input: string): string {
  const up = input.toUpperCase();
  let out = '';
  for (const ch of up) out += CYRILLIC[ch] ?? ch;
  return out.replace(/[^A-Z0-9]/g, '');
}

/** Normallashgan kod alifbo va uzunlik jihatidan yaroqlimi (bazaga murojaat qilishdan oldin tekshiriladi) */
export const isWellFormedEntryCode = (n: string): boolean =>
  n.length === ENTRY_CODE_LENGTH && [...n].every((c) => PIN_ALPHABET.includes(c));

export const formatEntryCode = (n: string): string =>
  n.match(new RegExp(`.{1,${ENTRY_CODE_GROUP}}`, 'g'))?.join('-') ?? n;

export const hashEntryCode = (input: string): string =>
  crypto
    .createHmac('sha256', derive('yuksalish/exam-entry/v1/lookup'))
    .update(normalizeEntryCode(input))
    .digest('hex');

export function encryptEntryCode(code: string, sessionId: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', derive('yuksalish/exam-entry/v1/enc'), iv);
  c.setAAD(Buffer.from(sessionId));
  const ct = Buffer.concat([c.update(normalizeEntryCode(code), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Dekodlab bo'lmasa (kalit almashgan/buzilgan) null */
export function decryptEntryCode(enc: string, sessionId: string): string | null {
  try {
    const buf = Buffer.from(enc, 'base64');
    if (buf.length <= IV_LEN + TAG_LEN) return null;
    const d = crypto.createDecipheriv(
      'aes-256-gcm',
      derive('yuksalish/exam-entry/v1/enc'),
      buf.subarray(0, IV_LEN),
    );
    d.setAAD(Buffer.from(sessionId));
    d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
    return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------- "Bu sizmisiz?" tasdiqlash tokeni (stateless, qisqa muddatli) ----------
export const CONFIRM_TTL_MS = 5 * 60_000;
interface ConfirmPayload {
  s: string; // sessionId
  k: string; // participantKey
  d: string; // deviceId
  e: number; // tugash (ms)
}
const sign = (data: string) =>
  crypto
    .createHmac('sha256', derive('yuksalish/exam-entry/v1/confirm'))
    .update(data)
    .digest('base64url');

export function signConfirm(
  p: { sessionId: string; participantKey: string; deviceId: string },
  now: Date,
): string {
  const body: ConfirmPayload = {
    s: p.sessionId,
    k: p.participantKey,
    d: p.deviceId,
    e: now.getTime() + CONFIRM_TTL_MS,
  };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${data}.${sign(data)}`;
}

/** Yaroqli bo'lsa ma'lumot, aks holda null (imzo/muddat/qurilma mos kelmasa) */
export function verifyConfirm(
  token: string,
  deviceId: string,
  now: Date,
): { sessionId: string; participantKey: string } | null {
  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = sign(data);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as ConfirmPayload;
    if (typeof p.e !== 'number' || p.e < now.getTime() || p.d !== deviceId) return null;
    return { sessionId: p.s, participantKey: p.k };
  } catch {
    return null;
  }
}
