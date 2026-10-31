import { LessonOverride } from '../../models/LessonOverride';
import type { LessonOverrideRow } from './timetable.resolver';

/** Mongo yozuvi -> resolver satri */
export const rowOf = (d: {
  _id: unknown;
  classId: unknown;
  date: string;
  lessonNo: number;
  groupKey?: string | null;
  targetTeacherId?: unknown;
  targetSubjectId?: unknown;
  type: LessonOverrideRow['type'];
  subjectId?: unknown;
  teacherId?: unknown;
  room?: string | null;
  moveGroupId?: string | null;
}): LessonOverrideRow => ({
  id: String(d._id),
  classId: String(d.classId),
  date: d.date,
  lessonNo: d.lessonNo,
  groupKey: d.groupKey ?? null,
  targetTeacherId: d.targetTeacherId ? String(d.targetTeacherId) : null,
  targetSubjectId: d.targetSubjectId ? String(d.targetSubjectId) : null,
  type: d.type,
  subjectId: d.subjectId ? String(d.subjectId) : null,
  teacherId: d.teacherId ? String(d.teacherId) : null,
  room: d.room ?? null,
  moveGroupId: d.moveGroupId ?? null,
});

/** Sinflar to'plami va davr uchun almashtirishlar (bitta so'rov) */
export async function loadOverridesForClasses(
  schoolId: string,
  classIds: string[],
  from: string,
  to: string,
): Promise<LessonOverrideRow[]> {
  if (!classIds.length) return [];
  const rows = await LessonOverride.find({
    schoolId,
    classId: { $in: classIds },
    date: { $gte: from, $lte: to },
  }).lean();
  return rows.map(rowOf);
}

/** Maktabning shu kundagi barcha almashtirishlari */
export async function loadOverridesForDate(
  schoolId: string,
  date: string,
): Promise<LessonOverrideRow[]> {
  const rows = await LessonOverride.find({ schoolId, date }).lean();
  return rows.map(rowOf);
}

/** O'qituvchi tayinlangan (o'rinbosar/almashtirish/qo'shimcha) sinflar — davr ichida */
export async function overrideClassIdsOfTeacher(
  schoolId: string,
  teacherId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const ids = await LessonOverride.distinct('classId', {
    schoolId,
    teacherId,
    date: { $gte: from, $lte: to },
  });
  return ids.map(String);
}
