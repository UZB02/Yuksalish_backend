// Hisobotlarda (PDF/Excel) ko'rinadigan o'zbekcha yorliqlar va sana formatlari — yagona manba

export const KIND_LABEL: Record<string, string> = {
  positive: 'Ijobiy',
  negative: 'Salbiy',
  neutral: 'Neytral',
};

export const CATEGORY_LABEL: Record<string, string> = {
  present: 'Keldi',
  late: 'Kechikdi',
  absent_excused: "Sababli yo'q",
  absent_unexcused: "Sababsiz yo'q",
  partial: 'Qisman',
};

export const STUDENT_STATUS_LABEL: Record<string, string> = {
  active: 'Faol',
  transferred: "Ko'chgan",
  graduated: 'Bitirgan',
};

export const GENDER_LABEL: Record<string, string> = { male: 'Erkak', female: 'Ayol' };

export const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Superadmin',
  school_admin: 'Maktab administratori',
  teacher: "O'qituvchi",
};

const pick = (map: Record<string, string>, v: string | null | undefined): string =>
  v ? (map[v] ?? v) : '';

export const kindLabel = (v: string | null | undefined) => pick(KIND_LABEL, v);
export const categoryLabel = (v: string | null | undefined) => pick(CATEGORY_LABEL, v);
export const studentStatusLabel = (v: string | null | undefined) => pick(STUDENT_STATUS_LABEL, v);
export const genderLabel = (v: string | null | undefined) => pick(GENDER_LABEL, v);
export const roleLabel = (v: string | null | undefined) => pick(ROLE_LABEL, v);

// ---- Sana formatlari: DD.MM.YYYY ----

/** "2026-10-05" -> "05.10.2026" (formati boshqacha bo'lsa o'zgarishsiz) */
export function fmtDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** "2026-10-05" -> "05.10" (grafik o'qi uchun) */
export function fmtDateShort(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}.${m[1]}` : iso;
}

/** UTC ISO vaqt -> Toshkent "DD.MM.YYYY HH:mm" */
export function fmtDateTime(isoUtc: string | null | undefined): string {
  if (!isoUtc) return '';
  const t = new Date(new Date(isoUtc).getTime() + 5 * 3_600_000).toISOString();
  return `${fmtDate(t.slice(0, 10))} ${t.slice(11, 16)}`;
}

/** "2026-10-05" -> Excel uchun haqiqiy sana (UTC yarim tun); noto'g'ri bo'lsa null */
export function toExcelDate(iso: unknown): Date | null {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

export const fmtPeriod = (p: { from: string; to: string }) =>
  `${fmtDate(p.from)} — ${fmtDate(p.to)}`;
