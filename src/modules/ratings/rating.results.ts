import { logger } from '../../core/logger';
import { RatingResult, type IRatingResult } from '../../models/RatingResult';
import { School } from '../../models/School';
import { addDaysStr, clock, todayTashkent } from '../../utils/clock';
import { publicCache } from '../public/public.cache';
import type { RatingSettings } from '../settings/rating.settings';
import { settingsService } from '../settings/settings.service';
import { notifyRatingResults } from '../telegram/telegram.rating-results';
import { resolvePeriod, type RatingPeriod } from './rating.period';
import { computeLive, loadActiveYear } from './ratings.service';

type ResultsCfg = Pick<
  RatingSettings,
  'resultsWeekday' | 'resultsTime' | 'resultsMonthDay' | 'resultsDate'
>;

/**
 * E'lon sanasi.
 * - week: davr (Du–Ya) ichidagi tanlangan hafta kuni (resultsWeekday);
 * - month: oyning resultsMonthDay-kuni (0 = oxirgi kun; oyda bunday kun bo'lmasa oxirgi kun);
 * - quarter/academic_year/custom: resultsDate, agar u shu davr [from, to] ichida bo'lsa; aks holda
 *   (null yoki boshqa davrning eski sanasi) davrning oxirgi kuni.
 * Natija [period.from, period.to] oralig'iga qisiladi.
 */
export function announceDate(
  period: Pick<RatingPeriod, 'type' | 'from' | 'to'>,
  cfg: Pick<ResultsCfg, 'resultsWeekday' | 'resultsMonthDay' | 'resultsDate'>,
): string {
  let d: string;
  if (period.type === 'week') d = addDaysStr(period.from, cfg.resultsWeekday - 1);
  else if (period.type === 'month') {
    const last = Number(period.to.slice(8, 10));
    const day = cfg.resultsMonthDay > 0 ? Math.min(cfg.resultsMonthDay, last) : last;
    d = `${period.to.slice(0, 8)}${String(day).padStart(2, '0')}`;
  } else {
    const rd = cfg.resultsDate;
    d = rd && rd >= period.from && rd <= period.to ? rd : period.to;
  }
  if (d > period.to) d = period.to;
  if (d < period.from) d = period.from;
  return d;
}

/** E'lon lahzasi (Asia/Tashkent, UTC+5): sana va aniq vaqt */
export function announceMoment(
  period: Pick<RatingPeriod, 'type' | 'from' | 'to'>,
  cfg: ResultsCfg,
): { date: string; at: Date } {
  const date = announceDate(period, cfg);
  return { date, at: new Date(`${date}T${cfg.resultsTime}:00+05:00`) };
}

/**
 * Joriy davrdan oldingi davr (faqat week/month/quarter uchun; boshqalarda yoki aniqlab bo'lmasa null).
 * Server o'chiq turgan paytda o'tkazib yuborilgan e'lonni keyin to'ldirish uchun.
 */
export function previousPeriod(
  cur: RatingPeriod,
  year: Parameters<typeof resolvePeriod>[1],
): RatingPeriod | null {
  if (cur.type !== 'week' && cur.type !== 'month' && cur.type !== 'quarter') return null;
  const prev = resolvePeriod(
    { periodType: cur.type, customFrom: null, customTo: null },
    year,
    addDaysStr(cur.from, -1),
  );
  // Chorakda oldingi chorak bo'lmasa butun o'quv yiliga qaytib ketadi — bunday holat oldingi davr emas
  if (prev.key === cur.key || prev.to >= cur.from || prev.type !== cur.type) return null;
  return prev;
}

const NOTIFY_FRESH_MS = 24 * 3_600_000;

/**
 * Davr natijasini [period.from, to] oralig'ida mavjud jonli hisob bilan (formula bir xil) hisoblab
 * arxivlaydi. Bir maktab+davr uchun faqat bitta arxiv (unikal indeks); mavjud bo'lsa null.
 */
