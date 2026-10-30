import type { Types } from 'mongoose';
import { MAX_LESSON_NO, TimetableVersion } from '../../models/TimetableVersion';
import { addDaysStr } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
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
}

/** 4-bosqichda (LessonOverride) to'ldiriladi; hozircha manba bo'sh */
export interface LessonOverrideRow {
  id: string;
  classId: string;
  date: string;
  lessonNo: number;
  groupKey: string | null;
  type: OverrideType;
  subjectId?: string | null;
  teacherId?: string | null;
  room?: string | null;
}

export type OverrideLoader = (
  schoolId: string,
  classIds: string[],
  from: string,
  to: string,
) => Promise<LessonOverrideRow[]>;

let overrideLoader: OverrideLoader = async () => [];
/** P4 da LessonOverride modeli shu yerga ulanadi */
export const setOverrideLoader = (fn: OverrideLoader) => {
  overrideLoader = fn;
};

/** Almashtirishlarni qo'llash (P4): hozircha ro'yxat bo'sh bo'lsa darslar o'zgarmaydi */
export function applyOverrides(
  lessons: ResolvedLesson[],
  overrides: LessonOverrideRow[],
): ResolvedLesson[] {
  if (!overrides.length) return lessons;
  // TODO(P4): substitute/cancel/replace/extra qoidalari
  return lessons;
}

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
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.lessonNo - b.lessonNo || a.classId.localeCompare(b.classId),
  );
}

/** Sinflar to'plami uchun davr darslari (bitta so'rov) */
export async function resolveClassesRange(
  schoolId: string,
  classIds: string[],
  from: string,
  to: string,
  match?: Match,
): Promise<ResolvedLesson[]> {
  if (!classIds.length || from > to) return [];
  const [slices, settings, overrides] = await Promise.all([
    loadVersionSlices(schoolId, { classIds }, from, to),
    loadResolverSettings(schoolId),
    overrideLoader(schoolId, classIds, from, to),
  ]);
  return applyOverrides(
    lessonsFromSlices(slices, settings, classIds, datesBetween(from, to), match),
    overrides,
  );
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

/** Bitta dars (sinf, sana, dars raqami, guruh) yoki null */
export async function resolveLesson(
  schoolId: string,
  classId: string,
  date: string,
  lessonNo: number,
  groupKey: string | null = null,
): Promise<ResolvedLesson | null> {
  const all = await resolveLessons(schoolId, classId, date);
  return all.find((l) => l.lessonNo === lessonNo && l.groupKey === groupKey) ?? null;
}

/** O'qituvchining davr ichidagi darslari (barcha sinflar) */
export async function teacherLessonsInRange(
  schoolId: string,
  teacherId: string,
  from: string,
  to: string,
): Promise<ResolvedLesson[]> {
  if (from > to) return [];
  const slices = await loadVersionSlices(schoolId, { teacherId }, from, to);
  const classIds = [...new Set(slices.map((s) => s.classId))];
  if (!classIds.length) return [];
  const [settings, overrides] = await Promise.all([
    loadResolverSettings(schoolId),
    overrideLoader(schoolId, classIds, from, to),
  ]);
  const lessons = lessonsFromSlices(
    slices,
    settings,
    classIds,
    datesBetween(from, to),
    (e) => e.teacherId === teacherId,
  );
  return applyOverrides(lessons, overrides);
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
) => resolveClassesRange(schoolId, [classId], from, to, (e) => e.subjectId === subjectId);
