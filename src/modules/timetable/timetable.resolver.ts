import type { Types } from 'mongoose';
import { MAX_LESSON_NO, TimetableVersion } from '../../models/TimetableVersion';
import { addDaysStr } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
import { loadOverridesForClasses, overrideClassIdsOfTeacher } from './overrides.loader';
import { settingsService } from '../settings/settings.service';
import { ATTENDANCE_KEY, type AttendanceSettings } from '../settings/attendance.settings';

/**
 * Darsni aniqlash servisi: (sinf, sana, dars raqami) -> fan/o'qituvchi/xona.
 * Davomat, baholash, jurnal va dashboard shu servisdan foydalanadi (P2+).
 * Davr uchun barcha versiyalar bitta so'rov bilan olinadi, hisob xotirada bajariladi.
 */

export type LessonSource = 'timetable' | 'override';
export type OverrideType = 'substitute' | 'cancel' | 'replace' | 'extra';

export interface ResolvedLesson {
  classId: string;
  date: string;
  weekday: number;
  lessonNo: number;
  groupKey: string | null;
  subjectId: string;
  teacherId: string;
  room: string | null;
  source: LessonSource;
  overrideType?: OverrideType;
  cancelled: boolean;
  versionId: string | null;
  overrideId?: string;
  /** O'rinbosar/almashtirishda jadvaldagi asl o'qituvchi */
  originalTeacherId?: string;
  /** Almashtirishda jadvaldagi asl fan */
  originalSubjectId?: string;
}

/** LessonOverride yozuvining resolver ko'rinishi */
export interface LessonOverrideRow {
  id: string;
  classId: string;
  date: string;
  lessonNo: number;
  groupKey: string | null;
  /** Qaysi darsga qaratilgan: jadvaldagi asl dars o'qituvchisi (eski yozuvlarda yo'q -> slotdagi birinchi dars) */
  targetTeacherId?: string | null;
  targetSubjectId?: string | null;
  type: OverrideType;
  subjectId?: string | null;
  teacherId?: string | null;
  room?: string | null;
  moveGroupId?: string | null;
}

export type OverrideLoader = (
  schoolId: string,
  classIds: string[],
  from: string,
  to: string,
) => Promise<LessonOverrideRow[]>;

let overrideLoader: OverrideLoader = loadOverridesForClasses;
/** Sinov uchun: almashtirishlar manbasini almashtirish (standart — Mongo) */
export const setOverrideLoader = (fn: OverrideLoader) => {
  overrideLoader = fn;
};

const slotKey = (classId: string, date: string, lessonNo: number, groupKey: string | null) =>
  `${classId}|${date}|${lessonNo}|${groupKey ?? ''}`;

/**
 * Almashtirishlarni qo'llash: jadval darsiga substitute/replace/cancel, bo'sh slotga extra.
 * Slotda bir nechta dars bo'lishi mumkin: o'zgartirish `targetTeacherId` (asl dars o'qituvchisi) bo'yicha
 * aniq bir darsga qo'llanadi; target yo'q (eski yozuv) bo'lsa slotdagi birinchi darsga.
 * Jadvalda mos dars topilmasa (jadval keyin o'zgargan) substitute/replace/cancel e'tiborsiz qoladi;
 * extra esa slotda jadval darsi bo'lsa e'tiborsiz qoladi (bo'sh slotga bir nechta extra mumkin).
 * Ro'yxat bo'sh bo'lsa lessons o'zgarishsiz qaytadi.
 */
export function applyOverrides(
  lessons: ResolvedLesson[],
  overrides: LessonOverrideRow[],
): ResolvedLesson[] {
  if (!overrides.length) return lessons;
  const out = lessons.map((l) => ({ ...l }));
  // Slot -> jadval darslari (asl o'qituvchi bilan: o'rinbosar qo'llangach ham target topilsin)
  const bySlot = new Map<string, { lesson: ResolvedLesson; teacher0: string }[]>();
  for (const l of out) {
    const k = slotKey(l.classId, l.date, l.lessonNo, l.groupKey);
    const list = bySlot.get(k) ?? [];
    list.push({ lesson: l, teacher0: l.teacherId });
    bySlot.set(k, list);
  }
  const extras: ResolvedLesson[] = [];
  for (const o of overrides) {
    const at = bySlot.get(slotKey(o.classId, o.date, o.lessonNo, o.groupKey)) ?? [];
    if (o.type === 'extra') {
      if (at.length || !o.subjectId || !o.teacherId) continue;
      extras.push({
        classId: o.classId,
        date: o.date,
        weekday: isoWeekday(o.date),
        lessonNo: o.lessonNo,
        groupKey: o.groupKey,
        subjectId: o.subjectId,
        teacherId: o.teacherId,
        room: o.room ?? null,
        source: 'override',
        overrideType: 'extra',
        overrideId: o.id,
        cancelled: false,
        versionId: null,
      });
      continue;
    }
    const hit = o.targetTeacherId ? at.find((x) => x.teacher0 === o.targetTeacherId) : at[0];
    if (!hit) continue;
    const base = hit.lesson;
    base.source = 'override';
    base.overrideType = o.type;
    base.overrideId = o.id;
    if (o.type === 'cancel') {
      base.cancelled = true;
      continue;
    }
    if (o.teacherId && o.teacherId !== base.teacherId) {
      base.originalTeacherId = base.teacherId;
      base.teacherId = o.teacherId;
    }
    if (o.type === 'replace' && o.subjectId && o.subjectId !== base.subjectId) {
      base.originalSubjectId = base.subjectId;
      base.subjectId = o.subjectId;
    }
    if (o.room) base.room = o.room;
  }
  return sortLessons([...out, ...extras]);
}

