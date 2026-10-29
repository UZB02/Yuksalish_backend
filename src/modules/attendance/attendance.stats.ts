import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { AttendanceStatus } from '../../models/AttendanceStatus';
import { ClassModel } from '../../models/Class';
import { Student } from '../../models/Student';
import { Subject } from '../../models/Subject';
import { School } from '../../models/School';
import { addDaysStr, todayTashkent } from '../../utils/clock';
import { round2 } from '../../utils/dayScore';
import { isId } from '../../utils/helpers';
import { allowedClassIds } from '../classes/classes.service';
import type { AttendanceCategory } from '../settings/attendance.settings';
import { activeYearId, getAttendanceSettings, toRecordDtos } from './attendance.service';
import { isWorkingDay } from './attendance.rules';

type Actor = Ctx['actor'];

const oid = (id: string) => new Types.ObjectId(id);
const rateOf = (present: number, late: number, total: number): number | null =>
  total > 0 ? round2(((present + late) / total) * 100) : null;

/** Kunning yakuniy kategoriyasi: eng og'ir (dars rejimida bir kunda bir nechta yozuv bo'lishi mumkin) */
const SEVERITY: AttendanceCategory[] = ['present', 'late', 'absent_excused', 'absent_unexcused'];
export const worstCategory = (cats: AttendanceCategory[]): AttendanceCategory =>
  cats.reduce(
    (w, c) => (SEVERITY.indexOf(c) > SEVERITY.indexOf(w) ? c : w),
    'present' as AttendanceCategory,
  );

/**
 * Kunning yakuniy holati (dars rejimida bir kunda bir nechta yozuv):
 * - hamma yozuv yo'qlik -> absent_unexcused (kamida bittasi sababsiz bo'lsa) yoki absent_excused;
 * - yozuvlarning bir qismi yo'qlik -> 'partial' (qisman);
 * - yo'qlik yo'q -> late (kamida bitta kechikish bo'lsa) yoki present.
 */
export type DayStatus = 'present' | 'late' | 'partial' | AttendanceCategory;
export function dayStatus(cats: AttendanceCategory[]): DayStatus {
  const absent = cats.filter((c) => c === 'absent_excused' || c === 'absent_unexcused');
  if (absent.length && absent.length < cats.length) return 'partial';
  if (absent.length)
    return absent.includes('absent_unexcused') ? 'absent_unexcused' : 'absent_excused';
  return cats.includes('late') ? 'late' : 'present';
}

function resolveRange(q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? todayTashkent();
  const from = q.from ?? addDaysStr(to, -29);
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
  return { from, to };
}

const emptyCounts = () => ({ present: 0, late: 0, absentExcused: 0, absentUnexcused: 0 });
type Counts = ReturnType<typeof emptyCounts>;
const addCat = (c: Counts, cat: AttendanceCategory, n = 1) => {
  if (cat === 'present') c.present += n;
  else if (cat === 'late') c.late += n;
  else if (cat === 'absent_excused') c.absentExcused += n;
  else c.absentUnexcused += n;
};
const totalOf = (c: Counts) => c.present + c.late + c.absentExcused + c.absentUnexcused;

