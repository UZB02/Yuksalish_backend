import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { telegramManager } from './telegram.manager';
import { startOutboxWorker, stopOutboxWorker } from './telegram.outbox';

/** Server ishga tushganda: bot (token va enabled bo'lsa) va xabar yuboruvchi. Test muhitida hech narsa qilmaydi. */
export function startTelegram(): void {
  if (env.isTest) return;
  startOutboxWorker();
  void telegramManager.reload().then(() => {
    if (telegramManager.status === 'error') {
      logger.warn({ lastError: telegramManager.lastError }, 'Telegram bot xato holatida');
    }
  });
}

export async function stopTelegram(): Promise<void> {
  stopOutboxWorker();
  await telegramManager.stop();
}
