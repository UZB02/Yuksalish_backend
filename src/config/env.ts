import 'dotenv/config';
import { z } from 'zod';
import { productionEnvProblems, resolveEnableDocs } from './env-guard';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET kamida 32 belgi bo'lishi kerak"),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(7),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(10),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().positive().default(15),
  RATE_LIMIT_ENABLED: bool.default(true),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Berilmasa: productionda false, boshqa muhitda true (env-guard.ts)
  ENABLE_DOCS: z.string().optional(),
  // Ochiq (public) frontend originlari; bo'sh bo'lsa CORS_ORIGINS ishlatiladi
  PUBLIC_CORS_ORIGINS: z.string().default(''),
  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  // Rejalashtirilgan vazifalar (reytingni kechasi qayta hisoblash)
  JOBS_ENABLED: bool.default(true),
  // Hisobotda bir martada max qator soni
  REPORTS_MAX_ROWS: z.coerce.number().int().min(1).default(5000),
  // Audit loglarni saqlash muddati (kun). Bo'sh = abadiy
  AUDIT_RETENTION_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(1).optional(),
  ),
  RATING_DEBOUNCE_MS: z.coerce.number().int().min(0).default(5000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Muhit o'zgaruvchilari noto'g'ri:");
  for (const i of parsed.error.issues) console.error(` - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

const problems = productionEnvProblems(parsed.data);
if (problems.length) {
  console.error('Production sozlamalari xavfsiz emas:');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ENABLE_DOCS: resolveEnableDocs(parsed.data.ENABLE_DOCS, parsed.data.NODE_ENV),
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  publicCorsOrigins: (parsed.data.PUBLIC_CORS_ORIGINS || parsed.data.CORS_ORIGINS)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
