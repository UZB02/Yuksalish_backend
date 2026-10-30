import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorDetail } from '../../core/errors';
import { AcademicYear, type AcademicYearDoc } from '../../models/AcademicYear';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { Subject } from '../../models/Subject';
import {
  MAX_LESSON_NO,
  TimetableVersion,
  type ITimetableEntry,
  type TimetableVersionDoc,
} from '../../models/TimetableVersion';
import { User } from '../../models/User';
import { addDaysStr, tashkentDate, todayTashkent } from '../../utils/clock';
import { purgeDateOf } from './timetable.purge';
import { isoWeekday } from '../../utils/dates';
import { isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { setClassSubjects } from '../classes/class-subjects.service';
import { rechain, rechainDetailed, versionsToReplace } from './timetable.chain';
import {
  analyzeTargets,
  blocking,
  busyTeachersAt,
  hypotheticalValidTo,
  isOutOfRange,
  type AnalysisTarget,
  type TimetableWarning,
} from './timetable.conflicts';
import type { EntryInput } from './timetable.schema';
import {
  loadResolverSettings,
  resolveClassesRange,
  teacherLessonsInRange,
  type ResolvedLesson,
  type ResolverSettings,
} from './timetable.resolver';

type Actor = Ctx['actor'];
type Phase = 'draft' | 'past' | 'current' | 'future' | 'replaced';
type Plain = ITimetableEntry & { subjectId: Types.ObjectId; teacherId: Types.ObjectId };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const idStr = (v: unknown) => String(v);

export const canManage = (a: Actor) =>
  a.role === 'superadmin' || a.permissions.includes('timetable.manage');
export const canViewAll = (a: Actor) =>
  a.role === 'superadmin' ||
  a.permissions.includes('timetable.view') ||
  a.permissions.includes('timetable.manage');

/** Sinfni ko'rish: ruxsatli admin yoki o'z sinfi (teacherIds / sinf rahbari) bo'lgan o'qituvchi */
function assertCanViewClass(actor: Actor, cls: Pick<ClassDoc, 'teacherIds' | 'homeroomTeacherId'>) {
  if (canViewAll(actor)) return;
  if (actor.role === 'teacher') {
    const mine =
      cls.teacherIds.some((t) => String(t) === actor.id) ||
      (cls.homeroomTeacherId && String(cls.homeroomTeacherId) === actor.id);
    if (mine) return;
  }
  throw AppError.forbidden("Bu sinf jadvalini ko'rishga ruxsat yo'q");
}

function assertCanViewAll(actor: Actor) {
  if (!canViewAll(actor)) throw AppError.forbidden();
}

/** O'rinbosar sahifasi o'qishlari (kun, sinflar, tanlovlar): view|manage yoki substitute */
const canViewDay = (a: Actor) => canViewAll(a) || a.permissions.includes('timetable.substitute');

async function loadClass(schoolId: string, classId: string): Promise<ClassDoc> {
  const cls = isId(classId) ? await ClassModel.findOne({ _id: classId, schoolId }) : null;
  if (!cls) throw AppError.notFound('Sinf topilmadi');
  return cls;
}

async function loadYear(cls: ClassDoc): Promise<AcademicYearDoc> {
  const year = await AcademicYear.findById(cls.academicYearId);
  if (!year) throw AppError.notFound("O'quv yili topilmadi");
  return year;
}

async function loadVersion(schoolId: string, id: string): Promise<TimetableVersionDoc> {
  const v = isId(id) ? await TimetableVersion.findOne({ _id: id, schoolId }) : null;
  if (!v) throw AppError.notFound('Jadval versiyasi topilmadi');
  return v;
}

function assertWritable(cls: ClassDoc) {
  if (cls.isArchived) throw AppError.conflict("Arxivdagi sinf jadvali faqat o'qish uchun");
}

function phaseOf(
  v: { status: string; validFrom: string; validTo: string | null },
  today: string,
): Phase {
  if (v.status === 'draft') return 'draft';
  if (v.status === 'replaced') return 'replaced';
  if (v.validFrom > today) return 'future';
  if (v.validTo !== null && v.validTo < today) return 'past';
  return 'current';
}

function checkInYear(year: AcademicYearDoc, date: string, path = 'validFrom') {
  if (date < ymd(year.startDate) || date > ymd(year.endDate)) {
    throw AppError.validation("Sana o'quv yili chegarasidan tashqarida", [
      {
        path,
        message: `Sana ${ymd(year.startDate)} va ${ymd(year.endDate)} orasida bo'lishi kerak`,
      },
    ]);
  }
}

const toPlain = (e: ITimetableEntry): Plain => e as Plain;

function slice(e: ITimetableEntry) {
  return {
    weekday: e.weekday,
    lessonNo: e.lessonNo,
    subjectId: idStr(e.subjectId),
    teacherId: idStr(e.teacherId),
    groupKey: e.groupKey ?? null,
    room: e.room ?? null,
  };
}

interface Names {
  subjects: Map<string, string>;
  teachers: Map<string, string>;
}
async function loadNames(subjectIds: string[], teacherIds: string[]): Promise<Names> {
  const [subjects, teachers] = await Promise.all([
    Subject.find({ _id: { $in: uniq(subjectIds) } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: uniq(teacherIds) } })
      .select('fullName')
      .lean(),
  ]);
  return {
    subjects: new Map(subjects.map((s) => [idStr(s._id), s.name])),
    teachers: new Map(teachers.map((t) => [idStr(t._id), t.fullName])),
  };
}

