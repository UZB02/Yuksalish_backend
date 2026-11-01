import { Bot, GrammyError, HttpError } from 'grammy';
import { env } from '../../config/env';
import { logger } from '../../core/logger';

export interface BotInfo {
  username: string;
  name: string;
}

export interface IncomingMessage {
  chatId: number;
  chatType: string;
  text: string;
  username: string | null;
}

export interface SendOptions {
  parseMode?: 'HTML' | 'MarkdownV2' | null;
}

/** Telegram API xatosi (client qatlami). network=true: Telegram ga yetib bo'lmadi */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly opts: { code?: number; retryAfter?: number; network?: boolean } = {},
  ) {
    super(message);
  }
  get code() {
    return this.opts.code;
  }
  get retryAfter() {
    return this.opts.retryAfter;
  }
  get network() {
    return this.opts.network === true;
  }
}

/** Telegram ga yupqa interfeys: testlarda soxtasi bilan almashtiriladi, tarmoqqa chiqmaydi */
export interface TelegramClient {
  getMe(): Promise<BotInfo>;
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void>;
  /** Long polling ni boshlaydi; getMe tayyor bo'lgach qaytadi. Keyingi halokatli xato onFatal ga */
  start(
    onMessage: (m: IncomingMessage) => Promise<string | null>,
    onFatal: (err: Error) => void,
  ): Promise<BotInfo>;
  /** Bot menyusidagi buyruqlar (setMyCommands). Ixtiyoriy: xato bot ishini to'xtatmaydi */
  setCommands?(commands: { command: string; description: string }[]): Promise<void>;
  stop(): Promise<void>;
}

export type ClientFactory = (token: string) => TelegramClient;

function toApiError(err: unknown, token: string): TelegramApiError {
  const scrub = (m: string) => (token ? m.split(token).join('***') : m);
  if (err instanceof GrammyError) {
    return new TelegramApiError(scrub(err.description), {
      code: err.error_code,
      retryAfter: err.parameters?.retry_after,
    });
  }
  if (err instanceof HttpError) {
    return new TelegramApiError("Telegram bilan bog'lanib bo'lmadi", { network: true });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new TelegramApiError(scrub(msg), { network: true });
}

export const grammyClientFactory: ClientFactory = (token) => {
  if (env.isTest) {
    throw new Error('Test muhitida haqiqiy Telegram klienti ishlatilmaydi');
  }
  const bot = new Bot(token);
  return {
    async getMe() {
      try {
        const me = await bot.api.getMe();
        return { username: me.username, name: me.first_name };
      } catch (err) {
        throw toApiError(err, token);
      }
    },
    async sendMessage(chatId, text, opts) {
      try {
        await bot.api.sendMessage(chatId, text, {
          ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        throw toApiError(err, token);
      }
    },
    async start(onMessage, onFatal) {
      bot.on('message:text', async (ctx) => {
        const reply = await onMessage({
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          text: ctx.message.text,
          username: ctx.from?.username ?? null,
        });
        if (reply) {
          // Javoblar HTML parse mode da (dinamik qismlar handleIncoming da escapeHtml qilinadi)
          await ctx.reply(reply, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          });
        }
      });
      // Bitta xabarni qayta ishlashdagi xato botni to'xtatmasin
      bot.catch((e) =>
        logger.error({ err: toApiError(e.error, token).message }, 'Telegram handler xatosi'),
      );
      return new Promise<BotInfo>((resolve, reject) => {
        let started = false;
        bot
          .start({
            allowed_updates: ['message'],
            onStart: (me) => {
              started = true;
              resolve({ username: me.username, name: me.first_name });
            },
          })
          .catch((err) => {
            const e = toApiError(err, token);
            if (started) onFatal(e);
            else reject(e);
          });
      });
    },
    async setCommands(commands) {
      await bot.api.setMyCommands(commands);
    },
    async stop() {
      await bot.stop().catch(() => undefined);
    },
  };
};
