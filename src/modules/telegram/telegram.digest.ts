import { logger } from '../../core/logger';
import { School } from '../../models/School';
import { User } from '../../models/User';
import { tashkentDate } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
import { hhmmTashkent } from './telegram.format';
import { telegramManager } from './telegram.manager';
import { telegramNotify, type EnqueueItem } from './telegram.outbox';
import { getTelegramSettings } from './telegram.schedule';
import { dayMessage, loadTeacherLines } from './telegram.teacher';

export interface DigestResult {
  schools: number;
  sent: number;
}

/**
 * Ertalabki "Bugungi darslarim": morningTime hozirgi Toshkent vaqtiga (HH:MM) teng, bugun ish kuni va
 * `notify.morningSchedule` yoqilgan maktablarning ulangan o'qituvchilariga. Darsi yo'q o'qituvchi o'tkazib yuboriladi.
 * dedupeKey `morning:<userId>:<sana>` — qayta ishga tushirish/takroriy tik xabarni ikki marta yubormaydi.
 * Cron har daqiqa chaqiradi; testlarda `now` beriladi.
 */
export async function runMorningDigests(now: Date = new Date()): Promise<DigestResult> {
  const result: DigestResult = { schools: 0, sent: 0 };
  if (!telegramManager.isRunning()) return result;
  const hhmm = hhmmTashkent(now);
  const date = tashkentDate(now);
  const weekday = isoWeekday(date);
  const schools = await School.find({ isActive: true }).select('_id').lean();
  for (const school of schools) {
    const schoolId = String(school._id);
    try {
      const s = await getTelegramSettings(schoolId);
      if (!s.notify.morningSchedule || s.morningTime !== hhmm || !s.workdays.includes(weekday)) {
        continue;
      }
      result.schools++;
      const teachers = await User.find({
        schoolId,
        role: 'teacher',
        isActive: true,
        'telegram.chatId': { $ne: null },
      })
        .select('_id')
        .lean();
      if (!teachers.length) continue;
      const lines = await loadTeacherLines(
        schoolId,
        teachers.map((t) => String(t._id)),
        date,
        date,
      );
      const items: EnqueueItem[] = [];
      for (const [userId, dayLines] of lines) {
        if (!dayLines.length) continue;
        items.push({
          userId,
          kind: 'morning',
          parseMode: 'HTML',
          dedupeKey: `morning:${userId}:${date}`,
          text: dayMessage('Bugun', date, dayLines, { greeting: true }),
        });
      }
      result.sent += await telegramNotify.enqueueMany(items);
    } catch (err) {
      logger.error({ err, schoolId }, 'Ertalabki jadval yuborishda xato');
    }
  }
  return result;
}