interface VersionLike {
  _id: Types.ObjectId;
  classId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  status: string;
  validFrom: string;
  validTo: string | null;
  weekPattern: string;
  entries: ITimetableEntry[];
  note: string | null;
  basedOnVersionId: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  activatedBy: Types.ObjectId | null;
  activatedAt: Date | null;
  replacedAt?: Date | null;
  replacedBy?: Types.ObjectId | null;
  forced: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function summaryOf(v: VersionLike, today: string) {
  return {
    id: idStr(v._id),
    classId: idStr(v.classId),
    status: v.status,
    phase: phaseOf(v, today),
    validFrom: v.validFrom,
    validTo: v.validTo,
    entryCount: v.entries.length,
    note: v.note ?? null,
    forced: v.forced,
    activatedAt: v.activatedAt ? v.activatedAt.toISOString() : null,
    replacedAt: v.replacedAt ? v.replacedAt.toISOString() : null,
    replacedBy: v.replacedBy ? idStr(v.replacedBy) : null,
    updatedAt: v.updatedAt.toISOString(),
    purgeAt: purgeAtOf(v),
  };
}

/** Avtomatik o'chiriladigan sana (YYYY-MM-DD, Toshkent): almashtirilgan yoki hech qachon faollashtirilmagan qoralama */
function purgeAtOf(v: VersionLike): string | null {
  if (v.status === 'replaced' && v.replacedAt) return tashkentDate(purgeDateOf(v.replacedAt));
  if (v.status === 'draft' && !v.activatedAt) return tashkentDate(purgeDateOf(v.updatedAt));
  return null;
}

async function dtoOf(v: VersionLike, settings: ResolverSettings, today: string) {
  const names = await loadNames(
    v.entries.map((e) => idStr(e.subjectId)),
    v.entries.map((e) => idStr(e.teacherId)),
  );
  return {
    ...summaryOf(v, today),
    academicYearId: idStr(v.academicYearId),
    weekPattern: v.weekPattern,
    basedOnVersionId: v.basedOnVersionId ? idStr(v.basedOnVersionId) : null,
    createdBy: v.createdBy ? idStr(v.createdBy) : null,
    activatedBy: v.activatedBy ? idStr(v.activatedBy) : null,
    createdAt: v.createdAt.toISOString(),
    entries: v.entries.map((e) => ({
      ...slice(e),
      subject: names.subjects.has(idStr(e.subjectId))
        ? { id: idStr(e.subjectId), name: names.subjects.get(idStr(e.subjectId)) as string }
        : null,
      teacher: names.teachers.has(idStr(e.teacherId))
        ? { id: idStr(e.teacherId), fullName: names.teachers.get(idStr(e.teacherId)) as string }
        : null,
      outOfRange: isOutOfRange(e, settings),
    })),
  };
}

/** Yozuvlarni tekshiradi va saqlanadigan ko'rinishga keltiradi (qattiq xatolar -> 400) */
async function validateEntries(
  schoolId: string,
  input: EntryInput[],
  settings: ResolverSettings,
  prev: ITimetableEntry[] = [],
): Promise<ITimetableEntry[]> {
  const errs: ErrorDetail[] = [];
  const seen = new Set<string>();
  const had = new Set(prev.map((p) => `${p.weekday}:${p.lessonNo}`));
  input.forEach((e, i) => {
    const k = `${e.weekday}:${e.lessonNo}`;
    if (seen.has(k)) {
      errs.push({
        path: `entries.${i}`,
        message: 'Bir hafta kuni va dars raqamiga bitta yozuv kiritiladi',
      });
    }
    seen.add(k);
    if (isOutOfRange(e, settings) && !had.has(k)) {
      errs.push({
        path: `entries.${i}`,
        message: `Dars faqat ish kunlariga (${settings.workingWeekdays.join(', ')}) va 1..${MAX_LESSON_NO}-dars oralig'iga qo'yiladi`,
      });
    }
  });
  const subjectIds = uniq(input.map((e) => e.subjectId));
  const teacherIds = uniq(input.map((e) => e.teacherId));
  const [subjects, teachers] = await Promise.all([
    Subject.find({ _id: { $in: subjectIds }, $or: [{ schoolId: null }, { schoolId }] })
      .select('_id')
      .lean(),
    User.find({ _id: { $in: teacherIds }, schoolId, role: 'teacher' })
      .select('_id')
      .lean(),
  ]);
  const sOk = new Set(subjects.map((s) => idStr(s._id)));
  const tOk = new Set(teachers.map((t) => idStr(t._id)));
  input.forEach((e, i) => {
    if (!sOk.has(e.subjectId))
      errs.push({ path: `entries.${i}.subjectId`, message: 'Fan topilmadi' });
    if (!tOk.has(e.teacherId)) {
      errs.push({
        path: `entries.${i}.teacherId`,
        message: "O'qituvchi topilmadi (shu maktabning o'qituvchisi bo'lishi kerak)",
      });
    }
  });
  if (errs.length) throw AppError.validation("Dars jadvali noto'g'ri", errs);
  return [...input]
    .sort((a, b) => a.weekday - b.weekday || a.lessonNo - b.lessonNo)
    .map((e) => ({
      weekday: e.weekday,
      lessonNo: e.lessonNo,
      subjectId: new Types.ObjectId(e.subjectId),
      teacherId: new Types.ObjectId(e.teacherId),
      groupKey: null,
      room: e.room ?? null,
    }));
}

async function addTeachersToClass(cls: ClassDoc, entries: ITimetableEntry[]) {
  const ids = uniq(entries.map((e) => idStr(e.teacherId)));
  const missing = ids.filter((t) => !cls.teacherIds.some((x) => idStr(x) === t));
  if (!missing.length) return;
  await ClassModel.updateOne({ _id: cls._id }, { $addToSet: { teacherIds: { $each: missing } } });
  cls.teacherIds = [...cls.teacherIds, ...missing.map((m) => new Types.ObjectId(m))];
}

/** Jadvalda bor, lekin ClassSubject'da yo'q fanlarni biriktiradi (bir tomonlama sinxronlash) */
async function syncAssignments(
  ctx: Ctx,
  schoolId: string,
  cls: ClassDoc,
  entries: ITimetableEntry[],
) {
  const existing = await ClassSubject.find({ classId: cls._id }).lean();
  const have = new Set(existing.map((e) => idStr(e.subjectId)));
  const votes = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const s = idStr(e.subjectId);
    if (have.has(s)) continue;
    const m = votes.get(s) ?? new Map<string, number>();
    m.set(idStr(e.teacherId), (m.get(idStr(e.teacherId)) ?? 0) + 1);
    votes.set(s, m);
  }
  if (!votes.size) return [] as { subjectId: string; teacherId: string }[];
  // Nofaol fan/o'qituvchi biriktirilmaydi (setClassSubjects ularni rad etadi)
  const activeSubjects = new Set(
    (
      await Subject.find({ _id: { $in: [...votes.keys()] }, isActive: true })
        .select('_id')
        .lean()
    ).map((s) => idStr(s._id)),
  );
  const added: { subjectId: string; teacherId: string }[] = [];
  const activeTeachers = new Set(
    (
      await User.find({
        _id: { $in: uniq([...votes.values()].flatMap((m) => [...m.keys()])) },
        isActive: true,
      })
        .select('_id')
        .lean()
    ).map((t) => idStr(t._id)),
  );
  for (const [subjectId, m] of votes) {
    if (!activeSubjects.has(subjectId)) continue;
    const best = [...m.entries()]
      .filter(([t]) => activeTeachers.has(t))
      .sort((a, b) => b[1] - a[1])[0];
    if (best) added.push({ subjectId, teacherId: best[0] });
  }
  if (!added.length) return added;
  const items = [
    ...existing.map((e) => ({ subjectId: idStr(e.subjectId), teacherId: idStr(e.teacherId) })),
    ...added,
  ];
  await setClassSubjects(ctx, schoolId, cls, items);
  return added;
}

