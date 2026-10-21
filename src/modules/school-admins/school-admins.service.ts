import type { Ctx } from '../../core/context';
import { userManagement, type ListQuery } from '../users/user-management.service';
import { toUserDto } from '../users/user.dto';

export const schoolAdminsService = {
  async list(q: ListQuery & { schoolId?: string }) {
    const { items, meta } = await userManagement.list('school_admin', { schoolId: q.schoolId }, q);
    return { items: items.map(toUserDto), meta };
  },

  async get(id: string) {
    return toUserDto(await userManagement.get('school_admin', id, {}));
  },

  async create(
    ctx: Ctx,
    input: {
      schoolId: string;
      fullName: string;
      username: string;
      password: string;
      permissions: string[];
    },
  ) {
    return toUserDto(await userManagement.create(ctx, { ...input, role: 'school_admin' }));
  },

  async update(ctx: Ctx, id: string, patch: { fullName?: string; isActive?: boolean }) {
    const user = await userManagement.get('school_admin', id, {});
    return toUserDto(await userManagement.update(ctx, user, patch));
  },

  async setPermissions(ctx: Ctx, id: string, permissions: string[]) {
    const user = await userManagement.get('school_admin', id, {});
    return toUserDto(await userManagement.setPermissions(ctx, user, permissions));
  },

  async resetPassword(ctx: Ctx, id: string, newPassword: string) {
    const user = await userManagement.get('school_admin', id, {});
    await userManagement.resetPassword(ctx, user, newPassword);
  },
};
