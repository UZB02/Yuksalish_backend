import type { IncomingMessage, ServerResponse } from 'http';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

/** Exam-client yo'li: autosave hajmi katta (25-250 so'rov/s), shuning uchun avtomatik log yozilmaydi */
export const isExamClientUrl = (url: string | undefined): boolean =>
  !!url && /^\/api\/v1\/exam-client(?:[/?#]|$)/.test(url);

/**
 * Daraja: exam-client uchun faqat xato (err yoki 5xx) loglanadi, qolgani 'silent'.
 * Boshqa yo'llar uchun pino-http standarti (5xx error, 4xx warn, qolgani info).
 */
export function httpLogLevel(
  req: IncomingMessage,
  res: ServerResponse,
  err?: Error,
): 'error' | 'warn' | 'info' | 'silent' {
  if (err || res.statusCode >= 500) return 'error';
  if (isExamClientUrl(req.url)) return 'silent';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

export const createHttpLogger = (logger: Logger) =>
  pinoHttp({ logger, customLogLevel: httpLogLevel });
