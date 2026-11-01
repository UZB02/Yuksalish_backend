import { ATTENDANCE_KEY, type AttendanceSettings } from '../settings/attendance.settings';
import {
  NOTIFY_DEFAULTS,
  TELEGRAM_KEY,
  type TelegramNotifyToggles,
  type TelegramSettings,
} from '../settings/telegram.settings';
import { settingsService } from '../settings/settings.service';
import { addDaysStr } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';

/** Maktab uchun hal qilingan sozlama: workdays va weeklyReportDay avtomatik qiymatlar bilan to'ldirilgan */
export interface ResolvedTelegramSettings {
  workdays: number[];
  morningTime: string;
  dailyReportTime: string;
  weeklyReportDay: number;
  weeklyReportTime: string;
  notify: TelegramNotifyToggles;
  dailyReportAbsentNames: boolean;
}

export async function getTelegramSettings(schoolId: string): Promise<ResolvedTelegramSettings> {
  const [s, att] = await Promise.all([
    settingsService.getEffective<TelegramSettings>(TELEGRAM_KEY, schoolId),
    settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
  ]);
  const workdays = [...(s.workdays?.length ? s.workdays : att.workingWeekdays)].sort(
    (a, b) => a - b,
  );
  return {
    workdays,
    morningTime: s.morningTime,
    dailyReportTime: s.dailyReportTime,
    weeklyReportDay: s.weeklyReportDay ?? (workdays[workdays.length - 1] as number),
    weeklyReportTime: s.weeklyReportTime,
    notify: { ...NOTIFY_DEFAULTS, ...s.notify },
    dailyReportAbsentNames: s.dailyReportAbsentNames,
  };
}

/** Berilgan sanadan keyingi (o'zi kirmaydi) birinchi ish kuni */
export function nextWorkday(date: string, workdays: number[]): string {
  let d = addDaysStr(date, 1);
  for (let i = 0; i < 7 && !workdays.includes(isoWeekday(d)); i++) d = addDaysStr(d, 1);
  return d;
}
