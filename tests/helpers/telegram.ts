import {
  TelegramApiError,
  type BotInfo,
  type ClientFactory,
  type SendOptions,
  type TelegramClient,
} from '../../src/modules/telegram/telegram.client';
import { telegramManager } from '../../src/modules/telegram/telegram.manager';

export const VALID_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x';
export const OTHER_TOKEN = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_y';

export interface Sent {
  token: string;
  chatId: number;
  text: string;
  opts?: SendOptions;
}

/** Tarmoqqa chiqmaydigan soxta Telegram */
export class FakeTelegram {
  sent: Sent[] = [];
  started: string[] = [];
  stopped = 0;
  validTokens = new Map<string, BotInfo>([
    [VALID_TOKEN, { username: 'yuksalish_test_bot', name: 'Yuksalish Test' }],
  ]);
  networkDown = false;
  failStart: Error | null = null;
  /** Keyingi sendMessage chaqiruvlari uchun xatolar navbati (null = muvaffaqiyat) */
  sendErrors: (Error | null)[] = [];

  factory: ClientFactory = (token) => {
    const client: TelegramClient = {
      getMe: async () => {
        if (this.networkDown) throw new TelegramApiError('network', { network: true });
        const info = this.validTokens.get(token);
        if (!info) throw new TelegramApiError('Unauthorized', { code: 401 });
        return info;
      },
      sendMessage: async (chatId, text, opts) => {
        const err = this.sendErrors.shift();
        if (err) throw err;
        this.sent.push({ token, chatId, text, opts });
      },
      start: async () => {
        if (this.failStart) throw this.failStart;
        const info = this.validTokens.get(token);
        if (!info) throw new TelegramApiError('Unauthorized', { code: 401 });
        this.started.push(token);
        return info;
      },
      stop: async () => {
        this.stopped++;
      },
    };
    return client;
  };

  install() {
    telegramManager.setClientFactory(this.factory);
  }
}

export async function uninstallTelegram() {
  await telegramManager.stop();
  telegramManager.setClientFactory(null);
}
