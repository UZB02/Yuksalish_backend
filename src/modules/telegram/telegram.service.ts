import { AppError } from '../../core/errors';
import type { Ctx } from '../../core/context';
import { TelegramBotConfig } from '../../models/TelegramBotConfig';
import { User } from '../../models/User';
import { auditService } from '../audit/audit.service';
import { TelegramApiError } from './telegram.client';
import { encryptToken } from './telegram.crypto';
import { issueLinkToken, unlinkUser } from './telegram.link.service';
import { resolveToken, telegramManager, TOKEN_REENTER_MESSAGE } from './telegram.manager';
import { enqueueMany } from './telegram.outbox';

export const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
export const NOT_CONFIGURED_MESSAGE = 'Telegram bot hozircha sozlanmagan';
const BAD_TOKEN_MESSAGE = "Token noto'g'ri yoki bot topilmadi";

export interface ConfigDto {
  configured: boolean;
  source: 'db' | 'env' | null;
  enabled: boolean;
  tokenLast4: string | null;
  botUsername: string | null;
  botName: string | null;
  status: 'running' | 'stopped' | 'error';
  lastError: string | null;
  updatedAt: string | null;
}

export interface MeDto {
  available: boolean;
  botUsername: string | null;
  linked: boolean;
  username: string | null;
  linkedAt: string | null;
}

export async function getConfigDto(): Promise<ConfigDto> {
  const r = await resolveToken();
  const m = telegramManager;
  let status = m.status;
  let lastError = m.lastError;
  // Manager hali reload qilinmagan bo'lsa ham dekripsiya xatosini ko'rsatamiz
  if (r.decryptError && status !== 'running') {
    status = 'error';
    lastError = TOKEN_REENTER_MESSAGE;
  }
  return {
    configured: r.configured,
    source: r.source,
    enabled: r.enabled,
    tokenLast4: r.tokenLast4,
    botUsername: r.source === 'db' ? (r.botUsername ?? m.botUsername) : m.botUsername,
    botName: r.source === 'db' ? (r.botName ?? m.botName) : m.botName,
    status,
    lastError,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}

const badToken = (message = BAD_TOKEN_MESSAGE) =>
  AppError.validation("Ma'lumotlar noto'g'ri", [{ path: 'token', message }]);

async function verifyToken(token: string) {
  if (!TOKEN_RE.test(token)) throw badToken();
  try {
    return await telegramManager.createClient(token).getMe();
  } catch (err) {
    if (err instanceof TelegramApiError && !err.network) throw badToken();
    throw AppError.badGateway(
      "Telegram bilan bog'lanib bo'lmadi. Birozdan so'ng qayta urinib ko'ring",
    );
  }
}

export const telegramService = {
  getConfig: getConfigDto,

  async updateConfig(ctx: Ctx, body: { token?: string; enabled?: boolean }): Promise<ConfigDto> {
    const current = await resolveToken();
    const set: Record<string, unknown> = { updatedBy: ctx.actor.id };
    if (body.token !== undefined) {
      const info = await verifyToken(body.token);
      Object.assign(set, {
        tokenEnc: encryptToken(body.token),
        tokenLast4: body.token.slice(-4),
        botUsername: info.username,
        botName: info.name,
      });
      if (body.enabled === undefined) set.enabled = true;
    } else if (body.enabled === true && (!current.configured || current.decryptError)) {
      throw badToken('Avval bot tokenini kiriting');
    }
    if (body.enabled !== undefined) set.enabled = body.enabled;
    await TelegramBotConfig.findOneAndUpdate(
      { key: 'platform' },
      { $set: set, $setOnInsert: { key: 'platform' } },
      { upsert: true },
    );
    await telegramManager.reload();
    const dto = await getConfigDto();
    await auditService.log({
      userId: ctx.actor.id,
      action: 'telegram.config.update',
      entity: 'telegram_config',
      entityId: 'platform',
      before: { enabled: current.enabled, tokenLast4: current.tokenLast4, source: current.source },
      after: {
        tokenChanged: body.token !== undefined,
        enabled: dto.enabled,
        tokenLast4: dto.tokenLast4,
        botUsername: dto.botUsername,
      },
      ip: ctx.ip,
    });
    return dto;
  },

  async deleteConfig(ctx: Ctx): Promise<ConfigDto> {
    const before = await resolveToken();
    await TelegramBotConfig.deleteOne({ key: 'platform' });
    await telegramManager.reload();
    await auditService.log({
      userId: ctx.actor.id,
      action: 'telegram.config.delete',
      entity: 'telegram_config',
      entityId: 'platform',
      before: { enabled: before.enabled, tokenLast4: before.tokenLast4, source: before.source },
      ip: ctx.ip,
    });
    return getConfigDto();
  },

  async me(userId: string): Promise<MeDto> {
    const u = await User.findById(userId).select('+telegram.chatId');
    const linked = typeof u?.telegram?.chatId === 'number';
    const running = telegramManager.isRunning();
    return {
      available: running,
      botUsername: running ? telegramManager.botUsername : null,
      linked,
      username: linked ? (u?.telegram.username ?? null) : null,
      linkedAt: linked ? (u?.telegram.linkedAt?.toISOString() ?? null) : null,
    };
  },

  async issueLink(userId: string): Promise<{ url: string; expiresAt: string }> {
    if (!telegramManager.isRunning() || !telegramManager.botUsername) {
      throw AppError.unavailable(NOT_CONFIGURED_MESSAGE);
    }
    const { token, expiresAt } = await issueLinkToken(userId);
    return {
      url: `https://t.me/${telegramManager.botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  },

  async unlinkMe(ctx: Ctx): Promise<MeDto> {
    const chatId = await unlinkUser(ctx.actor.id, {
      actorId: ctx.actor.id,
      reason: 'user',
      ip: ctx.ip,
    });
    if (chatId !== null) {
      // Uzilgandan keyin tasdiq xabari (chatId aniq beriladi, foydalanuvchi qidirilmaydi)
      await enqueueMany([
        { userId: ctx.actor.id, chatId, kind: 'unlink', text: 'Hisobingiz Telegramdan uzildi.' },
      ]);
    }
    return this.me(ctx.actor.id);
  },
};