/** Tartib: sana, dars raqami, sinf, o'qituvchi (slotda bir nechta dars barqaror tartibda) */
const sortLessons = (list: ResolvedLesson[]) =>
  list.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.lessonNo - b.lessonNo ||
      a.classId.localeCompare(b.classId) ||
      a.teacherId.localeCompare(b.teacherId),
  );

export interface SliceEntry {
  weekday: number;
  lessonNo: number;
  subjectId: string;
  teacherId: string;
  groupKey: string | null;
  room: string | null;
}

export interface VersionSlice {
  id: string;
  classId: string;
  validFrom: string;
  validTo: string | null;
  entries: SliceEntry[];
}

export interface ResolverSettings {
  workingWeekdays: number[];
  /** Faqat ma'lumot (muharrirdagi boshlang'ich qatorlar soni); tekshiruvlarda ishlatilmaydi */
  lessonsPerDay: number;
}

export async function loadResolverSettings(schoolId: string): Promise<ResolverSettings> {
  const s = await settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId);
  return { workingWeekdays: s.workingWeekdays, lessonsPerDay: s.lessonsPerDay };
}

interface SliceFilter {
  classIds?: Types.ObjectId[] | string[];
  teacherId?: string;
}

/** [from, to] bilan kesishadigan faollashtirilgan versiyalar (bitta so'rov) */
export async function loadVersionSlices(
  schoolId: string,
  filter: SliceFilter,
  from: string,
  to: string,
): Promise<VersionSlice[]> {
  const q: Record<string, unknown> = {
    schoolId,
    status: { $in: ['active', 'superseded'] },
    validFrom: { $lte: to },
    $or: [{ validTo: null }, { validTo: { $gte: from } }],
  };
  if (filter.classIds) q.classId = { $in: filter.classIds };
  if (filter.teacherId) q['entries.teacherId'] = filter.teacherId;
  const rows = await TimetableVersion.find(q).lean();
  return rows.map((v) => ({
    id: String(v._id),
    classId: String(v.classId),
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
  }));
}

/** Sana qaysi versiya ostida (zanjir kesishmagani uchun eng ko'pi bilan bittasi) */
export const versionOn = (slices: VersionSlice[], classId: string, date: string) =>
  slices.find(
    (v) =>
      v.classId === classId && v.validFrom <= date && (v.validTo === null || v.validTo >= date),
  ) ?? null;

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysStr(d, 1)) out.push(d);
  return out;
}

type Match = (e: SliceEntry, classId: string) => boolean;
type LessonMatch = (l: ResolvedLesson) => boolean;

/** Sof hisob: berilgan versiyalar va sozlamalar bo'yicha darslar (ish kuni bo'lmagan kunlar chiqarib tashlanadi) */
export function lessonsFromSlices(
  slices: VersionSlice[],
  settings: ResolverSettings,
  classIds: string[],
  dates: string[],
  match?: Match,
): ResolvedLesson[] {
  const out: ResolvedLesson[] = [];
  for (const date of dates) {
    const weekday = isoWeekday(date);
    if (!settings.workingWeekdays.includes(weekday)) continue;
    for (const classId of classIds) {
      const v = versionOn(slices, classId, date);
      if (!v) continue;
      for (const e of v.entries) {
        if (e.weekday !== weekday) continue;
        if (e.lessonNo < 1 || e.lessonNo > MAX_LESSON_NO) continue;
        if (match && !match(e, classId)) continue;
        out.push({
          classId,
          date,
          weekday,
          lessonNo: e.lessonNo,
          groupKey: e.groupKey,
          subjectId: e.subjectId,
          teacherId: e.teacherId,
          room: e.room,
          source: 'timetable',
          cancelled: false,
          versionId: v.id,
        });
      }
    }
  }
  return sortLessons(out);
}

