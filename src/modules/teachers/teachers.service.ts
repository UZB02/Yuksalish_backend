import type { Ctx } from '../../core/context';
import { AcademicYear } from '../../models/AcademicYear';
import type { UserDoc } from '../../models/User';
import { ClassModel } from '../../models/Class';
import { assignmentsOfTeachers } from '../classes/class-subjects.service';
import { classesService } from '../classes/classes.service';
import { userManagement, type ListQuery } from '../users/user-management.service';
import { photosService } from '../photos/photos.service';
import { toUserDto } from '../users/user.dto';

/** {teacherId -> sinf rahbari bo'lgan sinflar} (faol yil, arxivlanmagan) */
async function homeroomClassesOf(schoolId: string, teacherIds: string[]) {
  const map = new Map<string, { id: string; name: string }[]>();
  if (!teacherIds.length) return map;
  const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  if (!year) return map;
  const classes = await ClassModel.find({
    schoolId,
    academicYearId: year._id,
    isArchived: false,
    homeroomTeacherId: { $in: teacherIds },
  })
    .sort({ grade: 1, name: 1 })
    .select('name homeroomTeacherId');
  for (const c of classes) {
    const key = String(c.homeroomTeacherId);
    map.set(key, [...(map.get(key) ?? []), { id: c.id as string, name: c.name }]);
  }
  return map;
}

/** Teacher DTO + faol yil sinflari */
async function withClasses(schoolId: string, users: UserDoc[]) {
  const ids = users.map((u) => u.id as string);
  const [map, assignments, homerooms] = await Promise.all([
    classesService.classesOfTeachers(schoolId, ids),
    assignmentsOfTeachers(schoolId, ids),
    homeroomClassesOf(schoolId, ids),
  ]);
  return users.map((u) => ({
    ...toUserDto(u),
    classes: map.get(u.id) ?? [],
    /** Faol yildagi sinf+fan biriktirishlari */
    subjectAssignments: assignments.get(u.id) ?? [],
    /** Sinf rahbari bo'lgan sinflar (xulq bahosi qo'yadi) */
    homeroomClasses: homerooms.get(u.id) ?? [],
  }));
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

  async setPhoto(ctx: Ctx, schoolId: string, id: string, file: Express.Multer.File | undefined) {
    const user = await userManagement.get('teacher', id, { schoolId });
    await photosService.set(
      ctx,
      { schoolId, ownerType: 'user', owner: user, auditPrefix: 'teacher', auditEntity: 'user' },
      file,
    );
    return (await withClasses(schoolId, [user]))[0];
  },

  async removePhoto(ctx: Ctx, schoolId: string, id: string) {
    const user = await userManagement.get('teacher', id, { schoolId });
    await photosService.clear(ctx, {
      schoolId,
      ownerType: 'user',
      owner: user,
      auditPrefix: 'teacher',
      auditEntity: 'user',
    });
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
