import type { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorCode, type ErrorDetail } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { Student, type StudentDoc } from '../../models/Student';
import { Subject, type SubjectDoc } from '../../models/Subject';
import { SubjectGrade, type SubjectGradeDoc } from '../../models/SubjectGrade';
import { User } from '../../models/User';
import { addDaysStr, clock, todayTashkent } from '../../utils/clock';
import { round2 } from '../../utils/dayScore';
import { isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { allowedClassIds } from '../classes/classes.service';
import { ratingEvents } from '../ratings/ratings.events';
import { settingsService } from '../settings/settings.service';
import type { ScoringSettings } from '../settings/scoring.settings';
import { withinEditWindow } from '../scores/scores.rules';
import { canEditAnyGrade, checkDate, checkGradeValue, isGradeEditable } from './grades.rules';

type Actor = Ctx['actor'];

// ---------- DTO ----------

export async function toGradeDtos(
  docs: SubjectGradeDoc[],
  opts: { actor: Actor; settings: ScoringSettings; hideOthersComments?: boolean },
) {
  if (!docs.length) return [];
  const [students, classes, teachers, subjects] = await Promise.all([
    Student.find({ _id: { $in: uniq(docs.map((d) => String(d.studentId))) } }).select('fullName'),
    ClassModel.find({ _id: { $in: uniq(docs.map((d) => String(d.classId))) } }).select('name'),
    User.find({ _id: { $in: uniq(docs.map((d) => String(d.teacherId))) } }).select('fullName'),
    Subject.find({ _id: { $in: uniq(docs.map((d) => String(d.subjectId))) } }).select('name'),
  ]);
  const sMap = new Map(students.map((s) => [s.id as string, s.fullName]));
  const cMap = new Map(classes.map((c) => [c.id as string, c.name]));
  const tMap = new Map(teachers.map((t) => [t.id as string, t.fullName]));
  const subMap = new Map(subjects.map((s) => [s.id as string, s.name]));
  const now = clock.now();

  return docs.map((d) => {
    const own = String(d.teacherId) === opts.actor.id;
    return {
      id: d.id as string,
      schoolId: String(d.schoolId),
      studentId: String(d.studentId),
      student: { id: String(d.studentId), fullName: sMap.get(String(d.studentId)) ?? '' },
      classId: String(d.classId),
      class: { id: String(d.classId), name: cMap.get(String(d.classId)) ?? '' },
      subjectId: String(d.subjectId),
      subject: { id: String(d.subjectId), name: subMap.get(String(d.subjectId)) ?? '' },
      teacherId: String(d.teacherId),
      teacher: { id: String(d.teacherId), fullName: tMap.get(String(d.teacherId)) ?? '' },
      academicYearId: String(d.academicYearId),
      value: d.value,
      comment: opts.hideOthersComments && !own ? null : (d.comment ?? null),
      date: d.date,
      editable: isGradeEditable(d, opts.actor, opts.settings, now),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}

const snapshot = (d: SubjectGradeDoc) => ({
  studentId: String(d.studentId),
  classId: String(d.classId),
  subjectId: String(d.subjectId),
  teacherId: String(d.teacherId),
  value: d.value,
  comment: d.comment,
  date: d.date,
});

// ---------- Yordamchilar ----------

const throwValidation = (details: ErrorDetail[]) => {
  if (details.length) throw AppError.validation("Ma'lumotlar noto'g'ri", details);
};

async function activeYearId(schoolId: string): Promise<string | null> {
  const y = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  return y ? (y.id as string) : null;
}

/** Maktabga ko'rinadigan (global yoki o'z) FAOL fan */
async function loadSubject(schoolId: string, subjectId: string): Promise<SubjectDoc> {
  const doc = isId(subjectId)
    ? await Subject.findOne({ _id: subjectId, $or: [{ schoolId: null }, { schoolId }] })
    : null;
  if (!doc) throw AppError.notFound('Fan topilmadi');
  if (!doc.isActive) {
    throw AppError.validation('Fan faol emas', [{ path: 'subjectId', message: 'Fan faol emas' }]);
  }
  return doc;
}

/**
 * Baholash huquqi: o'qituvchi faqat o'zi shu fan o'qituvchisi etib biriktirilgan sinfda baholaydi;
 * superadmin / school_admin (grades.create — marshrutda tekshiriladi) — maktabdagi istalgan sinf/fan.
 */
async function assertCanGrade(actor: Actor, classId: Types.ObjectId, subjectId: Types.ObjectId) {
  if (actor.role !== 'teacher') return;
  const assigned = await ClassSubject.exists({ classId, subjectId, teacherId: actor.id });
  if (!assigned) {
    throw AppError.forbidden("Siz bu sinfda bu fan o'qituvchisi sifatida biriktirilmagansiz");
  }
}

/** Faol yildagi arxivlanmagan sinfdagi faol o'quvchi baholanadi */
function assertGradable(student: StudentDoc, cls: ClassDoc | null, yearId: string | null) {
  const err = (message: string) => AppError.validation(message, [{ path: 'studentId', message }]);
  if (student.status !== 'active') throw err("Faqat faol o'quvchini baholash mumkin");
  if (!cls || cls.isArchived) throw err('Sinf arxivlangan');
  if (!yearId || String(cls.academicYearId) !== yearId) {
    throw err("Faqat faol o'quv yilidagi sinf o'quvchisini baholash mumkin");
  }
}

const conflict = () =>
  AppError.conflict("Bu o'quvchiga shu fandan shu kuni allaqachon baho qo'yilgan", [
    { path: 'studentId', message: 'Bu kun uchun baho mavjud' },
  ]);

async function loadClass(schoolId: string, classId: string): Promise<ClassDoc> {
  const cls = isId(classId) ? await ClassModel.findOne({ _id: classId, schoolId }) : null;
  if (!cls) throw AppError.notFound('Sinf topilmadi');
  return cls;
}

const rangeCheck = (from: string, to: string) => {
  if (from > to) {
    throw AppError.validation("Davr noto'g'ri", [
      { path: 'from', message: "'from' sanasi 'to' dan keyin bo'lmasligi kerak" },
    ]);
  }
  if (addDaysStr(from, 366) < to) {
    throw AppError.validation('Davr juda uzun', [
      { path: 'to', message: 'Davr 366 kundan oshmasligi kerak' },
    ]);
  }
};

// ---------- Servis ----------

export const gradesService = {
  async create(
    ctx: Ctx,
    schoolId: string,
    input: {
      studentId: string;
      subjectId: string;
      date?: string;
      value: number;
      comment?: string | null;
    },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const notFound = AppError.notFound("O'quvchi topilmadi");
    const student = isId(input.studentId)
      ? await Student.findOne({ _id: input.studentId, schoolId, isDeleted: false })
      : null;
    if (!student) throw notFound;
    const [subject, yearId, cls] = await Promise.all([
      loadSubject(schoolId, input.subjectId),
      activeYearId(schoolId),
      ClassModel.findOne({ _id: student.classId, schoolId }),
    ]);
    assertGradable(student, cls, yearId);
    await assertCanGrade(ctx.actor, student.classId, subject._id);

    const date = input.date ?? todayTashkent();
    throwValidation([
      ...checkDate(settings, date, todayTashkent()),
      ...checkGradeValue(input.value),
    ]);
    if (
      await SubjectGrade.exists({
        schoolId,
        studentId: student._id,
        subjectId: subject._id,
        date,
        isDeleted: false,
      })
    ) {
      throw conflict();
    }
    let doc: SubjectGradeDoc;
    try {
      doc = await SubjectGrade.create({
        schoolId,
        studentId: student._id,
        classId: student.classId,
        subjectId: subject._id,
        teacherId: ctx.actor.id,
        academicYearId: yearId as string,
        value: input.value,
        comment: input.comment ?? null,
        date,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw conflict();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'grades.create',
      entity: 'subject_grade',
      entityId: doc.id,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toGradeDtos([doc], { actor: ctx.actor, settings }))[0];
  },

  /** O'zgartirish/o'chirish uchun bahoni topadi va huquqni tekshiradi */
  async loadForChange(
    ctx: Ctx,
    schoolId: string,
    id: string,
    settings: ScoringSettings,
  ): Promise<SubjectGradeDoc> {
    const notFound = AppError.notFound('Baho topilmadi');
    const doc = isId(id)
      ? await SubjectGrade.findOne({ _id: id, schoolId, isDeleted: false })
      : null;
    if (!doc) throw notFound;
    if (canEditAnyGrade(ctx.actor)) return doc;
    if (String(doc.teacherId) !== ctx.actor.id) {
      // O'qituvchi boshqa o'qituvchining bahosini umuman ko'rmaydi
      if (ctx.actor.role === 'teacher') throw notFound;
      throw AppError.forbidden("Bu bahoni o'zgartirishga ruxsat yo'q (grades.edit kerak)");
    }
    if (!withinEditWindow(doc.createdAt, settings, clock.now())) {
      throw AppError.forbidden(
        `Bahoni o'zgartirish muddati (${settings.editWindowHours} soat) tugagan`,
      );
    }
    return doc;
  },

  async update(
    ctx: Ctx,
    schoolId: string,
    id: string,
    patch: { value?: number; comment?: string | null },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const doc = await this.loadForChange(ctx, schoolId, id, settings);
    const before = snapshot(doc);
    const value = patch.value ?? doc.value;
    throwValidation(checkGradeValue(value));
    doc.value = value;
    if (patch.comment !== undefined) doc.comment = patch.comment;
    await doc.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'grades.update',
      entity: 'subject_grade',
      entityId: doc.id,
      before,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toGradeDtos([doc], { actor: ctx.actor, settings }))[0];
  },

  async remove(ctx: Ctx, schoolId: string, id: string) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const doc = await this.loadForChange(ctx, schoolId, id, settings);
    const before = snapshot(doc);
    doc.isDeleted = true;
    await doc.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'grades.delete',
      entity: 'subject_grade',
      entityId: doc.id,
      before,
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
  },

  /** Ommaviy baholash (UPSERT): sinf + fan + sana; har element mustaqil tekshiriladi */
  async bulk(
    ctx: Ctx,
    schoolId: string,
    input: {
      classId: string;
      subjectId: string;
      date?: string;
      items: { studentId: string; value: number; comment?: string | null }[];
    },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const cls = await loadClass(schoolId, input.classId);
    const subject = await loadSubject(schoolId, input.subjectId);
    await assertCanGrade(ctx.actor, cls._id, subject._id);
    const yearId = await activeYearId(schoolId);
    if (cls.isArchived || !yearId || String(cls.academicYearId) !== yearId) {
      throw AppError.validation('Sinf baholash uchun mavjud emas', [
        { path: 'classId', message: "Faqat faol o'quv yilidagi arxivlanmagan sinf baholanadi" },
      ]);
    }
    const date = input.date ?? todayTashkent();
    throwValidation(checkDate(settings, date, todayTashkent()));

    const students = await Student.find({ schoolId, classId: cls._id, isDeleted: false });
    const byId = new Map(students.map((s) => [s.id as string, s]));
    const existing = await SubjectGrade.find({
      schoolId,
      subjectId: subject._id,
      date,
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    });
    const existingBy = new Map(existing.map((g) => [String(g.studentId), g]));

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
        fail('VALIDATION_ERROR', "Faqat faol o'quvchini baholash mumkin");
        continue;
      }
      const errs = checkGradeValue(item.value);
      if (errs.length) {
        fail('VALIDATION_ERROR', errs.map((e) => e.message).join('; '));
        continue;
      }
      const comment = item.comment ?? null;
      try {
        const prev = existingBy.get(item.studentId);
        if (prev) {
          if (!isGradeEditable(prev, ctx.actor, settings, now)) {
            fail(
              'FORBIDDEN',
              `Bahoni o'zgartirish muddati (${settings.editWindowHours} soat) tugagan yoki baho boshqa o'qituvchiniki`,
            );
            continue;
          }
          prev.value = item.value;
          prev.comment = comment;
          await prev.save();
          updated++;
        } else {
          await SubjectGrade.create({
            schoolId,
            studentId: student._id,
            classId: student.classId,
            subjectId: subject._id,
            teacherId: ctx.actor.id,
            academicYearId: yearId,
            value: item.value,
            comment,
            date,
          });
          created++;
        }
      } catch (e) {
        if (isDuplicateKeyError(e)) fail('CONFLICT', 'Bu kun uchun baho allaqachon mavjud');
        else throw e;
      }
    }

    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'grades.bulk',
      entity: 'subject_grade',
      entityId: input.classId,
      after: {
        classId: input.classId,
        subjectId: input.subjectId,
        date,
        created,
        updated,
        failed: failed.length,
        items: input.items.length,
      },
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return { created, updated, failed };
  },

  async list(
    actor: Actor,
    schoolId: string,
    q: {
      classId?: string;
      subjectId?: string;
      studentId?: string;
      teacherId?: string;
      from?: string;
      to?: string;
      sort: 'date' | '-date';
      page: number;
      limit: number;
    },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const filter: Record<string, unknown> = { schoolId, isDeleted: false };
    // O'qituvchi faqat o'z baholarini ko'radi (teacherId filtri e'tiborga olinmaydi)
    if (actor.role === 'teacher') filter.teacherId = actor.id;
    else if (q.teacherId) filter.teacherId = q.teacherId;
    if (q.classId) filter.classId = q.classId;
    if (q.subjectId) filter.subjectId = q.subjectId;
    if (q.studentId) filter.studentId = q.studentId;
    if (q.from || q.to) {
      filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }
    const dir = q.sort === 'date' ? 1 : -1;
    const [docs, total] = await Promise.all([
      SubjectGrade.find(filter)
        .sort({ date: dir, createdAt: dir, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      SubjectGrade.countDocuments(filter),
    ]);
    return {
      items: await toGradeDtos(docs, { actor, settings }),
      meta: buildMeta(q.page, q.limit, total),
    };
  },

  /**
   * O'qituvchining baholash doirasi: biriktirilgan sinf+fan juftliklari (faol yil, arxivlanmagan sinf, faol fan).
   * Admin rollari uchun mode='all' (istalgan sinf/fan; juftliklar ro'yxati bo'sh).
   */
  async myAssignments(actor: Actor, schoolId: string) {
    if (actor.role !== 'teacher') return { mode: 'all' as const, assignments: [] };
    const yearId = await activeYearId(schoolId);
    if (!yearId) return { mode: 'assigned' as const, assignments: [] };
    const rows = await ClassSubject.find({
      schoolId,
      academicYearId: yearId,
      teacherId: actor.id,
    }).lean();
    const [classes, subjects] = await Promise.all([
      ClassModel.find({
        _id: { $in: uniq(rows.map((r) => String(r.classId))) },
        isArchived: false,
      })
        .select('name grade')
        .lean(),
      Subject.find({ _id: { $in: uniq(rows.map((r) => String(r.subjectId))) }, isActive: true })
        .select('name order')
        .lean(),
    ]);
    const cMap = new Map(classes.map((c) => [String(c._id), c]));
    const sMap = new Map(subjects.map((s) => [String(s._id), s]));
    const assignments = rows
      .filter((r) => cMap.has(String(r.classId)) && sMap.has(String(r.subjectId)))
      .map((r) => {
        const c = cMap.get(String(r.classId));
        const s = sMap.get(String(r.subjectId));
        return {
          classId: String(r.classId),
          className: c?.name ?? '',
          grade: c?.grade ?? 0,
          subjectId: String(r.subjectId),
          subjectName: s?.name ?? '',
        };
      })
      .sort(
        (a, b) =>
          a.grade - b.grade ||
          a.className.localeCompare(b.className, 'uz') ||
          a.subjectName.localeCompare(b.subjectName, 'uz'),
      );
    return { mode: 'assigned' as const, assignments };
  },

  /** Baholash varag'i: sinf o'quvchilari + shu fan/kun bahosi */
  async sheet(
    actor: Actor,
    schoolId: string,
    q: { classId: string; subjectId: string; date?: string },
  ) {
    const cls = await loadClass(schoolId, q.classId);
    const subject = await loadSubject(schoolId, q.subjectId);
    await assertCanGrade(actor, cls._id, subject._id);

    const settings = await settingsService.getEffectiveScoring(schoolId);
    const day = q.date ?? todayTashkent();
    const students = await Student.find({
      schoolId,
      classId: cls._id,
      isDeleted: false,
      status: 'active',
    }).sort({ fullName: 1, _id: 1 });
    const grades = await SubjectGrade.find({
      schoolId,
      subjectId: subject._id,
      date: day,
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    });
    const dtos = await toGradeDtos(grades, { actor, settings });
    const byStudent = new Map(dtos.map((d) => [d.studentId, d]));
    return {
      class: { id: cls.id as string, name: cls.name },
      subject: { id: subject.id as string, name: subject.name },
      date: day,
      settings: { editWindowHours: settings.editWindowHours, backdateDays: settings.backdateDays },
      students: students.map((st) => {
        const grade = byStudent.get(st.id as string) ?? null;
        return {
          studentId: st.id as string,
          fullName: st.fullName,
          studentCode: st.studentCode ?? null,
          grade,
          alreadyGraded: !!grade,
        };
      }),
    };
  },

  /** O'quvchi fan baholari xulosasi: fanlar bo'yicha o'rtacha va so'nggi baholar */
  async studentSummary(
    actor: Actor,
    schoolId: string,
    studentId: string,
    range: { from?: string; to?: string },
  ) {
    const notFound = AppError.notFound("O'quvchi topilmadi");
    if (!isId(studentId)) throw notFound;
    const student = await Student.findOne({ _id: studentId, schoolId, isDeleted: false });
    if (!student) throw notFound;
    const scope = await allowedClassIds(actor, schoolId);
    if (scope && !scope.includes(String(student.classId))) throw notFound;

    const to = range.to ?? todayTashkent();
    const from = range.from ?? addDaysStr(to, -29);
    rangeCheck(from, to);

    const settings = await settingsService.getEffectiveScoring(schoolId);
    const grades = await SubjectGrade.find({
      schoolId,
      studentId: student._id,
      isDeleted: false,
      date: { $gte: from, $lte: to },
    }).sort({ date: 1, createdAt: 1 });

    const subjects = await Subject.find({
      _id: { $in: uniq(grades.map((g) => String(g.subjectId))) },
    })
      .select('name order')
      .lean();
    const nameOf = new Map(subjects.map((s) => [String(s._id), s]));
    const bySubjectMap = new Map<string, SubjectGradeDoc[]>();
    for (const g of grades) {
      const k = String(g.subjectId);
      bySubjectMap.set(k, [...(bySubjectMap.get(k) ?? []), g]);
    }
    const avgOf = (list: { value: number }[]) =>
      list.length ? round2(list.reduce((a, g) => a + g.value, 0) / list.length) : null;
    const bySubject = [...bySubjectMap.entries()]
      .map(([subjectId, list]) => ({
        subjectId,
        name: nameOf.get(subjectId)?.name ?? '',
        average: avgOf(list),
        count: list.length,
        lastValue: list[list.length - 1].value,
        lastDate: list[list.length - 1].date,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uz'));

    const recentDocs = [...grades].reverse().slice(0, 10);
    const recent = await toGradeDtos(recentDocs, {
      actor,
      settings,
      hideOthersComments: actor.role === 'teacher',
    });
    const average = avgOf(grades);
    return {
      studentId: student.id as string,
      from,
      to,
      average,
      /** 100 ballik shkalada (o'rtacha × 20) — reytingda ishlatiladi */
      average100: average === null ? null : round2(average * 20),
      gradesCount: grades.length,
      bySubject,
      recent,
    };
  },
};
