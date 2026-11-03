import crypto from 'crypto';
import { logger } from '../../core/logger';
import type { ReqMeta } from '../../core/context';
import { AppError } from '../../core/errors';
import { PasswordResetCode } from '../../models/PasswordResetCode';
import { School } from '../../models/School';
import { User } from '../../models/User';
import { clock } from '../../utils/clock';
import { hashPassword } from '../../utils/password';
import { auditService } from '../audit/audit.service';
import { telegramManager } from '../telegram/telegram.manager';
import { telegramNotify } from '../telegram/telegram.outbox';
import { refreshTokenService } from './refresh-token.service';

export const RESET_CODE_TTL_MS = 10 * 60_000;
export const RESET_TOKEN_TTL_MS = 10 * 60_000;
export const RESET_RESEND_COOLDOWN_MS = 60_000;
export const RESET_MAX_ATTEMPTS = 5;

const INVALID_CODE = "Kod noto'g'ri yoki muddati o'tgan";
const CODE_CANCELLED = "Kod bekor qilindi, yangi kod so'rang";
const INVALID_SESSION = "Tiklash sessiyasi yaroqsiz yoki muddati o'tgan. Qaytadan boshlang";

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const codeHashOf = (userId: string, code: string) => sha256(`${userId}:${code}`);

const safeEqual = (a: string, b: string) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** "03.11.2026 14:05" (Asia/Tashkent, UTC+5) */
function formatTashkent(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000).toISOString();
  return `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)} ${t.slice(11, 16)}`;
}

/** Fonda ketayotgan yuborishlar (javob kechikmasligi uchun; testlar kutib oladi) */
const pending = new Set<Promise<void>>();

/**
 * Xabarni darhol botdan yuboradi; bo'lmasa (xato) outbox navbatiga qo'yadi. Hech qachon tashlamaydi.
 * Kod xabari muddati qisqa bo'lgani uchun darhol yuboriladi (outbox ~2s kechikadi).
 */
async function deliver(userId: string, chatId: number, text: string, kind: string): Promise<void> {
  try {
    const client = telegramManager.getClient();
    if (client) {
      await client.sendMessage(chatId, text, { parseMode: 'HTML' });
      return;
    }
  } catch (err) {
    logger.warn({ err: String(err), kind }, 'Parol tiklash xabarini darhol yuborib bo‘lmadi');
  }
  await telegramNotify.enqueue({ userId, chatId, text, kind, parseMode: 'HTML' });
}

