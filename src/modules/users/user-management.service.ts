import { permissionsForRole, TEACHER_BASE_PERMISSIONS } from '../../constants/permissions';
import type { Role } from '../../constants/roles';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { School } from '../../models/School';
import { User, type UserDoc } from '../../models/User';
import { escapeRegex, isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { hashPassword } from '../../utils/password';
import { auditService } from '../audit/audit.service';
import { refreshTokenService } from '../auth/refresh-token.service';

export type ManagedRole = Exclude<Role, 'superadmin'>;

const LABEL: Record<ManagedRole, string> = {
  school_admin: 'Maktab administratori',
  teacher: "O'qituvchi",
};

const snapshot = (u: UserDoc) => ({
  fullName: u.fullName,
  username: u.username,
  phone: u.phone,
  isActive: u.isActive,
  permissions: u.permissions,
  schoolId: u.schoolId ? String(u.schoolId) : null,
});

/** Ruxsat kalitlari rol katalogiga mos ekanini tekshiradi */
export function assertPermissionsValid(role: ManagedRole, perms: string[]): string[] {
  const allowed = permissionsForRole(role);
  const bad = perms.filter((p) => !allowed.includes(p));
  if (bad.length) {
    throw AppError.validation("Ruxsatlar ro'yxati noto'g'ri", [
      { path: 'permissions', message: `${LABEL[role]} uchun mavjud emas: ${bad.join(', ')}` },
    ]);
  }
  return uniq(perms);
}

/** Maktab admini o'zida yo'q ruxsatni bera olmaydi (yangi qo'shilayotganlar bo'yicha) */
export function assertNoEscalation(actor: Ctx['actor'], next: string[], current: string[] = []) {
  if (actor.role === 'superadmin') return;
  const denied = next.filter(
    (p) =>
      !current.includes(p) &&
      !TEACHER_BASE_PERMISSIONS.includes(p) &&
      !actor.permissions.includes(p),
  );
  if (denied.length)
    throw AppError.forbidden(`O'zingizda yo'q ruxsatni bera olmaysiz: ${denied.join(', ')}`);
}

export interface ListQuery {
  page: number;
  limit: number;
  search?: string;
  isActive?: boolean;
}

export const userManagement = {
  async list(role: ManagedRole, scope: { schoolId?: string }, q: ListQuery) {
    const filter: Record<string, unknown> = { role };
    if (scope.schoolId) filter.schoolId = scope.schoolId;
    if (q.isActive !== undefined) filter.isActive = q.isActive;
    if (q.search) {
      const re = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ fullName: re }, { username: re }];
    }
    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      User.countDocuments(filter),
    ]);
    return { items, meta: buildMeta(q.page, q.limit, total) };
  },

  /** Boshqa maktab yoki boshqa rol bo'lsa ham 404 (mavjudligi oshkor qilinmaydi) */
  async get(role: ManagedRole, id: string, scope: { schoolId?: string }): Promise<UserDoc> {
    const notFound = AppError.notFound(`${LABEL[role]} topilmadi`);
    if (!isId(id)) throw notFound;
    const filter: Record<string, unknown> = { _id: id, role };
    if (scope.schoolId) filter.schoolId = scope.schoolId;
    const user = await User.findOne(filter);
    if (!user) throw notFound;
    return user;
  },

  async create(
    ctx: Ctx,
    input: {
      role: ManagedRole;
      schoolId: string;
      fullName: string;
      username: string;
      password: string;
      phone?: string | null;
      permissions: string[];
    },
  ): Promise<UserDoc> {
    const permissions = assertPermissionsValid(input.role, input.permissions);
    if (input.role === 'teacher') assertNoEscalation(ctx.actor, permissions);

    const school = isId(input.schoolId) ? await School.findById(input.schoolId) : null;
    if (!school) {
      throw AppError.validation('Maktab topilmadi', [
        { path: 'schoolId', message: 'Maktab topilmadi' },
      ]);
    }
    const usernameTaken = AppError.conflict('Bu login band', [
      { path: 'username', message: 'Bu login band' },
    ]);
    if (await User.exists({ username: input.username })) throw usernameTaken;

    let user: UserDoc;
    try {
      user = await User.create({
        schoolId: school._id,
        role: input.role,
        fullName: input.fullName,
        username: input.username,
        phone: input.phone ?? null,
        permissions,
        passwordHash: await hashPassword(input.password),
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw usernameTaken;
      throw e;
    }

    await auditService.log({
      userId: ctx.actor.id,
      schoolId: String(school._id),
      action: `${input.role}.create`,
      entity: 'user',
      entityId: user.id,
      after: snapshot(user),
      ip: ctx.ip,
    });
    return user;
  },

  async update(
    ctx: Ctx,
    user: UserDoc,
    patch: { fullName?: string; phone?: string | null; isActive?: boolean },
  ) {
    const before = snapshot(user);
    if (patch.fullName !== undefined) user.fullName = patch.fullName;
    if (patch.phone !== undefined) user.phone = patch.phone;
    if (patch.isActive !== undefined) user.isActive = patch.isActive;
    await user.save();
    if (patch.isActive === false) await refreshTokenService.revokeAll(user.id);

    await auditService.log({
      userId: ctx.actor.id,
      schoolId: user.schoolId ? String(user.schoolId) : null,
      action: `${user.role}.update`,
      entity: 'user',
      entityId: user.id,
      before,
      after: snapshot(user),
      ip: ctx.ip,
    });
    return user;
  },

  async setPermissions(ctx: Ctx, user: UserDoc, perms: string[]) {
    const role = user.role as ManagedRole;
    const next = assertPermissionsValid(role, perms);
    if (role === 'teacher') assertNoEscalation(ctx.actor, next, user.permissions);

    const before = user.permissions;
    user.permissions = next;
    await user.save();

    await auditService.log({
      userId: ctx.actor.id,
      schoolId: user.schoolId ? String(user.schoolId) : null,
      action: `${role}.permissions`,
      entity: 'user',
      entityId: user.id,
      before: { permissions: before },
      after: { permissions: next },
      ip: ctx.ip,
    });
    return user;
  },

  async resetPassword(ctx: Ctx, user: UserDoc, newPassword: string) {
    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    user.failedLoginCount = 0;
    user.lockUntil = null;
    await user.save();
    await refreshTokenService.revokeAll(user.id);

    await auditService.log({
      userId: ctx.actor.id,
      schoolId: user.schoolId ? String(user.schoolId) : null,
      action: `${user.role}.password_reset`,
      entity: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
  },
};