const compact = (entries: ITimetableEntry[]) =>
  entries.map((e) => [
    e.weekday,
    e.lessonNo,
    idStr(e.subjectId),
    idStr(e.teacherId),
    e.room ?? null,
  ]);

function target(v: VersionLike, validFrom: string, validTo: string | null): AnalysisTarget {
  return {
    key: idStr(v._id),
    classId: idStr(v.classId),
    versionId: idStr(v._id),
    validFrom,
    validTo,
    entries: v.entries.map(slice),
  };
}

async function warningsFor(schoolId: string, v: VersionLike, validFrom = v.validFrom) {
  const validTo =
    v.status === 'draft'
      ? await hypotheticalValidTo(idStr(v.classId), validFrom, idStr(v._id))
      : v.validTo;
  const map = await analyzeTargets(schoolId, [target(v, validFrom, validTo)]);
  return map.get(idStr(v._id)) ?? [];
}

function blockDetails(w: TimetableWarning[]): ErrorDetail[] {
  return [
    { path: 'force', message: 'Davom ettirish uchun force: true va izoh (note) yuboring' },
    ...blocking(w).map((x) => ({
      path: `entries.${x.weekday}.${x.lessonNo}`,
      message: `${x.weekday}-kun, ${x.lessonNo}-dars: ${x.message}`,
    })),
  ];
}

export interface ActivateOpts {
  validFrom: string;
  force?: boolean;
  note?: string | null;
  syncAssignments?: boolean;
  confirmPast?: boolean;
}

/** Yon ta'sirsiz tekshiruvlar (ommaviy faollashtirishda oldindan hammasi uchun chaqiriladi) */
async function precheckActivation(
  v: TimetableVersionDoc,
  cls: ClassDoc,
  year: AcademicYearDoc,
  o: ActivateOpts,
  today: string,
) {
  if (v.status !== 'draft') throw AppError.conflict('Faqat qoralama faollashtiriladi');
  assertWritable(cls);
  if (!v.entries.length) {
    throw AppError.validation("Bo'sh jadvalni faollashtirib bo'lmaydi", [
      { path: 'entries', message: 'Kamida bitta dars kiritilishi kerak' },
    ]);
  }
  checkInYear(year, o.validFrom);
  if (o.validFrom < today && !o.confirmPast) {
    throw AppError.validation("O'tmish sanadan faollashtirish tasdiqlanmagan", [
      {
        path: 'confirmPast',
        message: "O'tmish sanadan faollashtirish uchun confirmPast: true kerak",
      },
    ]);
  }
  const clash = await TimetableVersion.exists({
    classId: v.classId,
    activatedAt: { $type: 'date' },
    validFrom: o.validFrom,
  });
  if (clash) {
    throw AppError.conflict('Bu sanada shu sinf uchun boshqa versiya allaqachon faol', [
      { path: 'validFrom', message: "Boshqa sana tanlang yoki o'sha versiyani tuzating" },
    ]);
  }
}

