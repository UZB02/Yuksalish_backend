import crypto from 'crypto';
import { constants, createReadStream } from 'fs';
import fs from 'fs/promises';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import sharp from 'sharp';
import type { RequestHandler, Response } from 'express';
import { env } from '../../../config/env';
import { AppError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import { ExamFile, type ExamFileDoc, type FileKind } from '../../../models/ExamFile';
import { sniffImageType } from '../../photos/photos.process';

/**
 * Test fayllari saqlash (IMTIHON_REJA §23): baytlar DISKDA (EXAM_FILES_DIR), MongoDB'da emas.
 *  - Diskdagi nom FAQAT serverda yaratiladi (32 hex), foydalanuvchi kiritgan hech narsa yo'lga tushmaydi.
 *  - Yozish atomik: avval `.tmp/` ga, keyin `rename` (bir fayl tizimi ichida atomik).
 *  - Yuklash diskka oqim bilan (multer diskStorage), katta bufer ushlanmaydi; har xato yo'lida vaqtinchalik fayl o'chadi.
 *  - O'quvchiga fayl diskdan OQIM bilan beriladi (xotira keshi yo'q): bir vaqtda ko'p so'rov RAM ni oshirmaydi.
 *  - Chegaralar: bitta fayl, papka jami, diskdagi bo'sh joy. Papka yozish uchun ochiq bo'lmasa aniq xabar bilan 503
 *    (ma'lumot jimgina yo'qolmaydi).
 */
const MB = 1024 * 1024;

export const filesConfig = {
  dir: resolveDir(),
  /** Bitta fayl */
  maxFileBytes: 10 * MB,
  /** Papka jami (pending + ready yozuvlar yig'indisi) */
  maxTotalBytes: env.EXAM_FILES_MAX_TOTAL_MB * MB,
  /** Diskda shuncha bo'sh joy qolmasa yuklash rad etiladi (0 = tekshirilmaydi) */
  minFreeBytes: env.EXAM_FILES_MIN_FREE_MB * MB,
  /** Rasm kirish pikseli chegarasi (dekompressiya bombasi va RAM) */
  maxInputPixels: 25_000_000,
  /** Rasm uzun tomoni (formulalar o'qilishi uchun) */
  imageMaxSide: 2200,
  imageQuality: 85,
};
export const TMP_DIR_NAME = '.tmp';

function resolveDir(): string {
  if (env.EXAM_FILES_DIR) return path.resolve(env.EXAM_FILES_DIR);
  if (env.isTest) return path.join(os.tmpdir(), `yuksalish-exam-files-test-${process.pid}`);
  return path.resolve(process.cwd(), 'data', 'exam-files');
}

const bad = (message: string) => AppError.validation(message, [{ path: 'file', message }]);
const NAME_RE = /^[0-9a-f]{32}$/;
export const newStorageName = () => crypto.randomBytes(16).toString('hex');

/** Diskdagi yo'l: faqat 32-hex nom qabul qilinadi (yo'l ajratuvchi/`..` mumkin emas) */
export function filePath(name: string): string {
  if (!NAME_RE.test(name)) throw new Error('Noto‘g‘ri fayl nomi');
  const p = path.join(filesConfig.dir, name);
  if (path.dirname(p) !== filesConfig.dir) throw new Error('Noto‘g‘ri fayl yo‘li');
  return p;
}
export const tmpDir = () => path.join(filesConfig.dir, TMP_DIR_NAME);
const tmpName = (prefix: string) => path.join(tmpDir(), `${prefix}-${newStorageName()}`);

const NOT_WRITABLE =
  'Test fayllari papkasi yozish uchun ochiq emas. Administrator EXAM_FILES_DIR papkasi (docker: exam-files volume) ruxsatlarini tekshirsin';

/** Papka mavjud va yozuvchi bo'lishini ta'minlaydi; aks holda aniq xabar bilan 503 */
export async function ensureFilesDir(): Promise<void> {
  try {
    await fs.mkdir(tmpDir(), { recursive: true });
    await fs.access(filesConfig.dir, constants.W_OK);
  } catch (err) {
    logger.error({ err, dir: filesConfig.dir }, NOT_WRITABLE);
    throw AppError.unavailable(NOT_WRITABLE);
  }
}

async function unlinkQuiet(p: string) {
  await fs.unlink(p).catch(() => undefined);
}

export async function freeBytes(): Promise<number> {
  const s = await fs.statfs(filesConfig.dir);
  return Number(s.bavail) * Number(s.bsize);
}

// ---------- Kvota (bir vaqtda yuklashlarga chidamli) ----------
let lock: Promise<unknown> = Promise.resolve();
/** Kvota tekshiruvi va yozuv yaratish ketma-ket bajariladi: ikki parallel yuklash ikkalasi ham "joy bor" demaydi */
function withQuotaLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

async function usedBytes(): Promise<number> {
  const r = await ExamFile.aggregate<{ total: number }>([
    { $match: { state: { $in: ['pending', 'ready'] } } },
    { $group: { _id: null, total: { $sum: '$size' } } },
  ]);
  return r[0]?.total ?? 0;
}

// ---------- Yuklash (diskka oqim) ----------
/** multipart `file` maydoni vaqtinchalik papkaga oqim bilan yoziladi (req.file.path); fayl hajmi chegarasi */
export const uploadTestFile: RequestHandler = (req, res, next) => {
  ensureFilesDir().then(
    () => {
      const up = multer({
        storage: multer.diskStorage({
          destination: (_r, _f, cb) => cb(null, tmpDir()),
          filename: (_r, _f, cb) => cb(null, `up-${newStorageName()}`),
        }),
        limits: { fileSize: filesConfig.maxFileBytes, files: 1, fields: 2, parts: 4 },
      }).single('file');
      up(req, res, (err: unknown) => {
        const f = (req as { file?: { path: string } }).file;
        // So'rov tugagach (muvaffaqiyat ham, xato ham) vaqtinchalik fayl qolmasin
        if (f) res.once('close', () => void unlinkQuiet(f.path));
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          return next(
            bad(
              err.code === 'LIMIT_FILE_SIZE'
                ? `Fayl hajmi ${Math.round(filesConfig.maxFileBytes / MB)} MB dan oshmasligi kerak`
                : "Fayl yuklashda xatolik: so'rov noto'g'ri",
            ),
          );
        }
        next(err);
      });
    },
    (e) => next(e),
  );
};

