import { env } from '../../config/env';
import type { Ctx, ReqMeta } from '../../core/context';
import { AppError } from '../../core/errors';
import { School } from '../../models/School';
import { User } from '../../models/User';
import { comparePassword, dummyCompare, hashPassword } from '../../utils/password';
import { auditService } from '../audit/audit.service';
import { toUserDto } from '../users/user.dto';
import { refreshTokenService } from './refresh-token.service';
import { signAccessToken } from './tokens';

const INVALID_CREDENTIALS = "Login yoki parol noto'g'ri";

export const authService = {
  async login(input: { username: string; password: string }, meta: ReqMeta) {
    const user = await User.findOne({ username: input.username }).select('+passwordHash');
    if (!user) {
      await dummyCompare(input.password);
      throw AppError.unauthorized(INVALID_CREDENTIALS);
    }

    if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockUntil.getTime() - Date.now()) / 60_000);
      throw AppError.rateLimited(
        `Juda ko'p xato urinish. ${mins} daqiqadan so'ng qayta urinib ko'ring`,
      );
    }

    if (!(await comparePassword(input.password, user.passwordHash))) {
      await this.registerFailure(user.id, meta);
      throw AppError.unauthorized(INVALID_CREDENTIALS);
    }

    if (!user.isActive)
      throw AppError.forbidden('Hisobingiz faol emas. Administratorga murojaat qiling');
    if (user.schoolId) {
      const school = await School.findById(user.schoolId).select('isActive');
      if (!school?.isActive)
        throw AppError.forbidden('Maktab faol emas. Administratorga murojaat qiling');
    }

    user.failedLoginCount = 0;
    user.lockUntil = null;
    user.lastLoginAt = new Date();
    await user.save();

    const refreshToken = await refreshTokenService.issue(user.id, meta);
    await auditService.log({
      userId: user.id,
      schoolId: user.schoolId ? String(user.schoolId) : null,
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      ip: meta.ip,
    });
    return { accessToken: signAccessToken(user), refreshToken, user: toUserDto(user) };
  },

  /** Xato urinishni hisoblaydi; limitga yetsa bloklaydi */
  async registerFailure(userId: string, meta: ReqMeta) {
    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { failedLoginCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!user) return;
    if (user.failedLoginCount >= env.LOGIN_MAX_ATTEMPTS) {
      user.failedLoginCount = 0;
      user.lockUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000);
      await user.save();
      await auditService.log({
        userId,
        schoolId: user.schoolId ? String(user.schoolId) : null,
        action: 'auth.locked',
        entity: 'user',
        entityId: userId,
        ip: meta.ip,
      });
    }
  },

  async refresh(rawToken: string | undefined, meta: ReqMeta) {
    if (!rawToken) throw AppError.unauthorized('Sessiya topilmadi');
    const { userId, refreshToken } = await refreshTokenService.rotate(rawToken, meta);

    const user = await User.findById(userId);
    let schoolOk = true;
    if (user?.schoolId) schoolOk = !!(await School.exists({ _id: user.schoolId, isActive: true }));
    if (!user || !user.isActive || !schoolOk) {
      await refreshTokenService.revokeAll(userId);
      throw AppError.unauthorized('Hisob nofaol');
    }
    return { accessToken: signAccessToken(user), refreshToken, user: toUserDto(user) };
  },

  async logout(rawToken: string | undefined) {
    if (rawToken) await refreshTokenService.revokeByRaw(rawToken);
  },

  async logoutAll(ctx: Ctx) {
    await refreshTokenService.revokeAll(ctx.actor.id);
  },

  async me(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw AppError.unauthorized();
    return toUserDto(user);
  },

  async changePassword(
    ctx: Ctx,
    input: { currentPassword: string; newPassword: string },
    currentRefreshRaw: string | undefined,
  ) {
    const user = await User.findById(ctx.actor.id).select('+passwordHash');
    if (!user) throw AppError.unauthorized();

    if (!(await comparePassword(input.currentPassword, user.passwordHash))) {
      throw AppError.validation("Joriy parol noto'g'ri", [
        { path: 'currentPassword', message: "Joriy parol noto'g'ri" },
      ]);
    }
    if (input.currentPassword === input.newPassword) {
      throw AppError.validation('Yangi parol joriy paroldan farq qilishi kerak', [
        { path: 'newPassword', message: 'Yangi parol joriy parol bilan bir xil' },
      ]);
    }

    user.passwordHash = await hashPassword(input.newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
    // Joriy qurilmadan boshqa barcha sessiyalar bekor qilinadi
    await refreshTokenService.revokeAll(user.id, currentRefreshRaw);

    await auditService.log({
      userId: user.id,
      schoolId: ctx.actor.schoolId,
      action: 'auth.password_change',
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
    // Eski access token yaroqsiz bo'lgani uchun yangisi beriladi
    return { accessToken: signAccessToken(user) };
  },
};