function checkForce(w: TimetableWarning[], o: { force?: boolean; note?: string | null }) {
  if (!blocking(w).length) return false;
  if (!o.force) throw AppError.conflict("O'qituvchilar to'qnashuvi bor", blockDetails(w));
  if (!o.note || !o.note.trim()) {
    throw AppError.validation('Majburiy faollashtirish uchun izoh kerak', [
      { path: 'note', message: 'Izoh kiritilishi shart' },
    ]);
  }
  return true;
}

async function commitActivation(
  ctx: Ctx,
  schoolId: string,
  v: TimetableVersionDoc,
  cls: ClassDoc,
  o: ActivateOpts,
  warnings: TimetableWarning[],
  today: string,
) {
  const forced = blocking(warnings).length > 0;
  const before = { status: v.status, validFrom: v.validFrom };
  v.status = 'active';
  v.validFrom = o.validFrom;
  v.validTo = null;
  v.activatedBy = new Types.ObjectId(ctx.actor.id);
  v.activatedAt = new Date();
  v.forced = forced;
  if (o.note) v.note = o.note;
  try {
    await v.save();
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      throw AppError.conflict('Bu sanada shu sinf uchun boshqa versiya allaqachon faol');
    }
    throw e;
  }
  const chain = await rechainDetailed(v.classId);
  const replacedIds = chain.replaced.filter((r) => r.replacedBy === idStr(v._id)).map((r) => r.id);
  await addTeachersToClass(cls, v.entries);
  const synced = o.syncAssignments ? await syncAssignments(ctx, schoolId, cls, v.entries) : [];
  await auditService.log({
    userId: ctx.actor.id,
    schoolId,
    action: 'timetable.version_activate',
    entity: 'timetable',
    entityId: idStr(v._id),
    before,
    after: {
      classId: idStr(v.classId),
      validFrom: o.validFrom,
      entryCount: v.entries.length,
      forced,
      pastActivation: o.validFrom < today,
      note: o.note ?? null,
      conflicts: forced ? blocking(warnings).length : 0,
      syncedAssignments: synced,
      replaced: replacedIds,
    },
    ip: ctx.ip,
  });
  return synced;
}

