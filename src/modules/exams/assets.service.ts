import crypto from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import type { RequestHandler } from 'express';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ExamAsset } from '../../models/ExamAsset';
import { isDuplicateKeyError, isId } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { sniffImageType } from '../photos/photos.process';

export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const ASSET_MAX_SIDE = 1600;
export const ASSET_QUALITY = 80;
/** Dekodlashdan oldingi piksel chegarasi (dekompressiya bombasidan himoya) */
const MAX_INPUT_PIXELS = 40_000_000;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const bad = (message: string) => AppError.validation(message, [{ path: 'image', message }]);

export interface ProcessedAsset {
  data: Buffer;
  width: number;
  height: number;
  size: number;
  hash: string;
  contentType: 'image/webp';
}

/**
 * Savol rasmini tekshiradi va qayta kodlaydi: magic-bytes (mimetype ga ishonilmaydi), EXIF bo'yicha
 * burish, uzun tomoni 1600 px gacha kichraytirish (kattalashtirilmaydi), WebP q80. withMetadata()
 * chaqirilmaydi: barcha metadata (EXIF/GPS/ICC) o'chadi.
 */
export async function processExamImage(buf: Buffer): Promise<ProcessedAsset> {
  if (buf.length > MAX_ASSET_BYTES) throw bad('Rasm hajmi 5 MB dan oshmasligi kerak');
  if (!sniffImageType(buf)) throw bad('Faqat JPG, PNG yoki WebP rasm yuklash mumkin');
  try {
    const src = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await src().metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    const { data, info } = await src()
      .rotate()
      .resize(ASSET_MAX_SIDE, ASSET_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: ASSET_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      width: info.width,
      height: info.height,
      size: data.length,
      hash: crypto.createHash('sha256').update(data).digest('hex'),
      contentType: 'image/webp',
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad("Rasm buzilgan yoki o'qib bo'lmaydi");
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_BYTES, files: 1, fields: 2, parts: 4 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      return cb(bad('Faqat JPG, PNG yoki WebP rasm yuklash mumkin'));
    }
    cb(null, true);
  },
}).single('image');

/** multipart `image` maydonini req.file ga yuklaydi (xotirada, 5 MB gacha) */
export const uploadExamImage: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Rasm hajmi 5 MB dan oshmasligi kerak'
          : "Rasm yuklashda xatolik: so'rov noto'g'ri";
      return next(bad(msg));
    }
    next(err);
  });
};

const toDto = (a: {
  id: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}) => ({
  id: a.id,
  contentType: a.contentType,
  size: a.size,
  width: a.width,
  height: a.height,
});

export const assetsService = {
  /** Yuklash. Maktab ichida bir xil rasm (qayta kodlangan baytlar bo'yicha) qayta saqlanmaydi */
  async upload(
    ctx: Ctx,
    schoolId: string,
    buf: Buffer | undefined,
    opts: { audit?: boolean } = {},
  ) {
    if (!buf) throw bad('Rasm fayli yuborilmadi');
    const p = await processExamImage(buf);
    const existing = await ExamAsset.findOne({ schoolId, hash: p.hash }).select(
      'contentType size width height',
    );
    if (existing) return { asset: toDto(existing), created: false };

    let doc;
    try {
      doc = await ExamAsset.create({
        schoolId,
        hash: p.hash,
        contentType: p.contentType,
        size: p.size,
        width: p.width,
        height: p.height,
        data: p.data,
        createdBy: ctx.actor.id,
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      // Parallel bir xil yuklash: g'olibni qaytaramiz
      const won = await ExamAsset.findOne({ schoolId, hash: p.hash }).select(
        'contentType size width height',
      );
      if (!won) throw e;
      return { asset: toDto(won), created: false };
    }
    if (opts.audit !== false)
      await auditService.log({
        userId: ctx.actor.id,
        schoolId,
        action: 'exam.asset.upload',
        entity: 'exam_asset',
        entityId: doc.id,
        after: { hash: p.hash, size: p.size, width: p.width, height: p.height },
        ip: ctx.ip,
      });
    return { asset: toDto(doc), created: true };
  },

  /** Rasm baytlari (faqat o'z maktabi; boshqa maktab/yo'q rasm: 404) */
  async read(schoolId: string, id: string) {
    const doc = isId(id) ? await ExamAsset.findOne({ _id: id, schoolId }).select('+data') : null;
    if (!doc) throw AppError.notFound('Rasm topilmadi');
    return { data: doc.data, contentType: doc.contentType, hash: doc.hash };
  },
};
