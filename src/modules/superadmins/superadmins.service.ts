import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { User, type UserDoc } from '../../models/User';
import { isDuplicateKeyError, isId } from '../../utils/helpers';
import { hashPassword } from '../../utils/password';
import { auditService } from '../audit/audit.service';
import { authService } from '../auth/auth.service';
import { refreshTokenService } from '../auth/refresh-token.service';
import { syncUserCommands } from '../telegram/telegram.commands';

const OWNER_ONLY = 'Bu amal faqat asosiy superadmin uchun';

const toDto = (u: UserDoc) => ({
  id: u.id,
  fullName: u.fullName,
  username: u.username,
  isActive: u.isActive,
  isOwner: !!u.isOwner,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

const snapshot = (u: UserDoc) => ({
  fullName: u.fullName,
  username: u.username,
  isActive: u.isActive,
  isOwner: !!u.isOwner,
});

/**
 * Chaqiruvchi asosiy superadmin ekanini va joriy parolini tekshiradi (barcha boshqaruv amallari uchun).
 * Avval 403 (owner emas), keyin parol (noto'g'ri bo'lsa login bilan bir xil bloklash hisobiga yoziladi).
 */
async function requireOwner(ctx: Ctx, currentPassword: string): Promise<UserDoc> {
  const actor = await User.findById(ctx.actor.id).select('+passwordHash');
  if (!actor || actor.role !== 'superadmin' || !actor.isOwner) {
    throw AppError.forbidden(OWNER_ONLY);
  }
  await authService.verifyCurrentPassword(actor, currentPassword, ctx.ip);
  return actor;
}

async function getTarget(id: string): Promise<UserDoc> {
  const notFound = AppError.notFound('Superadmin topilmadi');
  if (!isId(id)) throw notFound;
  const user = await User.findOne({ _id: id, role: 'superadmin' });
  if (!user) throw notFound;
  return user;
}

export const superadminsService = {
  /** Barcha superadminlar (asosiy birinchi, keyin qo'shilish tartibida) */
  async list() {
    const items = await User.find({ role: 'superadmin' }).sort({
      isOwner: -1,
      createdAt: 1,
      _id: 1,
    });
    return items.map(toDto);
  },

  async create(
    ctx: Ctx,
    input: { fullName: string; username: string; password: string; currentPassword: string },
  ) {
    await requireOwner(ctx, input.currentPassword);
    const taken = AppError.conflict('Bu login band', [
      { path: 'username', message: 'Bu login band' },
    ]);
    if (await User.exists({ username: input.username })) throw taken;

    let user: UserDoc;
    try {
      user = await User.create({
        role: 'superadmin',
        schoolId: null,
        isOwner: false,
        fullName: input.fullName,
        username: input.username,
        permissions: [],
        passwordHash: await hashPassword(input.password),
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw taken;
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      action: 'superadmin.create',
      entity: 'user',
      entityId: user.id,
      after: snapshot(user),
      ip: ctx.ip,
    });
    return toDto(user);
  },

  async update(
    ctx: Ctx,
    id: string,
    patch: { isActive?: boolean; password?: string; fullName?: string; currentPassword: string },
  ) {
    const actor = await requireOwner(ctx, patch.currentPassword);
    const user = await getTarget(id);
    if (user.id === actor.id && patch.isActive === false) {
      throw AppError.forbidden("O'zingizni nofaol qila olmaysiz");
    }
    if (user.isOwner) {
      throw AppError.forbidden("Asosiy superadminni bu yerda o'zgartirib bo'lmaydi");
    }

    const before = snapshot(user);
    if (patch.fullName !== undefined) user.fullName = patch.fullName;
    if (patch.isActive !== undefined) user.isActive = patch.isActive;
    if (patch.password !== undefined) {
      user.passwordHash = await hashPassword(patch.password);
      user.passwordChangedAt = new Date();
      user.failedLoginCount = 0;
      user.lockUntil = null;
    }
    await user.save();
    // Nofaol qilingan yoki paroli tiklangan superadminning barcha sessiyalari bekor qilinadi
    if (patch.isActive === false || patch.password !== undefined) {
      await refreshTokenService.revokeAll(user.id);
    }
    if (patch.isActive !== undefined && patch.isActive !== before.isActive) {
      await syncUserCommands(user.id);
    }
    await auditService.log({
      userId: ctx.actor.id,
      action: 'superadmin.update',
      entity: 'user',
      entityId: user.id,
      before,
      after: {
        ...snapshot(user),
        ...(patch.password !== undefined ? { passwordReset: true } : {}),
      },
      ip: ctx.ip,
    });
    return toDto(user);
  },

  /**
   * Asosiylikni topshirish. Tranzaksiyasiz, lekin "nol owner" holati qolmasligi uchun:
   *  1) unique indeks (isOwner:true) ikkita owner bo'lishiga DB darajasida yo'l qo'ymaydi,
   *     shuning uchun avval o'zidan belgi olinadi (shart: hali owner),
   *  2) keyin nishonga yoziladi (shart: faol superadmin). Muvaffaqiyatsiz bo'lsa yoki xato
   *     ko'tarilsa — 3) belgi o'ziga qaytariladi (rollback).
   *  Jarayon 1 va 2 orasida o'lib qolsa, ishga tushishda ensureOwnerSuperadmin() eng eski
   *  faol superadminni owner qilib tiklaydi.
   */
  async transferOwnership(ctx: Ctx, id: string, currentPassword: string) {
    const actor = await requireOwner(ctx, currentPassword);
    const target = await getTarget(id);
    if (target.id === actor.id) {
      throw AppError.validation("Asosiylikni o'zingizga topshira olmaysiz");
    }
    if (!target.isActive) {
      throw AppError.validation('Asosiylik faqat faol superadminga topshiriladi');
    }

    const released = await User.updateOne(
      { _id: actor._id, isOwner: true },
      { $set: { isOwner: false } },
    );
    if (!released.modifiedCount) throw AppError.forbidden(OWNER_ONLY);

    let assigned = false;
    try {
      const r = await User.updateOne(
        { _id: target._id, role: 'superadmin', isActive: true },
        { $set: { isOwner: true } },
      );
      assigned = r.modifiedCount === 1;
    } finally {
      if (!assigned) await User.updateOne({ _id: actor._id }, { $set: { isOwner: true } });
    }
    if (!assigned)
      throw AppError.validation("Asosiylikni topshirib bo'lmadi. Qayta urinib ko'ring");

    await auditService.log({
      userId: ctx.actor.id,
      action: 'superadmin.transfer',
      entity: 'user',
      entityId: target.id,
      before: { ownerId: actor.id, ownerUsername: actor.username },
      after: { ownerId: target.id, ownerUsername: target.username },
      ip: ctx.ip,
    });
    const fresh = await User.find({ _id: { $in: [actor._id, target._id] } });
    return fresh.map(toDto);
  },
};
