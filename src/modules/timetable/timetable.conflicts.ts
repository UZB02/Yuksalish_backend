import { ClassModel } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { Subject } from '../../models/Subject';
import { MAX_LESSON_NO, TimetableVersion } from '../../models/TimetableVersion';
import { User } from '../../models/User';
import { uniq } from '../../utils/helpers';
import { loadResolverSettings, type ResolverSettings, type SliceEntry } from './timetable.resolver';

export const WARNING_CODES = [
  'teacher_double_booked',
  'teacher_overlap_approved',
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
  /** info — ma'lumot uchun (to'sqinlik qilmaydi, xato sifatida sanalmaydi) */
  severity: 'error' | 'warning' | 'info';
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
    /** Shu sinfning to'qnashayotgan barcha versiyalari (bitta ogohlantirishga jamlanadi) */
    versions: { versionId: string; validFrom: string; validTo: string | null }[];
  };
  /** teacher_overlap_approved: ruxsatni kim va qaysi tomondagi yozuvga bergan */
  approval?: {
    /** self — shu yozuvning o'zida; other — ikkinchi sinfdagi yozuvda; both — ikkalasida */
    side: 'self' | 'other' | 'both';
    approvedBy: string;
    approvedByName: string | null;
    approvedAt: string;
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

type Approval = { side: 'self' | 'other'; approvedBy: string; approvedAt: string };

function otherOf(
  classId: string,
  className: string,
  first: AnalysisTarget,
  versions: AnalysisTarget[],
): NonNullable<TimetableWarning['other']> {
  return {
    classId,
    className,
    versionId: first.versionId ?? first.key,
    validFrom: first.validFrom,
    validTo: first.validTo,
    versions: versions.map((v) => ({
      versionId: v.versionId ?? v.key,
      validFrom: v.validFrom,
      validTo: v.validTo,
    })),
  };
}

const FAR = '9999-12-31';
const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? FAR) && bFrom <= (aTo ?? FAR);

export const isOutOfRange = (e: { weekday: number; lessonNo: number }, s: ResolverSettings) =>
  !s.workingWeekdays.includes(e.weekday) || e.lessonNo < 1 || e.lessonNo > MAX_LESSON_NO;

/**
 * Sinfda `validFrom` dan faollashtiriladigan qoralamaning taxminiy tugash sanasi.
 * Yangi qoida: oxirgi faollashtirilgan versiya o'z `validFrom` idan boshlab g'olib — undan keyin
 * boshlanadigan versiyalar almashtiriladi, shuning uchun u doim ochiq (null) bo'ladi.
 * (Imzo chaqiruvchilar uchun saqlangan; `replaced` versiyalar hech qachon hisobga olinmaydi.)
 */
