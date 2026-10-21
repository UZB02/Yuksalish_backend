import type { Ctx } from '../../core/context';
import type { ErrorDetail } from '../../core/errors';
import type { AttendanceStatusDoc } from '../../models/AttendanceStatus';
import { isoWeekday } from '../../utils/dates';
import { addDaysStr } from '../../utils/clock';
import type { AttendanceCategory, AttendanceSettings } from '../settings/attendance.settings';

type Actor = Ctx['actor'];

/** Istalgan yozuvni istalgan vaqtda o'zgartira oladimi (attendance.edit yoki superadmin) */
export const canEditAny = (a: Actor): boolean =>
  a.role === 'superadmin' || a.permissions.includes('attendance.edit');

export const withinEditWindow = (createdAt: Date, s: AttendanceSettings, now: Date): boolean =>
  now.getTime() - createdAt.getTime() <= s.editWindowHours * 3_600_000;

/** O'z yozuvi tahrir oynasida, yoki attendance.edit. Boshqa o'qituvchi yozuvi — faqat attendance.edit bilan. */
export const isEditable = (
  rec: { markedBy: unknown; createdAt: Date },
  actor: Actor,
  s: AttendanceSettings,
  now: Date,
): boolean =>
  canEditAny(actor) ||
  (String(rec.markedBy) === actor.id && withinEditWindow(rec.createdAt, s, now));

/** Sana: kelajakda emas, backdateDays dan eski emas va ish kuni */
export function checkDate(s: AttendanceSettings, date: string, today: string): ErrorDetail[] {
  if (date > today) return [{ path: 'date', message: "Kelajak sanasiga davomat olib bo'lmaydi" }];
  if (date < addDaysStr(today, -s.backdateDays)) {
    return [
      {
        path: 'date',
        message: `Davomat ko'pi bilan ${s.backdateDays} kun oldingi sana uchun olinadi`,
      },
    ];
  }
  if (!isWorkingDay(s, date)) {
    return [{ path: 'date', message: 'Dam olish kuni: davomat olinmaydi' }];
  }
  return [];
}

export const isWorkingDay = (
  s: Pick<AttendanceSettings, 'workingWeekdays'>,
  date: string,
): boolean => s.workingWeekdays.includes(isoWeekday(date));

/** Rejimga mos dars raqamini aniqlaydi (xato bo'lsa details bilan) */
export function resolveLessonNo(
  s: AttendanceSettings,
  lessonNo: number | undefined | null,
): { lessonNo: number; errors: ErrorDetail[] } {
  if (s.mode === 'daily') {
    if (lessonNo !== undefined && lessonNo !== null && lessonNo !== 0) {
      return {
        lessonNo: 0,
        errors: [{ path: 'lessonNo', message: 'Kunlik rejimda dars raqami berilmaydi' }],
      };
    }
    return { lessonNo: 0, errors: [] };
  }
  if (lessonNo === undefined || lessonNo === null || lessonNo < 1 || lessonNo > s.lessonsPerDay) {
    return {
      lessonNo: 0,
      errors: [
        { path: 'lessonNo', message: `Dars raqami 1 dan ${s.lessonsPerDay} gacha bo'lishi kerak` },
      ],
    };
  }
  return { lessonNo, errors: [] };
}

export interface RecordValues {
  statusId: string;
  minutesLate: number | null;
  note: string | null;
}

/**
 * Holat, kechikish daqiqasi va izoh qoidalari.
 * @param keepInactiveId tahrirda o'zgarmagan (keyin nofaol bo'lgan) holat ruxsat etiladi
 */
export function checkValues(
  s: AttendanceSettings,
  v: RecordValues,
  statuses: Map<string, AttendanceStatusDoc>,
  keepInactiveId: string | null = null,
): { errors: ErrorDetail[]; category: AttendanceCategory | null } {
  const errs: ErrorDetail[] = [];
  const st = statuses.get(v.statusId);
  if (!st) {
    errs.push({ path: 'statusId', message: 'Davomat holati topilmadi' });
    return { errors: errs, category: null };
  }
  if (!st.isActive && v.statusId !== keepInactiveId) {
    errs.push({ path: 'statusId', message: 'Davomat holati faol emas' });
  }
  if (v.minutesLate !== null) {
    if (st.category !== 'late') {
      errs.push({
        path: 'minutesLate',
        message: "Kechikish daqiqasi faqat 'late' kategoriyasida beriladi",
      });
    } else if (!Number.isInteger(v.minutesLate) || v.minutesLate < 1 || v.minutesLate > 600) {
      errs.push({
        path: 'minutesLate',
        message: "Kechikish daqiqasi 1 dan 600 gacha bo'lishi kerak",
      });
    }
  }
  if (s.noteRequiredCategories.includes(st.category) && !v.note) {
    errs.push({ path: 'note', message: 'Bu holat uchun izoh majburiy' });
  }
  return { errors: errs, category: st.category };
}
