import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { ClassModel } from '../../models/Class';
import { Student } from '../../models/Student';
import { Subject } from '../../models/Subject';
import { todayTashkent } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
import { uniq } from '../../utils/helpers';
import { getAttendanceSettings } from '../attendance/attendance.service';
import {
  loadVersionSlices,
  teacherLessons,
  type OverrideType,
  type LessonSource,
} from './timetable.resolver';

type Actor = Ctx['actor'];

export type TodayAttendanceStatus = 'taken' | 'partial' | 'none';

export interface TodayLesson {
  date: string;
  lessonNo: number;
  classId: string;
  class: { id: string; name: string };
  subjectId: string;
  subject: { id: string; name: string };
  room: string | null;
  source: LessonSource;
  overrideType: OverrideType | null;
  /** O'rinbosar sifatida (P4): override turi 'substitute' */
  substitute: boolean;
  cancelled: boolean;
  /** Davomat holati: hamma faol o'quvchi belgilangan / qisman / hech kim */
  status: TodayAttendanceStatus;
  markedStudents: number;
  totalStudents: number;
}

/** O'qituvchining bugungi darslari (barcha sinflar) va har bir dars uchun davomat holati */
export async function myTodayLessons(actor: Actor, schoolId: string) {
  const date = todayTashkent();
  const settings = await getAttendanceSettings(schoolId);
  const base = { date, attendanceMode: settings.mode };

  const slices = await loadVersionSlices(schoolId, { teacherId: actor.id }, date, date);
  const working = settings.workingWeekdays.includes(isoWeekday(date));
  if (!working) {
    return { ...base, working, hasTimetable: slices.length > 0, lessons: [] as TodayLesson[] };
  }

  // O'rinbosar/qo'shimcha darsi bor o'qituvchining o'z jadvali bo'lmasligi mumkin: avval darslar
  const resolved = await teacherLessons(schoolId, actor.id, date);
  const hasTimetable = slices.length > 0 || resolved.length > 0;
  if (!hasTimetable) return { ...base, working, hasTimetable, lessons: [] as TodayLesson[] };
  const classes = await ClassModel.find({
    _id: { $in: uniq(resolved.map((l) => l.classId)) },
    schoolId,
    isArchived: false,
  })
    .select('name')
    .lean();
  const classMap = new Map(classes.map((c) => [String(c._id), c.name]));
  const lessons = resolved.filter((l) => classMap.has(l.classId));
  if (!lessons.length) return { ...base, working, hasTimetable, lessons: [] as TodayLesson[] };

  const classOids = [...classMap.keys()].map((id) => new Types.ObjectId(id));
  const [subjects, students] = await Promise.all([
    Subject.find({ _id: { $in: uniq(lessons.map((l) => l.subjectId)) } })
      .select('name')
      .lean(),
    Student.find({ schoolId, classId: { $in: classOids }, isDeleted: false, status: 'active' })
      .select('classId')
      .lean(),
  ]);
  const subjectName = new Map(subjects.map((s) => [String(s._id), s.name]));
  const classOfStudent = new Map(students.map((s) => [String(s._id), String(s.classId)]));
  const totals = new Map<string, number>();
  for (const s of students) totals.set(String(s.classId), (totals.get(String(s.classId)) ?? 0) + 1);

  const records = await AttendanceRecord.find({
    schoolId,
    date,
    isDeleted: false,
    studentId: { $in: students.map((s) => s._id) },
    lessonNo: settings.mode === 'daily' ? 0 : { $gte: 1 },
  })
    .select('studentId lessonNo')
    .lean();
  // `${classId}:${lessonNo}` -> belgilangan o'quvchilar
  const marked = new Map<string, Set<string>>();
  for (const r of records) {
    const cid = classOfStudent.get(String(r.studentId));
    if (!cid) continue;
    const key = `${cid}:${r.lessonNo}`;
    const set = marked.get(key) ?? new Set<string>();
    set.add(String(r.studentId));
    marked.set(key, set);
  }

  const out: TodayLesson[] = lessons.map((l) => {
    const total = totals.get(l.classId) ?? 0;
    const unit = settings.mode === 'daily' ? 0 : l.lessonNo;
    const n = marked.get(`${l.classId}:${unit}`)?.size ?? 0;
    let status: TodayAttendanceStatus = 'none';
    if (total > 0 && n >= total) status = 'taken';
    else if (n > 0) status = 'partial';
    return {
      date,
      lessonNo: l.lessonNo,
      classId: l.classId,
      class: { id: l.classId, name: classMap.get(l.classId) ?? '' },
      subjectId: l.subjectId,
      subject: { id: l.subjectId, name: subjectName.get(l.subjectId) ?? '' },
      room: l.room,
      source: l.source,
      overrideType: l.overrideType ?? null,
      substitute: l.source === 'override' && l.overrideType === 'substitute',
      cancelled: l.cancelled,
      status,
      markedStudents: n,
      totalStudents: total,
    };
  });
  out.sort((a, b) => a.lessonNo - b.lessonNo || a.class.name.localeCompare(b.class.name, 'uz'));
  return { ...base, working, hasTimetable, lessons: out };
}