export async function hypotheticalValidTo(
  _classId: string,
  _validFrom: string,
  _excludeId?: string,
): Promise<string | null> {
  return null;
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
          status: { $ne: 'replaced' },
          'entries.teacherId': { $in: teacherIds },
        })
          .select('classId validFrom validTo entries')
          .lean()
      : [],
  ]);
  const subjectActive = new Map(subjects.map((s) => [String(s._id), s.isActive]));
  const teacherActive = new Map(teachers.map((t) => [String(t._id), t.isActive]));
  // Sinf+fan -> biriktirilgan o'qituvchilar to'plami (bir fanga bir nechta o'qituvchi bo'lishi mumkin)
  const assignment = new Map<string, Set<string>>();
  for (const a of assigned) {
    const k = `${a.classId}:${a.subjectId}`;
    const set = assignment.get(k) ?? new Set<string>();
    set.add(String(a.teacherId));
    assignment.set(k, set);
  }

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
        overlapApproval: e.overlapApproval
          ? {
              approvedBy: String(e.overlapApproval.approvedBy),
              approvedAt: new Date(e.overlapApproval.approvedAt).toISOString(),
            }
          : null,
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

  // Ruxsat bergan superadminlar nomlari (faqat tegishli yozuvlardan)
  const approverIds = uniq(
    [...targets, ...pool].flatMap((t) =>
      t.entries.flatMap((x) => (x.overlapApproval ? [x.overlapApproval.approvedBy] : [])),
    ),
  );
  const approverNames = new Map(
    (approverIds.length
      ? await User.find({ _id: { $in: approverIds } })
          .select('fullName')
          .lean()
      : []
    ).map((u) => [String(u._id), u.fullName]),
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
      // Har bir boshqa sinf uchun bitta ogohlantirish: sinfning bir nechta versiyasi
      // (masalan ketma-ket faol versiyalar) bir vaqtda to'qnashsa ham takrorlanmaydi
      // Ruxsat berilgan juftlik (ikki yozuvdan biri superadmin ruxsatiga ega) xato emas, info
      const clashes = new Map<string, AnalysisTarget[]>();
      const approvedClashes = new Map<
        string,
        { versions: AnalysisTarget[]; approvals: Approval[] }
      >();
      for (const r of rivals) {
        const hit = r.entries.find(
          (x) =>
            x.teacherId === e.teacherId &&
            x.weekday === e.weekday &&
            x.lessonNo === e.lessonNo &&
            !isOutOfRange(x, settings),
        );
        if (!hit) continue;
        if (e.overlapApproval || hit.overlapApproval) {
          const cur = approvedClashes.get(r.classId) ?? { versions: [], approvals: [] };
          cur.versions.push(r);
          if (e.overlapApproval) cur.approvals.push({ side: 'self', ...e.overlapApproval });
          if (hit.overlapApproval) cur.approvals.push({ side: 'other', ...hit.overlapApproval });
          approvedClashes.set(r.classId, cur);
          continue;
        }
        clashes.set(r.classId, [...(clashes.get(r.classId) ?? []), r]);
      }
      for (const [otherClassId, { versions, approvals }] of approvedClashes) {
        const first = versions[0] as AnalysisTarget;
        const name = classNames.get(otherClassId) ?? '?';
        const sides = new Set(approvals.map((a) => a.side));
        const main = approvals.find((a) => a.side === 'self') ?? (approvals[0] as Approval);
        list.push({
          ...base,
          code: 'teacher_overlap_approved',
          severity: 'info',
          message: `Ruxsat berilgan: o'qituvchi shu vaqtda ${name} sinfida ham dars beradi`,
          other: otherOf(otherClassId, name, first, versions),
          approval: {
            side: sides.size > 1 ? 'both' : main.side,
            approvedBy: main.approvedBy,
            approvedByName: approverNames.get(main.approvedBy) ?? null,
            approvedAt: main.approvedAt,
          },
        });
      }
      for (const [otherClassId, versions] of clashes) {
        const first = versions[0] as AnalysisTarget;
        const name = classNames.get(otherClassId) ?? '?';
        list.push({
          ...base,
          code: 'teacher_double_booked',
          severity: 'error',
          message: `O'qituvchi shu vaqtda ${name} sinfida ham dars beradi`,
          other: otherOf(otherClassId, name, first, versions),
        });
      }
      const assignedTeachers = assignment.get(`${t.classId}:${e.subjectId}`);
      if (!assignedTeachers?.has(e.teacherId)) {
        list.push({
          ...base,
          code: 'teacher_not_assigned',
          severity: 'warning',
          message: assignedTeachers
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
    result.set(t.key, dedupeWarnings(list));
  }
  return result;
}

/** Aynan bir xil (kod + katak + boshqa sinf) ogohlantirishlarni bittaga keltiradi */
export function dedupeWarnings(list: TimetableWarning[]): TimetableWarning[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    // Bir katakda bir nechta dars bo'lishi mumkin: o'qituvchi va fan ham kalitga kiradi
    const k = `${w.code}:${w.weekday}:${w.lessonNo}:${w.teacherId}:${w.subjectId}:${w.other?.classId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Ogohlantirishlar soni (faqat ma'lumot beruvchi info kodlarisiz) */
export const countIssues = (w: TimetableWarning[]) => w.filter((x) => x.severity !== 'info').length;

export const blocking = (w: TimetableWarning[]) => w.filter((x) => BLOCKING_CODES.includes(x.code));

export interface BusyTeacher {
  teacherId: string;
  classId: string;
  className: string;
  /** Boshqa sinfdagi shu yozuvda bir vaqtda o'tishga ruxsat berilgan (juftlik ruxsat bilan qoplangan) */
  approved: boolean;
}

/**
 * Berilgan katak (hafta kuni + dars) uchun `[validFrom, validTo]` davrida boshqa sinflarda
 * band bo'lgan o'qituvchilar (faollashtirilgan versiyalar bo'yicha). Bitta (o'qituvchi, sinf) — bitta yozuv.
 */
export async function busyTeachersAt(
  schoolId: string,
  classId: string,
  validFrom: string,
  validTo: string | null,
  weekday: number,
  lessonNo: number,
): Promise<BusyTeacher[]> {
  const versions = await TimetableVersion.find({
    schoolId,
    classId: { $ne: classId },
    activatedAt: { $type: 'date' },
    status: { $ne: 'replaced' },
    validFrom: { $lte: validTo ?? FAR },
    $or: [{ validTo: null }, { validTo: { $gte: validFrom } }],
    entries: { $elemMatch: { weekday, lessonNo } },
  })
    .select('classId entries')
    .lean();
  const classNames = new Map(
    (
      await ClassModel.find({ _id: { $in: uniq(versions.map((v) => String(v.classId))) } })
        .select('name')
        .lean()
    ).map((c) => [String(c._id), c.name]),
  );
  const seen = new Map<string, BusyTeacher>();
  for (const v of versions) {
    for (const e of v.entries) {
      if (e.weekday !== weekday || e.lessonNo !== lessonNo) continue;
      const key = `${e.teacherId}:${v.classId}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        teacherId: String(e.teacherId),
        classId: String(v.classId),
        className: classNames.get(String(v.classId)) ?? '?',
        approved: !!e.overlapApproval,
      });
    }
  }
  return [...seen.values()];
}