export interface InspectedFile {
  kind: FileKind;
  contentType: string;
  /** Saqlanadigan fayl (vaqtinchalik papkada): PDF uchun yuklangan fayl, rasm uchun qayta kodlangani */
  path: string;
  size: number;
  hash: string;
  width: number;
  height: number;
  pages: number;
}

const PDF_RISKY = /\/(?:JavaScript|JS|Launch)(?![A-Za-z])/;
const PDF_ENCRYPT = /\/Encrypt(?![A-Za-z])/;
const PDF_PAGE = /\/Type\s*\/Page(?![a-zA-Z])/g;

/** PDF ni oqim bilan tekshiradi (xotirada butun fayl yo'q): sarlavha, parol, skript, %%EOF; hash va sahifalar */
async function inspectPdf(p: string) {
  const hash = crypto.createHash('sha256');
  let carry = '';
  let read = 0;
  let pages = 0;
  let lastEnd = -1;
  let tail = '';
  for await (const chunk of createReadStream(p, { highWaterMark: 256 * 1024 })) {
    const buf = chunk as Buffer;
    hash.update(buf);
    const text = buf.toString('latin1');
    if (read === 0 && !text.slice(0, 1024).includes('%PDF-')) throw bad('PDF fayl buzilgan');
    const combined = carry + text;
    const base = read - carry.length;
    if (PDF_ENCRYPT.test(combined)) throw bad('Parol bilan himoyalangan PDF qabul qilinmaydi');
    if (PDF_RISKY.test(combined))
      throw bad('PDF ichida skript bor: faqat oddiy PDF qabul qilinadi');
    for (const m of combined.matchAll(PDF_PAGE)) {
      const end = base + m.index! + m[0].length;
      if (end > lastEnd) {
        pages++;
        lastEnd = end;
      }
    }
    read += buf.length;
    carry = combined.slice(-64);
    tail = (tail + text).slice(-2048);
  }
  if (!tail.includes('%%EOF')) throw bad('PDF fayl to‘liq emas yoki buzilgan');
  return { hash: hash.digest('hex'), pages };
}

async function hashFile(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}

// Rasm qayta kodlash: bir vaqtda ko'pi bilan 2 ta (har biri o'nlab MB RAM olishi mumkin)
const MAX_IMAGE_JOBS = 2;
let imageJobs = 0;
const imageWaiters: (() => void)[] = [];
async function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (imageJobs >= MAX_IMAGE_JOBS) await new Promise<void>((r) => imageWaiters.push(r));
  imageJobs++;
  try {
    return await fn();
  } finally {
    imageJobs--;
    imageWaiters.shift()?.();
  }
}

/**
 * Yuklangan vaqtinchalik faylni tekshiradi (mimetype/kengaytmaga ishonilmaydi: magic-bytes).
 * Rasm: EXIF bo'yicha burib, kichraytirib, WebP ga qayta kodlanadi (barcha metadata o'chadi); diskdan diskka.
 */
