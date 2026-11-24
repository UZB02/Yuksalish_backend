import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../core/logger';
import { ExamFile } from '../../../models/ExamFile';
import { ExamSession } from '../../../models/ExamSession';
import { clock } from '../../../utils/clock';
import {
  NAME_RE,
  TMP_DIR_NAME,
  deleteFiles,
  expireFiles,
  filesConfig,
  removeBytes,
} from './filetest.storage';

/**
 * Test fayllari umr sikli (IMTIHON_REJA §23). Mavjud minutlik sweeper ichidan chaqiriladi (5 daqiqada bir marta).
 * Hammasi IDEMPOTENT va restartga chidamli (holat faqat DB va disk da; xotirada hech narsa yo'q).
 *
 *  1. Yopilgan imtihon: closedAt + 14 kun o'tgach baytlar o'chadi, yozuv 'expired' bo'lib qoladi (kalit, javoblar,
 *     ballar, natijalar ishlaydi). Qayta ochish closedAt ni bo'shatadi: qoida shu bilan qayta boshlanadi.
 *  2. O'chirilgan, bekor qilingan yoki hujjati yo'q imtihon: yozuv va baytlar darhol o'chadi.
 *  3. Bog'lanmagan (blok kalitiga hech qachon qo'yilmagan) yuklashlar 24 soatdan keyin; 1 soatdan ortiq 'pending'
 *     (yuklash yarim qolgan) yozuvlar.
 *  4. Diskda yozuvsiz fayllar va .tmp qoldiqlari: faqat 1 soatdan eski bo'lsa (yuklanayotgan fayl o'chmasligi uchun).
 * Qoralama, rejalashtirilgan yoki ochiq imtihonga bog'langan fayl HECH QACHON o'chirilmaydi (1-3 qoidalarda
 * faqat yuqoridagi sessiya holatlari). Fayl bitta imtihonga tegishli (umumiy fayl yo'q), shuning uchun havolalar
 * hisobi sessiya bo'yicha.
 *
 * Juda eski qoralamalar: avtomatik o'chirilmaydi (foydalanuvchi hali ishlayotgan bo'lishi mumkin); egasi qaror qiladi
 * (taklif: 90 kundan beri tegilmagan qoralama fayllarini bo'shatish) — docs/IMTIHON_REJA.md §23.
 */
export const FILE_RETENTION_DAYS = 14;
export const UNBOUND_HOURS = 24;
export const AGE_GUARD_MS = 60 * 60_000;
const DAY = 86_400_000;

export interface FileSweepResult {
  expired: number;
  deleted: number;
  diskOrphans: number;
}

export async function runFileSweeper(now: Date = clock.now()): Promise<FileSweepResult> {
  const out: FileSweepResult = { expired: 0, deleted: 0, diskOrphans: 0 };

  // 1-2. Imtihon holati bo'yicha
  const sids = await ExamFile.distinct('sessionId');
  if (sids.length) {
    const sessions = await ExamSession.find({ _id: { $in: sids } })
      .select('status closedAt isDeleted')
      .lean();
    const bySid = new Map(sessions.map((s) => [String(s._id), s]));
    for (const sid of sids) {
      const s = bySid.get(String(sid));
      if (!s || s.isDeleted || s.status === 'cancelled') {
        const docs = await ExamFile.find({ sessionId: sid }).select('storageName');
        out.deleted += await deleteFiles(docs);
      } else if (
        s.status === 'closed' &&
        s.closedAt &&
        now.getTime() - s.closedAt.getTime() > FILE_RETENTION_DAYS * DAY
      ) {
        const docs = await ExamFile.find({ sessionId: sid, state: { $in: ['ready', 'pending'] } }).select(
          'storageName',
        );
        out.expired += await expireFiles(docs, now);
      }
    }
  }

  // 3. Bog'lanmagan yuklashlar va yarim qolgan yuklashlar
  const stale = await ExamFile.find({
    $or: [
      { state: 'ready', bound: false, createdAt: { $lt: new Date(now.getTime() - UNBOUND_HOURS * 3_600_000) } },
      { state: 'pending', createdAt: { $lt: new Date(now.getTime() - AGE_GUARD_MS) } },
    ],
  }).select('storageName');
  out.deleted += await deleteFiles(stale);

  // 4. Diskdagi yozuvsiz fayllar (yosh chegarasi bilan)
  out.diskOrphans += await sweepDisk(now);
  return out;
}

async function sweepDisk(now: Date): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(filesConfig.dir);
  } catch {
    return 0; // papka hali yo'q (hech narsa yuklanmagan)
  }
  const old = (st: { mtimeMs: number }) => now.getTime() - st.mtimeMs > AGE_GUARD_MS;
  for (const name of entries) {
    if (name === TMP_DIR_NAME) {
      let tmp: string[] = [];
      try {
        tmp = await fs.readdir(path.join(filesConfig.dir, TMP_DIR_NAME));
      } catch {
        /* yo'q */
      }
      for (const t of tmp) {
        const p = path.join(filesConfig.dir, TMP_DIR_NAME, t);
        const st = await fs.stat(p).catch(() => null);
        if (st && st.isFile() && old(st)) {
          await fs.unlink(p).catch(() => undefined);
          removed++;
        }
      }
      continue;
    }
    if (!NAME_RE.test(name)) continue; // begona fayllarga tegilmaydi
    const st = await fs.stat(path.join(filesConfig.dir, name)).catch(() => null);
    if (!st || !st.isFile() || !old(st)) continue;
    if (await ExamFile.exists({ storageName: name })) continue;
    await removeBytes(name);
    removed++;
  }
  return removed;
}

let lastRun = 0;
/** Minutlik sweeper uchun: 5 daqiqada bir marta, xatolar sweeperni to'xtatmaydi */
export async function runFileSweeperThrottled(): Promise<void> {
  const t = Date.now();
  if (t - lastRun < 5 * 60_000) return;
  lastRun = t;
  try {
    const r = await runFileSweeper();
    if (r.expired || r.deleted || r.diskOrphans) logger.info(r, 'Test fayllari tozalandi');
  } catch (err) {
    logger.error({ err }, 'Test fayllarini tozalash xatosi');
  }
}
