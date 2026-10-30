import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../core/logger';
import { recalculateAll } from '../modules/ratings/ratings.service';
import { runTimetablePurge } from '../modules/timetable/timetable.purge';

/** Rejalashtirilgan vazifalar (JOBS_ENABLED=false bilan o'chiriladi) */
export function startJobs(): void {
  if (!env.JOBS_ENABLED) {
    logger.info("Rejalashtirilgan vazifalar o'chirilgan (JOBS_ENABLED=false)");
    return;
  }
  // Har kuni 02:00 (Asia/Tashkent): barcha faol maktablar reytingini qayta hisoblash
  cron.schedule(
    '0 2 * * *',
    () => {
      recalculateAll()
        .then(() => logger.info('Kechki reyting hisobi tugadi'))
        .catch((err) => logger.error({ err }, 'Kechki reyting hisobi xatosi'));
    },
    { timezone: 'Asia/Tashkent' },
  );
  // Har kuni 03:00: 30 kundan eski almashtirilgan versiyalar va qoralamalarni o'chirish
  cron.schedule(
    '0 3 * * *',
    () => {
      void runTimetablePurge();
    },
    { timezone: 'Asia/Tashkent' },
  );
  logger.info('Vazifalar ishga tushdi: reyting 02:00, jadval tozalash 03:00 (Asia/Tashkent)');
}
