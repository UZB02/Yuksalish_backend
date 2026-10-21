import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { ClassModel } from '../../models/Class';
import { Student, type Gender, type StudentDoc, type StudentStatus } from '../../models/Student';
import { fmtDate } from '../../utils/dates';
import { escapeRegex, isDuplicateKeyError, isId } from '../../utils/helpers';
import { cleanText, nameKeyOf } from '../../utils/text';
import { auditService } from '../audit/audit.service';
import { allowedClassIds } from '../classes/classes.service';
import { ratingEvents } from '../ratings/ratings.events';
import type { ExportStudent } from './students.excel';

type Actor = Ctx['actor'];

export async function toStudentDtos(docs: StudentDoc[], schoolId: string) {
  const classIds = [...new Set(docs.map((d) => String(d.classId)))];
  const classes = classIds.length
    ? await ClassModel.find({ _id: { $in: classIds }, schoolId }).select('name')
    : [];
  const names = new Map(classes.map((c) => [c.id, c.name]));
  return docs.map((s) => ({
    id: s.id,
    fullName: s.fullName,
    studentCode: s.studentCode ?? null,
    birthDate: fmtDate(s.birthDate),
    gender: s.gender ?? null,
    classId: String(s.classId),
    class: { id: String(s.classId), name: names.get(String(s.classId)) ?? '' },
    parentPhone: s.parentPhone ?? null,
    photoUrl: s.photoUrl ?? null,
    status: s.status,
    createdAt: s.createdAt,
  }));
}

const snapshot = (s: StudentDoc) => ({
  fullName: s.fullName,
  studentCode: s.studentCode,
  birthDate: fmtDate(s.birthDate),
  gender: s.gender,
  classId: String(s.classId),
  parentPhone: s.parentPhone,
  photoUrl: s.photoUrl,
  status: s.status,
});

const DUP_CODE = () =>
  AppError.conflict("Bu ID raqamli o'quvchi allaqachon mavjud", [
    { path: 'studentCode', message: 'Bu ID band' },
  ]);
const DUP_NAME = () =>
  AppError.conflict("Bunday F.I.Sh. va tug'ilgan sanali o'quvchi allaqachon mavjud", [
    { path: 'fullName', message: "F.I.Sh. va tug'ilgan sana bo'yicha dublikat" },
  ]);

/** Dublikat: bir xil ID, yoki ID yo'q bo'lsa — F.I.Sh. + tug'ilgan sana */
async function assertNoDuplicate(
  schoolId: string,
  v: { studentCode: string | null; nameKey: string; birthDate: Date | null },
  exceptId?: string,
) {
  const or: Record<string, unknown>[] = [];
  if (v.studentCode) or.push({ studentCode: v.studentCode });
  if (v.birthDate || !v.studentCode) or.push({ nameKey: v.nameKey, birthDate: v.birthDate });
  const filter: Record<string, unknown> = { schoolId, isDeleted: false, $or: or };
  if (exceptId) filter._id = { $ne: exceptId };
  const dup = await Student.findOne(filter).select('studentCode');
  if (dup) throw v.studentCode && dup.studentCode === v.studentCode ? DUP_CODE() : DUP_NAME();
}

async function assertClass(schoolId: string, classId: string) {
  if (!isId(classId) || !(await ClassModel.exists({ _id: classId, schoolId }))) {
    throw AppError.validation('Sinf topilmadi', [{ path: 'classId', message: 'Sinf topilmadi' }]);
  }
}

/** Boshqa maktab, o'chirilgan yoki (o'qituvchi uchun) biriktirilmagan sinf o'quvchisi -> 404 */
async function findOrFail(actor: Actor, schoolId: string, id: string): Promise<StudentDoc> {
  const notFound = AppError.notFound("O'quvchi topilmadi");
  if (!isId(id)) throw notFound;
  const student = await Student.findOne({ _id: id, schoolId, isDeleted: false });
  if (!student) throw notFound;
  const scope = await allowedClassIds(actor, schoolId);
  if (scope && !scope.includes(String(student.classId))) throw notFound;
  return student;
}

export interface StudentInput {
  fullName: string;
  studentCode?: string | null;
  birthDate?: Date | null;
  gender?: Gender | null;
  classId: string;
  parentPhone?: string | null;
  photoUrl?: string | null;
  status?: StudentStatus;
}

