import { createApp } from './app';
import { connectDb, disconnectDb, ensureIndexes } from './config/db';
import { env } from './config/env';
import { logger } from './core/logger';
import { startJobs } from './jobs';

async function main() {
  await connectDb(undefined, { autoIndex: false });
  await ensureIndexes();
  const app = createApp();
  startJobs();
  const server = app.listen(env.PORT, () => {
    logger.info(`API ishga tushdi: http://localhost:${env.PORT}/api/v1 (docs: /api/docs)`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} qabul qilindi, to'xtatilmoqda`);
    server.close(() => {
      void disconnectDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    // Jarayonni to'xtatmaymiz: bitta e'tiborsiz qolgan promise butun API ni o'chirmasin
    logger.error({ err: reason }, 'Ishlov berilmagan promise rad etildi (unhandledRejection)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, "Ushlanmagan xato (uncaughtException), jarayon to'xtatilmoqda");
    // Holat noma'lum — toza to'xtatib, 0 dan farqli kod bilan chiqamiz (docker restart qayta ko'taradi)
    server.close(() => {
      void disconnectDb().finally(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Ishga tushmadi');
  process.exit(1);
});
