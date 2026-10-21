import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import './core/zod-uz';
import { logger } from './core/logger';
import { openApiSpec } from './docs/openapi';
import { errorHandler } from './middlewares/errorHandler';
import { notFound } from './middlewares/notFound';
import { apiLimiter } from './middlewares/rateLimiters';
import { sanitize } from './middlewares/sanitize';
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
  app.use((req, res, next) =>
    req.path.startsWith('/api/v1/public') ? publicCors(req, res, next) : adminCors(req, res, next),
  );
  if (!env.isTest) app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(sanitize);

  app.use('/health', healthRouter);
  if (env.ENABLE_DOCS) app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.use('/api/v1', apiLimiter, apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