export async function inspectUpload(uploadPath: string): Promise<InspectedFile> {
  const st = await fs.stat(uploadPath);
  if (!st.size) throw bad('Fayl bo‘sh');
  if (st.size > filesConfig.maxFileBytes) {
    throw bad(`Fayl hajmi ${Math.round(filesConfig.maxFileBytes / MB)} MB dan oshmasligi kerak`);
  }
  const fh = await fs.open(uploadPath, 'r');
  const head = Buffer.alloc(16);
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }
  if (await hasPdfHeader(uploadPath)) {
    const { hash, pages } = await inspectPdf(uploadPath);
    return {
      kind: 'pdf',
      contentType: 'application/pdf',
      path: uploadPath,
      size: st.size,
      hash,
      width: 0,
      height: 0,
      pages,
    };
  }
  if (!sniffImageType(head)) throw bad('Faqat PDF, JPG yoki PNG fayl yuklash mumkin');
  const out = tmpName('img');
  try {
    const info = await withImageSlot(async () => {
      const src = () =>
        sharp(uploadPath, {
          limitInputPixels: filesConfig.maxInputPixels,
          failOn: 'error',
          sequentialRead: true,
        });
      const meta = await src().metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
      return src()
        .rotate()
        .resize(filesConfig.imageMaxSide, filesConfig.imageMaxSide, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: filesConfig.imageQuality })
        .toFile(out);
    });
    return {
      kind: 'image',
      contentType: 'image/webp',
      path: out,
      size: info.size,
      hash: await hashFile(out),
      width: info.width,
      height: info.height,
      pages: 1,
    };
  } catch (e) {
    await unlinkQuiet(out);
    if (e instanceof AppError) throw e;
    throw bad("Rasm buzilgan yoki o'qib bo'lmaydi");
  }
}

/** PDF sarlavhasi birinchi 1024 baytning istalgan joyida bo'lishi mumkin (standart) */
async function hasPdfHeader(p: string): Promise<boolean> {
  const fh = await fs.open(p, 'r');
  try {
    const b = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(b, 0, 1024, 0);
    return b.subarray(0, bytesRead).toString('latin1').includes('%PDF-');
  } finally {
    await fh.close();
  }
}

export interface FileMeta {
  schoolId: string;
  sessionId: string;
  blockId: string;
  createdBy: string | null;
}

/**
 * Tekshirilgan faylni saqlaydi. Kvota va bo'sh joy tekshiruvi qulf ichida, yozuv ('pending', hajm bilan) ham shu
 * qulfda yaratiladi: parallel yuklashlar bir-birining joyini "ko'rmasdan" ikkalasi o'tib ketmaydi. Keyin atomik rename.
 * Xatoda yozuv va vaqtinchalik fayl tozalanadi.
 */
export async function commitFile(f: InspectedFile, meta: FileMeta): Promise<ExamFileDoc> {
  const name = newStorageName();
  let doc: ExamFileDoc;
  try {
    doc = await withQuotaLock(async () => {
      if (filesConfig.minFreeBytes > 0) {
        const free = await freeBytes();
        if (free < filesConfig.minFreeBytes + f.size) {
          throw AppError.unavailable(
            `Serverda bo‘sh joy yetarli emas (kamida ${Math.round(filesConfig.minFreeBytes / MB / 1024)} GB qolishi kerak): fayl yuklab bo‘lmaydi`,
          );
        }
      }
      const used = await usedBytes();
      if (used + f.size > filesConfig.maxTotalBytes) {
        throw AppError.conflict(
          `Test fayllari xotirasi to‘lgan (jami ${Math.round(filesConfig.maxTotalBytes / MB / 1024)} GB). Eski imtihonlar fayllari 14 kundan keyin o‘chadi`,
        );
      }
      return ExamFile.create({
        schoolId: meta.schoolId,
        sessionId: meta.sessionId,
        blockId: meta.blockId,
        storageName: name,
        hash: f.hash,
        kind: f.kind,
        contentType: f.contentType,
        size: f.size,
        width: f.width,
        height: f.height,
        pages: f.pages,
        state: 'pending',
        createdBy: meta.createdBy,
      });
    });
  } catch (e) {
    await unlinkQuiet(f.path);
    throw e;
  }
  try {
    await fs.rename(f.path, filePath(name));
  } catch (err) {
    logger.error({ err }, 'Test faylini saqlab bo‘lmadi');
    await unlinkQuiet(f.path);
    await ExamFile.deleteOne({ _id: doc._id });
    throw AppError.unavailable(NOT_WRITABLE);
  }
  doc.state = 'ready';
  await ExamFile.updateOne({ _id: doc._id }, { $set: { state: 'ready' } });
  return doc;
}

