import { ClassModel } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { Subject } from '../../models/Subject';
import { MAX_LESSON_NO, TimetableVersion } from '../../models/TimetableVersion';
import { User } from '../../models/User';
import { addDaysStr } from '../../utils/clock';
import { uniq } from '../../utils/helpers';
import { loadResolverSettings, type ResolverSettings, type SliceEntry } from './timetable.resolver';

export const WARNING_CODES = [
  'teacher_double_booked',
  'teacher_not_assigned',
  'subject_inactive',
  'teacher_inactive',
  'out_of_range',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** Faollashtirishni to'xtatadigan (force kerak) kodlar */
export const BLOCKING_CODES: WarningCode[] = ['teacher_double_booked'];

export interface TimetableWarning {
  code: WarningCode;
  severity: 'error' | 'warning';
  weekday: number;
  lessonNo: number;
  subjectId: string;
  teacherId: string;
  message: string;
  other?: {
    classId: string;
    className: string;
    versionId: string;
    validFrom: string;
    validTo: string | null;
  };
}

/** Tahlil qilinadigan (haqiqiy yoki virtual) versiya */
export interface AnalysisTarget {
  key: string;
  classId: string;
  versionId: string | null;
  validFrom: string;
  /** Faollashtirilgandan keyingi taxminiy tugash sanasi */
  validTo: string | null;
  entries: SliceEntry[];
}

const FAR = '9999-12-31';
const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? FAR) && bFrom <= (aTo ?? FAR);

export const isOutOfRange = (e: { weekday: number; lessonNo: number }, s: ResolverSettings) =>
  !s.workingWeekdays.includes(e.weekday) || e.lessonNo < 1 || e.lessonNo > MAX_LESSON_NO;

/**
 * Sinfda `validFrom` dan boshlanadigan versiyaning taxminiy tugash sanasi:
 * keyingi faollashtirilgan versiyaning boshlanishidan bir kun oldin (yo'q bo'lsa null).
 */
export async function hypotheticalValidTo(
  classId: string,
  validFrom: string,
  excludeId?: string,
): Promise<string | null> {
  const q: Record<string, unknown> = {
    classId,
    activatedAt: { $type: 'date' },
    validFrom: { $gt: validFrom },
  };
  if (excludeId) q._id = { $ne: excludeId };
  const next = await TimetableVersion.findOne(q).sort({ validFrom: 1 }).select('validFrom').lean();
  return next ? addDaysStr(next.validFrom, -1) : null;
}

/**
 * Versiyalar uchun ogohlantirishlar. `extras` — hali saqlanmagan, lekin birga faollashtiriladigan
 * (ommaviy faollashtirish) virtual versiyalar: ular bir-biri bilan ham tekshiriladi.
 */
export async function analyzeTargets(
  schoolId: string,
  targets: AnalysisTarget[],
  extras: AnalysisTarget[] = [],
  settingsIn?: ResolverSettings,
): Promise<Map<string, TimetableWarning[]>> {
  const result = new Map<string, TimetableWarning[]>();
  if (!targets.length) return result;
  const settings = settingsIn ?? (await loadResolverSettings(schoolId));

  const all = [...targets, ...extras];
  const subjectIds = uniq(all.flatMap((t) => t.entries.map((e) => e.subjectId)));
  const teacherIds = uniq(all.flatMap((t) => t.entries.map((e) => e.teacherId)));
  const classIds = uniq(targets.map((t) => t.classId));

  const [subjects, teachers, assigned, others] = await Promise.all([
    Subject.find({ _id: { $in: subjectIds } })
      .select('isActive')
      .lean(),
    User.find({ _id: { $in: teacherIds }, schoolId, role: 'teacher' })
      .select('isActive')
      .lean(),
    ClassSubject.find({ classId: { $in: classIds } }).lean(),
    teacherIds.length
      ? TimetableVersion.find({
          schoolId,
          activatedAt: { $type: 'date' },
          'entries.teacherId': { $in: teacherIds },
        })
          .select('classId validFrom validTo entries')
          .lean()
      : [],
  ]);
  const subjectActive = new Map(subjects.map((s) => [String(s._id), s.isActive]));
  const teacherActive = new Map(teachers.map((t) => [String(t._id), t.isActive]));
  const assignment = new Map(
    assigned.map((a) => [`${a.classId}:${a.subjectId}`, String(a.teacherId)]),
  );

  const pool: AnalysisTarget[] = [
    ...others.map((v) => ({
      key: String(v._id),
      classId: String(v.classId),
      versionId: String(v._id),
      validFrom: v.validFrom,
      validTo: v.validTo,
      entries: v.entries.map((e) => ({
        weekday: e.weekday,
        lessonNo: e.lessonNo,
        subjectId: String(e.subjectId),
        teacherId: String(e.teacherId),
        groupKey: e.groupKey ?? null,
        room: e.room ?? null,
      })),
    })),
    ...extras,
  ];
  const otherClassIds = uniq(pool.map((p) => p.classId));
  const classNames = new Map(
    (
      await ClassModel.find({ _id: { $in: otherClassIds } })
        .select('name')
        .lean()
    ).map((c) => [String(c._id), c.name]),
  );

  for (const t of targets) {
    const list: TimetableWarning[] = [];
    const rivals = pool.filter(
      (p) =>
        p.classId !== t.classId &&
        p.versionId !== t.versionId &&
        overlaps(t.validFrom, t.validTo, p.validFrom, p.validTo),
    );
    for (const e of t.entries) {
      const base = {
        weekday: e.weekday,
        lessonNo: e.lessonNo,
        subjectId: e.subjectId,
        teacherId: e.teacherId,
      };
      if (isOutOfRange(e, settings)) {
        list.push({
          ...base,
          code: 'out_of_range',
          severity: 'warning',
          message: "Dam olish kuniga qo'yilgan dars",
        });
        continue;
      }
      for (const r of rivals) {
        const clash = r.entries.find(
          (x) =>
            x.teacherId === e.teacherId &&
            x.weekday === e.weekday &&
            x.lessonNo === e.lessonNo &&
            !isOutOfRange(x, settings),
        );
        if (!clash) continue;
        const name = classNames.get(r.classId) ?? '?';
        list.push({
          ...base,
          code: 'teacher_double_booked',
          severity: 'error',
          message: `O'qituvchi shu vaqtda ${name} sinfida ham dars beradi`,
          other: {
            classId: r.classId,
            className: name,
            versionId: r.versionId ?? r.key,
            validFrom: r.validFrom,
            validTo: r.validTo,
          },
        });
      }
      const assignedTeacher = assignment.get(`${t.classId}:${e.subjectId}`);
      if (assignedTeacher !== e.teacherId) {
        list.push({
          ...base,
          code: 'teacher_not_assigned',
          severity: 'warning',
          message: assignedTeacher
            ? "Fan boshqa o'qituvchiga biriktirilgan"
            : "Fan sinfga biriktirilmagan yoki o'qituvchi biriktirilmagan",
        });
      }
      if (subjectActive.get(e.subjectId) !== true) {
        list.push({
          ...base,
          code: 'subject_inactive',
          severity: 'warning',
          message: 'Fan faol emas yoki topilmadi',
        });
      }
      if (teacherActive.get(e.teacherId) !== true) {
        list.push({
          ...base,
          code: 'teacher_inactive',
          severity: 'warning',
          message: "O'qituvchi faol emas yoki topilmadi",
        });
      }
    }
    result.set(t.key, list);
  }
  return result;
}

export const blocking = (w: TimetableWarning[]) => w.filter((x) => BLOCKING_CODES.includes(x.code));
