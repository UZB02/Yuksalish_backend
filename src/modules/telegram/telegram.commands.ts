import { logger } from '../../core/logger';
import { User } from '../../models/User';
import type { CommandScope } from './telegram.client';
import { commandsForRole } from './telegram.menu';
import { telegramManager } from './telegram.manager';

const chatScope = (chatId: number): CommandScope => ({ type: 'chat', chat_id: chatId });

/** Chat menyusini rolga moslab o'rnatadi. Hech qachon tashlamaydi */
export async function setChatCommands(chatId: number, role: string): Promise<void> {
  const client = telegramManager.getClient();
  if (!client?.setCommands) return;
  try {
    await client.setCommands(commandsForRole(role), chatScope(chatId));
  } catch (err) {
    logger.warn({ err: String(err) }, 'Telegram chat buyruqlarini o‘rnatib bo‘lmadi');
  }
}

/** Chatning shaxsiy menyusini o'chiradi (default ko'rinadi). Hech qachon tashlamaydi */
export async function clearChatCommands(chatId: number): Promise<void> {
  const client = telegramManager.getClient();
  if (!client?.deleteCommands) return;
  try {
    await client.deleteCommands(chatScope(chatId));
  } catch (err) {
    logger.warn({ err: String(err) }, 'Telegram chat buyruqlarini o‘chirib bo‘lmadi');
  }
}

/** Foydalanuvchi holatiga qarab menyuni qayta sinxronlaydi (faol bo'lsa o'rnatadi, aks holda o'chiradi). Hech qachon tashlamaydi */
export async function syncUserCommands(userId: string): Promise<void> {
  try {
    const u = await User.findById(userId).select('+telegram.chatId role isActive');
    const chatId = u?.telegram?.chatId ?? null;
    if (!u || chatId === null) return;
    if (u.isActive) await setChatCommands(chatId, u.role);
    else await clearChatCommands(chatId);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Telegram menyusini sinxronlab bo‘lmadi');
  }
}

const SYNC_INTERVAL_MS = 50; // ~20 so'rov/s
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bot ishga tushganda: ulangan barcha foydalanuvchilarning menyusini yangilaydi (fonda, sekin, xatolarsiz) */
export async function syncAllLinkedCommands(intervalMs = SYNC_INTERVAL_MS): Promise<number> {
  let n = 0;
  try {
    const users = await User.find({ 'telegram.chatId': { $ne: null } }).select(
      '+telegram.chatId role isActive',
    );
    for (const u of users) {
      const chatId = u.telegram?.chatId ?? null;
      if (chatId === null) continue;
      if (!telegramManager.isRunning()) break;
      if (u.isActive) await setChatCommands(chatId, u.role);
      else await clearChatCommands(chatId);
      n++;
      if (intervalMs > 0) await sleep(intervalMs);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'Telegram menyularini sinxronlab bo‘lmadi');
  }
  return n;
}