export const passwordResetService = {
  /** Faqat testlar uchun: fonda yuborilayotgan xabarlarni kutadi */
  async flush(): Promise<void> {
    await Promise.all([...pending]);
  },

  /** Ommaviy ma'lumot: foydalanuvchi ma'lumotisiz */
  info() {
    const available = telegramManager.isRunning();
    return { available, botUsername: available ? telegramManager.botUsername : null };
  },

  /**
   * Kod so'rash. Har doim bir xil javob (foydalanuvchi bormi/faolmi/ulanganmi/bot ishlayaptimi — sezdirmaydi).
   * Xabar fonda yuboriladi, shuning uchun javob vaqti ham farq qilmaydi.
   */
  async request(username: string): Promise<{ sent: true }> {
    const user = await User.findOne({ username }).select('+telegram.chatId');
    const chatId = user?.telegram?.chatId ?? null;
    if (!user || !user.isActive || chatId === null || !telegramManager.isRunning()) {
      return { sent: true };
    }
    if (user.schoolId) {
      const school = await School.findById(user.schoolId).select('isActive');
      if (!school?.isActive) return { sent: true };
    }

    const now = clock.now();
    const last = await PasswordResetCode.findOne({ userId: user._id })
      .sort({ createdAt: -1 })
      .select('createdAt');
    if (last && now.getTime() - last.createdAt.getTime() < RESET_RESEND_COOLDOWN_MS) {
      return { sent: true };
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await PasswordResetCode.deleteMany({ userId: user._id });
    await PasswordResetCode.create({
      userId: user._id,
      codeHash: codeHashOf(user.id, code),
      expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MS),
    });

    const text =
      `🔐 Yuksalish EDU: parolni tiklash kodi: <b>${code}</b>\n` +
      `Kod 10 daqiqa amal qiladi. Agar bu siz bo'lmasangiz, ushbu xabarga e'tibor bermang va parolingizni hech kimga aytmang.`;
    const p: Promise<void> = deliver(user.id, chatId, text, 'password_reset_code').finally(() => {
      pending.delete(p);
    });
    pending.add(p);
    return { sent: true };
  },

  /** Kodni tekshiradi; to'g'ri bo'lsa bir martalik resetToken beradi */
  async verify(input: { username: string; code: string }): Promise<{ resetToken: string }> {
    const invalid = () => AppError.validation(INVALID_CODE);
    const user = await User.findOne({ username: input.username }).select('_id');
    if (!user) throw invalid();

    const now = clock.now();
    const live = { userId: user._id, usedAt: null, verifiedAt: null, expiresAt: { $gt: now } };
    // Urinish avval atomik hisoblanadi (parallel taxminlar chegaradan oshib ketmasin)
    const doc = await PasswordResetCode.findOneAndUpdate(
      { ...live, attempts: { $lt: RESET_MAX_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      const exhausted = await PasswordResetCode.findOneAndUpdate(live, { $set: { usedAt: now } });
      throw exhausted ? AppError.validation(CODE_CANCELLED) : invalid();
    }

    if (!safeEqual(doc.codeHash, codeHashOf(user.id, input.code))) {
      if (doc.attempts >= RESET_MAX_ATTEMPTS) {
        await PasswordResetCode.updateOne({ _id: doc._id }, { $set: { usedAt: now } });
        throw AppError.validation(CODE_CANCELLED);
      }
      throw invalid();
    }

    const resetToken = crypto.randomBytes(32).toString('base64url');
    const claimed = await PasswordResetCode.findOneAndUpdate(
      { _id: doc._id, usedAt: null, verifiedAt: null },
      {
        $set: {
          verifiedAt: now,
          resetTokenHash: sha256(resetToken),
          resetTokenExpiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
        },
      },
    );
    if (!claimed) throw invalid();
    return { resetToken };
  },

  /** Yangi parolni o'rnatadi; resetToken bir martalik */
  async complete(input: { resetToken: string; password: string }, meta: ReqMeta) {
    const now = clock.now();
    const invalid = () =>
      AppError.validation(INVALID_SESSION, [{ path: 'resetToken', message: INVALID_SESSION }]);
    // Atomik "egallash": parallel ikki so'rovdan faqat bittasi o'tadi
    const doc = await PasswordResetCode.findOneAndUpdate(
      {
        resetTokenHash: sha256(input.resetToken),
        usedAt: null,
        resetTokenExpiresAt: { $gt: now },
      },
      { $set: { usedAt: now } },
    );
    if (!doc) throw invalid();

    const user = await User.findById(doc.userId).select('+passwordHash +telegram.chatId');
    if (!user || !user.isActive) throw invalid();
    if (user.schoolId) {
      const school = await School.findById(user.schoolId).select('isActive');
      if (!school?.isActive) throw invalid();
    }

    user.passwordHash = await hashPassword(input.password);
    user.passwordChangedAt = now;
    user.failedLoginCount = 0;
    user.lockUntil = null;
    await user.save();
    // passwordChangedAt o'zgargani uchun eski access tokenlar ham yaroqsiz (authenticate: pv)
    await refreshTokenService.revokeAll(user.id);

    await auditService.log({
      userId: user.id,
      schoolId: user.schoolId ? String(user.schoolId) : null,
      action: 'user.password_reset_self',
      entity: 'user',
      entityId: user.id,
      ip: meta.ip,
    });

    const chatId = user.telegram?.chatId ?? null;
    if (chatId !== null) {
      await deliver(
        user.id,
        chatId,
        `✅ Parolingiz o'zgartirildi (${formatTashkent(now)}). Agar bu siz bo'lmasangiz, darhol administratorga murojaat qiling.`,
        'password_reset_done',
      );
    }
    return { reset: true as const };
  },
};
