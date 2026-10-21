import { addDaysStr } from '../../utils/clock';
import type { PeriodType, RatingSettings } from '../settings/rating.settings';

export interface ActiveYearInfo {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  periods: { id: string; name: string; startDate: string; endDate: string }[];
}

export interface RatingPeriod {
  type: PeriodType;
  from: string;
  to: string;
  key: string;
  label: string;
  /** Tanlangan tur uchun ma'lumot yetishmaganda boshqa turga o'tilgan */
  fallback?: boolean;
}

const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentyabr',
  'oktyabr',
  'noyabr',
  'dekabr',
];

const monthOf = (d: string) => Number(d.slice(5, 7)) - 1;
const dayOf = (d: string) => Number(d.slice(8, 10));

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function monthPeriod(today: string, fallback = false): RatingPeriod {
  const y = Number(today.slice(0, 4));
  const m = monthOf(today);
  const mm = String(m + 1).padStart(2, '0');
  return {
    type: 'month',
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`,
    key: `month:${y}-${mm}`,
    label: `${y}-yil ${MONTHS[m]}`,
    ...(fallback ? { fallback: true } : {}),
  };
}

function weekPeriod(today: string): RatingPeriod {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = yakshanba
  const from = addDaysStr(today, -((dow + 6) % 7)); // dushanba
  const to = addDaysStr(from, 6);
  const label =
    monthOf(from) === monthOf(to)
      ? `${dayOf(from)}–${dayOf(to)}-${MONTHS[monthOf(to)]}`
      : `${dayOf(from)}-${MONTHS[monthOf(from)]} – ${dayOf(to)}-${MONTHS[monthOf(to)]}`;
  return { type: 'week', from, to, key: `week:${from}`, label };
}

/**
 * Reyting davrini aniqlaydi (Asia/Tashkent kunlari, YYYY-MM-DD).
 * @param year maktabning faol o'quv yili (yo'q bo'lsa null)
 */
export function resolvePeriod(
  s: Pick<RatingSettings, 'periodType' | 'customFrom' | 'customTo'>,
  year: ActiveYearInfo | null,
  today: string,
): RatingPeriod {
  switch (s.periodType) {
    case 'week':
      return weekPeriod(today);
    case 'month':
      return monthPeriod(today);
    case 'custom':
      if (s.customFrom && s.customTo) {
        return {
          type: 'custom',
          from: s.customFrom,
          to: s.customTo,
          key: `custom:${s.customFrom}:${s.customTo}`,
          label: `${s.customFrom} – ${s.customTo}`,
        };
      }
      return monthPeriod(today, true);
    case 'academic_year':
      if (!year) return monthPeriod(today, true);
      return {
        type: 'academic_year',
        from: year.startDate,
        to: year.endDate,
        key: `year:${year.startDate}:${year.endDate}`,
        label: year.name,
      };
    case 'quarter': {
      if (!year) return monthPeriod(today, true);
      const ps = [...year.periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
      const current = ps.find((p) => p.startDate <= today && today <= p.endDate);
      // Joriy chorak yo'q (tanaffus): eng oxirgi tugagan chorak
      const ended = [...ps].reverse().find((p) => p.endDate < today);
      const p = current ?? ended;
      if (p) {
        return {
          type: 'quarter',
          from: p.startDate,
          to: p.endDate,
          key: `quarter:${p.startDate}:${p.endDate}`,
          label: `${year.name}, ${p.name}`,
        };
      }
      // Choraklar belgilanmagan yoki hali boshlanmagan: o'quv yilining o'zi
      return {
        type: 'quarter',
        from: year.startDate,
        to: year.endDate,
        key: `quarter:${year.startDate}:${year.endDate}`,
        label: year.name,
      };
    }
  }
}
