import { photoUrl } from '../photos/photos.url';
import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorCode, type ErrorDetail } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { AcademicYear } from '../../models/AcademicYear';
import { BehaviorType, type BehaviorTypeDoc } from '../../models/BehaviorType';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { Score, type ScoreDoc } from '../../models/Score';
import { Student, type StudentDoc } from '../../models/Student';
import { User } from '../../models/User';
import { addDaysStr, clock, todayTashkent } from '../../utils/clock';
import { dailyScore, round2 } from '../../utils/dayScore';
import { isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { allowedClassIds } from '../classes/classes.service';
import type { ScoringSettings } from '../settings/scoring.settings';
import { settingsService } from '../settings/settings.service';
import { ratingEvents } from '../ratings/ratings.events';
import {
  canEditAny,
  checkDate,
  checkValues,
  isEditable,
  withinEditWindow,
  type ScoreValues,
} from './scores.rules';

type Actor = Ctx['actor'];

// ---------- DTO ----------

export async function toScoreDtos(
  docs: ScoreDoc[],
  opts: { actor: Actor; settings: ScoringSettings; hideOthersComments?: boolean },
) {
  if (!docs.length) return [];
  const studentIds = uniq(docs.map((d) => String(d.studentId)));
  const classIds = uniq(docs.map((d) => String(d.classId)));
  const teacherIds = uniq(docs.map((d) => String(d.teacherId)));
  const typeIds = uniq(docs.filter((d) => d.behaviorTypeId).map((d) => String(d.behaviorTypeId)));
  const [students, classes, teachers, types] = await Promise.all([
    Student.find({ _id: { $in: studentIds } }).select('fullName'),
    ClassModel.find({ _id: { $in: classIds } }).select('name'),
    User.find({ _id: { $in: teacherIds } }).select('fullName'),
    typeIds.length ? BehaviorType.find({ _id: { $in: typeIds } }) : Promise.resolve([]),
  ]);
  const sMap = new Map(students.map((s) => [s.id as string, s.fullName]));
  const cMap = new Map(classes.map((c) => [c.id as string, c.name]));
  const tMap = new Map(teachers.map((t) => [t.id as string, t.fullName]));
  const bMap = new Map(types.map((b) => [b.id as string, b]));
  const now = clock.now();

  return docs.map((d) => {
    const bt = d.behaviorTypeId ? bMap.get(String(d.behaviorTypeId)) : undefined;
    const own = String(d.teacherId) === opts.actor.id;
    return {
      id: d.id as string,
      schoolId: String(d.schoolId),
      studentId: String(d.studentId),
      student: { id: String(d.studentId), fullName: sMap.get(String(d.studentId)) ?? '' },
      classId: String(d.classId),
      class: { id: String(d.classId), name: cMap.get(String(d.classId)) ?? '' },
      teacherId: String(d.teacherId),
      teacher: { id: String(d.teacherId), fullName: tMap.get(String(d.teacherId)) ?? '' },
      academicYearId: String(d.academicYearId),
      behaviorTypeId: d.behaviorTypeId ? String(d.behaviorTypeId) : null,
      behaviorType: bt
        ? { id: bt.id as string, name: bt.name, kind: bt.kind, color: bt.color }
        : null,
      value: d.value,
      comment: opts.hideOthersComments && !own ? null : (d.comment ?? null),
      date: d.date,
      editable: isEditable(d, opts.actor, opts.settings, now),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}

const snapshot = (d: ScoreDoc) => ({
  studentId: String(d.studentId),
  classId: String(d.classId),
  teacherId: String(d.teacherId),
  behaviorTypeId: d.behaviorTypeId ? String(d.behaviorTypeId) : null,
  value: d.value,
  comment: d.comment,
  date: d.date,
});

// ---------- Yordamchilar ----------

const throwValidation = (details: ErrorDetail[]) => {
  if (details.length) throw AppError.validation("Ma'lumotlar noto'g'ri", details);
};

/** Maktabga ko'rinadigan (global + o'z) xulq turlari */
async function loadTypes(schoolId: string): Promise<Map<string, BehaviorTypeDoc>> {
  const docs = await BehaviorType.find({ $or: [{ schoolId: null }, { schoolId }] });
  return new Map(docs.map((d) => [d.id as string, d]));
}

async function activeYearId(schoolId: string): Promise<string | null> {
  const y = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  return y ? (y.id as string) : null;
}

/** Faol yildagi arxivlanmagan sinfdagi faol o'quvchi baholanadi */
function assertScorable(student: StudentDoc, cls: ClassDoc | null, yearId: string | null) {
  const err = (message: string) => AppError.validation(message, [{ path: 'studentId', message }]);
  if (student.status !== 'active') throw err("Faqat faol o'quvchini baholash mumkin");
  if (!cls || cls.isArchived) throw err('Sinf arxivlangan');
  if (!yearId || String(cls.academicYearId) !== yearId) {
    throw err("Faqat faol o'quv yilidagi sinf o'quvchisini baholash mumkin");
  }
}

async function findStudent(actor: Actor, schoolId: string, studentId: string): Promise<StudentDoc> {
  const notFound = AppError.notFound("O'quvchi topilmadi");
  if (!isId(studentId)) throw notFound;
  const student = await Student.findOne({ _id: studentId, schoolId, isDeleted: false });
  if (!student) throw notFound;
  const scope = await allowedClassIds(actor, schoolId);
  if (scope && !scope.includes(String(student.classId))) throw notFound;
  return student;
}

/**
 * Xulq bahosini o'qituvchilardan faqat sinf rahbari (homeroomTeacherId) qo'ya oladi.
 * Admin rollari (permission asosida) bu cheklovdan holi.
 */
function assertCanGradeConduct(actor: Actor, cls: ClassDoc | null) {
  if (actor.role !== 'teacher' || !cls) return;
  if (!cls.homeroomTeacherId || String(cls.homeroomTeacherId) !== actor.id) {
    throw AppError.forbidden("Xulq bahosini faqat sinf rahbari qo'ya oladi");
  }
}

const conflict = () =>
  AppError.conflict("Bu o'quvchiga shu kuni allaqachon baho qo'ygansiz", [
    { path: 'studentId', message: 'Bu kun uchun baho mavjud' },
  ]);

// ---------- Servis ----------

export const scoresService = {
  async create(
    ctx: Ctx,
    schoolId: string,
    input: {
      studentId: string;
      date?: string;
      value: number;
      behaviorTypeId?: string | null;
      comment?: string | null;
    },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const student = await findStudent(ctx.actor, schoolId, input.studentId);
    const [types, yearId, cls] = await Promise.all([
      loadTypes(schoolId),
      activeYearId(schoolId),
      ClassModel.findOne({ _id: student.classId, schoolId }),
    ]);
    assertScorable(student, cls, yearId);
    assertCanGradeConduct(ctx.actor, cls);

    const date = input.date ?? todayTashkent();
    const values: ScoreValues = {
      value: input.value,
      behaviorTypeId: input.behaviorTypeId ?? null,
      comment: input.comment ?? null,
    };
    throwValidation([
      ...checkDate(settings, date, todayTashkent()),
      ...checkValues(settings, values, types),
    ]);

    if (
      await Score.exists({
        schoolId,
        studentId: student._id,
        teacherId: ctx.actor.id,
        date,
        isDeleted: false,
      })
    ) {
      throw conflict();
    }
    let doc: ScoreDoc;
    try {
      doc = await Score.create({
        schoolId,
        studentId: student._id,
        classId: student.classId,
        teacherId: ctx.actor.id,
        academicYearId: yearId as string,
        behaviorTypeId: values.behaviorTypeId,
        value: values.value,
        comment: values.comment,
        date,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw conflict();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'scores.create',
      entity: 'score',
      entityId: doc.id,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toScoreDtos([doc], { actor: ctx.actor, settings }))[0];
  },

  /** O'zgartirish/o'chirish uchun bahoni topadi va huquqni tekshiradi */
  async loadForChange(
    ctx: Ctx,
    schoolId: string,
    id: string,
    settings: ScoringSettings,
  ): Promise<ScoreDoc> {
    const notFound = AppError.notFound('Baho topilmadi');
    const doc = isId(id) ? await Score.findOne({ _id: id, schoolId, isDeleted: false }) : null;
    if (!doc) throw notFound;
    const own = String(doc.teacherId) === ctx.actor.id;
    if (canEditAny(ctx.actor)) return doc;
    if (!own) {
      // O'qituvchi boshqa o'qituvchining bahosini umuman ko'rmaydi
      if (ctx.actor.role === 'teacher') throw notFound;
      throw AppError.forbidden("Bu bahoni o'zgartirishga ruxsat yo'q (scores.edit kerak)");
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
    patch: { value?: number; behaviorTypeId?: string | null; comment?: string | null },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const doc = await this.loadForChange(ctx, schoolId, id, settings);
    const before = snapshot(doc);
    const types = await loadTypes(schoolId);

    const next: ScoreValues = {
      value: patch.value ?? doc.value,
      behaviorTypeId:
        patch.behaviorTypeId !== undefined
          ? patch.behaviorTypeId
          : doc.behaviorTypeId
            ? String(doc.behaviorTypeId)
            : null,
      comment: patch.comment !== undefined ? patch.comment : (doc.comment ?? null),
    };
    const keep = doc.behaviorTypeId ? String(doc.behaviorTypeId) : null;
    throwValidation(checkValues(settings, next, types, keep));

    doc.value = next.value;
    doc.behaviorTypeId = next.behaviorTypeId ? new Types.ObjectId(next.behaviorTypeId) : null;
    doc.comment = next.comment;
    await doc.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'scores.update',
      entity: 'score',
      entityId: doc.id,
      before,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
    return (await toScoreDtos([doc], { actor: ctx.actor, settings }))[0];
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
      action: 'scores.delete',
      entity: 'score',
      entityId: doc.id,
      before,
      ip: ctx.ip,
    });
    void ratingEvents.dataChanged(schoolId);
  },

  /** Ommaviy baholash (UPSERT): har element mustaqil tekshiriladi */
  async bulk(
    ctx: Ctx,
    schoolId: string,
    input: {
      classId: string;
      date?: string;
      items: {
        studentId: string;
        value: number;
        behaviorTypeId?: string | null;
        comment?: string | null;
      }[];
    },
  ) {
    const settings = await settingsService.getEffectiveScoring(schoolId);
    const scope = await allowedClassIds(ctx.actor, schoolId);
    const notFound = AppError.notFound('Sinf topilmadi');
    if (!isId(input.classId) || (scope && !scope.includes(input.classId))) throw notFound;
    const [cls, yearId, types] = await Promise.all([
      ClassModel.findOne({ _id: input.classId, schoolId }),
      activeYearId(schoolId),
      loadTypes(schoolId),
    ]);
    if (!cls) throw notFound;
    assertCanGradeConduct(ctx.actor, cls);
    if (cls.isArchived || !yearId || String(cls.academicYearId) !== yearId) {
      throw AppError.validation('Sinf baholash uchun mavjud emas', [
        { path: 'classId', message: "Faqat faol o'quv yilidagi arxivlanmagan sinf baholanadi" },
      ]);
    }
    const date = input.date ?? todayTashkent();
    throwValidation(checkDate(settings, date, todayTashkent()));

    const students = await Student.find({ schoolId, classId: cls._id, isDeleted: false });
    const byId = new Map(students.map((s) => [s.id as string, s]));
    const existing = await Score.find({
      schoolId,
      teacherId: ctx.actor.id,
      date,
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    });
    const existingBy = new Map(existing.map((s) => [String(s.studentId), s]));

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
      const values: ScoreValues = {
        value: item.value,
        behaviorTypeId: item.behaviorTypeId ?? null,
        comment: item.comment ?? null,
      };
      const prev = existingBy.get(item.studentId);
      const errs = checkValues(
        settings,
        values,
        types,
        prev?.behaviorTypeId ? String(prev.behaviorTypeId) : null,
      );
      if (errs.length) {
        fail('VALIDATION_ERROR', errs.map((e) => e.message).join('; '));
        continue;
      }
      try {
        if (prev) {
          if (!isEditable(prev, ctx.actor, settings, now)) {
            fail(
              'FORBIDDEN',
              `Bahoni o'zgartirish muddati (${settings.editWindowHours} soat) tugagan`,
            );
            continue;
          }
          prev.value = values.value;
          prev.behaviorTypeId = values.behaviorTypeId
            ? new Types.ObjectId(values.behaviorTypeId)
            : null;
          prev.comment = values.comment;
          await prev.save();
          updated++;
        } else {
          await Score.create({
            schoolId,
            studentId: student._id,
            classId: student.classId,
            teacherId: ctx.actor.id,
            academicYearId: yearId,
            behaviorTypeId: values.behaviorTypeId,
            value: values.value,
            comment: values.comment,
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
      action: 'scores.bulk',
      entity: 'score',
      entityId: input.classId,
      after: {
        classId: input.classId,
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
      studentId?: string;
      teacherId?: string;
      behaviorTypeId?: string;
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
    if (q.studentId) filter.studentId = q.studentId;
    if (q.behaviorTypeId) filter.behaviorTypeId = q.behaviorTypeId;
    if (q.from || q.to) {
      filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }
    const dir = q.sort === 'date' ? 1 : -1;
    const [docs, total] = await Promise.all([
      Score.find(filter)
        .sort({ date: dir, createdAt: dir, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      Score.countDocuments(filter),
    ]);
    return {
      items: await toScoreDtos(docs, { actor, settings }),
      meta: buildMeta(q.page, q.limit, total),
    };
  },

  /** Baholash varag'i: sinf o'quvchilari + shu kun baholari */
  async scoringSheet(actor: Actor, schoolId: string, classId: string, date?: string) {
    const notFound = AppError.notFound('Sinf topilmadi');
    if (!isId(classId)) throw notFound;
    const filter: Record<string, unknown> = { _id: classId, schoolId };
    if (actor.role === 'teacher') filter.teacherIds = actor.id;
    const cls = await ClassModel.findOne(filter);
    if (!cls) throw notFound;
    assertCanGradeConduct(actor, cls);

    const settings = await settingsService.getEffectiveScoring(schoolId);
    const day = date ?? todayTashkent();
    const students = await Student.find({
      schoolId,
      classId: cls._id,
      isDeleted: false,
      status: 'active',
    }).sort({
      fullName: 1,
      _id: 1,
    });
    const scores = await Score.find({
      schoolId,
      date: day,
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    });
    const dtos = await toScoreDtos(scores, { actor, settings });
    const dtoById = new Map(dtos.map((d) => [d.id, d]));
    const byStudent = new Map<string, ScoreDoc[]>();
    for (const s of scores) {
      const k = String(s.studentId);
      byStudent.set(k, [...(byStudent.get(k) ?? []), s]);
    }
    return {
      class: { id: cls.id as string, name: cls.name },
      date: day,
      settings,
      students: students.map((st) => {
        const list = byStudent.get(st.id) ?? [];
        const mine = list.find((s) => String(s.teacherId) === actor.id);
        return {
          studentId: st.id as string,
          fullName: st.fullName,
          studentCode: st.studentCode ?? null,
          photo: photoUrl(st.photoId),
          myScore: mine ? (dtoById.get(mine.id) ?? null) : null,
          dayScore: dailyScore(
            list.map((s) => ({ value: s.value, createdAt: s.createdAt })),
            settings.dailyAggregation,
          ),
          scoresCount: list.length,
        };
      }),
    };
  },

  /** Joriy foydalanuvchi sinflari bo'yicha bugungi baholash jarayoni */
  async todayProgress(actor: Actor, schoolId: string) {
    const yearId = await activeYearId(schoolId);
    if (!yearId) return [];
    const filter: Record<string, unknown> = { schoolId, academicYearId: yearId, isArchived: false };
    // O'qituvchi: xulq bahosi faqat o'zi sinf rahbari bo'lgan sinflarda
    if (actor.role === 'teacher') filter.homeroomTeacherId = actor.id;
    const classes = await ClassModel.find(filter).sort({ grade: 1, name: 1 });
    if (!classes.length) return [];

    const students = await Student.find({
      schoolId,
      classId: { $in: classes.map((c) => c._id) },
      isDeleted: false,
      status: 'active',
    }).select('classId');
    const classOf = new Map(students.map((s) => [s.id as string, String(s.classId)]));
    const total = new Map<string, number>();
    for (const s of students) total.set(String(s.classId), (total.get(String(s.classId)) ?? 0) + 1);

    const mine = await Score.find({
      schoolId,
      teacherId: actor.id,
      date: todayTashkent(),
      isDeleted: false,
      studentId: { $in: students.map((s) => s._id) },
    }).select('studentId');
    const scored = new Map<string, Set<string>>();
    for (const sc of mine) {
      const cid = classOf.get(String(sc.studentId));
      if (!cid) continue;
      if (!scored.has(cid)) scored.set(cid, new Set());
      scored.get(cid)?.add(String(sc.studentId));
    }
    return classes.map((c) => ({
      classId: c.id as string,
      className: c.name,
      scored: scored.get(c.id)?.size ?? 0,
      total: total.get(c.id) ?? 0,
    }));
  },

  /** O'quvchi ball xulosasi (kunlik agregatlar; izohlar maxfiyligi bilan) */
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

    const settings = await settingsService.getEffectiveScoring(schoolId);
    const scores = await Score.find({
      schoolId,
      studentId: student._id,
      isDeleted: false,
      date: { $gte: from, $lte: to },
    }).sort({ date: 1, createdAt: 1 });

    const byDate = new Map<string, ScoreDoc[]>();
    for (const s of scores) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
    const trend = [...byDate.entries()].map(([date, list]) => ({
      date,
      dayScore: dailyScore(
        list.map((s) => ({ value: s.value, createdAt: s.createdAt })),
        settings.dailyAggregation,
      ) as number,
    }));
    const average = trend.length
      ? round2(trend.reduce((a, t) => a + t.dayScore, 0) / trend.length)
      : null;

    const counts = new Map<string, number>();
    for (const s of scores) {
      const k = s.behaviorTypeId ? String(s.behaviorTypeId) : '';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const typeIds = [...counts.keys()].filter(Boolean);
    const types = typeIds.length ? await BehaviorType.find({ _id: { $in: typeIds } }) : [];
    const typeMap = new Map(types.map((t) => [t.id as string, t]));
    const byBehaviorType = [...counts.entries()]
      .map(([k, count]) => {
        const t = k ? typeMap.get(k) : undefined;
        return {
          behaviorTypeId: k || null,
          name: t?.name ?? 'Xulq turisiz',
          kind: t?.kind ?? 'neutral',
          color: t?.color ?? '#6B7280',
          count,
        };
      })
      .sort((a, b) => b.count - a.count);

    const recentDocs = [...scores].reverse().slice(0, 10);
    const recent = await toScoreDtos(recentDocs, {
      actor,
      settings,
      hideOthersComments: actor.role === 'teacher',
    });
    return {
      studentId: student.id as string,
      from,
      to,
      average,
      daysCount: trend.length,
      scoresCount: scores.length,
      trend,
      byBehaviorType,
      recent,
    };
  },
};
