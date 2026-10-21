// Vaqt manbai (testlarda almashtiriladi) va Asia/Tashkent (UTC+5, DST yo'q) kun hisobi
let nowFn: () => Date = () => new Date();

export const clock = {
  now: (): Date => nowFn(),
  /** Faqat testlar uchun */
  set(fn: () => Date) {
    nowFn = fn;
  },
  reset() {
    nowFn = () => new Date();
  },
};

const TASHKENT_OFFSET_MS = 5 * 3_600_000;

/** Berilgan vaqt Toshkentda qaysi kunga to'g'ri kelishi: YYYY-MM-DD */
export const tashkentDate = (d: Date = clock.now()): string =>
  new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);

export const todayTashkent = (): string => tashkentDate(clock.now());

/** YYYY-MM-DD ga n kun qo'shadi (manfiy ham mumkin) */
export function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
