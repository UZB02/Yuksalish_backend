import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { dateStrSchema } from '../../core/validators';
import { addDaysStr, todayTashkent } from '../../utils/clock';

/** Davr qoidalari: from<=to, <=366 kun, kelajakka chiqmaydi */
function periodCheck(value: object, ctx: z.RefinementCtx) {
  const v = value as { from: string; to: string };
  // Format xatosi alohida (dateStrSchema) xabar beradi — bu yerda faqat to'g'ri sanalar tekshiriladi
  const ok = (d: unknown) =>
    typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
  if (!ok(v.from) || !ok(v.to)) return;
  if (v.from > v.to) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: "'from' sanasi 'to' dan keyin bo'lmasligi kerak",
    });
  } else if (addDaysStr(v.from, 366) < v.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Davr 366 kundan oshmasligi kerak' });
  }
  if (v.to > todayTashkent()) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Davr kelajakka chiqmasligi kerak' });
  }
}

/** Hisobot so'rovi: majburiy from/to + qo'shimcha maydonlar */
export const reportQuery = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ from: dateStrSchema, to: dateStrSchema, ...shape }).superRefine(periodCheck);

export const formatQuery = z.object({ format: z.enum(['xlsx', 'pdf']).default('xlsx') });

export function assertRowLimit(rows: number): void {
  if (rows > env.REPORTS_MAX_ROWS) {
    throw AppError.validation(
      `Davrni qisqartiring: hisobotda ${env.REPORTS_MAX_ROWS} qatordan ko'p ma'lumot chiqadi`,
      [{ path: 'from', message: `Natija ${rows} qator (maksimum ${env.REPORTS_MAX_ROWS})` }],
    );
  }
}