export async function createRatingResult(
  schoolId: string,
  period: RatingPeriod,
  to: string,
  opts: { manual?: boolean; announcedAt?: Date } = {},
): Promise<(IRatingResult & { _id: unknown }) | null> {
  if (await RatingResult.exists({ schoolId, periodKey: period.key })) return null;
  const [rating, live] = await Promise.all([
    settingsService.getEffectiveRating(schoolId),
    computeLive(schoolId, period.from, to),
  ]);
  const students = live.data.students
    .filter((r) => r.eligible && r.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .map((r) => {
      const c = live.classNames.get(r.classId);
      return {
        studentId: r.studentId,
        fullName: r.fullName,
        classId: r.classId,
        className: c?.name ?? null,
        grade: c?.grade ?? null,
        score: r.score,
        rank: r.rank as number,
        daysCount: r.daysCount,
        scoresCount: r.scoresCount,
      };
    });
  const classes = live.data.classes
    .filter((c) => c.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .map((c) => ({
      classId: c.classId,
      name: c.className,
      grade: c.grade,
      score: c.score,
      rank: c.rank as number,
      ratedStudents: c.ratedStudents,
    }));
  try {
    const doc = await RatingResult.create({
      schoolId,
      periodType: period.type,
      periodKey: period.key,
      from: period.from,
      to,
      periodTo: period.to,
      label: period.label,
      announcedAt: opts.announcedAt ?? clock.now(),
      manual: opts.manual ?? false,
      settings: {
        method: rating.method,
        weights: rating.weights,
        minScoresCount: rating.minScoresCount,
        tieBreak: rating.tieBreak,
      },
      studentsCount: students.length,
      classesCount: classes.length,
      students,
      classes,
    });
    publicCache.clear();
    return doc as unknown as IRatingResult & { _id: unknown };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null; // parallel e'lon: boshqasi yozib bo'ldi
    throw err;
  }
}

export interface AnnounceRunResult {
  schools: number;
  created: number;
}

/**
 * Minutlik vazifa: e'lon yoqilgan har bir faol maktab uchun joriy davr (va o'tkazib yuborilgan
 * bo'lsa oldingi davr) e'lon lahzasi o'tgan va arxivi yo'q bo'lsa — arxivlaydi. Idempotent.
 * Telegram faqat e'lon lahzasidan 24 soat ichida yuboriladi (yoqilgandan keyingi eski davr uchun jim).
 */
export async function runRatingResults(now: Date = clock.now()): Promise<AnnounceRunResult> {
  const out: AnnounceRunResult = { schools: 0, created: 0 };
  const schools = await School.find({ isActive: true }).select('_id').lean();
  for (const sch of schools) {
    const schoolId = String(sch._id);
    try {
      const rating = await settingsService.getEffectiveRating(schoolId);
      if (!rating.resultsEnabled) continue;
      out.schools++;
      const year = await loadActiveYear(schoolId);
      const today = todayTashkent();
      const cur = resolvePeriod(rating, year, today);
      const prev = previousPeriod(cur, year);
      // Eskisidan yangisiga: oldingi davr, keyin joriy
      for (const period of prev ? [prev, cur] : [cur]) {
        const m = announceMoment(period, rating);
        if (now < m.at) continue;
        const doc = await createRatingResult(schoolId, period, m.date, { announcedAt: now });
        if (!doc) continue;
        out.created++;
        logger.info(
          { schoolId, periodKey: period.key, from: period.from, to: m.date },
          'Reyting davri yakuniy natijasi e‘lon qilindi',
        );
        if (now.getTime() - m.at.getTime() < NOTIFY_FRESH_MS) {
          await notifyRatingResults(schoolId, doc);
        }
      }
    } catch (err) {
      logger.error({ err, schoolId }, 'Reyting yakuniy natijasini e‘lon qilishda xato');
    }
  }
  return out;
}
