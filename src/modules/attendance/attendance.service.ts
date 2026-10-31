import { photoUrl } from '../photos/photos.url';
import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorCode, type ErrorDetail } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { AcademicYear } from '../../models/AcademicYear';
import {
  AttendanceRecord,
  type AttendanceRecordDoc,
  type AttendanceSource,
} from '../../models/AttendanceRecord';
import { AttendanceStatus, type AttendanceStatusDoc } from '../../models/AttendanceStatus';
import { ClassModel } from '../../models/Class';
import { Student } from '../../models/Student';
import { Subject } from '../../models/Subject';
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
  checkSubjectInput,
  resolveLessonNo,
  withinEditWindow,
  type RecordValues,
} from './attendance.rules';
import {
  assertLessonSubject,
  assertLessonSubjectFree,
  lessonSubjectOptions,
} from './attendance.subjects';
import {
  canAccessClassOn,
  chooseLesson,
  decideTake,
  enrichLessons,
  isAdminActor,
  isHomeroomOf,
  isParallelSlot,
  loadSlotContext,
  pickLesson,
  type TakeDecision,
} from './attendance.lesson';

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
  const userIds = uniq(
    docs.flatMap((d) => [
      String(d.markedBy),
      String(d.updatedBy),
      ...(d.teacherId ? [String(d.teacherId)] : []),
    ]),
  );
  const subjectIds = uniq(docs.flatMap((d) => (d.subjectId ? [String(d.subjectId)] : [])));
  const [students, classes, statuses, users, subjects] = await Promise.all([
    Student.find({ _id: { $in: studentIds } }).select('fullName'),
    ClassModel.find({ _id: { $in: classIds } }).select('name'),
    AttendanceStatus.find({ _id: { $in: statusIds } }),
    User.find({ _id: { $in: userIds } }).select('fullName'),
    subjectIds.length
      ? Subject.find({ _id: { $in: subjectIds } }).select('name')
      : Promise.resolve([]),
  ]);
  const sMap = new Map(students.map((s) => [s.id as string, s.fullName]));
  const cMap = new Map(classes.map((c) => [c.id as string, c.name]));
  const stMap = new Map(statuses.map((s) => [s.id as string, s]));
  const uMap = new Map(users.map((u) => [u.id as string, u.fullName]));
  const subMap = new Map(subjects.map((s) => [s.id as string, s.name]));
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
      subjectId: d.subjectId ? String(d.subjectId) : null,
      subject: d.subjectId
        ? { id: String(d.subjectId), name: subMap.get(String(d.subjectId)) ?? '' }
        : null,
      teacherId: d.teacherId ? String(d.teacherId) : null,
      teacher: d.teacherId
        ? { id: String(d.teacherId), fullName: uMap.get(String(d.teacherId)) ?? '' }
        : null,
      source: d.source ?? null,
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
  subjectId: d.subjectId ? String(d.subjectId) : null,
  teacherId: d.teacherId ? String(d.teacherId) : null,
  source: d.source ?? null,
  statusId: String(d.statusId),
  category: d.category,
  minutesLate: d.minutesLate,
  note: d.note,
});

const throwValidation = (details: ErrorDetail[]) => {
  if (details.length) throw AppError.validation("Ma'lumotlar noto'g'ri", details);
};

