import { logger } from '../../core/logger';
import { School } from '../../models/School';
import type { IRatingResult } from '../../models/RatingResult';
import { escapeHtml as esc } from './telegram.format';
import { telegramManager } from './telegram.manager';
import { telegramNotify, type EnqueueItem } from './telegram.outbox';
import { fmtPct, reportRecipients } from './telegram.report';
import { getTelegramSettings } from './telegram.schedule';

const TOP_STUDENTS = 10;
const TOP_CLASSES = 3;
const MEDALS = ['🥇', '🥈', '🥉'];

const TITLES: Record<string, string> = {
  week: 'Hafta yakuni',
  month: 'Oy yakuni',
  quarter: 'Chorak yakuni',
  academic_year: "O'quv yili yakuni",
  custom: 'Davr yakuni',
};

type ResultLike = Pick<IRatingResult, 'periodType' | 'label' | 'students' | 'classes'>;

/** Yakuniy natija xabari (HTML): top 10 o'quvchi va top 3 sinf */
export function buildRatingResultsMessage(schoolName: string, r: ResultLike): string {
  const lines = [
    `🏆 <b>${esc(TITLES[r.periodType] ?? TITLES.custom!)}</b> · ${esc(schoolName)}`,
    esc(r.label),
    '',
  ];
  const students = [...r.students].sort((a, b) => a.rank - b.rank).slice(0, TOP_STUDENTS);
  if (!students.length) lines.push('Bu davrda reytingga kirgan o‘quvchi yo‘q.');
  for (const s of students) {
    const mark = MEDALS[s.rank - 1] ?? `${s.rank}.`;
    lines.push(
      `${mark} ${esc(s.fullName)}${s.className ? ` · ${esc(s.className)}` : ''} — ${fmtPct(s.score)}`,
    );
  }
  const classes = [...r.classes].sort((a, b) => a.rank - b.rank).slice(0, TOP_CLASSES);
  if (classes.length) {
    lines.push(
      '',
      `🏫 Eng yaxshi sinflar: ${classes.map((c) => `${c.rank}) ${esc(c.name)} ${fmtPct(c.score)}`).join(' ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Yakuniy natijani maktab rahbariyatiga (faol, Telegram ulangan school_admin) va tanlagan
 * superadminlarga navbatga qo'yadi. `notify.ratingResults` o'chiq yoki bot ishlamasa — hech narsa.
 * dedupeKey: `ratingResults:<maktab>:<foydalanuvchi>:<davr kaliti>`.
 */
export async function notifyRatingResults(
  schoolId: string,
  result: ResultLike & { periodKey: string },
): Promise<number> {
  try {
    if (!telegramManager.isRunning() || !result.students.length) return 0;
    const s = await getTelegramSettings(schoolId);
    if (!s.notify.ratingResults) return 0;
    const school = await School.findById(schoolId).select('name').lean();
    if (!school) return 0;
    const userIds = await reportRecipients(schoolId);
    if (!userIds.length) return 0;
    const text = buildRatingResultsMessage(school.name, result);
    const items: EnqueueItem[] = userIds.map((userId) => ({
      userId,
      kind: 'ratingResults',
      parseMode: 'HTML',
      dedupeKey: `ratingResults:${schoolId}:${userId}:${result.periodKey}`,
      text,
    }));
    return await telegramNotify.enqueueMany(items);
  } catch (err) {
    logger.error({ err, schoolId }, 'Reyting yakuni Telegram xabarini navbatga qo‘yishda xato');
    return 0;
  }
}
