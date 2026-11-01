import { Types } from 'mongoose';
import { logger } from '../../core/logger';
import { TelegramOutbox } from '../../models/TelegramOutbox';
import { User } from '../../models/User';
import { TelegramApiError } from './telegram.client';
import { unlinkUser } from './telegram.link.service';
import { telegramManager } from './telegram.manager';

export const TELEGRAM_MAX_LEN = 4096;
export const MAX_ATTEMPTS = 5;
const BATCH = 50; // ~2s da bir marta => ~25 xabar/soniya
const CLEANUP_MS = 30 * 86_400_000;

/** Matnni 4096 belgilik bo'laklarga ajratadi: iloji bo'lsa qator oxirida, bo'lmasa qattiq kesadi */
export function splitMessage(text: string, limit = TELEGRAM_MAX_LEN): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts.filter((p) => p.length > 0);
}

export interface EnqueueItem {
  userId: string | Types.ObjectId;
  text: string;
  kind: string;
  dedupeKey?: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  /** Odatda chatId foydalanuvchidan olinadi; uzilish xabari kabi hollarda aniq beriladi */
  chatId?: number;
}

function rowsFor(item: EnqueueItem, chatId: number) {
  const parts = splitMessage(item.text);
  return parts.map((text, i) => ({
    userId: item.userId,
    chatId,
    text,
    parseMode: item.parseMode ?? null,
    kind: item.kind,
    ...(item.dedupeKey
      ? { dedupeKey: parts.length > 1 ? `${item.dedupeKey}#${i + 1}` : item.dedupeKey }
      : {}),
  }));
}

/**
 * Xabarlarni navbatga qo'yadi. Foydalanuvchi ulanmagan yoki bot ishlamayotgan bo'lsa — jim o'tkazib yuboradi.
 * Hech qachon tashlamaydi: asosiy amal (masalan, almashtirishni saqlash) buzilmasin.
 */
export async function enqueueMany(items: EnqueueItem[]): Promise<number> {
  try {
    if (!items.length || !telegramManager.isRunning()) return 0;
    const needLookup = items.filter((i) => i.chatId === undefined).map((i) => i.userId);
    const chatByUser = new Map<string, number>();
    if (needLookup.length) {
      const users = await User.find({
        _id: { $in: needLookup },
        isActive: true,
        'telegram.chatId': { $ne: null },
      }).select('+telegram.chatId');
      for (const u of users) {
        if (u.telegram.chatId !== null) chatByUser.set(u._id.toString(), u.telegram.chatId);
      }
    }
    const docs = items.flatMap((i) => {
      const chatId = i.chatId ?? chatByUser.get(i.userId.toString());
      return chatId === undefined ? [] : rowsFor(i, chatId);
    });
    if (!docs.length) return 0;
    try {
      const res = await TelegramOutbox.insertMany(docs, { ordered: false });
      return res.length;
    } catch (err) {
      // Takroriy dedupeKey (E11000) — kutilgan holat; qolganlari baribir yozilgan
      const e = err as {
        code?: number;
        insertedDocs?: unknown[];
        writeErrors?: { code?: number }[];
      };
      const onlyDup =
        e.code === 11000 || (e.writeErrors?.length && e.writeErrors.every((w) => w.code === 11000));
      if (onlyDup) return e.insertedDocs?.length ?? 0;
      throw err;
    }
  } catch (err) {
    logger.error({ err }, 'Telegram navbatiga yozib bo‘lmadi');
    return 0;
  }
}

export const telegramNotify = {
  enqueue(item: EnqueueItem): Promise<number> {
    return enqueueMany([item]);
  },
  enqueueMany,
};

const backoffMs = (attempts: number) => Math.min(15_000 * 2 ** (attempts - 1), 60 * 60_000);

export interface ProcessResult {
  sent: number;
  failed: number;
  retried: number;
  rateLimited: boolean;
}

let busy = false;

/** Navbatdagi xabarlarni bir partiya yuboradi (worker har ~2s da chaqiradi; testlarda to'g'ridan-to'g'ri) */
export async function processOutboxOnce(now: Date = new Date()): Promise<ProcessResult> {
  const result: ProcessResult = { sent: 0, failed: 0, retried: 0, rateLimited: false };
  const client = telegramManager.getClient();
  if (!client || busy) return result;
  busy = true;
  try {
    const batch = await TelegramOutbox.find({ status: 'pending', sendAfter: { $lte: now } })
      .sort({ sendAfter: 1, _id: 1 })
      .limit(BATCH);
    for (const m of batch) {
      // Foydalanuvchi uzilgan/o'chirilgan bo'lsa yubormaymiz
      const stillLinked = await User.exists({
        _id: m.userId,
        isActive: true,
        'telegram.chatId': m.chatId,
      });
      if (!stillLinked) {
        await markFailed(m._id, 'unlinked', now);
        result.failed++;
        continue;
      }
      try {
        await client.sendMessage(m.chatId, m.text, { parseMode: m.parseMode });
        await TelegramOutbox.updateOne(
          { _id: m._id },
          {
            $set: {
              status: 'sent',
              sentAt: now,
              lastError: null,
              cleanupAt: new Date(now.getTime() + CLEANUP_MS),
            },
            $inc: { attempts: 1 },
          },
        );
        result.sent++;
      } catch (err) {
        const e = err instanceof TelegramApiError ? err : null;
        if (e?.code === 429) {
          // Telegram limiti: butun partiyani to'xtatib, retry_after dan keyin qayta uramiz (urinish hisoblanmaydi)
          const wait = Math.max(1, e.retryAfter ?? 1) * 1000;
          await TelegramOutbox.updateOne(
            { _id: m._id },
            { $set: { sendAfter: new Date(now.getTime() + wait), lastError: 'rate_limited' } },
          );
          result.rateLimited = true;
          result.retried++;
          break;
        }
        if (e?.code === 403) {
          // Foydalanuvchi botni bloklagan: ulanishni uzamiz
          await markFailed(m._id, 'bot_blocked', now, 1);
          await unlinkUser(m.userId, { actorId: null, reason: 'bot_blocked' });
          result.failed++;
          continue;
        }
        const attempts = m.attempts + 1;
        const permanent = e?.code !== undefined && e.code >= 400 && e.code < 500;
        const msg = e ? e.message.slice(0, 200) : 'unknown_error';
        if (permanent || attempts >= MAX_ATTEMPTS) {
          await markFailed(m._id, msg, now, 1);
          result.failed++;
        } else {
          await TelegramOutbox.updateOne(
            { _id: m._id },
            {
              $set: { sendAfter: new Date(now.getTime() + backoffMs(attempts)), lastError: msg },
              $inc: { attempts: 1 },
            },
          );
          result.retried++;
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Telegram outbox xatosi');
  } finally {
    busy = false;
  }
  return result;
}

async function markFailed(id: Types.ObjectId, error: string, now: Date, inc = 0) {
  await TelegramOutbox.updateOne(
    { _id: id },
    {
      $set: { status: 'failed', lastError: error, cleanupAt: new Date(now.getTime() + CLEANUP_MS) },
      ...(inc ? { $inc: { attempts: inc } } : {}),
    },
  );
}

let timer: NodeJS.Timeout | null = null;

export function startOutboxWorker(intervalMs = 2000): void {
  if (timer) return;
  timer = setInterval(() => {
    void processOutboxOnce();
  }, intervalMs);
  timer.unref();
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
