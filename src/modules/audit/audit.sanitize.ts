// Audit before/after ichidagi maxfiy maydonlarni o'qish paytida ham olib tashlash (eski yozuvlar uchun xavfsizlik zahirasi)
const SENSITIVE_KEY = /pass(word)?|hash|token|secret|jwt|authorization|cookie|api[-_]?key/i;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 500;
const MAX_JSON_BYTES = 8000;

export interface Sanitized {
  value: unknown;
  truncated: boolean;
}

export function sanitizeAuditValue(input: unknown): Sanitized {
  let truncated = false;

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      if (v.length > MAX_STRING) {
        truncated = true;
        return `${v.slice(0, MAX_STRING)}…`;
      }
      return v;
    }
    if (typeof v !== 'object') return v;
    if (v instanceof Date) return v.toISOString();
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return '[…]';
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY) truncated = true;
      return v.slice(0, MAX_ARRAY).map((x) => walk(x, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = walk(x, depth + 1);
    }
    return out;
  };

  const value = walk(input, 0);
  // Umumiy hajm cheklovi
  if (value !== null && JSON.stringify(value).length > MAX_JSON_BYTES) {
    return {
      value: { truncated: true, preview: JSON.stringify(value).slice(0, 1000) },
      truncated: true,
    };
  }
  return { value, truncated };
}
