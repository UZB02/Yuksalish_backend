import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorCode, type ErrorDetail } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { AcademicYear } from '../../models/AcademicYear';
import { AttendanceRecord, type AttendanceRecordDoc } from '../../models/AttendanceRecord';
import { AttendanceStatus, type AttendanceStatusDoc } from '../../models/AttendanceStatus';
import { ClassModel } from '../../models/Class';
import { Student } from '../../models/Student';
import { User } from '../../models/User';
import { clock, todayTashkent } from '../../utils/clock';
import { isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { allowedClassIds } from '../classes/classes.service';
import { ratingEvents } from '../ratings/ratings.events';
import type { AttendanceSettings } from '../settings/attendance.settings';
import { ATTENDANCE_KEY } from '../settings/attendance.settings';
import { settingsService } from '../settings/settings.service';
import { toStatusDto } from '../attendance-statuses/attendance-statuses.service';
import {
  canEditAny,
  checkDate,
  checkValues,
  isEditable,
  isWorkingDay,
  resolveLessonNo,
  withinEditWindow,
  type RecordValues,
} from './attendance.rules';

type Actor = Ctx['actor'];

export const getAttendanceSettings = (schoolId: string) =>
  settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId);

/** Maktabga ko'rinadigan (global + o'z) holatlar */
export async function loadStatuses(schoolId: string): Promise<Map<string, AttendanceStatusDoc>> {
  const docs = await AttendanceStatus.find({ $or: [{ schoolId: null }, { schoolId }] });
  return new Map(docs.map((d) => [d.id as string, d]));
}

export async function activeYearId(schoolId: string): Promise<string | null> {
  const y = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  return y ? (y.id as string) : null;
}

// ---------- DTO ----------

