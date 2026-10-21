import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { Student } from '../../models/Student';
import { User, type UserDoc } from '../../models/User';
import { classKeyOf, cleanText } from '../../utils/text';
import { escapeRegex, isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';

type AuthActor = Ctx['actor'];

/** O'qituvchi uchun o'ziga biriktirilgan sinflar; boshqa rollar uchun null (cheklov yo'q) */
export async function allowedClassIds(
  actor: AuthActor,
  schoolId: string,
): Promise<string[] | null> {
  if (actor.role !== 'teacher') return null;
  const docs = await ClassModel.find({ schoolId, teacherIds: actor.id }).select('_id');
  return docs.map((d) => d.id);
}

export async function toClassDtos(docs: ClassDoc[], schoolId: string) {
  if (!docs.length) return [];
  const userIds = uniq(
    docs.flatMap((c) => [
      ...c.teacherIds.map(String),
      ...(c.homeroomTeacherId ? [String(c.homeroomTeacherId)] : []),
    ]),
  );
  const [users, counts] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('fullName'),
    Student.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          schoolId: new Types.ObjectId(schoolId),
          classId: { $in: docs.map((d) => d._id) },
          isDeleted: false,
          status: 'active',
        },
      },
      { $group: { _id: '$classId', n: { $sum: 1 } } },
    ]),
  ]);
  const names = new Map(users.map((u) => [u.id, u.fullName]));
  const countOf = new Map(counts.map((c) => [String(c._id), c.n]));
  const ref = (id: string) => (names.has(id) ? { id, fullName: names.get(id) as string } : null);

  return docs.map((c) => {
    const home = c.homeroomTeacherId ? String(c.homeroomTeacherId) : null;
    return {
      id: c.id,
      name: c.name,
      grade: c.grade,
      section: c.section ?? null,
      academicYearId: String(c.academicYearId),
      homeroomTeacherId: home,
      homeroomTeacher: home ? ref(home) : null,
      teacherIds: c.teacherIds.map(String),
      teachers: c.teacherIds.map((t) => ref(String(t))).filter((t) => t !== null),
      studentsCount: countOf.get(c.id) ?? 0,
      isArchived: c.isArchived,
      createdAt: c.createdAt,
    };
  });
}

const snapshot = (c: ClassDoc) => ({
  name: c.name,
  grade: c.grade,
  section: c.section,
  academicYearId: String(c.academicYearId),
  homeroomTeacherId: c.homeroomTeacherId ? String(c.homeroomTeacherId) : null,
  teacherIds: c.teacherIds.map(String),
  isArchived: c.isArchived,
});

async function findOrFail(schoolId: string, id: string, actor?: AuthActor): Promise<ClassDoc> {
  const filter: Record<string, unknown> = { _id: id, schoolId };
  if (actor?.role === 'teacher') filter.teacherIds = actor.id;
  const cls = isId(id) ? await ClassModel.findOne(filter) : null;
  if (!cls) throw AppError.notFound('Sinf topilmadi');
  return cls;
}

/** Berilgan id lar shu maktabning faol o'qituvchilari ekanini tekshiradi */
async function assertTeachers(schoolId: string, ids: string[], path = 'teacherIds') {
  const bad = ids.filter((i) => !isId(i));
  const found = bad.length
    ? []
    : await User.find({ _id: { $in: ids }, schoolId, role: 'teacher', isActive: true }).select(
        '_id',
      );
  if (bad.length || found.length !== ids.length) {
    throw AppError.validation("O'qituvchilar ro'yxati noto'g'ri", [
      { path, message: "O'qituvchi topilmadi yoki faol emas" },
    ]);
  }
}

async function assertNameFree(schoolId: string, yearId: string, name: string, exceptId?: string) {
  const key = classKeyOf(name);
  const siblings = await ClassModel.find({ schoolId, academicYearId: yearId }).select('name');
  if (siblings.some((s) => s.id !== exceptId && classKeyOf(s.name) === key)) throw nameTaken();
}
const nameTaken = () =>
  AppError.conflict('Bunday nomli sinf mavjud', [
    { path: 'name', message: "Bu o'quv yilida sinf nomi band" },
  ]);

export interface ClassListQuery {
  academicYearId?: string;
  grade?: number;
  search?: string;
  isArchived?: boolean;
  page: number;
  limit: number;
}

