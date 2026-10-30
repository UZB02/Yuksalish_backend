import crypto from 'crypto';
import sharp from 'sharp';
import { AppError } from '../../core/errors';
import { sniffImageType } from '../photos/photos.process';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MIN_LOGO_SIDE = 128;
const MAX_INPUT_PIXELS = 40_000_000;
const LOGO_MAX_SIDE = 512;
/** Hujjatlar (PDF/Excel) uchun kichik nusxa */
const DOC_MAX_SIDE = 160;

export const PLATFORM_VARIANTS = [
  'logo',
  'favicon',
  'icon192',
  'icon512',
  'maskable512',
  'apple180',
] as const;
export type PlatformVariant = (typeof PLATFORM_VARIANTS)[number];

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const bad = (message: string) => AppError.validation(message, [{ path: 'file', message }]);

export interface ProcessedLogo {
  hash: string;
  /** variant -> PNG */
  variants: Record<string, Buffer>;
}

/** Logoni `size` x `size` kvadratga joylaydi (ichki `inner` x `inner` ga sig'diriladi) */
async function square(logo: Buffer, size: number, inner: number, bg: typeof CLEAR | typeof WHITE) {
  const fitted = await sharp(logo)
    .resize(inner, inner, { fit: 'inside', background: CLEAR })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: fitted, gravity: 'centre' }])
    .png()
    .toBuffer();
}

/**
 * Logoni tekshiradi va barcha variantlarni yaratadi. Faqat PNG/JPEG/WebP (SVG yo'q: XSS);
 * fayl turi magic bytes va sharp metadata bo'yicha aniqlanadi. Barcha metadata o'chadi.
 * - logo: kesilgan (trim), eng uzun tomoni <= 512, shaffoflik saqlanadi
 * - favicon 32px, icon192/icon512: shaffof kvadrat (logo to'liq sig'adi)
 * - maskable512: OQ fon, logo markazdagi 80% xavfsiz zonada
 * - apple180: OQ fon (iOS shaffoflikni qora qiladi), logo 86% da
 * - doc: PDF/Excel sarlavhasi uchun kichik PNG
 */
export async function processLogo(buf: Buffer): Promise<ProcessedLogo> {
  if (buf.length > MAX_LOGO_BYTES) throw bad('Logo hajmi 2 MB dan oshmasligi kerak');
  if (!sniffImageType(buf)) throw bad('Faqat PNG, JPG yoki WebP logo yuklash mumkin');
  try {
    const src = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await src().metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '')) {
      throw bad('Faqat PNG, JPG yoki WebP logo yuklash mumkin');
    }
    if (Math.min(meta.width, meta.height) < MIN_LOGO_SIDE) {
      throw bad(`Logo kamida ${MIN_LOGO_SIDE}x${MIN_LOGO_SIDE} piksel bo'lishi kerak`);
    }

    const base = await src().rotate().ensureAlpha().png().toBuffer();
    let trimmed = base;
    try {
      trimmed = await sharp(base).trim({ threshold: 10 }).png().toBuffer();
    } catch {
      // bir xil rangli rasm: kesmasdan davom etamiz
    }
    const logo = await sharp(trimmed)
      .resize(LOGO_MAX_SIDE, LOGO_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const [favicon, icon192, icon512, maskable512, apple180, doc] = await Promise.all([
      square(logo, 32, 32, CLEAR),
      square(logo, 192, 192, CLEAR),
      square(logo, 512, 512, CLEAR),
      square(logo, 512, Math.round(512 * 0.8), WHITE),
      square(logo, 180, Math.round(180 * 0.86), WHITE),
      sharp(logo)
        .resize(DOC_MAX_SIDE, DOC_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer(),
    ]);
    return {
      hash: crypto.createHash('sha256').update(logo).digest('hex').slice(0, 16),
      variants: { logo, favicon, icon192, icon512, maskable512, apple180, doc },
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad("Logo buzilgan yoki o'qib bo'lmaydi");
  }
}