export async function toRecordDtos(
  docs: AttendanceRecordDoc[],
  opts: { actor: Actor; settings: AttendanceSettings },
) {
  if (!docs.length) return [];
  const studentIds = uniq(docs.map((d) => String(d.studentId)));
  const classIds = uniq(docs.map((d) => String(d.classId)));
  const statusIds = uniq(docs.map((d) => String(d.statusId)));
  const userIds = uniq(docs.flatMap((d) => [String(d.markedBy), String(d.updatedBy)]));
  const [students, classes, statuses, users] = await Promise.all([
    Student.find({ _id: { $in: studentIds } }).select('fullName'),
    ClassModel.find({ _id: { $in: classIds } }).select('name'),
    AttendanceStatus.find({ _id: { $in: statusIds } }),
    User.find({ _id: { $in: userIds } }).select('fullName'),
  ]);
  const sMap = new Map(students.map((s) => [s.id as string, s.fullName]));
  const cMap = new Map(classes.map((c) => [c.id as string, c.name]));
  const stMap = new Map(statuses.map((s) => [s.id as string, s]));
  const uMap = new Map(users.map((u) => [u.id as string, u.fullName]));
  const now = clock.now();

  return docs.map((d) => {
    const st = stMap.get(String(d.statusId));
    return {
      id: d.id as string,
      schoolId: String(d.schoolId),
      studentId: String(d.studentId),
      student: { id: String(d.studentId), fullName: sMap.get(String(d.studentId)) ?? '' },
      classId: String(d.classId),
      class: { id: String(d.classId), name: cMap.get(String(d.classId)) ?? '' },
      academicYearId: String(d.academicYearId),
      date: d.date,
      lessonNo: d.lessonNo,
      statusId: String(d.statusId),
      status: st
        ? {
            id: st.id as string,
            name: st.name,
            shortName: st.shortName,
            color: st.color,
            category: st.category,
          }
        : null,
      minutesLate: d.minutesLate ?? null,
      note: d.note ?? null,
      markedBy: { id: String(d.markedBy), fullName: uMap.get(String(d.markedBy)) ?? '' },
      updatedBy: { id: String(d.updatedBy), fullName: uMap.get(String(d.updatedBy)) ?? '' },
      editable: isEditable(d, opts.actor, opts.settings, now),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}

const snapshot = (d: AttendanceRecordDoc) => ({
  studentId: String(d.studentId),
  classId: String(d.classId),
  date: d.date,
  lessonNo: d.lessonNo,
  statusId: String(d.statusId),
  category: d.category,
  minutesLate: d.minutesLate,
  note: d.note,
});

const throwValidation = (details: ErrorDetail[]) => {
  if (details.length) throw AppError.validation("Ma'lumotlar noto'g'ri", details);
};

/** Faol yildagi arxivlanmagan sinf */
async function loadTakeableClass(actor: Actor, schoolId: string, classId: string) {
  const notFound = AppError.notFound('Sinf topilmadi');
  if (!isId(classId)) throw notFound;
  const scope = await allowedClassIds(actor, schoolId);
  if (scope && !scope.includes(classId)) throw notFound;
  const [cls, yearId] = await Promise.all([
    ClassModel.findOne({ _id: classId, schoolId }),
    activeYearId(schoolId),
  ]);
  if (!cls) throw notFound;
  if (cls.isArchived || !yearId || String(cls.academicYearId) !== yearId) {
    throw AppError.validation('Sinf davomat uchun mavjud emas', [
      {
        path: 'classId',
        message: "Faqat faol o'quv yilidagi arxivlanmagan sinfda davomat olinadi",
      },
    ]);
  }
  return { cls, yearId };
}

// ---------- Servis ----------

export const attendanceService = {
  /** Ommaviy davomat (UPSERT): har element mustaqil tekshiriladi */
  async bulk(
    ctx: Ctx,
    schoolId: string,
    input: {
      classId: string;
      date?: string;
      lessonNo?: number;
      items: {
        studentId: string;
        statusId: string;
        minutesLate?: number | null;
        note?: string | null;
      }[];
    },
  ) {
    const settings = await getAttendanceSettings(schoolId);
    const { cls, yearId } = await loadTakeableClass(ctx.actor, schoolId, input.classId);
    const date = input.date ?? todayTashkent();
    const unit = resolveLessonNo(settings, input.lessonNo);
    throwValidation([...checkDate(settings, date, todayTashkent()), ...unit.errors]);
    const lessonNo = unit.lessonNo;

    const [statuses, students] = await Promise.all([
      loadStatuses(schoolId),
      Student.find({ schoolId, classId: cls._id, isDeleted: false }),
    ]);
    const byId = new Map(students.map((s) => [s.id as string, s]));
    const existing = await AttendanceRecord.find({
      schoolId,
      date,
      lessonNo,
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    });
    const existingBy = new Map(existing.map((r) => [String(r.studentId), r]));

    const failed: { studentId: string; code: ErrorCode; message: string }[] = [];
    const seen = new Set<string>();
    const now = clock.now();
    let created = 0;
    let updated = 0;

    for (const item of input.items) {
      const fail = (code: ErrorCode, message: string) =>
        failed.push({ studentId: item.studentId, code, message });
      const student = byId.get(item.studentId);
      if (!student) {
        fail('NOT_FOUND', "O'quvchi bu sinfda topilmadi");
        continue;
      }
      if (seen.has(item.studentId)) {
        fail('CONFLICT', "O'quvchi so'rovda takrorlangan");
        continue;
      }
      seen.add(item.studentId);
      if (student.status !== 'active') {
        fail('VALIDATION_ERROR', "Faqat faol o'quvchi uchun davomat olinadi");
        continue;
      }
      const values: RecordValues = {
        statusId: item.statusId,
        minutesLate: item.minutesLate ?? null,
        note: item.note ?? null,
      };
      const prev = existingBy.get(item.studentId);
      const { errors, category } = checkValues(
        settings,
        values,
        statuses,
        prev ? String(prev.statusId) : null,
      );
      if (errors.length || !category) {
        fail('VALIDATION_ERROR', errors.map((e) => e.message).join('; '));
        continue;
      }
      try {
        if (prev) {
          if (!isEditable(prev, ctx.actor, settings, now)) {
            fail(
              'FORBIDDEN',
              "Bu yozuvni o'zgartirishga ruxsat yo'q (muddat tugagan yoki boshqa foydalanuvchi yozgan)",
            );
            continue;
          }
          prev.statusId = new Types.ObjectId(values.statusId);
          prev.category = category;
          prev.minutesLate = values.minutesLate;
          prev.note = values.note;
          prev.updatedBy = new Types.ObjectId(ctx.actor.id);
          await prev.save();
          updated++;
        } else {
          await AttendanceRecord.create({
            schoolId,
            studentId: student._id,
            classId: student.classId,
            academicYearId: yearId,
            date,
            lessonNo,
            statusId: values.statusId,
            category,
            minutesLate: values.minutesLate,
            note: values.note,
            markedBy: ctx.actor.id,
            updatedBy: ctx.actor.id,
          });
          created++;
        }
      } catch (e) {
        if (isDuplicateKeyError(e)) fail('CONFLICT', 'Bu birlik uchun yozuv allaqachon mavjud');
        else throw e;
      }
    }

    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'attendance.bulk',
      entity: 'attendance',
      entityId: input.classId,
      after: {
        classId: input.classId,
        date,
        lessonNo,
        created,
        updated,
        failed: failed.length,
        items: input.items.length,
      },
      ip: ctx.ip,
    });
    if (created + updated > 0) void ratingEvents.attendanceChanged(schoolId);
    return { created, updated, failed };
  },

  /** O'zgartirish/o'chirish uchun yozuvni topadi va huquqni tekshiradi */
  async loadForChange(ctx: Ctx, schoolId: string, id: string, settings: AttendanceSettings) {
    const notFound = AppError.notFound('Davomat yozuvi topilmadi');
    const doc = isId(id)
      ? await AttendanceRecord.findOne({ _id: id, schoolId, isDeleted: false })
      : null;
    if (!doc) throw notFound;
    const scope = await allowedClassIds(ctx.actor, schoolId);
    if (scope && !scope.includes(String(doc.classId))) throw notFound;
    if (canEditAny(ctx.actor)) return doc;
    if (String(doc.markedBy) !== ctx.actor.id) {
      throw AppError.forbidden(
        "Boshqa foydalanuvchi yozgan yozuvni o'zgartirish uchun attendance.edit kerak",
      );
    }
    if (!withinEditWindow(doc.createdAt, settings, clock.now())) {
      throw AppError.forbidden(
        `Yozuvni o'zgartirish muddati (${settings.editWindowHours} soat) tugagan`,
      );
    }
    return doc;
  },

  async update(
    ctx: Ctx,
    schoolId: string,
    id: string,
    patch: { statusId?: string; minutesLate?: number | null; note?: string | null },
  ) {
    const settings = await getAttendanceSettings(schoolId);
    const doc = await this.loadForChange(ctx, schoolId, id, settings);
    const before = snapshot(doc);
    const statuses = await loadStatuses(schoolId);

    const statusId = patch.statusId ?? String(doc.statusId);
    const note = patch.note !== undefined ? patch.note : (doc.note ?? null);
    const nextStatus = statuses.get(statusId);
    let minutesLate =
      patch.minutesLate !== undefined ? patch.minutesLate : (doc.minutesLate ?? null);
    // Kategoriya 'late' dan chiqsa va daqiqa berilmagan bo'lsa, avtomatik tozalanadi
    if (patch.minutesLate === undefined && nextStatus && nextStatus.category !== 'late')
      minutesLate = null;

    const { errors, category } = checkValues(
      settings,
      { statusId, minutesLate, note },
      statuses,
      String(doc.statusId),
    );
    throwValidation(errors);

    doc.statusId = new Types.ObjectId(statusId);
    doc.category = category as AttendanceRecordDoc['category'];
    doc.minutesLate = minutesLate;
    doc.note = note;
    doc.updatedBy = new Types.ObjectId(ctx.actor.id);
    await doc.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'attendance.update',
      entity: 'attendance',
      entityId: doc.id,
      before,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    void ratingEvents.attendanceChanged(schoolId);
    return (await toRecordDtos([doc], { actor: ctx.actor, settings }))[0];
  },

  async remove(ctx: Ctx, schoolId: string, id: string) {
    const settings = await getAttendanceSettings(schoolId);
    const doc = await this.loadForChange(ctx, schoolId, id, settings);
    const before = snapshot(doc);
    doc.isDeleted = true;
    doc.updatedBy = new Types.ObjectId(ctx.actor.id);
    await doc.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'attendance.delete',
      entity: 'attendance',
      entityId: doc.id,
      before,
      ip: ctx.ip,
    });
    void ratingEvents.attendanceChanged(schoolId);
  },

  async list(
    actor: Actor,
    schoolId: string,
    q: {
      classId?: string;
      studentId?: string;
      statusId?: string;
      category?: string;
      from?: string;
      to?: string;
      lessonNo?: number;
      sort: 'date' | '-date';
      page: number;
      limit: number;
    },
  ) {
    const settings = await getAttendanceSettings(schoolId);
    const filter: Record<string, unknown> = { schoolId, isDeleted: false };
    const scope = await allowedClassIds(actor, schoolId); // o'qituvchi: faqat o'z sinflari
    if (scope) filter.classId = { $in: q.classId ? scope.filter((c) => c === q.classId) : scope };
    else if (q.classId) filter.classId = q.classId;
    if (q.studentId) filter.studentId = q.studentId;
    if (q.statusId) filter.statusId = q.statusId;
    if (q.category) filter.category = q.category;
    if (q.lessonNo !== undefined) filter.lessonNo = q.lessonNo;
    if (q.from || q.to) {
      filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }
    const dir = q.sort === 'date' ? 1 : -1;
    const [docs, total] = await Promise.all([
      AttendanceRecord.find(filter)
        .sort({ date: dir, lessonNo: dir, createdAt: dir, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      AttendanceRecord.countDocuments(filter),
    ]);
    return {
      items: await toRecordDtos(docs, { actor, settings }),
      meta: buildMeta(q.page, q.limit, total),
    };
  },

  /** Davomat varag'i */
  async sheet(
    actor: Actor,
    schoolId: string,
    classId: string,
    q: { date?: string; lessonNo?: number },
  ) {
    const notFound = AppError.notFound('Sinf topilmadi');
    if (!isId(classId)) throw notFound;
    const filter: Record<string, unknown> = { _id: classId, schoolId };
    if (actor.role === 'teacher') filter.teacherIds = actor.id;
    const cls = await ClassModel.findOne(filter);
    if (!cls) throw notFound;

    const settings = await getAttendanceSettings(schoolId);
    const date = q.date ?? todayTashkent();
    // Varaqni ko'rishda dars raqami standart 1 (dars rejimida)
    const unit = resolveLessonNo(
      settings,
      settings.mode === 'lesson' ? (q.lessonNo ?? 1) : undefined,
    );
    throwValidation(unit.errors);

    const [students, statuses] = await Promise.all([
      Student.find({ schoolId, classId: cls._id, isDeleted: false, status: 'active' }).sort({
        fullName: 1,
        _id: 1,
      }),
      loadStatuses(schoolId),
    ]);
    const records = await AttendanceRecord.find({
      schoolId,
      date,
      lessonNo: unit.lessonNo,
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    });
    const dtos = await toRecordDtos(records, { actor, settings });
    const dtoByStudent = new Map(dtos.map((d) => [d.studentId, d]));

    const summary = {
      total: students.length,
      marked: 0,
      present: 0,
      late: 0,
      absentExcused: 0,
      absentUnexcused: 0,
    };
    for (const r of records) {
      summary.marked++;
      if (r.category === 'present') summary.present++;
      else if (r.category === 'late') summary.late++;
      else if (r.category === 'absent_excused') summary.absentExcused++;
      else summary.absentUnexcused++;
    }
    return {
      class: { id: cls.id as string, name: cls.name },
      date,
      mode: settings.mode,
      lessonNo: settings.mode === 'lesson' ? unit.lessonNo : null,
      lessonsPerDay: settings.lessonsPerDay,
      isWorkingDay: isWorkingDay(settings, date),
      settings,
      statuses: [...statuses.values()]
        .filter((s) => s.isActive)
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map(toStatusDto),
      students: students.map((s) => ({
        studentId: s.id as string,
        fullName: s.fullName,
        studentCode: s.studentCode ?? null,
        record: dtoByStudent.get(s.id) ?? null,
      })),
      summary,
    };
  },
};
