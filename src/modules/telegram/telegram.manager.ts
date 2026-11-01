import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { TelegramBotConfig } from '../../models/TelegramBotConfig';
import { handleIncoming } from './telegram.bot';
import {
  grammyClientFactory,
  TelegramApiError,
  type ClientFactory,
  type TelegramClient,
} from './telegram.client';
import { decryptToken } from './telegram.crypto';

export type BotStatus = 'running' | 'stopped' | 'error';

export interface ResolvedToken {
  configured: boolean;
  source: 'db' | 'env' | null;
  enabled: boolean;
  /** Ochiq token (faqat xotirada, hech qachon API/logga chiqmaydi) */
  token: string | null;
  tokenLast4: string | null;
  botUsername: string | null;
  botName: string | null;
  updatedAt: Date | null;
  decryptError: boolean;
}

export const TOKEN_REENTER_MESSAGE = 'Token qayta kiritilishi kerak';

export const BOT_COMMANDS = [
  { command: 'bugun', description: 'Bugungi darslarim' },
  { command: 'ertaga', description: 'Ertangi darslarim' },
  { command: 'hafta', description: 'Haftalik jadval' },
  { command: 'help', description: 'Yordam' },
  { command: 'stop', description: 'Hisobni uzish' },
];

/** Bazadagi sozlama (bo'lsa) yoki .env zaxirasidan tokenni aniqlaydi */
export async function resolveToken(): Promise<ResolvedToken> {
  const doc = await TelegramBotConfig.findOne({ key: 'platform' });
  const envToken = env.TELEGRAM_BOT_TOKEN || null;
  if (doc?.tokenEnc) {
    let token: string | null = null;
    let decryptError = false;
    try {
      token = decryptToken(doc.tokenEnc);
    } catch {
      decryptError = true;
    }
    return {
      configured: true,
      source: 'db',
      enabled: doc.enabled,
      token,
      tokenLast4: doc.tokenLast4,
      botUsername: doc.botUsername,
      botName: doc.botName,
      updatedAt: doc.updatedAt,
      decryptError,
    };
  }
  return {
    configured: Boolean(envToken),
    source: envToken ? 'env' : null,
    enabled: doc ? doc.enabled : Boolean(envToken),
    token: envToken,
    tokenLast4: envToken ? envToken.slice(-4) : null,
    botUsername: null,
    botName: null,
    updatedAt: doc?.updatedAt ?? null,
    decryptError: false,
  };
}

class TelegramManager {
  private factory: ClientFactory = grammyClientFactory;
  private client: TelegramClient | null = null;
  private chain: Promise<void> = Promise.resolve();
  status: BotStatus = 'stopped';
  lastError: string | null = null;
  botUsername: string | null = null;
  botName: string | null = null;

  /** Testlar uchun: soxta klient fabrikasi */
  setClientFactory(factory: ClientFactory | null): void {
    this.factory = factory ?? grammyClientFactory;
  }

  createClient(token: string): TelegramClient {
    return this.factory(token);
  }

  /** Ishlayotgan klient (bot running bo'lmasa null) */
  getClient(): TelegramClient | null {
    return this.status === 'running' ? this.client : null;
  }

  isRunning(): boolean {
    return this.status === 'running' && this.client !== null;
  }

  /** Konfiguratsiya o'zgarganda chaqiriladi: to'xtatib, yangi tokenni bilan qayta ishga tushiradi. Hech qachon tashlamaydi. */
  reload(): Promise<void> {
    this.chain = this.chain.then(() => this.doReload()).catch(() => undefined);
    return this.chain;
  }

  async stop(): Promise<void> {
    this.chain = this.chain.then(() => this.doStop()).catch(() => undefined);
    await this.chain;
  }

  private async doStop(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.status = 'stopped';
    if (c) await c.stop().catch(() => undefined);
  }

  private fail(message: string): void {
    this.status = 'error';
    this.lastError = message;
    this.client = null;
  }

  private async doReload(): Promise<void> {
    await this.doStop();
    this.lastError = null;
    this.botUsername = null;
    this.botName = null;
    let r: ResolvedToken;
    try {
      r = await resolveToken();
    } catch (err) {
      logger.error({ err }, 'Telegram sozlamasini o‘qib bo‘lmadi');
      return this.fail('Sozlamani o‘qib bo‘lmadi');
    }
    if (!r.configured || !r.enabled) return;
    if (r.decryptError || !r.token) return this.fail(TOKEN_REENTER_MESSAGE);

    try {
      const client = this.factory(r.token);
      const info = await client.start(handleIncoming, (err) => {
        // Polling halokatli to'xtadi (masalan, boshqa nusxa ham polling qilyapti)
        if (this.client === client) {
          logger.error({ err: err.message }, 'Telegram polling to‘xtadi');
          this.fail(`Bot to'xtadi: ${err.message}`);
        }
      });
      void client
        .setCommands?.(BOT_COMMANDS)
        .catch((err) =>
          logger.warn({ err: String(err) }, 'Telegram buyruqlarini o‘rnatib bo‘lmadi'),
        );
      this.client = client;
      this.status = 'running';
      this.botUsername = info.username;
      this.botName = info.name;
      logger.info({ bot: info.username }, 'Telegram bot ishga tushdi');
    } catch (err) {
      const msg =
        err instanceof TelegramApiError
          ? err.network
            ? "Telegram bilan bog'lanib bo'lmadi"
            : err.message
          : 'Noma‘lum xato';
      logger.error({ err: msg }, 'Telegram bot ishga tushmadi');
      this.fail(`Bot ishga tushmadi: ${msg}`);
    }
  }
}

export const telegramManager = new TelegramManager();