export const studentsService = {
  async list(
    actor: Actor,
    schoolId: string,
    q: { classId?: string; status?: StudentStatus; search?: string; page: number; limit: number },
  ) {
    const filter: Record<string, unknown> = { schoolId, isDeleted: false };
    if (q.status) filter.status = q.status;
    const scope = await allowedClassIds(actor, schoolId);
    if (scope) {
      filter.classId = { $in: q.classId ? scope.filter((c) => c === q.classId) : scope };
    } else if (q.classId) filter.classId = q.classId;
    if (q.search) {
      const re = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ fullName: re }, { studentCode: re }];
    }
    const [docs, total] = await Promise.all([
      Student.find(filter)
        .sort({ fullName: 1, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      Student.countDocuments(filter),
    ]);
    return { items: await toStudentDtos(docs, schoolId), meta: buildMeta(q.page, q.limit, total) };
  },

  async get(actor: Actor, schoolId: string, id: string) {
    return (await toStudentDtos([await findOrFail(actor, schoolId, id)], schoolId))[0];
  },

  async create(ctx: Ctx, schoolId: string, input: StudentInput) {
    await assertClass(schoolId, input.classId);
    const fullName = cleanText(input.fullName);
    const v = {
      fullName,
      nameKey: nameKeyOf(fullName),
      studentCode: input.studentCode ?? null,
      birthDate: input.birthDate ?? null,
    };
    await assertNoDuplicate(schoolId, v);

    let student: StudentDoc;
    try {
      student = await Student.create({
        schoolId,
        ...v,
        gender: input.gender ?? null,
        classId: input.classId,
        parentPhone: input.parentPhone ?? null,
        photoUrl: input.photoUrl ?? null,
        status: input.status ?? 'active',
        classHistory: [{ classId: input.classId, from: new Date(), to: null }],
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw DUP_CODE();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'student.create',
      entity: 'student',
      entityId: student.id,
      after: snapshot(student),
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toStudentDtos([student], schoolId))[0];
  },

  async update(
    ctx: Ctx,
    schoolId: string,
    id: string,
    patch: Partial<Omit<StudentInput, 'classId'>>,
  ) {
    const student = await findOrFail(ctx.actor, schoolId, id);
    const before = snapshot(student);

    if (patch.fullName !== undefined) {
      student.fullName = cleanText(patch.fullName);
      student.nameKey = nameKeyOf(student.fullName);
    }
    if (patch.studentCode !== undefined) student.studentCode = patch.studentCode;
    if (patch.birthDate !== undefined) student.birthDate = patch.birthDate;
    if (patch.gender !== undefined) student.gender = patch.gender;
    if (patch.parentPhone !== undefined) student.parentPhone = patch.parentPhone;
    if (patch.photoUrl !== undefined) student.photoUrl = patch.photoUrl;
    if (patch.status !== undefined) student.status = patch.status;

    if (
      patch.fullName !== undefined ||
      patch.studentCode !== undefined ||
      patch.birthDate !== undefined
    ) {
      await assertNoDuplicate(
        schoolId,
        {
          studentCode: student.studentCode,
          nameKey: student.nameKey,
          birthDate: student.birthDate,
        },
        student.id,
      );
    }
    try {
      await student.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw DUP_CODE();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'student.update',
      entity: 'student',
      entityId: student.id,
      before,
      after: snapshot(student),
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toStudentDtos([student], schoolId))[0];
  },

  /** Soft delete */
  async remove(ctx: Ctx, schoolId: string, id: string) {
    const student = await findOrFail(ctx.actor, schoolId, id);
    const before = snapshot(student);
    student.isDeleted = true;
    await student.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'student.delete',
      entity: 'student',
      entityId: student.id,
      before,
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
  },

  /** Boshqa sinfga o'tkazish; tarix classHistory ga yoziladi */
  async transfer(ctx: Ctx, schoolId: string, id: string, classId: string) {
    const student = await findOrFail(ctx.actor, schoolId, id);
    await assertClass(schoolId, classId);
    if (String(student.classId) === classId) {
      throw AppError.validation("O'quvchi allaqachon shu sinfda", [
        { path: 'classId', message: "O'quvchi allaqachon shu sinfda" },
      ]);
    }
    const now = new Date();
    const from = String(student.classId);
    for (const h of student.classHistory) if (!h.to) h.to = now;
    student.classHistory.push({ classId: new Types.ObjectId(classId), from: now, to: null });
    student.classId = new Types.ObjectId(classId);
    await student.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'student.transfer',
      entity: 'student',
      entityId: student.id,
      before: { classId: from },
      after: { classId },
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toStudentDtos([student], schoolId))[0];
  },

  /** Eksport uchun qatorlar (o'qituvchi faqat o'z sinflari) */
  async exportRows(actor: Actor, schoolId: string, classId?: string): Promise<ExportStudent[]> {
    const filter: Record<string, unknown> = { schoolId, isDeleted: false };
    const scope = await allowedClassIds(actor, schoolId);
    if (scope) filter.classId = { $in: classId ? scope.filter((c) => c === classId) : scope };
    else if (classId) {
      if (!isId(classId)) throw AppError.notFound('Sinf topilmadi');
      filter.classId = classId;
    }
    const docs = await Student.find(filter).sort({ fullName: 1 }).limit(20000);
    const dtos = await toStudentDtos(docs, schoolId);
    return dtos.map((s) => ({
      fullName: s.fullName,
      className: s.class.name,
      birthDate: s.birthDate,
      gender: s.gender,
      studentCode: s.studentCode,
      parentPhone: s.parentPhone,
    }));
  },
};