export const classesService = {
  async list(actor: AuthActor, schoolId: string, q: ClassListQuery) {
    const filter: Record<string, unknown> = { schoolId, isArchived: q.isArchived ?? false };
    if (q.academicYearId) filter.academicYearId = q.academicYearId;
    else {
      const active = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
      if (!active) return { items: [], meta: buildMeta(q.page, q.limit, 0) };
      filter.academicYearId = active._id;
    }
    if (q.grade) filter.grade = q.grade;
    if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
    if (actor.role === 'teacher') filter.teacherIds = actor.id;

    const [docs, total] = await Promise.all([
      ClassModel.find(filter)
        .sort({ grade: 1, name: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      ClassModel.countDocuments(filter),
    ]);
    return { items: await toClassDtos(docs, schoolId), meta: buildMeta(q.page, q.limit, total) };
  },

  async get(actor: AuthActor, schoolId: string, id: string) {
    const cls = await findOrFail(schoolId, id, actor);
    return (await toClassDtos([cls], schoolId))[0];
  },

  async create(
    ctx: Ctx,
    schoolId: string,
    input: {
      name: string;
      grade: number;
      section?: string | null;
      academicYearId?: string;
      homeroomTeacherId?: string | null;
      teacherIds: string[];
    },
  ) {
    let yearId = input.academicYearId;
    if (yearId) {
      if (!isId(yearId) || !(await AcademicYear.exists({ _id: yearId, schoolId }))) {
        throw AppError.validation("O'quv yili topilmadi", [
          { path: 'academicYearId', message: "O'quv yili topilmadi" },
        ]);
      }
    } else {
      const active = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
      if (!active) {
        throw AppError.validation("Faol o'quv yili yo'q", [
          { path: 'academicYearId', message: "Avval o'quv yilini yarating va faollashtiring" },
        ]);
      }
      yearId = active.id as string;
    }

    const name = cleanText(input.name);
    await assertNameFree(schoolId, yearId, name);
    const home = input.homeroomTeacherId ?? null;
    const teacherIds = uniq([...input.teacherIds, ...(home ? [home] : [])]);
    await assertTeachers(
      schoolId,
      teacherIds,
      home && !input.teacherIds.includes(home) ? 'homeroomTeacherId' : 'teacherIds',
    );

    let cls: ClassDoc;
    try {
      cls = await ClassModel.create({
        schoolId,
        name,
        grade: input.grade,
        section: input.section ?? null,
        academicYearId: yearId,
        homeroomTeacherId: home,
        teacherIds,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'class.create',
      entity: 'class',
      entityId: cls.id,
      after: snapshot(cls),
      ip: ctx.ip,
    });
    return (await toClassDtos([cls], schoolId))[0];
  },

  async update(
    ctx: Ctx,
    schoolId: string,
    id: string,
    patch: {
      name?: string;
      grade?: number;
      section?: string | null;
      homeroomTeacherId?: string | null;
      teacherIds?: string[];
    },
  ) {
    const cls = await findOrFail(schoolId, id);
    const before = snapshot(cls);

    if (patch.name !== undefined) {
      const name = cleanText(patch.name);
      await assertNameFree(schoolId, String(cls.academicYearId), name, cls.id);
      cls.name = name;
    }
    if (patch.grade !== undefined) cls.grade = patch.grade;
    if (patch.section !== undefined) cls.section = patch.section;

    if (patch.teacherIds !== undefined || patch.homeroomTeacherId !== undefined) {
      const home =
        patch.homeroomTeacherId !== undefined
          ? patch.homeroomTeacherId
          : cls.homeroomTeacherId
            ? String(cls.homeroomTeacherId)
            : null;
      const base = patch.teacherIds ?? cls.teacherIds.map(String);
      const teacherIds = uniq([...base, ...(home ? [home] : [])]);
      await assertTeachers(
        schoolId,
        teacherIds.filter((t) => !before.teacherIds.includes(t)),
      );
      cls.teacherIds = teacherIds.map((t) => new Types.ObjectId(t));
      cls.homeroomTeacherId = home ? new Types.ObjectId(home) : null;
    }
    try {
      await cls.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'class.update',
      entity: 'class',
      entityId: cls.id,
      before,
      after: snapshot(cls),
      ip: ctx.ip,
    });
    return (await toClassDtos([cls], schoolId))[0];
  },

  async setArchived(ctx: Ctx, schoolId: string, id: string, archived: boolean) {
    const cls = await findOrFail(schoolId, id);
    if (cls.isArchived !== archived) {
      cls.isArchived = archived;
      await cls.save();
      await auditService.log({
        userId: ctx.actor.id,
        schoolId,
        action: archived ? 'class.archive' : 'class.unarchive',
        entity: 'class',
        entityId: cls.id,
        before: { isArchived: !archived },
        after: { isArchived: archived },
        ip: ctx.ip,
      });
    }
    return (await toClassDtos([cls], schoolId))[0];
  },

  /** Sinf o'qituvchilarini to'liq almashtirish; sinf rahbari teacherIds ichida bo'lishi shart */
  async setTeachers(
    ctx: Ctx,
    schoolId: string,
    id: string,
    input: { teacherIds: string[]; homeroomTeacherId: string | null },
  ) {
    const cls = await findOrFail(schoolId, id);
    const teacherIds = uniq(input.teacherIds);
    if (input.homeroomTeacherId && !teacherIds.includes(input.homeroomTeacherId)) {
      throw AppError.validation("Sinf rahbari o'qituvchilar ro'yxatida bo'lishi kerak", [
        { path: 'homeroomTeacherId', message: "Sinf rahbari teacherIds ichida bo'lishi kerak" },
      ]);
    }
    await assertTeachers(schoolId, teacherIds);

    const before = snapshot(cls);
    cls.teacherIds = teacherIds.map((t) => new Types.ObjectId(t));
    cls.homeroomTeacherId = input.homeroomTeacherId
      ? new Types.ObjectId(input.homeroomTeacherId)
      : null;
    await cls.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'class.teachers',
      entity: 'class',
      entityId: cls.id,
      before: { teacherIds: before.teacherIds, homeroomTeacherId: before.homeroomTeacherId },
      after: { teacherIds, homeroomTeacherId: input.homeroomTeacherId },
      ip: ctx.ip,
    });
    return (await toClassDtos([cls], schoolId))[0];
  },

  /** O'qituvchining faol yil sinflarini to'liq almashtirish (Class.teacherIds yangilanadi) */
  async setTeacherClasses(ctx: Ctx, schoolId: string, teacher: UserDoc, classIds: string[]) {
    const wanted = uniq(classIds);
    const active = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
    const valid =
      wanted.every(isId) && active
        ? await ClassModel.find({
            _id: { $in: wanted },
            schoolId,
            academicYearId: active._id,
            isArchived: false,
          }).select('_id')
        : [];
    if (valid.length !== wanted.length) {
      throw AppError.validation("Sinflar ro'yxati noto'g'ri", [
        {
          path: 'classIds',
          message: "Sinf topilmadi (faol o'quv yilidagi arxivlanmagan sinflar bo'lishi kerak)",
        },
      ]);
    }

    const scope = { schoolId, academicYearId: active?._id, isArchived: false };
    const current = (
      await ClassModel.find({ ...scope, teacherIds: teacher._id }).select('_id')
    ).map((c) => c.id as string);
    const removed = current.filter((c) => !wanted.includes(c));

    if (removed.length) {
      await ClassModel.updateMany(
        { _id: { $in: removed } },
        { $pull: { teacherIds: teacher._id } },
      );
      await ClassModel.updateMany(
        { _id: { $in: removed }, homeroomTeacherId: teacher._id },
        { homeroomTeacherId: null },
      );
    }
    if (wanted.length) {
      await ClassModel.updateMany(
        { _id: { $in: wanted } },
        { $addToSet: { teacherIds: teacher._id } },
      );
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'teacher.classes',
      entity: 'user',
      entityId: teacher.id,
      before: { classIds: current },
      after: { classIds: wanted },
      ip: ctx.ip,
    });
  },

  /** O'qituvchilar uchun {teacherId -> [{id,name}]} (faol yil, arxivlanmagan sinflar) */
  async classesOfTeachers(schoolId: string, teacherIds: string[]) {
    const map = new Map<string, { id: string; name: string }[]>();
    if (!teacherIds.length) return map;
    const active = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
    if (!active) return map;
    const classes = await ClassModel.find({
      schoolId,
      academicYearId: active._id,
      isArchived: false,
      teacherIds: { $in: teacherIds },
    })
      .sort({ grade: 1, name: 1 })
      .select('name teacherIds');
    for (const c of classes) {
      for (const t of c.teacherIds.map(String)) {
        if (!map.has(t)) map.set(t, []);
        map.get(t)?.push({ id: c.id, name: c.name });
      }
    }
    return map;
  },
};
