import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import './core/zod-uz';
import { createHttpLogger } from './core/http-logger';
import { logger } from './core/logger';
import { openApiSpec } from './docs/openapi';
import { errorHandler } from './middlewares/errorHandler';
import { notFound } from './middlewares/notFound';
import {
  apiLimiter,
  examClientIpLimiter,
  examClientLimiter,
  photoLimiter,
} from './middlewares/rateLimiters';
import { sanitize } from './middlewares/sanitize';
import { examClientRouter } from './modules/exam-client/exam-client.routes';
import { photosRouter } from './modules/photos/photos.routes';
import { healthRouter } from './modules/health/health.routes';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  // Admin API: cookie bilan (credentials); public API: faqat o'qish, credentials kerak emas
  const adminCors = cors({ origin: env.corsOrigins, credentials: true });
  const publicCors = cors({
    origin: env.publicCorsOrigins,
    credentials: false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  // Branding o'qish (GET/HEAD): admin va ochiq frontendlar ikkalasi ham o'qiy oladi, cookie kerak emas
  const brandingReadCors = cors({
    origin: [...new Set([...env.corsOrigins, ...env.publicCorsOrigins])],
    credentials: false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  app.use((req, res, next) => {
    // Exam-client: bir origin (Caddy), CORS sarlavhalari qo'yilmaydi (admin credentials-CORS ostiga tushmaydi)
    if (req.path.startsWith('/api/v1/exam-client')) return next();
    if (req.path.startsWith('/api/v1/public')) return publicCors(req, res, next);
    if (
      req.path.startsWith('/api/v1/branding') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      return brandingReadCors(req, res, next);
    }
    return adminCors(req, res, next);
  });
  if (!env.isTest) app.use(createHttpLogger(logger));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(sanitize);

  app.use('/health', healthRouter);
  if (env.ENABLE_DOCS) app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  // Rasmlar apiLimiter dan oldin: o'z (yuqoriroq) limiti bilan
  app.use('/api/v1/photos', photoLimiter, photosRouter);
  // Exam-client apiLimiter dan oldin (maktab NAT'i): urinish tokeni bo'yicha o'z limiterlari bilan.
  // Hozircha bo'sh joy (placeholder): har qanday so'rov 404 (E4 da to'ldiriladi)
  app.use('/api/v1/exam-client', examClientIpLimiter, examClientLimiter, examClientRouter);
  app.use('/api/v1', apiLimiter, apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
