export type DailyAggregation = 'average' | 'min' | 'last';

export interface DayScoreInput {
  /** null = faqat jarima qaydi (kunlik ballga kirmaydi) */
  value: number | null;
  createdAt: Date | number;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Bir kundagi (bir necha o'qituvchi) baholardan o'quvchining kunlik ballini hisoblaydi.
 * average — o'rtacha (2 xonagacha yaxlitlanadi), min — eng past, last — createdAt bo'yicha oxirgisi.
 * value=null (faqat jarima qaydi) yozuvlari e'tiborga olinmaydi. Ballik baho bo'lmasa null.
 */
export function dailyScore(all: DayScoreInput[], mode: DailyAggregation): number | null {
  const items = all.filter(
    (i): i is { value: number; createdAt: Date | number } =>
      i.value !== null && i.value !== undefined,
  );
  if (items.length === 0) return null;
  switch (mode) {
    case 'min':
      return Math.min(...items.map((i) => i.value));
    case 'last': {
      let last = items[0];
      for (const it of items) if (+it.createdAt >= +last.createdAt) last = it;
      return last.value;
    }
    case 'average':
    default:
      return round2(items.reduce((s, i) => s + i.value, 0) / items.length);
  }
}
