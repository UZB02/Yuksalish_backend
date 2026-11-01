import crypto from 'crypto';
import { Types } from 'mongoose';
import { TelegramLinkToken } from '../../models/TelegramLinkToken';
import { TelegramOutbox } from '../../models/TelegramOutbox';
import { User } from '../../models/User';
import { clock } from '../../utils/clock';
import { auditService } from '../audit/audit.service';

export const LINK_TTL_MS = 15 * 60_000;

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/** Bir martalik havola tokenini beradi; foydalanuvchining oldingilari o'chiriladi */
export async function issueLinkToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  // 24 bayt -> 32 belgi base64url ([A-Za-z0-9_-]); Telegram /start payload chegarasi 64
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(clock.now().getTime() + LINK_TTL_MS);
  await TelegramLinkToken.deleteMany({ userId });
  await TelegramLinkToken.create({ userId, tokenHash: sha256(token), expiresAt });
  return { token, expiresAt };
}

/** Foydalanuvchining kutilayotgan (yuborilmagan) xabarlarini bekor qiladi */
export async function cancelPending(userId: Types.ObjectId | string, reason: string) {
  await TelegramOutbox.updateMany(
    { userId, status: 'pending' },
    {
      $set: {
        status: 'failed',
        lastError: reason,
        cleanupAt: new Date(Date.now() + 30 * 86_400_000),
      },
    },
  );
}

const CLEAR = {
  'telegram.chatId': null,
  'telegram.username': null,
  'telegram.linkedAt': null,
};

/** Foydalanuvchini Telegramdan uzadi. Ulangan bo'lmasa null, aks holda eski chatId */
export async function unlinkUser(
  userId: Types.ObjectId | string,
  audit?: { actorId: string | null; reason: string; ip?: string },
): Promise<number | null> {
  const user = await User.findOneAndUpdate(
    { _id: userId, 'telegram.chatId': { $ne: null } },
    { $set: CLEAR },
  ).select('+telegram.chatId schoolId');
  const chatId = user?.telegram?.chatId ?? null;
  if (!user || chatId === null) return null;
  await cancelPending(user._id, 'unlinked');
  if (audit) {
    await auditService.log({
      userId: audit.actorId,
      schoolId: user.schoolId?.toString() ?? null,
      action: 'telegram.unlink',
      entity: 'user',
      entityId: user._id.toString(),
      after: { reason: audit.reason },
      ip: audit.ip,
    });
  }
  return chatId;
}

export type LinkResult =
  { ok: true; fullName: string } | { ok: false; reason: 'invalid' | 'inactive' };

/** /start <token>: tokenni bir martalik iste'mol qiladi va chatni foydalanuvchiga ulaydi */
export async function linkChat(
  rawToken: string,
  chat: { chatId: number; username: string | null },
): Promise<LinkResult> {
  const row = await TelegramLinkToken.findOneAndDelete({
    tokenHash: sha256(rawToken),
    expiresAt: { $gt: clock.now() },
  });
  if (!row) return { ok: false, reason: 'invalid' };
  const user = await User.findById(row.userId).select('fullName isActive schoolId');
  if (!user || !user.isActive) return { ok: false, reason: 'inactive' };

  // Bu chat boshqa foydalanuvchiga ulangan bo'lsa — o'sha ulanish ko'chiriladi
  const others = await User.find({
    _id: { $ne: user._id },
    'telegram.chatId': chat.chatId,
  }).select('_id schoolId');
  for (const o of others) {
    await unlinkUser(o._id, { actorId: user._id.toString(), reason: 'chat_moved' });
  }
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'telegram.chatId': chat.chatId,
        'telegram.username': chat.username,
        'telegram.linkedAt': clock.now(),
      },
    },
  );
  await auditService.log({
    userId: user._id.toString(),
    schoolId: user.schoolId?.toString() ?? null,
    action: 'telegram.link',
    entity: 'user',
    entityId: user._id.toString(),
    after: { username: chat.username },
  });
  return { ok: true, fullName: user.fullName };
}