export const attendanceStats = {
  /** Sinf/o'quvchilar bo'yicha davr statistikasi */
  async summary(
    actor: Actor,
    schoolId: string,
    q: { classId?: string; from?: string; to?: string },
  ) {
    const { from, to } = resolveRange(q);
    const scope = await allowedClassIds(actor, schoolId);
    const notFound = AppError.notFound('Sinf topilmadi');

    const studentFilter: Record<string, unknown> = { schoolId, isDeleted: false, status: 'active' };
    if (q.classId) {
      if (!isId(q.classId) || (scope && !scope.includes(q.classId))) throw notFound;
      if (!(await ClassModel.exists({ _id: q.classId, schoolId }))) throw notFound;
      studentFilter.classId = q.classId;
    } else if (scope) studentFilter.classId = { $in: scope };

    const students = await Student.find(studentFilter)
      .select('fullName classId')
      .sort({ fullName: 1, _id: 1 })
      .lean();
    const rows = await AttendanceRecord.aggregate<{
      _id: { s: Types.ObjectId; c: AttendanceCategory; l: boolean };
      n: number;
    }>([
      {
        $match: {
          schoolId: oid(schoolId),
          isDeleted: false,
          date: { $gte: from, $lte: to },
          studentId: { $in: students.map((s) => s._id) },
        },
      },
      {
        $group: {
          _id: { s: '$studentId', c: '$category', l: { $gt: ['$lessonNo', 0] } },
          n: { $sum: 1 },
        },
      },
    ]);

    const per = new Map<string, Counts>();
    let hasDay = false;
    let hasLesson = false;
    for (const r of rows) {
      const key = String(r._id.s);
      const c = per.get(key) ?? emptyCounts();
      addCat(c, r._id.c, r.n);
      per.set(key, c);
      if (r._id.l) hasLesson = true;
      else hasDay = true;
    }
    let unit: 'day' | 'lesson' | 'mixed';
    if (hasDay && hasLesson) unit = 'mixed';
    else if (hasLesson) unit = 'lesson';
    else if (hasDay) unit = 'day';
    else unit = (await getAttendanceSettings(schoolId)).mode === 'lesson' ? 'lesson' : 'day';

    const list = students.map((s) => {
      const c = per.get(String(s._id)) ?? emptyCounts();
      const total = totalOf(c);
      return {
        studentId: String(s._id),
        fullName: s.fullName,
        ...c,
        total,
        rate: rateOf(c.present, c.late, total),
      };
    });
    const agg = emptyCounts();
    for (const l of list) {
      agg.present += l.present;
      agg.late += l.late;
      agg.absentExcused += l.absentExcused;
      agg.absentUnexcused += l.absentUnexcused;
    }
    const total = totalOf(agg);
    return {
      from,
      to,
      unit,
      ...(q.classId
        ? { class: { ...agg, total, rate: rateOf(agg.present, agg.late, total) } }
        : {}),
      students: list,
    };
  },

  /** O'quvchi profili uchun davomat xulosasi */
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

    const { from, to } = resolveRange(range);
    const settings = await getAttendanceSettings(schoolId);
    const records = await AttendanceRecord.find({
      schoolId,
      studentId: student._id,
      isDeleted: false,
      date: { $gte: from, $lte: to },
    }).sort({ date: 1, lessonNo: 1, createdAt: 1 });

    const counts = emptyCounts();
    const byStatus = new Map<string, number>();
    const byDate = new Map<string, typeof records>();
    for (const r of records) {
      addCat(counts, r.category);
      byStatus.set(String(r.statusId), (byStatus.get(String(r.statusId)) ?? 0) + 1);
      byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    }
    const lessonSubjectIds = [
      ...new Set(records.flatMap((r) => (r.subjectId ? [String(r.subjectId)] : []))),
    ];
    const subjectDocs = lessonSubjectIds.length
      ? await Subject.find({ _id: { $in: lessonSubjectIds } })
          .select('name')
          .lean()
      : [];
    const subjectName = new Map(subjectDocs.map((s) => [String(s._id), s.name]));
    const statusDocs = byStatus.size
      ? await AttendanceStatus.find({ _id: { $in: [...byStatus.keys()] } })
      : [];
    const stMap = new Map(statusDocs.map((s) => [s.id as string, s]));
    const total = totalOf(counts);

    const recentDocs = [...records]
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) || b.lessonNo - a.lessonNo || +b.createdAt - +a.createdAt,
      )
      .slice(0, 10);
    return {
      studentId: student.id as string,
      from,
      to,
      total,
      ...counts,
      rate: rateOf(counts.present, counts.late, total),
      byStatus: [...byStatus.entries()]
        .map(([id, count]) => {
          const st = stMap.get(id);
          return {
            statusId: id,
            name: st?.name ?? '',
            color: st?.color ?? '#6B7280',
            category: st?.category ?? 'present',
            count,
          };
        })
        .sort((a, b) => b.count - a.count),
      days: [...byDate.entries()].map(([date, list]) => ({
        date,
        // category — eng og'ir kategoriya (eski mijozlar uchun); status — kunning yakuniy holati ('partial' bilan)
        category: worstCategory(list.map((r) => r.category)),
        status: dayStatus(list.map((r) => r.category)),
        lessons: list.length,
        records: list.map((r) => ({
          lessonNo: r.lessonNo,
          subjectId: r.subjectId ? String(r.subjectId) : null,
          subject: r.subjectId
            ? { id: String(r.subjectId), name: subjectName.get(String(r.subjectId)) ?? '' }
            : null,
          statusId: String(r.statusId),
          category: r.category,
        })),
      })),
      recent: await toRecordDtos(recentDocs, { actor, settings }),
    };
  },

  /**
   * Bugungi davomat olish jarayoni (sinf bo'yicha). "Birlik" — kunlik rejimda kun, dars rejimida har bir dars.
   * Birlik "olingan" hisoblanadi, agar sinfning HAMMA faol o'quvchisiga shu birlik uchun yozuv bo'lsa.
   */
  async todayProgress(actor: Actor, schoolId: string) {
    const settings = await getAttendanceSettings(schoolId);
    const today = todayTashkent();
    if (!isWorkingDay(settings, today)) return [];
    const yearId = await activeYearId(schoolId);
    if (!yearId) return [];

    const filter: Record<string, unknown> = { schoolId, academicYearId: yearId, isArchived: false };
    if (actor.role === 'teacher') filter.teacherIds = actor.id;
    const classes = await ClassModel.find(filter).sort({ grade: 1, name: 1 });
    if (!classes.length) return [];

    const students = await Student.find({
      schoolId,
      classId: { $in: classes.map((c) => c._id) },
      isDeleted: false,
      status: 'active',
    }).select('classId');
    const classOf = new Map(students.map((s) => [s.id as string, String(s.classId)]));
    const totalStudents = new Map<string, number>();
    for (const s of students)
      totalStudents.set(String(s.classId), (totalStudents.get(String(s.classId)) ?? 0) + 1);

    const lessonFilter = settings.mode === 'daily' ? 0 : { $gte: 1, $lte: settings.lessonsPerDay };
    const records = await AttendanceRecord.find({
      schoolId,
      date: today,
      isDeleted: false,
      lessonNo: lessonFilter,
      studentId: { $in: students.map((s) => s._id) },
    }).select('studentId lessonNo');

    // sinf -> birlik(lessonNo) -> o'quvchilar to'plami
    const marked = new Map<string, Map<number, Set<string>>>();
    for (const r of records) {
      const cid = classOf.get(String(r.studentId));
      if (!cid) continue;
      const units = marked.get(cid) ?? new Map<number, Set<string>>();
      const set = units.get(r.lessonNo) ?? new Set<string>();
      set.add(String(r.studentId));
      units.set(r.lessonNo, set);
      marked.set(cid, units);
    }
    const unitNos =
      settings.mode === 'daily'
        ? [0]
        : Array.from({ length: settings.lessonsPerDay }, (_, i) => i + 1);
    return classes.map((c) => {
      const total = totalStudents.get(c.id) ?? 0;
      const units = marked.get(c.id) ?? new Map<number, Set<string>>();
      const markedUnits =
        total > 0 ? unitNos.filter((n) => (units.get(n)?.size ?? 0) >= total).length : 0;
      const anyStudents = new Set<string>();
      for (const set of units.values()) for (const s of set) anyStudents.add(s);
      return {
        classId: c.id as string,
        className: c.name,
        markedUnits,
        totalUnits: unitNos.length,
        markedStudents: anyStudents.size,
        totalStudents: total,
      };
    });
  },

  /**
   * Dashboard uchun bugungi davomat. Qoida: o'quvchi bugungi yozuvlari bo'yicha bitta guruhga tushadi (dayStatus):
   * present / late / partial (bir qism dars yo'q, bir qismi bor) / absent (hamma yozuv yo'qlik, ikkala turi). total = doiradagi faol o'quvchilar soni.
   * unmarkedClasses = kamida bitta faol o'quvchisiga bugun hech qanday yozuv yo'q sinflar (faqat ish kunida).
   */
  async dashboardToday(actor: Actor, schoolId: string | undefined) {
    const today = todayTashkent();
    const result = { present: 0, late: 0, partial: 0, absent: 0, total: 0, unmarkedClasses: 0 };
    const schoolIds = schoolId
      ? [schoolId]
      : (await School.find({ isActive: true }).select('_id').lean()).map((s) => String(s._id));

    for (const sid of schoolIds) {
      const yearId = await activeYearId(sid);
      if (!yearId) continue;
      const classFilter: Record<string, unknown> = {
        schoolId: sid,
        academicYearId: yearId,
        isArchived: false,
      };
      if (actor.role === 'teacher') classFilter.teacherIds = actor.id;
      const classes = await ClassModel.find(classFilter).select('_id').lean();
      const students = await Student.find({
        schoolId: sid,
        classId: { $in: classes.map((c) => c._id) },
        isDeleted: false,
        status: 'active',
      })
        .select('classId')
        .lean();
      result.total += students.length;

      const settings = await getAttendanceSettings(sid);
      if (!isWorkingDay(settings, today)) continue;

      const records = await AttendanceRecord.find({
        schoolId: sid,
        date: today,
        isDeleted: false,
        studentId: { $in: students.map((s) => s._id) },
      })
        .select('studentId category')
        .lean();
      const cats = new Map<string, AttendanceCategory[]>();
      for (const r of records)
        cats.set(String(r.studentId), [...(cats.get(String(r.studentId)) ?? []), r.category]);
      for (const list of cats.values()) {
        const w = dayStatus(list);
        if (w === 'present') result.present++;
        else if (w === 'late') result.late++;
        else if (w === 'partial') result.partial++;
        else result.absent++;
      }
      const unmarked = new Set<string>();
      for (const s of students) if (!cats.has(String(s._id))) unmarked.add(String(s.classId));
      result.unmarkedClasses += unmarked.size;
    }
    return result;
  },
};
