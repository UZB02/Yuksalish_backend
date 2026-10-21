// Production xavfsizlik tekshiruvlari (sof funksiyalar — env.ts va testlar ishlatadi)

export const EXAMPLE_JWT_SECRET = 'change-me-change-me-change-me-change-me';
export const EXAMPLE_SEED_PASSWORD = 'ChangeMe123';

export function isPlaceholderSecret(value: string): boolean {
  // change-me, change_me, CHANGE_ME, ChangeMe ... hammasi bir xil ushlanadi
  const v = value.trim().toLowerCase().replace(/[-_\s]/g, '');
  return v.includes('changeme');
}

export function isPlaceholderSeedPassword(value: string): boolean {
  const v = value.trim();
  return v === EXAMPLE_SEED_PASSWORD || isPlaceholderSecret(v);
}

/** Productionda xavfli (namuna) qiymatlar topilsa, xato matnlari ro'yxatini qaytaradi. */
export function productionEnvProblems(e: { NODE_ENV?: string; JWT_ACCESS_SECRET?: string }): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (e.JWT_ACCESS_SECRET && isPlaceholderSecret(e.JWT_ACCESS_SECRET)) {
    problems.push(
      "JWT_ACCESS_SECRET namuna (change-me / CHANGE_ME) qiymatda — productionda haqiqiy maxfiy kalit kerak (openssl rand -hex 48)",
    );
  }
  return problems;
}

/** ENABLE_DOCS berilmasa: productionda o'chiq, aks holda yoqiq. Aniq qiymat doim ustun. */
export function resolveEnableDocs(raw: string | undefined, nodeEnv: string | undefined): boolean {
  if (raw !== undefined && raw !== '') return raw === 'true' || raw === '1';
  return nodeEnv !== 'production';
}

/** Productionda seed superadmin paroli namuna bo'lmasligi kerak. Xato matnini yoki null qaytaradi. */
export function seedPasswordProblem(nodeEnv: string | undefined, password: string | undefined): string | null {
  if (nodeEnv !== 'production' || !password) return null;
  return isPlaceholderSeedPassword(password)
    ? "SEED_SUPERADMIN_PASSWORD namuna qiymatda (ChangeMe123 / CHANGE_ME_...) — productionda kuchli parol bering"
    : null;
}