/**
 * Muddati o'tgan faylni (yozuv saqlanadi) qayta yuklash: yozuv id si o'zgarmaydi, shuning uchun kalit va
 * variantlar tegilmaydi. Kvota hozirgi (expired) yozuv hisobga olinmagani uchun yangidan tekshiriladi.
 */
export async function recommitFile(doc: ExamFileDoc, f: InspectedFile): Promise<void> {
  const name = newStorageName();
  try {
    await withQuotaLock(async () => {
      if (filesConfig.minFreeBytes > 0 && (await freeBytes()) < filesConfig.minFreeBytes + f.size) {
        throw AppError.unavailable(
          `Serverda bo‘sh joy yetarli emas (kamida ${Math.round(filesConfig.minFreeBytes / MB / 1024)} GB qolishi kerak): fayl yuklab bo‘lmaydi`,
        );
      }
      if ((await usedBytes()) + f.size > filesConfig.maxTotalBytes) {
        throw AppError.conflict('Test fayllari xotirasi to‘lgan');
      }
      await ExamFile.updateOne(
        { _id: doc._id },
        {
          $set: {
            storageName: name,
            hash: f.hash,
            kind: f.kind,
            contentType: f.contentType,
            size: f.size,
            width: f.width,
            height: f.height,
            pages: f.pages,
            state: 'pending',
            expiredAt: null,
          },
        },
      );
    });
  } catch (e) {
    await unlinkQuiet(f.path);
    throw e;
  }
  try {
    await fs.rename(f.path, filePath(name));
  } catch (err) {
    logger.error({ err }, 'Test faylini saqlab bo‘lmadi');
    await unlinkQuiet(f.path);
    await ExamFile.updateOne(
      { _id: doc._id },
      { $set: { state: 'expired', expiredAt: new Date() } },
    );
    throw AppError.unavailable(NOT_WRITABLE);
  }
  await ExamFile.updateOne({ _id: doc._id }, { $set: { state: 'ready' } });
}

// ---------- Berish (diskdan oqim) ----------
export type ServeResult = 'ok' | 'not-modified' | 'missing';

/**
 * Faylni diskdan javobga OQIM bilan beradi. ETag/304 saqlanadi; mijoz uzilsa oqim yopiladi va fayl deskriptori
 * qaytariladi (pipeline). Disk faylida yo'q bo'lsa 'missing' (chaqiruvchi "muddati tugagan" deb javob beradi).
 */
export async function serveFile(
  doc: Pick<ExamFileDoc, 'storageName' | 'contentType' | 'hash'>,
  ifNoneMatch: string | undefined,
  res: Response,
): Promise<ServeResult> {
  let fh;
  try {
    fh = await fs.open(filePath(doc.storageName), 'r');
  } catch {
    return 'missing';
  }
  try {
    const st = await fh.stat();
    const etag = `"${doc.hash}"`;
    res.set({
      'Content-Type': doc.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=3600',
      Vary: 'Authorization',
      ETag: etag,
    });
    if (ifNoneMatch === etag) {
      res.status(304).end();
      return 'not-modified';
    }
    res.set('Content-Length', String(st.size));
    res.status(200);
    try {
      await pipeline(fh.createReadStream({ autoClose: false }), res);
    } catch {
      /* mijoz uzildi: oqim va deskriptor quyida yopiladi */
    }
    return 'ok';
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ---------- O'chirish ----------
/** Baytlarni diskdan o'chiradi (yo'q bo'lsa xato emas) */
export async function removeBytes(storageName: string): Promise<void> {
  if (!NAME_RE.test(storageName)) return;
  await unlinkQuiet(filePath(storageName));
}

/** Yozuv va baytlarni butunlay o'chiradi */
export async function deleteFiles(
  docs: Pick<ExamFileDoc, '_id' | 'storageName'>[],
): Promise<number> {
  if (!docs.length) return 0;
  for (const d of docs) await removeBytes(d.storageName);
  const r = await ExamFile.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  return r.deletedCount ?? 0;
}

/** Baytlar o'chadi, yozuv 'expired' bo'lib qoladi (kalit va natijalar ishlayveradi) */
export async function expireFiles(docs: Pick<ExamFileDoc, '_id' | 'storageName'>[], now: Date) {
  if (!docs.length) return 0;
  for (const d of docs) await removeBytes(d.storageName);
  const r = await ExamFile.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $set: { state: 'expired', expiredAt: now } },
  );
  return r.modifiedCount ?? 0;
}

export { NAME_RE };
