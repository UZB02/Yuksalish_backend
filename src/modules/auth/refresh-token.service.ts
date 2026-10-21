import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { ReqMeta } from '../../core/context';
import { RefreshToken } from '../../models/RefreshToken';
import { auditService } from '../audit/audit.service';
import { generateRefreshToken, hashToken } from './tokens';

// Parallel so'rovlar (bir nechta tab) tasodifan sessiyani o'chirib yubormasligi uchun
const REUSE_GRACE_MS = 10_000;

export const refreshTokenService = {
  async issue(userId: string, meta: ReqMeta): Promise<string> {
    const raw = generateRefreshToken();
    await RefreshToken.create({
      userId: new Types.ObjectId(userId),
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
    });
    return raw;
  },

  /** Tokenni almashtirish (rotatsiya). Eski token qayta ishlatilsa — barcha sessiyalar bekor. */
  async rotate(raw: string, meta: ReqMeta): Promise<{ userId: string; refreshToken: string }> {
    const invalid = () => AppError.unauthorized('Sessiya yaroqsiz. Qaytadan kiring');
    const doc = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
    if (!doc) throw invalid();

    if (doc.rotatedAt) {
      if (Date.now() - doc.rotatedAt.getTime() > REUSE_GRACE_MS) {
        await this.revokeAll(String(doc.userId));
        await auditService.log({
          userId: String(doc.userId),
          action: 'auth.refresh_reuse',
          entity: 'user',
          entityId: String(doc.userId),
          ip: meta.ip,
        });
      }
      throw invalid();
    }
    if (doc.revokedAt || doc.expiresAt.getTime() <= Date.now()) throw invalid();

    // Atomik "egallash": parallel ikki so'rovdan faqat bittasi o'tadi
    const now = new Date();
    const claimed = await RefreshToken.findOneAndUpdate(
      { _id: doc._id, revokedAt: null, rotatedAt: null },
      { revokedAt: now, rotatedAt: now },
    );
    if (!claimed) throw invalid();

    const userId = String(doc.userId);
    return { userId, refreshToken: await this.issue(userId, meta) };
  },

  async revokeByRaw(raw: string): Promise<void> {
    await RefreshToken.updateOne(
      { tokenHash: hashToken(raw), revokedAt: null },
      { revokedAt: new Date() },
    );
  },

  /** Foydalanuvchining barcha (yoki exceptRaw dan boshqa) sessiyalarini bekor qiladi */
  async revokeAll(userId: string, exceptRaw?: string): Promise<void> {
    const filter: Record<string, unknown> = { userId, revokedAt: null };
    if (exceptRaw) filter.tokenHash = { $ne: hashToken(exceptRaw) };
    await RefreshToken.updateMany(filter, { revokedAt: new Date() });
  },
};
