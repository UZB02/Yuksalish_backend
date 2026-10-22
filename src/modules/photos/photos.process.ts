import crypto from 'crypto';
import sharp from 'sharp';
import { AppError } from '../../core/errors';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_SIDE = 512;
export const PHOTO_QUALITY = 80;
/** Dekodlashdan oldingi piksel chegarasi (dekompressiya bombasidan himoya) */
const MAX_INPUT_PIXELS = 40_000_000;

export const ALLOWED_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const bad = (message: string) => AppError.validation(message, [{ path: 'photo', message }]);

/** Fayl mazmuni (magic bytes) bo'yicha tur: mimetype ga ishonilmaydi */
export function sniffImageType(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}

export interface ProcessedPhoto {
  data: Buffer;
  width: number;
  height: number;
  size: number;
  hash: string;
  contentType: 'image/webp';
}

/**
 * Rasmni tekshiradi va qayta kodlaydi: EXIF bo'yicha burish, markazdan kvadratga kesish
 * (max 512x512), WebP q80. withMetadata() chaqirilmaydi — barcha metadata (EXIF/GPS/ICC) o'chadi.
 */
export async function processPhoto(buf: Buffer): Promise<ProcessedPhoto> {
  if (buf.length > MAX_PHOTO_BYTES) throw bad('Rasm hajmi 5 MB dan oshmasligi kerak');
  if (!sniffImageType(buf)) throw bad('Faqat JPG, PNG yoki WebP rasm yuklash mumkin');
  try {
    const src = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await src().metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    // Burish tomonlarni almashtiradi, lekin min(w, h) o'zgarmaydi
    const side = Math.min(PHOTO_MAX_SIDE, meta.width, meta.height);
    const { data, info } = await src()
      .rotate()
      .resize(side, side, { fit: 'cover', position: 'centre' })
      .webp({ quality: PHOTO_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      width: info.width,
      height: info.height,
      size: data.length,
      hash: crypto.createHash('sha256').update(data).digest('hex').slice(0, 32),
      contentType: 'image/webp',
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad("Rasm buzilgan yoki o'qib bo'lmaydi");
  }
}