/** Faol yildagi arxivlanmagan sinf */
async function loadTakeableClass(
  actor: Actor,
  schoolId: string,
  classId: string,
  date: string,
  settings: AttendanceSettings,
) {
  const notFound = AppError.notFound('Sinf topilmadi');
  if (!isId(classId)) throw notFound;
  const [cls, yearId] = await Promise.all([
    ClassModel.findOne({ _id: classId, schoolId }),
    activeYearId(schoolId),
  ]);
  if (!cls) throw notFound;
  // O'qituvchi: o'z sinflari yoki shu sanada jadvalda darsi bor sinf (sanaga bog'liq vaqtinchalik kirish)
  if (!(await canAccessClassOn(actor, schoolId, cls, date, settings))) throw notFound;
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

const throwDenied = (d: TakeDecision) => {
  if (d.canTake) return;
  if (d.denial === 'conflict') throw AppError.conflict(d.reason ?? "Davomat olib bo'lmaydi");
  throw AppError.forbidden(d.reason ?? "Davomat olishga ruxsat yo'q");
};

/** Qo'lda olingan dars yozuvi uchun o'qituvchi snapshoti: o'qituvchi o'zi, aks holda null */
const manualTeacher = (actor: Actor): string | null => (actor.role === 'teacher' ? actor.id : null);

/** Parallel darsda boshqa o'qituvchi belgilagan yozuv uchun xabar */
async function crossLessonMessage(rec: AttendanceRecordDoc): Promise<string> {
  const [teacher, subject] = await Promise.all([
    rec.teacherId ? User.findById(rec.teacherId).select('fullName').lean() : null,
    rec.subjectId ? Subject.findById(rec.subjectId).select('name').lean() : null,
  ]);
  const who = teacher?.fullName ?? "boshqa o'qituvchi";
  const what = subject ? ` (${subject.name})` : '';
  return `Bu o'quvchi shu soatda ${who}${what} darsida allaqachon belgilangan`;
}

/** Varaqda: yozuv tanlangan darsdan boshqa o'qituvchiga tegishli bo'lsa */
function otherLessonOf(
  rec: {
    teacher: { id: string; fullName: string } | null;
    subject: { id: string; name: string } | null;
  } | null,
  lesson: { teacherId: string } | null,
) {
  if (!rec?.teacher || !lesson || rec.teacher.id === lesson.teacherId) return null;
  return { teacher: rec.teacher, subject: rec.subject };
}

const scheduledSubjectConflict = async (subjectId: string) => {
  const name = (await Subject.findById(subjectId).select('name').lean())?.name ?? '';
  return AppError.conflict(
    `Jadvalga ko'ra bu dars ${name} fanidan; boshqa fan tanlash uchun admin yoki sinf rahbari kerak`,
  );
};

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
      subjectId?: string;
      /** Slotda bir nechta dars bo'lsa: qaysi o'qituvchining darsi (admin / sinf rahbari) */
      teacherId?: string;
      items: {
        studentId: string;
        statusId: string;
        minutesLate?: number | null;
        note?: string | null;
      }[];
    },
  ) {
    const settings = await getAttendanceSettings(schoolId);
    const date = input.date ?? todayTashkent();
    const { cls, yearId } = await loadTakeableClass(
      ctx.actor,
      schoolId,
      input.classId,
      date,
      settings,
    );
    const slot = await loadSlotContext(schoolId, input.classId, date, settings);
    const unit = resolveLessonNo(settings, input.lessonNo, slot.maxNo);
    throwValidation([...checkDate(settings, date, todayTashkent()), ...unit.errors]);
    const lessonNo = unit.lessonNo;

    // Dars rejimi: jadval (agar yoqilgan bo'lsa) bo'yicha kim va qaysi fanga davomat olishi mumkin
    const choice =
      settings.mode === 'lesson'
        ? chooseLesson(slot, lessonNo, {
            actorId: ctx.actor.role === 'teacher' ? ctx.actor.id : null,
            teacherId: input.teacherId,
            subjectId: input.subjectId,
          })
        : { lesson: null, ambiguous: false };
    const lesson = choice.lesson;
    if (choice.ambiguous) {
      throw AppError.validation("Bu soatda bir nechta dars bor: o'qituvchini tanlang", [
        { path: 'teacherId', message: "Bu soatda bir nechta dars bor: o'qituvchini tanlang" },
      ]);
    }
    const decision = settings.mode === 'lesson' ? decideTake(ctx.actor, cls, slot, lesson) : null;
    if (decision) throwDenied(decision);
    // Bir vaqtda bir nechta dars (parallel o'qituvchilar): "bir dars = bir fan" qoidasi o'quvchi darajasida
    const parallel = settings.mode === 'lesson' && isParallelSlot(slot, lessonNo);
    const privileged =
      isAdminActor(ctx.actor) || (isHomeroomOf(cls, ctx.actor) && slot.tt.homeroomCanTakeAnyLesson);
    const resolved = decision && lesson && !decision.manual ? lesson : null;
    throwValidation(checkSubjectInput(settings, input.subjectId, !!resolved));

    // Fan, huquq va "bir dars = bir fan" qoidasi
    let subjectId: string | null = null;
    let teacherId: string | null = null;
    let source: AttendanceSource | null = null;
    if (resolved && (!input.subjectId || input.subjectId === resolved.subjectId)) {
      if (!parallel) {
        await assertLessonSubjectFree(schoolId, cls._id, date, lessonNo, resolved.subjectId);
      }
      subjectId = resolved.subjectId;
      teacherId = resolved.teacherId;
      source = resolved.source;
    } else if (settings.mode === 'lesson' && input.subjectId) {
      if (resolved && !decision?.canOverride)
        throw await scheduledSubjectConflict(resolved.subjectId);
      const used = await AttendanceRecord.distinct('subjectId', {
        schoolId,
        classId: cls._id,
        date,
        lessonNo,
        isDeleted: false,
        subjectId: { $ne: null },
      });
      await assertLessonSubject(
        ctx.actor,
        schoolId,
        cls,
        input.subjectId,
        used.map((u) => String(u)),
      );
      if (!parallel) {
        await assertLessonSubjectFree(schoolId, cls._id, date, lessonNo, input.subjectId);
      }
      subjectId = input.subjectId;
      teacherId = manualTeacher(ctx.actor);
      source = 'manual';
    }

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
    let crossConflicts = 0;

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
      // Parallel darslar: o'quvchi shu soatda boshqa o'qituvchining darsida allaqachon belgilangan
      const other = existingBy.get(item.studentId);
      const crossLesson =
        parallel &&
        !!other &&
        !!teacherId &&
        !!other.teacherId &&
        String(other.teacherId) !== teacherId;
      if (crossLesson && !privileged) {
        crossConflicts++;
        fail('CONFLICT', await crossLessonMessage(other as AttendanceRecordDoc));
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
          // Admin / sinf rahbari boshqa o'qituvchi darsidagi belgini almashtira oladi (oxirgi yozuv g'olib)
          if (!(crossLesson && privileged) && !isEditable(prev, ctx.actor, settings, now)) {
            fail(
              'FORBIDDEN',
              "Bu yozuvni o'zgartirishga ruxsat yo'q (muddat tugagan yoki boshqa foydalanuvchi yozgan)",
            );
            continue;
          }
          prev.statusId = new Types.ObjectId(values.statusId);
          if (subjectId && String(prev.subjectId ?? '') !== subjectId) {
            // Fan o'zgargan: snapshot ham yangilanadi
            prev.subjectId = new Types.ObjectId(subjectId);
            prev.teacherId = teacherId ? new Types.ObjectId(teacherId) : null;
            prev.source = source;
          } else if (teacherId && prev.teacherId && String(prev.teacherId) !== teacherId) {
            // Parallel darslarda belgi boshqa o'qituvchi darsidan olib o'tiladi
            prev.teacherId = new Types.ObjectId(teacherId);
            prev.source = source;
          } else if (subjectId && !prev.source) {
            // Eski (snapshotsiz) yozuv
            prev.teacherId = teacherId ? new Types.ObjectId(teacherId) : null;
            prev.source = source;
          }
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
            subjectId,
            teacherId,
            source,
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

    if (crossConflicts > 0 && created + updated === 0 && failed.length === crossConflicts) {
      throw AppError.conflict(
        failed[0]?.message ?? "O'quvchi boshqa o'qituvchi darsida allaqachon belgilangan",
        failed.map((f) => ({ path: `items.${f.studentId}`, message: f.message })),
      );
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
        subjectId,
        teacherId,
        source,
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
    const docClass = await ClassModel.findOne({ _id: doc.classId, schoolId });
    if (!docClass || !(await canAccessClassOn(ctx.actor, schoolId, docClass, doc.date, settings))) {
      throw notFound;
    }
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
    patch: {
      statusId?: string;
      subjectId?: string;
      minutesLate?: number | null;
      note?: string | null;
    },
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

    if (patch.subjectId !== undefined) {
      if (doc.lessonNo === 0) {
        throwValidation([{ path: 'subjectId', message: 'Kunlik yozuvga fan biriktirilmaydi' }]);
      }
      const cls = await ClassModel.findOne({ _id: doc.classId, schoolId });
      if (!cls) throw AppError.notFound('Sinf topilmadi');
      const slot = await loadSlotContext(schoolId, String(doc.classId), doc.date, settings);
      const lesson = pickLesson(slot, doc.lessonNo, {
        actorId: ctx.actor.role === 'teacher' ? ctx.actor.id : null,
        teacherId: doc.teacherId ? String(doc.teacherId) : null,
        subjectId: patch.subjectId,
      });
      const decision = decideTake(ctx.actor, cls, slot, lesson);
      throwDenied(decision);
      let nextSource: AttendanceSource = 'manual';
      let nextTeacher = manualTeacher(ctx.actor);
      const scheduled = lesson && !decision.manual ? lesson : null;
      if (scheduled && patch.subjectId === scheduled.subjectId) {
        nextSource = scheduled.source;
        nextTeacher = scheduled.teacherId;
      } else {
        if (scheduled && !decision.canOverride)
          throw await scheduledSubjectConflict(scheduled.subjectId);
        const keep = doc.subjectId ? [String(doc.subjectId)] : [];
        await assertLessonSubject(ctx.actor, schoolId, cls, patch.subjectId, keep);
      }
      await assertLessonSubjectFree(
        schoolId,
        doc.classId,
        doc.date,
        doc.lessonNo,
        patch.subjectId,
        doc._id,
      );
      doc.subjectId = new Types.ObjectId(patch.subjectId);
      doc.teacherId = nextTeacher ? new Types.ObjectId(nextTeacher) : null;
      doc.source = nextSource;
    }
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
      subjectId?: string;
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
    if (q.subjectId) filter.subjectId = q.subjectId;
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
    q: { date?: string; lessonNo?: number; teacherId?: string },
  ) {
    const notFound = AppError.notFound('Sinf topilmadi');
    if (!isId(classId)) throw notFound;
    const cls = await ClassModel.findOne({ _id: classId, schoolId });
    if (!cls) throw notFound;

    const settings = await getAttendanceSettings(schoolId);
    const date = q.date ?? todayTashkent();
    if (!(await canAccessClassOn(actor, schoolId, cls, date, settings))) throw notFound;
    const slot = await loadSlotContext(schoolId, classId, date, settings);
    // Varaqni ko'rishda dars raqami standart 1 (dars rejimida)
    const unit = resolveLessonNo(
      settings,
      settings.mode === 'lesson' ? (q.lessonNo ?? 1) : undefined,
      slot.maxNo,
    );
    throwValidation(unit.errors);
    const choice =
      settings.mode === 'lesson'
        ? chooseLesson(slot, unit.lessonNo, {
            actorId: actor.role === 'teacher' ? actor.id : null,
            teacherId: q.teacherId,
          })
        : { lesson: null, ambiguous: false };
    const lesson = choice.lesson;
    const decision = settings.mode === 'lesson' ? decideTake(actor, cls, slot, lesson) : null;
    const lessonDtos = await enrichLessons(slot.lessons, actor);

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

    // Dars rejimi: darsning joriy fani (yozuvlardan) va tanlanadigan fanlar
    let lessonSubject: { id: string; name: string } | null = null;
    let subjects: Awaited<ReturnType<typeof lessonSubjectOptions>> = [];
    if (settings.mode === 'lesson') {
      // Parallel darslarda tanlangan dars o'qituvchisining yozuvlaridagi fan (eski, o'qituvchisiz yozuvlar ham)
      lessonSubject =
        dtos.find((d) => d.subject && (!lesson || !d.teacherId || d.teacherId === lesson.teacherId))
          ?.subject ?? null;
      subjects = await lessonSubjectOptions(
        actor,
        schoolId,
        cls,
        lessonSubject ? [lessonSubject.id] : [],
      );
    }

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
      subjectId: lessonSubject?.id ?? null,
      subject: lessonSubject,
      subjects,
      lessonsPerDay: settings.lessonsPerDay,
      /** Ruxsat etilgan eng katta dars raqami: max(lessonsPerDay, jadvaldagi eng katta dars) */
      maxLessonNo: settings.mode === 'lesson' ? slot.maxNo : null,
      timetable: {
        enforcement: slot.tt.enforcement,
        hasTimetable: slot.hasVersion,
        homeroomCanTakeAnyLesson: slot.tt.homeroomCanTakeAnyLesson,
      },
      lesson: lesson
        ? (lessonDtos.find(
            (l) =>
              l.lessonNo === lesson.lessonNo &&
              l.groupKey === lesson.groupKey &&
              l.teacherId === lesson.teacherId,
          ) ?? null)
        : null,
      lessons: lessonDtos,
      /** Slotda bir nechta dars bor va qaysi biri ekani aniqlanmadi (admin / sinf rahbari tanlashi kerak) */
      lessonChoiceRequired: choice.ambiguous,
      canTake: decision ? decision.canTake : true,
      cannotTakeReason: decision?.reason ?? null,
      /** Jadvaldagi fan o'rniga boshqasini tanlash mumkin (admin / sinf rahbari, suggest) */
      canOverrideSubject: decision ? decision.canOverride : false,
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
        photo: photoUrl(s.photoId),
        record: dtoByStudent.get(s.id) ?? null,
        /** Shu soatda boshqa o'qituvchining (parallel) darsida belgilangan bo'lsa — kim va qaysi fan */
        otherLesson: otherLessonOf(dtoByStudent.get(s.id) ?? null, lesson),
      })),
      summary,
    };
  },
};
