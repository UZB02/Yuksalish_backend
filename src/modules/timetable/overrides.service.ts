import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import {
  LessonOverride,
  type ILessonOverride,
  type LessonOverrideType,
} from '../../models/LessonOverride';
import { Subject } from '../../models/Subject';
import { User } from '../../models/User';
import { isoWeekday } from '../../utils/dates';
import { isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { loadOverridesForDate } from './overrides.loader';
import type { CreateOverrideInput, MoveOverrideInput } from './timetable.schema';
import {
  applyOverrides,
  datesBetween,
  lessonsFromSlices,
  loadResolverSettings,
  loadVersionSlices,
  type ResolvedLesson,
} from './timetable.resolver';

const idStr = (v: unknown) => String(v);

export interface OverrideDto {
  id: string;
  classId: string;
  class: { id: string; name: string };
  date: string;
  lessonNo: number;
  type: LessonOverrideType;
  subject: { id: string; name: string } | null;
  teacher: { id: string; fullName: string } | null;
  originalSubject: { id: string; name: string } | null;
  originalTeacher: { id: string; fullName: string } | null;
  room: string | null;
  reason: string | null;
  moveGroupId: string | null;
  createdAt: Date;
  createdBy: { id: string; fullName: string } | null;
}

type OverrideRec = ILessonOverride & { _id: Types.ObjectId };

const fail = (path: string, message: string) => AppError.validation(message, [{ path, message }]);
const conflict = (message: string, path?: string) =>
  AppError.conflict(message, path ? [{ path, message }] : undefined);

/** Baza (almashtirishsiz) jadval darslari: sinf(lar) va davr uchun, bitta so'rov */
async function baseLessons(schoolId: string, classIds: string[], from: string, to: string) {
  const [slices, settings] = await Promise.all([
    loadVersionSlices(schoolId, { classIds }, from, to),
    loadResolverSettings(schoolId),
  ]);
  return {
    settings,
    lessons: lessonsFromSlices(slices, settings, classIds, datesBetween(from, to)),
  };
}

/** Maktabning shu kundagi barcha (arxivlanmagan sinflar) darslari, almashtirishlar hisobga olingan */
export async function schoolDayLessons(schoolId: string, date: string) {
  const [slices, settings, overrides] = await Promise.all([
    loadVersionSlices(schoolId, {}, date, date),
    loadResolverSettings(schoolId),
    loadOverridesForDate(schoolId, date),
  ]);
  const classIds = uniq([...slices.map((s) => s.classId), ...overrides.map((o) => o.classId)]);
  const classes = classIds.length
    ? await ClassModel.find({ _id: { $in: classIds }, schoolId, isArchived: false })
        .select('name')
        .lean()
    : [];
  const live = new Set(classes.map((c) => idStr(c._id)));
  const lessons = applyOverrides(
    lessonsFromSlices(slices, settings, classIds, [date]),
    overrides,
  ).filter((l) => live.has(l.classId));
  return { lessons, classNames: new Map(classes.map((c) => [idStr(c._id), c.name])), settings };
}

async function loadLiveClass(schoolId: string, classId: string): Promise<ClassDoc> {
  const cls = isId(classId) ? await ClassModel.findOne({ _id: classId, schoolId }) : null;
  if (!cls) throw AppError.notFound('Sinf topilmadi');
  if (cls.isArchived) throw conflict("Arxivlangan sinf darslarini o'zgartirib bo'lmaydi");
  return cls;
}

async function loadTeacher(schoolId: string, teacherId: string) {
  const t = isId(teacherId)
    ? await User.findOne({ _id: teacherId, schoolId, role: 'teacher', isActive: true })
        .select('fullName')
        .lean()
    : null;
  if (!t) throw fail('teacherId', "O'qituvchi topilmadi yoki faol emas");
  return t;
}

async function assertSubject(schoolId: string, subjectId: string) {
  const s = isId(subjectId)
    ? await Subject.exists({
        _id: subjectId,
        isActive: true,
        $or: [{ schoolId: null }, { schoolId }],
      })
    : null;
  if (!s) throw fail('subjectId', 'Fan topilmadi');
}

interface Plan {
  cls: ClassDoc;
  date: string;
  lessonNo: number;
  type: LessonOverrideType;
  subjectId: string | null;
  teacherId: string | null;
  room: string | null;
  reason: string | null;
  moveGroupId: string | null;
}

/** Bir slot uchun qoidalar tekshiruvi (jadval darsi, maydonlar, o'qituvchi bandligi). Yozmaydi. */
async function validatePlan(
  schoolId: string,
  p: Plan,
  base: ResolvedLesson | null,
  dayLessons: () => Promise<ResolvedLesson[]>,
  classNames: () => Promise<Map<string, string>>,
) {
  const classId = idStr(p.cls._id);
  if (await LessonOverride.exists({ schoolId, classId, date: p.date, lessonNo: p.lessonNo })) {
    throw conflict("Bu darsga allaqachon o'zgartirish kiritilgan. Avval uni o'chiring");
  }
  if (p.type === 'extra') {
    if (base)
      throw conflict("Bu soatda jadvalda dars bor. Qo'shimcha dars uchun bo'sh soat tanlang");
    if (!p.subjectId) throw fail('subjectId', 'Fan tanlanishi shart');
    if (!p.teacherId) throw fail('teacherId', "O'qituvchi tanlanishi shart");
  } else {
    if (!base) throw conflict("Bu soatda jadvalda dars yo'q");
    if (p.type === 'substitute') {
      if (!p.teacherId) throw fail('teacherId', "O'rinbosar o'qituvchi tanlanishi shart");
      if (p.teacherId === base.teacherId) {
        throw fail('teacherId', "O'rinbosar darsning asl o'qituvchisidan farq qilishi kerak");
      }
    }
    if (p.type === 'replace') {
      if (!p.subjectId) throw fail('subjectId', 'Yangi fan tanlanishi shart');
      if (!p.teacherId) throw fail('teacherId', "O'qituvchi tanlanishi shart");
      if (p.subjectId === base.subjectId) {
        throw fail('subjectId', 'Yangi fan jadvaldagi fandan farq qilishi kerak');
      }
    }
  }
  if (p.subjectId) await assertSubject(schoolId, p.subjectId);
  if (p.teacherId) {
    const teacher = await loadTeacher(schoolId, p.teacherId);
    const busy = (await dayLessons()).find(
      (l) =>
        l.teacherId === p.teacherId &&
        l.lessonNo === p.lessonNo &&
        !l.cancelled &&
        !(l.classId === classId && l.groupKey === null),
    );
    if (busy) {
      const name = (await classNames()).get(busy.classId) ?? '?';
      throw conflict(
        `${teacher.fullName} shu soatda (${p.lessonNo}-dars) ${name} sinfida dars o'tadi`,
        'teacherId',
      );
    }
  }
}

async function assertWorkday(schoolId: string, date: string, path = 'date') {
  const settings = await loadResolverSettings(schoolId);
  if (!settings.workingWeekdays.includes(isoWeekday(date))) {
    throw fail(path, 'Bu sana ish kuni emas');
  }
  return settings;
}

/** DTO: nomlar va jadvaldagi asl dars (bitta so'rovlar to'plami) */
async function toDtos(schoolId: string, rows: OverrideRec[]): Promise<OverrideDto[]> {
  if (!rows.length) return [];
  const classIds = uniq(rows.map((r) => idStr(r.classId)));
  const dates = rows.map((r) => r.date).sort();
  const [base, classes] = await Promise.all([
    baseLessons(schoolId, classIds, dates[0] as string, dates[dates.length - 1] as string),
    ClassModel.find({ _id: { $in: classIds }, schoolId })
      .select('name')
      .lean(),
  ]);
  const baseBy = new Map(
    base.lessons
      .filter((l) => l.groupKey === null)
      .map((l) => [`${l.classId}|${l.date}|${l.lessonNo}`, l]),
  );
  const origOf = (r: OverrideRec) => baseBy.get(`${idStr(r.classId)}|${r.date}|${r.lessonNo}`);
  const subjectIds = uniq(
    rows.flatMap((r) => [r.subjectId, origOf(r)?.subjectId]).filter(Boolean) as unknown[],
  ).map(idStr);
  const userIds = uniq(
    rows
      .flatMap((r) => [r.teacherId, r.createdBy, origOf(r)?.teacherId])
      .filter(Boolean) as unknown[],
  ).map(idStr);
  const [subjects, users] = await Promise.all([
    Subject.find({ _id: { $in: subjectIds } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('fullName')
      .lean(),
  ]);
  const cName = new Map(classes.map((c) => [idStr(c._id), c.name]));
  const sName = new Map(subjects.map((s) => [idStr(s._id), s.name]));
  const uName = new Map(users.map((u) => [idStr(u._id), u.fullName]));
  const subj = (id: unknown) => (id ? { id: idStr(id), name: sName.get(idStr(id)) ?? '?' } : null);
  const user = (id: unknown) =>
    id ? { id: idStr(id), fullName: uName.get(idStr(id)) ?? '?' } : null;
  return rows.map((r) => {
    const o = origOf(r);
    return {
      id: idStr(r._id),
      classId: idStr(r.classId),
      class: { id: idStr(r.classId), name: cName.get(idStr(r.classId)) ?? '?' },
      date: r.date,
      lessonNo: r.lessonNo,
      type: r.type,
      subject: subj(r.subjectId),
      teacher: user(r.teacherId),
      originalSubject: r.type === 'extra' ? null : subj(o?.subjectId),
      originalTeacher: r.type === 'extra' ? null : user(o?.teacherId),
      room: r.room ?? null,
      reason: r.reason ?? null,
      moveGroupId: r.moveGroupId ?? null,
      createdAt: r.createdAt,
      createdBy: user(r.createdBy),
    };
  });
}

async function audit(
  ctx: Ctx,
  schoolId: string,
  action: 'timetable.override_created' | 'timetable.override_deleted',
  dto: OverrideDto,
) {
  const snapshot = {
    classId: dto.classId,
    class: dto.class.name,
    date: dto.date,
    lessonNo: dto.lessonNo,
    type: dto.type,
    subjectId: dto.subject?.id ?? null,
    teacherId: dto.teacher?.id ?? null,
    originalSubjectId: dto.originalSubject?.id ?? null,
    originalTeacherId: dto.originalTeacher?.id ?? null,
    room: dto.room,
    reason: dto.reason,
    moveGroupId: dto.moveGroupId,
  };
  await auditService.log({
    userId: ctx.actor.id,
    schoolId,
    action,
    entity: 'timetable_override',
    entityId: dto.id,
    before: action === 'timetable.override_deleted' ? snapshot : null,
    after: action === 'timetable.override_created' ? snapshot : null,
    ip: ctx.ip,
  });
}

const sortDtos = (items: OverrideDto[]) =>
  items.sort(
    (a, b) =>
      a.class.name.localeCompare(b.class.name, 'uz') ||
      a.lessonNo - b.lessonNo ||
      a.id.localeCompare(b.id),
  );

function insertDoc(schoolId: string, ctx: Ctx, p: Plan) {
  return LessonOverride.create({
    schoolId,
    classId: p.cls._id,
    date: p.date,
    lessonNo: p.lessonNo,
    groupKey: null,
    type: p.type,
    subjectId: p.subjectId,
    teacherId: p.teacherId,
    room: p.room,
    moveGroupId: p.moveGroupId,
    reason: p.reason,
    createdBy: ctx.actor.id,
  });
}

const dupConflict = () => conflict("Bu darsga allaqachon o'zgartirish kiritilgan");

/** Kun bo'yicha kesh: bir so'rovda bir necha tekshiruv uchun */
function dayCache(schoolId: string, date: string) {
  let p: ReturnType<typeof schoolDayLessons> | null = null;
  const get = () => (p ??= schoolDayLessons(schoolId, date));
  return {
    lessons: async () => (await get()).lessons,
    classNames: async () => (await get()).classNames,
  };
}

export const overridesService = {
  async list(schoolId: string, date: string): Promise<{ items: OverrideDto[] }> {
    const rows = await LessonOverride.find({ schoolId, date }).lean();
    return { items: sortDtos(await toDtos(schoolId, rows as OverrideRec[])) };
  },

  async create(ctx: Ctx, schoolId: string, input: CreateOverrideInput): Promise<OverrideDto> {
    const cls = await loadLiveClass(schoolId, input.classId);
    await assertWorkday(schoolId, input.date);
    const classId = idStr(cls._id);
    const { lessons } = await baseLessons(schoolId, [classId], input.date, input.date);
    const base = lessons.find((l) => l.lessonNo === input.lessonNo && l.groupKey === null) ?? null;
    const isCancel = input.type === 'cancel';
    const plan: Plan = {
      cls,
      date: input.date,
      lessonNo: input.lessonNo,
      type: input.type,
      // O'rinbosarda fan o'zgarmaydi; bekor qilishda fan/o'qituvchi saqlanmaydi
      subjectId: isCancel || input.type === 'substitute' ? null : (input.subjectId ?? null),
      teacherId: isCancel ? null : (input.teacherId ?? null),
      room: isCancel ? null : (input.room ?? null),
      reason: input.reason ?? null,
      moveGroupId: null,
    };
    const day = dayCache(schoolId, input.date);
    await validatePlan(schoolId, plan, base, day.lessons, day.classNames);
    let doc;
    try {
      doc = await insertDoc(schoolId, ctx, plan);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw dupConflict();
      throw e;
    }
    const [dto] = await toDtos(schoolId, [doc.toObject() as OverrideRec]);
    await audit(ctx, schoolId, 'timetable.override_created', dto as OverrideDto);
    return dto as OverrideDto;
  },

  /** Ko'chirish = manba slotda cancel + maqsad slotda extra (bir xil moveGroupId) */
  async move(
    ctx: Ctx,
    schoolId: string,
    input: MoveOverrideInput,
  ): Promise<{ items: OverrideDto[] }> {
    const { from, to } = input;
    if (from.date === to.date && from.lessonNo === to.lessonNo) {
      throw fail('to', "Yangi o'rin eski o'rindan farq qilishi kerak");
    }
    const cls = await loadLiveClass(schoolId, input.classId);
    await assertWorkday(schoolId, from.date, 'from.date');
    await assertWorkday(schoolId, to.date, 'to.date');
    const classId = idStr(cls._id);
    const dates = [from.date, to.date].sort();
    const { lessons } = await baseLessons(
      schoolId,
      [classId],
      dates[0] as string,
      dates[1] as string,
    );
    const at = (d: string, n: number) =>
      lessons.find((l) => l.date === d && l.lessonNo === n && l.groupKey === null) ?? null;
    const source = at(from.date, from.lessonNo);
    if (!source) throw conflict("Ko'chiriladigan soatda jadvalda dars yo'q");
    const moveGroupId = new Types.ObjectId().toString();
    const cancelPlan: Plan = {
      cls,
      date: from.date,
      lessonNo: from.lessonNo,
      type: 'cancel',
      subjectId: null,
      teacherId: null,
      room: null,
      reason: input.reason ?? null,
      moveGroupId,
    };
    const extraPlan: Plan = {
      cls,
      date: to.date,
      lessonNo: to.lessonNo,
      type: 'extra',
      subjectId: source.subjectId,
      teacherId: input.teacherId ?? source.teacherId,
      room: null,
      reason: input.reason ?? null,
      moveGroupId,
    };
    const fromDay = dayCache(schoolId, from.date);
    const toDay = dayCache(schoolId, to.date);
    await validatePlan(schoolId, cancelPlan, source, fromDay.lessons, fromDay.classNames);
    await validatePlan(
      schoolId,
      extraPlan,
      at(to.date, to.lessonNo),
      toDay.lessons,
      toDay.classNames,
    );

    let first;
    try {
      first = await insertDoc(schoolId, ctx, cancelPlan);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw dupConflict();
      throw e;
    }
    let second;
    try {
      second = await insertDoc(schoolId, ctx, extraPlan);
    } catch (e) {
      // Tranzaksiya yo'q: birinchi yozuvni qaytarib olamiz
      await LessonOverride.deleteOne({ _id: first._id });
      if (isDuplicateKeyError(e)) throw dupConflict();
      throw e;
    }
    const dtos = await toDtos(schoolId, [first.toObject(), second.toObject()] as OverrideRec[]);
    for (const d of dtos) await audit(ctx, schoolId, 'timetable.override_created', d);
    // Javob tartibi: [bekor qilingan (manba), qo'shimcha (maqsad)]
    return { items: dtos };
  },

  /** O'chirish; ko'chirishning bir yarmi o'chirilsa ikkalasi ham o'chadi */
  async remove(ctx: Ctx, schoolId: string, id: string): Promise<void> {
    const doc = isId(id) ? await LessonOverride.findOne({ _id: id, schoolId }).lean() : null;
    if (!doc) throw AppError.notFound("O'zgartirish topilmadi");
    const rows = doc.moveGroupId
      ? await LessonOverride.find({ schoolId, moveGroupId: doc.moveGroupId }).lean()
      : [doc];
    const dtos = await toDtos(schoolId, rows as OverrideRec[]);
    await LessonOverride.deleteMany({ schoolId, _id: { $in: rows.map((r) => r._id) } });
    for (const d of dtos) await audit(ctx, schoolId, 'timetable.override_deleted', d);
  },

  /** Shu soatga o'qituvchilar: bo'shlar birinchi, fan o'qituvchilari, kam yuklanganlar */
  async freeTeachers(schoolId: string, date: string, lessonNo: number, subjectId?: string) {
    const [teachers, day, subjectTeachers] = await Promise.all([
      User.find({ schoolId, role: 'teacher', isActive: true }).select('fullName').lean(),
      schoolDayLessons(schoolId, date),
      subjectId ? ClassSubject.distinct('teacherId', { schoolId, subjectId }) : Promise.resolve([]),
    ]);
    const teaches = new Set(subjectTeachers.map(idStr));
    const busy = new Set<string>();
    const count = new Map<string, number>();
    for (const l of day.lessons) {
      if (l.cancelled) continue;
      count.set(l.teacherId, (count.get(l.teacherId) ?? 0) + 1);
      if (l.lessonNo === lessonNo) busy.add(l.teacherId);
    }
    const items = teachers.map((t) => ({
      id: idStr(t._id),
      fullName: t.fullName,
      free: !busy.has(idStr(t._id)),
      teachesSubject: teaches.has(idStr(t._id)),
      lessonsThatDay: count.get(idStr(t._id)) ?? 0,
    }));
    items.sort(
      (a, b) =>
        Number(b.free) - Number(a.free) ||
        Number(b.teachesSubject) - Number(a.teachesSubject) ||
        a.lessonsThatDay - b.lessonsThatDay ||
        a.fullName.localeCompare(b.fullName, 'uz'),
    );
    return { items };
  },
};