/** Sinflar to'plami uchun davr darslari (bitta so'rov) */
export async function resolveClassesRange(
  schoolId: string,
  classIds: string[],
  from: string,
  to: string,
  match?: LessonMatch,
): Promise<ResolvedLesson[]> {
  if (!classIds.length || from > to) return [];
  const [slices, settings, overrides] = await Promise.all([
    loadVersionSlices(schoolId, { classIds }, from, to),
    loadResolverSettings(schoolId),
    overrideLoader(schoolId, classIds, from, to),
  ]);
  const lessons = applyOverrides(
    lessonsFromSlices(slices, settings, classIds, datesBetween(from, to)),
    overrides,
  );
  return match ? lessons.filter(match) : lessons;
}

/** Sinfning shu sanadagi darslari va sinfda shu sana uchun amaldagi jadval versiyasi borligi */
export async function resolveClassDay(
  schoolId: string,
  classId: string,
  date: string,
): Promise<{ hasVersion: boolean; lessons: ResolvedLesson[] }> {
  const [slices, settings, overrides] = await Promise.all([
    loadVersionSlices(schoolId, { classIds: [classId] }, date, date),
    loadResolverSettings(schoolId),
    overrideLoader(schoolId, [classId], date, date),
  ]);
  return {
    hasVersion: !!versionOn(slices, classId, date),
    lessons: applyOverrides(lessonsFromSlices(slices, settings, [classId], [date]), overrides),
  };
}

/** Sinfning shu sanadagi barcha darslari */
export const resolveLessons = (schoolId: string, classId: string, date: string) =>
  resolveClassesRange(schoolId, [classId], date, date);

/**
 * Bitta dars (sinf, sana, dars raqami, guruh) yoki null. Slotda bir nechta dars bo'lsa `teacherId`
 * (joriy o'qituvchi) berilgan darsni, bo'lmasa birinchisini qaytaradi.
 */
export async function resolveLesson(
  schoolId: string,
  classId: string,
  date: string,
  lessonNo: number,
  groupKey: string | null = null,
  teacherId?: string,
): Promise<ResolvedLesson | null> {
  const all = (await resolveLessons(schoolId, classId, date)).filter(
    (l) => l.lessonNo === lessonNo && l.groupKey === groupKey,
  );
  return (teacherId ? all.find((l) => l.teacherId === teacherId) : undefined) ?? all[0] ?? null;
}

/**
 * O'qituvchining davr ichidagi darslari (barcha sinflar), almashtirishlar hisobga olingan:
 * o'rinbosar qilingan dars yangi o'qituvchiga o'tadi, bekor qilingan dars (cancelled) asl o'qituvchida qoladi.
 */
export async function teacherLessonsInRange(
  schoolId: string,
  teacherId: string,
  from: string,
  to: string,
): Promise<ResolvedLesson[]> {
  if (from > to) return [];
  const [mySlices, overrideClasses] = await Promise.all([
    loadVersionSlices(schoolId, { teacherId }, from, to),
    overrideClassIdsOfTeacher(schoolId, teacherId, from, to),
  ]);
  const classIds = [...new Set([...mySlices.map((s) => s.classId), ...overrideClasses])];
  if (!classIds.length) return [];
  const [settings, overrides] = await Promise.all([
    loadResolverSettings(schoolId),
    overrideLoader(schoolId, classIds, from, to),
  ]);
  const dates = datesBetween(from, to);
  if (!overrides.length) {
    return lessonsFromSlices(mySlices, settings, classIds, dates, (e) => e.teacherId === teacherId);
  }
  // Almashtirish bor: sinflarning to'liq jadvali (o'rinbosar boshqa o'qituvchining darsiga keladi)
  const slices = await loadVersionSlices(schoolId, { classIds }, from, to);
  return applyOverrides(lessonsFromSlices(slices, settings, classIds, dates), overrides).filter(
    (l) => l.teacherId === teacherId,
  );
}

/** O'qituvchining shu sanadagi darslari */
export const teacherLessons = (schoolId: string, teacherId: string, date: string) =>
  teacherLessonsInRange(schoolId, teacherId, date, date);

/** Sinf+fan bo'yicha davr ichidagi darslar (bitta so'rov) */
export const subjectLessonsInRange = (
  schoolId: string,
  classId: string,
  subjectId: string,
  from: string,
  to: string,
) => resolveClassesRange(schoolId, [classId], from, to, (l) => l.subjectId === subjectId);
