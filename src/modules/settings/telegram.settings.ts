import { z } from 'zod';
import { AppError } from '../../core/errors';

export const TELEGRAM_KEY = 'telegram';

export interface TelegramNotifyToggles {
  morningSchedule: boolean;
  substitutions: boolean;
  timetableChanges: boolean;
  dailyReport: boolean;
  weeklyReport: boolean;
  ratingResults: boolean;
}

/** Maktabning Telegram bot sozlamalari (saqlangan ko'rinish; null = avtomatik) */
export interface TelegramSettings {
  /** ISO hafta kunlari (1 = dushanba). null = maktabning ish haftasi (davomat sozlamasi workingWeekdays) */
  workdays: number[] | null;
  /** "HH:MM" (Asia/Tashkent) */
  morningTime: string;
  dailyReportTime: string;
  /** Haftalik hisobot kuni (ISO). null = oxirgi ish kuni */
  weeklyReportDay: number | null;
  weeklyReportTime: string;
  /** To'liq obyekt sifatida almashtiriladi (normalize standartlar bilan to'ldiradi) */
  notify: TelegramNotifyToggles;
  /** Kunlik hisobotda kelmaganlar ism-familiyasi */
  dailyReportAbsentNames: boolean;
}

export const NOTIFY_DEFAULTS: TelegramNotifyToggles = {
  morningSchedule: true,
  substitutions: true,
  timetableChanges: true,
  dailyReport: true,
  weeklyReport: true,
  ratingResults: true,
};

export const TELEGRAM_DEFAULTS: TelegramSettings = {
  workdays: null,
  morningTime: '07:30',
  dailyReportTime: '16:00',
  weeklyReportDay: null,
  weeklyReportTime: '17:00',
  notify: NOTIFY_DEFAULTS,
  dailyReportAbsentNames: true,
};

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Vaqt HH:MM ko‘rinishida bo‘lishi kerak');
const weekday = z.number().int().min(1).max(7);

export const telegramValuesSchema = z.object({
  workdays: z
    .array(weekday)
    .min(1, "Kamida bitta ish kuni bo'lishi kerak")
    .max(7)
    .refine((a) => new Set(a).size === a.length, {
      message: 'Hafta kunlari takrorlanmasligi kerak',
    })
    .nullable()
    .optional(),
  morningTime: hhmm.optional(),
  dailyReportTime: hhmm.optional(),
  weeklyReportDay: weekday.nullable().optional(),
  weeklyReportTime: hhmm.optional(),
  notify: z
    .object({
      morningSchedule: z.boolean().optional(),
      substitutions: z.boolean().optional(),
      timetableChanges: z.boolean().optional(),
      dailyReport: z.boolean().optional(),
      weeklyReport: z.boolean().optional(),
      ratingResults: z.boolean().optional(),
    })
    .optional(),
  dailyReportAbsentNames: z.boolean().optional(),
});

/** Hafta kunlari tartiblanadi; notify standart qiymatlar bilan to'ldirilib to'liq obyekt bo'ladi */
export function normalizeTelegram(values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  if (Array.isArray(out.workdays)) {
    out.workdays = [...(out.workdays as number[])].sort((a, b) => a - b);
  }
  if (out.notify && typeof out.notify === 'object') {
    out.notify = { ...NOTIFY_DEFAULTS, ...(out.notify as object) };
  }
  return out;
}

/** Haftalik hisobot kuni ish kunlari ichida bo'lishi kerak (ikkalasi ham aniq berilgan bo'lsa) */
export function validateTelegram(merged: Record<string, unknown>): void {
  const days = merged.workdays as number[] | null | undefined;
  const wd = merged.weeklyReportDay as number | null | undefined;
  if (days && wd && !days.includes(wd)) {
    throw AppError.validation('Haftalik hisobot kuni ish kunlari ichida bo‘lishi kerak', [
      {
        path: 'weeklyReportDay',
        message: 'Haftalik hisobot kuni ish kunlaridan biri bo‘lishi kerak',
      },
    ]);
  }
}
