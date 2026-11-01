import { isoWeekday } from '../../utils/dates';

/** Telegram HTML parse mode uchun: foydalanuvchi matnini xavfsiz qiladi */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];
const WEEKDAYS = ['dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba', 'yakshanba'];
const WEEKDAYS_SHORT = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

/** "2026-11-04" -> "4-noyabr" */
export function dayMonthUz(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d}-${MONTHS[(m as number) - 1]}`;
}

/** "2026-11-04" -> "seshanba" */
export const weekdayUz = (date: string): string => WEEKDAYS[isoWeekday(date) - 1] as string;

/** ISO hafta kuni (1..7) -> "Du" */
export const weekdayShortUz = (weekday: number): string => WEEKDAYS_SHORT[weekday - 1] as string;

/** "4-noyabr (seshanba)" */
export const dateLongUz = (date: string): string => `${dayMonthUz(date)} (${weekdayUz(date)})`;

/** Toshkent vaqti bo'yicha "HH:MM" */
export const hhmmTashkent = (d: Date): string =>
  new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(11, 16);