export const timetableService = {
  /** Faol yildagi sinflar bo'yicha jadval holati */
  async overview(actor: Actor, schoolId: string) {
    if (!canViewDay(actor)) throw AppError.forbidden();
    const today = todayTashkent();
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).lean();
    if (!year) return { today, classes: [] };
    const classes = await ClassModel.find({ schoolId, academicYearId: year._id, isArchived: false })
      .select('name grade homeroomTeacherId')
      .lean();
    classes.sort((a, b) => a.grade - b.grade || a.name.localeCompare(b.name, 'uz'));
    const manage = canManage(actor);
    const versions = await TimetableVersion.find({
      schoolId,
      classId: { $in: classes.map((c) => c._id) },
      ...(manage ? {} : { status: { $ne: 'draft' } }),
    }).lean();
    const byClass = new Map<string, typeof versions>();
    for (const v of versions) {
      const k = idStr(v.classId);
      byClass.set(k, [...(byClass.get(k) ?? []), v]);
    }
    const rows = classes.map((c) => {
      const list = byClass.get(idStr(c._id)) ?? [];
      const drafts = list
        .filter((v) => v.status === 'draft')
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const act = list
        .filter((v) => v.status !== 'draft' && v.status !== 'replaced')
        .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
      const current = act.filter((v) => phaseOf(v, today) === 'current').pop() ?? null;
      const upcoming = act.find((v) => phaseOf(v, today) === 'future') ?? null;
      return { c, list, draft: drafts[0] ?? null, current, upcoming, act };
    });
    // Ogohlantirishlar: qoralama, bo'lmasa joriy, bo'lmasa kelgusi versiya bo'yicha (bitta tahlil)
    const targets: AnalysisTarget[] = [];
    for (const r of rows) {
      const focus = r.draft ?? r.current ?? r.upcoming;
      if (!focus) continue;
      // Qoralama faollashtirilsa o'z validFrom idan keyingi versiyalarni almashtiradi -> ochiq
      const validTo = focus.status === 'draft' ? null : focus.validTo;
      targets.push(target(focus as VersionLike, focus.validFrom, validTo));
    }
    const warn = await analyzeTargets(schoolId, targets);
    return {
      today,
      classes: rows.map((r) => {
        const focus = r.draft ?? r.current ?? r.upcoming;
        const w = focus ? (warn.get(idStr(focus._id)) ?? []) : [];
        return {
          classId: idStr(r.c._id),
          name: r.c.name,
          grade: r.c.grade,
          homeroomTeacherId: r.c.homeroomTeacherId ? idStr(r.c.homeroomTeacherId) : null,
          current: r.current ? summaryOf(r.current as VersionLike, today) : null,
          upcoming: r.upcoming ? summaryOf(r.upcoming as VersionLike, today) : null,
          draft: r.draft ? summaryOf(r.draft as VersionLike, today) : null,
          warningsCount: w.length,
          errorsCount: w.filter((x) => x.severity === 'error').length,
        };
      }),
    };
  },

  /** Sinfning versiyalari (qoralamalar faqat timetable.manage uchun) + muharrir uchun kontekst */
  async listVersions(actor: Actor, schoolId: string, classId: string) {
    const cls = await loadClass(schoolId, classId);
    assertCanViewClass(actor, cls);
    const [year, settings] = await Promise.all([loadYear(cls), loadResolverSettings(schoolId)]);
    const today = todayTashkent();
    const rows = await TimetableVersion.find({
      classId: cls._id,
      ...(canManage(actor) ? {} : { status: { $ne: 'draft' } }),
    }).lean();
    const versions = rows
      .map((v) => summaryOf(v as VersionLike, today))
      .sort((a, b) => {
        if ((a.status === 'draft') !== (b.status === 'draft')) return a.status === 'draft' ? -1 : 1;
        return b.validFrom.localeCompare(a.validFrom) || b.updatedAt.localeCompare(a.updatedAt);
      });
    return {
      class: {
        id: idStr(cls._id),
        name: cls.name,
        grade: cls.grade,
        isArchived: cls.isArchived,
        homeroomTeacherId: cls.homeroomTeacherId ? idStr(cls.homeroomTeacherId) : null,
      },
      academicYear: {
        id: idStr(year._id),
        name: year.name,
        startDate: ymd(year.startDate),
        endDate: ymd(year.endDate),
      },
      settings,
      today,
      versions,
    };
  },

  async getVersion(actor: Actor, schoolId: string, id: string, validFrom?: string) {
    const v = await loadVersion(schoolId, id);
    if (v.status === 'draft' && !canManage(actor))
      throw AppError.notFound('Jadval versiyasi topilmadi');
    const cls = await loadClass(schoolId, idStr(v.classId));
    assertCanViewClass(actor, cls);
    const settings = await loadResolverSettings(schoolId);
    const warnings = canManage(actor)
      ? await warningsFor(schoolId, v, validFrom ?? v.validFrom)
      : [];
    // Faollashtirilsa almashtiriladigan versiyalar (faqat qoralama uchun, boshqaruvchiga)
    const willReplace =
      canManage(actor) && v.status === 'draft'
        ? await versionsToReplace(v.classId, validFrom ?? v.validFrom, idStr(v._id))
        : [];
    return { version: await dtoOf(v, settings, todayTashkent()), warnings, willReplace };
  },

  async busyTeachers(
    actor: Actor,
    schoolId: string,
    id: string,
    weekday: number,
    lessonNo: number,
    validFrom?: string,
  ) {
    if (!canManage(actor)) throw AppError.forbidden();
    const v = await loadVersion(schoolId, id);
    const from = validFrom ?? v.validFrom;
    const to =
      v.status === 'draft'
        ? await hypotheticalValidTo(idStr(v.classId), from, idStr(v._id))
        : v.validTo;
    return { items: await busyTeachersAt(schoolId, idStr(v.classId), from, to, weekday, lessonNo) };
  },

  async createVersion(
    ctx: Ctx,
    schoolId: string,
    classId: string,
    body: {
      validFrom?: string;
      copyFrom?: 'active' | string | { classId: string };
      note?: string | null;
    },
  ) {
    const cls = await loadClass(schoolId, classId);
    assertWritable(cls);
    const year = await loadYear(cls);
    const today = todayTashkent();
    const yFrom = ymd(year.startDate);
    const yTo = ymd(year.endDate);
    let validFrom = body.validFrom;
    if (validFrom) checkInYear(year, validFrom);
    else {
      const tomorrow = addDaysStr(today, 1);
      validFrom = tomorrow < yFrom ? yFrom : tomorrow > yTo ? yTo : tomorrow;
    }

    let source: TimetableVersionDoc | null = null;
    const pickActive = async (cid: Types.ObjectId | string) => {
      const list = await TimetableVersion.find({
        classId: cid,
        activatedAt: { $type: 'date' },
        status: { $ne: 'replaced' },
      }).sort({
        validFrom: 1,
      });
      return (
        list.filter((x) => phaseOf(x, today) === 'current').pop() ??
        list.find((x) => phaseOf(x, today) === 'future') ??
        list.pop() ??
        null
      );
    };
    const cf = body.copyFrom;
    if (cf === 'active') source = await pickActive(cls._id);
    else if (typeof cf === 'string') {
      source = await TimetableVersion.findOne({ _id: cf, schoolId });
    } else if (cf) {
      const other = await loadClass(schoolId, cf.classId);
      source = await pickActive(other._id);
    }
    if (cf && !source) throw AppError.notFound('Nusxa olinadigan versiya topilmadi');

    const doc = await TimetableVersion.create({
      schoolId,
      academicYearId: cls.academicYearId,
      classId: cls._id,
      status: 'draft',
      validFrom,
      entries: source ? source.entries.map(toPlain) : [],
      note: body.note ?? null,
      basedOnVersionId: source ? source._id : null,
      createdBy: ctx.actor.id,
    });
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'timetable.version_create',
      entity: 'timetable',
      entityId: doc.id,
      after: {
        classId: cls.id,
        validFrom,
        basedOnVersionId: source ? idStr(source._id) : null,
        entryCount: doc.entries.length,
      },
      ip: ctx.ip,
    });
    return timetableService.getVersion(ctx.actor, schoolId, doc.id);
  },

  async updateDraft(
    ctx: Ctx,
    schoolId: string,
    id: string,
    body: { entries: EntryInput[]; validFrom?: string; note?: string | null },
  ) {
    const v = await loadVersion(schoolId, id);
    if (v.status !== 'draft') {
      throw AppError.conflict(
        "Faollashtirilgan versiyani faqat 'tuzatish' orqali o'zgartirish mumkin",
      );
    }
    const cls = await loadClass(schoolId, idStr(v.classId));
    assertWritable(cls);
    const settings = await loadResolverSettings(schoolId);
    if (body.validFrom) checkInYear(await loadYear(cls), body.validFrom);
    const entries = await validateEntries(schoolId, body.entries, settings, v.entries);
    const before = { entryCount: v.entries.length, validFrom: v.validFrom };
    v.entries = entries as typeof v.entries;
    if (body.validFrom) v.validFrom = body.validFrom;
    if (body.note !== undefined) v.note = body.note ?? null;
    await v.save();
    await addTeachersToClass(cls, entries);
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'timetable.version_update',
      entity: 'timetable',
      entityId: v.id,
      before,
      after: { classId: cls.id, entryCount: entries.length, validFrom: v.validFrom },
      ip: ctx.ip,
    });
    return {
      version: await dtoOf(v, settings, todayTashkent()),
      warnings: await warningsFor(schoolId, v),
    };
  },

  /** Qoralamani yoki kelajakdagi (hali kuchga kirmagan) faol versiyani o'chiradi */
  async deleteVersion(ctx: Ctx, schoolId: string, id: string) {
    const v = await loadVersion(schoolId, id);
    const cls = await loadClass(schoolId, idStr(v.classId));
    assertWritable(cls);
    const today = todayTashkent();
    const phase = phaseOf(v, today);
    if (phase !== 'draft' && phase !== 'future') {
      throw AppError.conflict(
        "Kuchga kirgan yoki o'tgan versiyani o'chirib bo'lmaydi (faqat tuzatish mumkin)",
      );
    }
    await v.deleteOne();
    if (phase === 'future') await rechain(v.classId);
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'timetable.version_delete',
      entity: 'timetable',
      entityId: id,
      before: {
        classId: idStr(v.classId),
        status: v.status,
        validFrom: v.validFrom,
        entryCount: v.entries.length,
      },
      ip: ctx.ip,
    });
    return { deleted: true };
  },

  async activate(ctx: Ctx, schoolId: string, id: string, o: ActivateOpts) {
    const v = await loadVersion(schoolId, id);
    const cls = await loadClass(schoolId, idStr(v.classId));
    const year = await loadYear(cls);
    const today = todayTashkent();
    await precheckActivation(v, cls, year, o, today);
    const validTo = await hypotheticalValidTo(idStr(v.classId), o.validFrom, idStr(v._id));
    const warnings = (await analyzeTargets(schoolId, [target(v, o.validFrom, validTo)])).get(
      idStr(v._id),
    ) as TimetableWarning[];
    checkForce(warnings, o);
    const synced = await commitActivation(ctx, schoolId, v, cls, o, warnings, today);
    const settings = await loadResolverSettings(schoolId);
    return {
      version: await dtoOf(v, settings, today),
      warnings,
      syncedAssignments: synced,
    };
  },

  /** Bir nechta sinf qoralamasini bir sanadan faollashtirish (hammasi tekshirilgandan keyin) */
  async activateBulk(ctx: Ctx, schoolId: string, versionIds: string[], o: ActivateOpts) {
    const ids = uniq(versionIds);
    const versions = await Promise.all(ids.map((i) => loadVersion(schoolId, i)));
    if (new Set(versions.map((v) => idStr(v.classId))).size !== versions.length) {
      throw AppError.validation('Bir sinfdan bitta qoralama tanlanadi', [
        { path: 'versionIds', message: 'Bir sinfning bir nechta qoralamasi tanlangan' },
      ]);
    }
    const today = todayTashkent();
    const classes = new Map<string, ClassDoc>();
    for (const v of versions) {
      const cid = idStr(v.classId);
      if (!classes.has(cid)) classes.set(cid, await loadClass(schoolId, cid));
    }
    const years = new Map<string, AcademicYearDoc>();
    for (const cls of classes.values()) {
      const yid = idStr(cls.academicYearId);
      if (!years.has(yid)) years.set(yid, await loadYear(cls));
    }
    for (const v of versions) {
      const cls = classes.get(idStr(v.classId)) as ClassDoc;
      await precheckActivation(
        v,
        cls,
        years.get(idStr(cls.academicYearId)) as AcademicYearDoc,
        o,
        today,
      );
    }
    const targets: AnalysisTarget[] = [];
    for (const v of versions) {
      const validTo = await hypotheticalValidTo(idStr(v.classId), o.validFrom, idStr(v._id));
      targets.push(target(v, o.validFrom, validTo));
    }
    // Birga faollashtiriladiganlar bir-biri bilan ham tekshiriladi
    const warn = await analyzeTargets(schoolId, targets, targets);
    const all = [...warn.values()].flat();
    checkForce(all, o);
    const out = [];
    for (const v of versions) {
      const cls = classes.get(idStr(v.classId)) as ClassDoc;
      const w = warn.get(idStr(v._id)) ?? [];
      const synced = await commitActivation(ctx, schoolId, v, cls, o, w, today);
      out.push({
        versionId: idStr(v._id),
        classId: idStr(v.classId),
        className: cls.name,
        warningsCount: w.length,
        syncedAssignments: synced,
      });
    }
    return { activated: out };
  },

  /** Ommaviy faollashtirish ogohlantirishlari (hech narsa o'zgarmaydi): sinflar bo'yicha */
  async bulkPreview(schoolId: string, versionIds: string[], validFrom: string) {
    const versions = await Promise.all(uniq(versionIds).map((i) => loadVersion(schoolId, i)));
    const names = new Map(
      (
        await ClassModel.find({ _id: { $in: versions.map((v) => v.classId) } })
          .select('name')
          .lean()
      ).map((c) => [idStr(c._id), c.name]),
    );
    const targets: AnalysisTarget[] = [];
    for (const v of versions) {
      const validTo = await hypotheticalValidTo(idStr(v.classId), validFrom, idStr(v._id));
      targets.push(target(v, validFrom, validTo));
    }
    const warn = await analyzeTargets(schoolId, targets, targets);
    const willReplace = (
      await Promise.all(
        versions.map(async (v) =>
          (await versionsToReplace(v.classId, validFrom, idStr(v._id))).map((r) => ({
            ...r,
            classId: idStr(v.classId),
            className: names.get(idStr(v.classId)) ?? '?',
          })),
        ),
      )
    ).flat();
    return {
      willReplace,
      warnings: versions.flatMap((v) =>
        (warn.get(idStr(v._id)) ?? []).map((w) => ({
          ...w,
          versionId: idStr(v._id),
          classId: idStr(v.classId),
          className: names.get(idStr(v.classId)) ?? '?',
        })),
      ),
    };
  },

  /** Faol versiyani joyida tuzatish (audit bilan). To'liq o'tgan davr versiyasi tuzatilmaydi. */
  async correct(
    ctx: Ctx,
    schoolId: string,
    id: string,
    body: {
      entries: EntryInput[];
      force?: boolean;
      note?: string | null;
      syncAssignments?: boolean;
    },
  ) {
    const v = await loadVersion(schoolId, id);
    if (v.status === 'draft') {
      throw AppError.conflict("Qoralamani oddiy saqlash orqali o'zgartiring");
    }
    const today = todayTashkent();
    if (v.status === 'replaced') {
      throw AppError.conflict("Almashtirilgan versiyani tuzatib bo'lmaydi (faqat nusxalash mumkin)");
    }
    if (phaseOf(v, today) === 'past') {
      throw AppError.conflict("To'liq o'tgan davr jadvalini tuzatib bo'lmaydi");
    }
    const cls = await loadClass(schoolId, idStr(v.classId));
    assertWritable(cls);
    const settings = await loadResolverSettings(schoolId);
    const entries = await validateEntries(schoolId, body.entries, settings, v.entries);
    const before = compact(v.entries);
    const draftLike = { ...v.toObject(), entries } as unknown as VersionLike;
    const warnings = (
      await analyzeTargets(schoolId, [target(draftLike, v.validFrom, v.validTo)])
    ).get(idStr(v._id)) as TimetableWarning[];
    checkForce(warnings, body);
    v.entries = entries as typeof v.entries;
    if (blocking(warnings).length) v.forced = true;
    await v.save();
    await addTeachersToClass(cls, entries);
    const synced = body.syncAssignments ? await syncAssignments(ctx, schoolId, cls, entries) : [];
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'timetable.version_correct',
      entity: 'timetable',
      entityId: v.id,
      before: { classId: cls.id, validFrom: v.validFrom, entries: before },
      after: {
        entries: compact(entries),
        forced: blocking(warnings).length > 0,
        note: body.note ?? null,
        syncedAssignments: synced,
      },
      ip: ctx.ip,
    });
    return { version: await dtoOf(v, settings, today), warnings, syncedAssignments: synced };
  },

  /** O'qituvchining haftasi: sana ttushgan hafta (dushanba..yakshanba), ish kunlari bo'yicha */
  async teacherWeek(actor: Actor, schoolId: string, teacherId: string, date?: string) {
    if (!canViewAll(actor) && actor.id !== teacherId) throw AppError.forbidden();
    const teacher = isId(teacherId)
      ? await User.findOne({ _id: teacherId, schoolId, role: 'teacher' }).select('fullName').lean()
      : null;
    if (!teacher) throw AppError.notFound("O'qituvchi topilmadi");
    const today = todayTashkent();
    const base = date ?? today;
    const from = addDaysStr(base, -(isoWeekday(base) - 1));
    const to = addDaysStr(from, 6);
    const [lessons, settings] = await Promise.all([
      teacherLessonsInRange(schoolId, teacherId, from, to),
      loadResolverSettings(schoolId),
    ]);
    const classIds = uniq(lessons.map((l) => l.classId));
    const classes = await ClassModel.find({ _id: { $in: classIds }, isArchived: false })
      .select('name grade')
      .lean();
    const live = new Set(classes.map((c) => idStr(c._id)));
    const visible = lessons.filter((l) => live.has(l.classId));
    const enriched = await enrich(visible, classes);
    const days = settings.workingWeekdays.map((weekday) => {
      const d = addDaysStr(from, weekday - 1);
      return { date: d, weekday, lessons: enriched.filter((l) => l.date === d) };
    });
    return {
      teacher: { id: teacherId, fullName: teacher.fullName },
      from,
      to,
      today,
      settings,
      weeklyCount: visible.length,
      days,
    };
  },

  /** Bir kun uchun barcha sinflar jadvali (sana tushgan hafta kuni, o'sha sanadagi versiyalar bo'yicha) */
  async day(actor: Actor, schoolId: string, date?: string) {
    assertCanViewAll(actor);
    const today = todayTashkent();
    const d = date ?? today;
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).lean();
    const settings = await loadResolverSettings(schoolId);
    const base = { date: d, weekday: isoWeekday(d), today, settings };
    const working = settings.workingWeekdays.includes(base.weekday);
    if (!year) return { ...base, working, classes: [] };
    const classes = await ClassModel.find({ schoolId, academicYearId: year._id, isArchived: false })
      .select('name grade')
      .lean();
    classes.sort((a, b) => a.grade - b.grade || a.name.localeCompare(b.name, 'uz'));
    const lessons = working
      ? await resolveClassesRange(
          schoolId,
          classes.map((c) => idStr(c._id)),
          d,
          d,
        )
      : [];
    const enriched = await enrich(lessons, classes);
    return {
      ...base,
      working,
      classes: classes.map((c) => ({
        classId: idStr(c._id),
        name: c.name,
        grade: c.grade,
        lessons: enriched.filter((l) => l.classId === idStr(c._id)),
      })),
    };
  },

  /**
   * O'rinbosar sahifasi uchun tekis kun ro'yxati: hamma sinflar darslari (almashtirishlar hisobga olingan),
   * sinf nomi va dars raqami bo'yicha. `teacherId` berilsa asl (jadvaldagi) yoki joriy o'qituvchisi shu bo'lgan darslar.
   */
  async teacherDay(actor: Actor, schoolId: string, date?: string, teacherId?: string) {
    if (!canViewDay(actor)) throw AppError.forbidden();
    const d = date ?? todayTashkent();
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).lean();
    const settings = await loadResolverSettings(schoolId);
    const isWorkday = settings.workingWeekdays.includes(isoWeekday(d));
    if (!year || !isWorkday) return { date: d, isWorkday, lessons: [] };
    const classes = await ClassModel.find({ schoolId, academicYearId: year._id, isArchived: false })
      .select('name grade')
      .lean();
    const lessons = await resolveClassesRange(
      schoolId,
      classes.map((c) => idStr(c._id)),
      d,
      d,
    );
    const enriched = await enrich(lessons, classes);
    const origNames = await loadNames(
      [],
      enriched.map((l) => l.originalTeacherId).filter((x): x is string => !!x),
    );
    const flat = enriched
      .filter((l) => !teacherId || l.teacherId === teacherId || l.originalTeacherId === teacherId)
      .map((l) => ({
        classId: l.classId,
        class: { id: l.classId, name: l.class?.name ?? '?' },
        lessonNo: l.lessonNo,
        subject: l.subject,
        teacher: l.teacher,
        originalTeacher: l.originalTeacherId
          ? {
              id: l.originalTeacherId,
              fullName: origNames.teachers.get(l.originalTeacherId) ?? '?',
            }
          : null,
        source: l.source,
        overrideType: l.overrideType ?? null,
        overrideId: l.overrideId ?? null,
        cancelled: l.cancelled,
      }))
      .sort((a, b) => a.class.name.localeCompare(b.class.name, 'uz') || a.lessonNo - b.lessonNo);
    return { date: d, isWorkday, lessons: flat };
  },

  /** Muharrir uchun tanlov ro'yxatlari: faol fanlar/o'qituvchilar, sinf biriktirishlari, fan -> o'qituvchilar */
  async options(actor: Actor, schoolId: string, classId?: string) {
    if (!canViewDay(actor)) throw AppError.forbidden();
    const [subjects, teachers, assignments] = await Promise.all([
      Subject.find({ $or: [{ schoolId: null }, { schoolId }], isActive: true })
        .select('name order')
        .lean(),
      User.find({ schoolId, role: 'teacher', isActive: true }).select('fullName').lean(),
      (async () => {
        const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id').lean();
        return year ? ClassSubject.find({ schoolId, academicYearId: year._id }).lean() : [];
      })(),
    ]);
    subjects.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'uz'));
    teachers.sort((a, b) => a.fullName.localeCompare(b.fullName, 'uz'));
    const subjectTeachers: Record<string, string[]> = {};
    for (const a of assignments) {
      const k = idStr(a.subjectId);
      subjectTeachers[k] = uniq([...(subjectTeachers[k] ?? []), idStr(a.teacherId)]);
    }
    return {
      subjects: subjects.map((x) => ({ id: idStr(x._id), name: x.name })),
      teachers: teachers.map((x) => ({ id: idStr(x._id), fullName: x.fullName })),
      classAssignments: classId
        ? assignments
            .filter((a) => idStr(a.classId) === classId)
            .map((a) => ({ subjectId: idStr(a.subjectId), teacherId: idStr(a.teacherId) }))
        : [],
      subjectTeachers,
    };
  },

  /** Resolver natijasi (P2+ uchun ham): sinfning shu sanadagi darslari */
  async lessons(actor: Actor, schoolId: string, classId: string, date: string) {
    const cls = await loadClass(schoolId, classId);
    assertCanViewClass(actor, cls);
    const lessons = await resolveClassesRange(schoolId, [classId], date, date);
    return {
      classId,
      date,
      lessons: await enrich(lessons, [{ _id: cls._id, name: cls.name, grade: cls.grade }]),
    };
  },
};

async function enrich(
  lessons: ResolvedLesson[],
  classes: { _id: Types.ObjectId; name: string; grade: number }[],
) {
  const names = await loadNames(
    lessons.map((l) => l.subjectId),
    lessons.map((l) => l.teacherId),
  );
  const cMap = new Map(classes.map((c) => [idStr(c._id), c]));
  return lessons.map((l) => {
    const c = cMap.get(l.classId);
    return {
      ...l,
      class: c ? { id: l.classId, name: c.name, grade: c.grade } : null,
      subject: { id: l.subjectId, name: names.subjects.get(l.subjectId) ?? '?' },
      teacher: { id: l.teacherId, fullName: names.teachers.get(l.teacherId) ?? '?' },
    };
  });
}
