import type { Ctx } from '../../core/context';
import type { UserDoc } from '../../models/User';
import { classesService } from '../classes/classes.service';
import { userManagement, type ListQuery } from '../users/user-management.service';
import { toUserDto } from '../users/user.dto';

/** Teacher DTO + faol yil sinflari */
async function withClasses(schoolId: string, users: UserDoc[]) {
  const map = await classesService.classesOfTeachers(
    schoolId,
    users.map((u) => u.id),
  );
  return users.map((u) => ({ ...toUserDto(u), classes: map.get(u.id) ?? [] }));
}

// Barcha amallar req.schoolId (tenant) bilan cheklanadi
export const teachersService = {
  async list(schoolId: string, q: ListQuery) {
    const { items, meta } = await userManagement.list('teacher', { schoolId }, q);
    return { items: await withClasses(schoolId, items), meta };
  },

  async get(schoolId: string, id: string) {
    const user = await userManagement.get('teacher', id, { schoolId });
    return (await withClasses(schoolId, [user]))[0];
  },

  async create(
    ctx: Ctx,
    schoolId: string,
    input: {
      fullName: string;
      username: string;
      password: string;
      phone?: string | null;
      permissions: string[];
    },
  ) {
    const user = await userManagement.create(ctx, { ...input, role: 'teacher', schoolId });
    return (await withClasses(schoolId, [user]))[0];
  },

  async update(
    ctx: Ctx,
    schoolId: string,
    id: string,
    patch: { fullName?: string; phone?: string | null; isActive?: boolean },
  ) {
    const user = await userManagement.get('teacher', id, { schoolId });
    await userManagement.update(ctx, user, patch);
    return (await withClasses(schoolId, [user]))[0];
  },

  async setPermissions(ctx: Ctx, schoolId: string, id: string, permissions: string[]) {
    const user = await userManagement.get('teacher', id, { schoolId });
    await userManagement.setPermissions(ctx, user, permissions);
    return (await withClasses(schoolId, [user]))[0];
  },

  async setClasses(ctx: Ctx, schoolId: string, id: string, classIds: string[]) {
    const user = await userManagement.get('teacher', id, { schoolId });
    await classesService.setTeacherClasses(ctx, schoolId, user, classIds);
    return (await withClasses(schoolId, [user]))[0];
  },

  async resetPassword(ctx: Ctx, schoolId: string, id: string, newPassword: string) {
    const user = await userManagement.get('teacher', id, { schoolId });
    await userManagement.resetPassword(ctx, user, newPassword);
  },
};
