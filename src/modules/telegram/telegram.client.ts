import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
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

export interface InlineButton {
  text: string;
  /** Telegram cheklovi: <= 64 bayt */
  data: string;
}

/** Matn (HTML) va ixtiyoriy inline klaviatura (qatorlar bo'yicha) */
export interface BotReply {
  text: string;
  keyboard?: InlineButton[][];
}

export interface IncomingCallback {
  chatId: number;
  chatType: string;
  data: string;
}

/** Callback natijasi: answer = tugma bosilganda qisqa bildirishnoma, edit = xabarni yangilash */
export interface CallbackResult {
  answer?: string;
  edit?: BotReply;
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

export interface BotCommand {
  command: string;
  description: string;
}

/** Telegram BotCommandScope: default (berilmasa) yoki aniq chat */
export type CommandScope = { type: 'chat'; chat_id: number };

/** Telegram ga yupqa interfeys: testlarda soxtasi bilan almashtiriladi, tarmoqqa chiqmaydi */
export interface TelegramClient {
  getMe(): Promise<BotInfo>;
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void>;
  /** Long polling ni boshlaydi; getMe tayyor bo'lgach qaytadi. Keyingi halokatli xato onFatal ga */
  start(
    onMessage: (m: IncomingMessage) => Promise<string | BotReply | null>,
    onFatal: (err: Error) => void,
    onCallback?: (c: IncomingCallback) => Promise<CallbackResult | null>,
  ): Promise<BotInfo>;
  /** Bot menyusidagi buyruqlar (setMyCommands). Ixtiyoriy: xato bot ishini to'xtatmaydi */
  setCommands?(commands: BotCommand[], scope?: CommandScope): Promise<void>;
  /** Scope uchun buyruqlarni o'chiradi (chat menyusi defaultga qaytadi). Ixtiyoriy */
  deleteCommands?(scope: CommandScope): Promise<void>;
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

function toInlineKeyboard(rows: InlineButton[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) kb.text(b.text, b.data);
    if (i < rows.length - 1) kb.row();
  });
  return kb;
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
    async start(onMessage, onFatal, onCallback) {
      bot.on('message:text', async (ctx) => {
        const reply = await onMessage({
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          text: ctx.message.text,
          username: ctx.from?.username ?? null,
        });
        if (reply) {
          const r = typeof reply === 'string' ? { text: reply } : reply;
          // Javoblar HTML parse mode da (dinamik qismlar handleIncoming da escapeHtml qilinadi)
          await ctx.reply(r.text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(r.keyboard ? { reply_markup: toInlineKeyboard(r.keyboard) } : {}),
          });
        }
      });
      if (onCallback) {
        bot.on('callback_query:data', async (ctx) => {
          const chat = ctx.callbackQuery.message?.chat;
          const res = chat
            ? await onCallback({
                chatId: chat.id,
                chatType: chat.type,
                data: ctx.callbackQuery.data,
              })
            : null;
          if (res?.edit) {
            try {
              await ctx.editMessageText(res.edit.text, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                ...(res.edit.keyboard ? { reply_markup: toInlineKeyboard(res.edit.keyboard) } : {}),
              });
            } catch (err) {
              // Matn o'zgarmagan bo'lsa Telegram xato qaytaradi: e'tiborsiz
              if (!(err instanceof GrammyError && /not modified/i.test(err.description))) throw err;
            }
          }
          await ctx.answerCallbackQuery(res?.answer ? { text: res.answer } : undefined);
        });
      }
      // Bitta xabarni qayta ishlashdagi xato botni to'xtatmasin
      bot.catch((e) =>
        logger.error({ err: toApiError(e.error, token).message }, 'Telegram handler xatosi'),
      );
      return new Promise<BotInfo>((resolve, reject) => {
        let started = false;
        bot
          .start({
            allowed_updates: onCallback ? ['message', 'callback_query'] : ['message'],
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
    async setCommands(commands, scope) {
      await bot.api.setMyCommands(commands, scope ? { scope } : undefined);
    },
    async deleteCommands(scope) {
      await bot.api.deleteMyCommands({ scope });
    },
    async stop() {
      await bot.stop().catch(() => undefined);
    },
  };
};
