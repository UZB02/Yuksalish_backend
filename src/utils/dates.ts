/** "YYYY-MM-DD" (yoki ISO) -> UTC yarim tun Date; noto'g'ri bo'lsa null */
export function parseDateOnly(input: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (!m) return null;
  return buildUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function buildUtcDate(y: number, mo: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return null;
  return date;
}

/** Date -> "YYYY-MM-DD" (UTC) */
export const fmtDate = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

/** Excel seriya raqami -> UTC Date */
export function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  return new Date(Math.round((serial - 25569) * 86_400_000));
}

/** ISO hafta kuni: 1 = dushanba ... 7 = yakshanba (YYYY-MM-DD uchun) */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
