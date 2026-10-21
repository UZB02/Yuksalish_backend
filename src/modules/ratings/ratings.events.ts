import { env } from '../../config/env';
import { settingsHooks } from '../../core/hooks';
import { logger } from '../../core/logger';
import { School } from '../../models/School';
import { publicCache } from '../public/public.cache';
import { ATTENDANCE_KEY, type AttendanceSettings } from '../settings/attendance.settings';
import { settingsService } from '../settings/settings.service';
import { Debouncer } from './debouncer';
import { ratingHooks, recalculateSchool, recalculateSchools } from './ratings.service';

const SCHOOLS_KEY = '*schools';

const debouncer = new Debouncer(
  env.RATING_DEBOUNCE_MS,
  (key) => (key === SCHOOLS_KEY ? recalculateSchools() : recalculateSchool(key)),
  undefined,
  (key, err) => logger.error({ err, key }, 'Reytingni qayta hisoblashda xato'),
);

// Maktab qayta hisoblangach umumiy (maktablar) reyting ham yangilanadi
ratingHooks.afterSchoolRecalc = () => debouncer.schedule(SCHOOLS_KEY);

export const ratingEvents = {
  /**
   * Baho/o'quvchi o'zgarganda chaqiriladi. refreshMode='realtime' bo'lsa maktab bo'yicha
   * debounce (~5 s) bilan qayta hisoblanadi, 'nightly' bo'lsa faqat jadval bo'yicha.
   */
  async dataChanged(schoolId: string): Promise<void> {
    try {
      const r = await settingsService.getEffectiveRating(schoolId);
      if (r.refreshMode === 'realtime') debouncer.schedule(schoolId);
    } catch (err) {
      logger.error({ err }, 'Reyting hodisasi xatosi');
    }
  },

  /**
   * Davomat o'zgarganda: faqat ratingImpact.enabled bo'lsa (samaradorlik) va refreshMode=realtime bo'lsa
   * qayta hisoblash rejalashtiriladi.
   */
  async attendanceChanged(schoolId: string): Promise<void> {
    try {
      const [att, rating] = await Promise.all([
        settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
        settingsService.getEffectiveRating(schoolId),
      ]);
      if (att.ratingImpact.enabled && rating.refreshMode === 'realtime')
        debouncer.schedule(schoolId);
    } catch (err) {
      logger.error({ err }, 'Davomat hodisasi xatosi');
    }
  },

  schedule(schoolId: string) {
    debouncer.schedule(schoolId);
  },

  get pending(): string[] {
    return debouncer.pendingKeys;
  },

  /** Kutayotgan hisoblarni darhol bajaradi (testlar / to'xtatish) */
  async flushAll(): Promise<void> {
    for (let i = 0; i < 5 && debouncer.pendingKeys.length; i++) await debouncer.flush();
  },
};

// Sozlama o'zgarganda: public kesh tozalanadi, reyting (davr/usul/ball qoidalari) qayta hisoblanadi
settingsHooks.on(async (e) => {
  publicCache.clear();
  if (e.key === 'attendance') {
    // Faqat jarima yoki ish kunlari o'zgarganda qayta hisoblanadi
    if (!e.changed?.some((k) => k === 'ratingImpact' || k === 'workingWeekdays')) return;
  } else if (e.key !== 'rating' && e.key !== 'scoring') return;
  if (e.scope === 'school' && e.schoolId) {
    debouncer.schedule(e.schoolId);
  } else {
    const schools = await School.find({ isActive: true }).select('_id').lean();
    for (const s of schools) debouncer.schedule(String(s._id));
    debouncer.schedule(SCHOOLS_KEY);
  }
});
