import { Types } from 'mongoose';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { BehaviorType } from '../../models/BehaviorType';
import { ClassModel } from '../../models/Class';
import { Score } from '../../models/Score';
import { Student } from '../../models/Student';
import { User } from '../../models/User';
import type { AuthUser } from '../../types/express';
import { addDaysStr, todayTashkent } from '../../utils/clock';
import { round2 } from '../../utils/dayScore';
import { activeYearId, getAttendanceSettings } from '../attendance/attendance.service';
import { isWorkingDay } from '../attendance/attendance.rules';
import { dayStatus } from '../attendance/attendance.stats';
import { loadDayRows } from '../ratings/ratings.service';
import type { AttendanceCategory } from '../settings/attendance.settings';
import { settingsService } from '../settings/settings.service';

/** "E'tibor talab qiladigan o'quvchilar" chegaralari (hozircha sozlama emas) */
export const ATTENTION = {
  /** Oynalar uzunligi (kun): oxirgi N kun (bugun bilan) va undan oldingi N kun */
  windowDays: 7,
  /** Ball pasayishi (oldingi oyna o'rtachasi - joriy oyna o'rtachasi) shu qiymatga teng yoki katta */
  dropPoints: 15,
  /** Pasayishni baholash uchun har ikkala oynada kamida shuncha ballangan kun kerak */
  minScoredDays: 2,
  /** Oxirgi oynada salbiy xulq turi bilan kamida shuncha baho */
  negativeCount: 3,
  /** Oxirgi oynada kamida shuncha SABABSIZ yo'q KUN */
  unexcusedDays: 2,
  /** Ro'yxat uzunligi */
  limit: 10,
} as const;

/** Davomat dinamikasi oynasi (kun, bugun bilan) */
export const ATTENDANCE_TREND_DAYS = 30;

const oid = (id: string) => new Types.ObjectId(id);
const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Dashboard'dagi mavjud mantiq bilan bir xil sinflar: faol o'quv yili, arxivlanmagan; o'qituvchi — o'z sinflari */
async function scopeClasses(
  actor: AuthUser,
  schoolId: string,
  teacherField?: 'teacherIds' | 'homeroomTeacherId',
) {
  const yearId = await activeYearId(schoolId);
  if (!yearId) return [];
  const filter: Record<string, unknown> = { schoolId, academicYearId: yearId, isArchived: false };
  if (actor.role === 'teacher') filter[teacherField ?? 'teacherIds'] = actor.id;
  return ClassModel.find(filter).sort({ grade: 1, name: 1 }).lean();
}

const activeStudents = (schoolId: string, classIds: Types.ObjectId[], select: string) =>
  Student.find({ schoolId, classId: { $in: classIds }, isDeleted: false, status: 'active' })
    .select(select)
    .lean();

export const dashboardWidgets = {
  /**
   * Bugun xulq bahosi tugallanmagan sinflar. "Baholangan" = bugun (har qanday o'qituvchi tomonidan)
   * kamida bitta bahosi bor faol o'quvchi. Admin: faqat tugallanmaganlar; o'qituvchi: o'z sinf rahbari
   * bo'lgan barcha sinflar (progress bilan).
   */
  async unscoredClasses(actor: AuthUser, schoolId: string) {
    const today = todayTashkent();
    const isTeacher = actor.role === 'teacher';
    const settings = await getAttendanceSettings(schoolId);
    const base = { date: today, scope: isTeacher ? ('homeroom' as const) : ('school' as const) };
    if (!isWorkingDay(settings, today)) {
      return { ...base, workingDay: false, totalClasses: 0, classes: [] as never[] };
    }
    const classes = await scopeClasses(actor, schoolId, 'homeroomTeacherId');
    const students = classes.length
      ? await activeStudents(
          schoolId,
          classes.map((c) => c._id),
          'classId',
        )
      : [];
    const classOf = new Map(students.map((s) => [String(s._id), String(s.classId)]));
    const total = new Map<string, number>();
    for (const s of students) total.set(String(s.classId), (total.get(String(s.classId)) ?? 0) + 1);

    const scoredIds = students.length
      ? await Score.distinct('studentId', {
          schoolId: oid(schoolId),
          date: today,
          isDeleted: false,
          studentId: { $in: students.map((s) => s._id) },
        })
      : [];
    const graded = new Map<string, number>();
    for (const id of scoredIds) {
      const cid = classOf.get(String(id));
      if (cid) graded.set(cid, (graded.get(cid) ?? 0) + 1);
    }

    const homeroomIds = [
      ...new Set(
        classes.flatMap((c) => (c.homeroomTeacherId ? [String(c.homeroomTeacherId)] : [])),
      ),
    ];
    const teachers = homeroomIds.length
      ? await User.find({ _id: { $in: homeroomIds }, schoolId })
          .select('fullName')
          .lean()
      : [];
    const nameOf = new Map(teachers.map((u) => [String(u._id), u.fullName]));

    const rows = classes
      .map((c) => {
        const t = total.get(String(c._id)) ?? 0;
        const g = graded.get(String(c._id)) ?? 0;
        const hid = c.homeroomTeacherId ? String(c.homeroomTeacherId) : null;
        return {
          classId: String(c._id),
          className: c.name,
          homeroomTeacher: hid && nameOf.has(hid) ? { id: hid, fullName: nameOf.get(hid)! } : null,
          graded: g,
          total: t,
        };
      })
      .filter((r) => r.total > 0 && (isTeacher || r.graded < r.total));
    rows.sort(
      (a, b) =>
        a.graded / a.total - b.graded / b.total ||
        a.className.localeCompare(b.className, undefined, { numeric: true }),
    );
    return { ...base, workingDay: true, totalClasses: classes.length, classes: rows };
  },

  /** E'tibor talab qiladigan o'quvchilar (qoidalar: ATTENTION) */
  async attentionStudents(actor: AuthUser, schoolId: string) {
    const A = ATTENTION;
    const today = todayTashkent();
    const cur = { from: addDaysStr(today, -(A.windowDays - 1)), to: today };
    const prev = { from: addDaysStr(cur.from, -A.windowDays), to: addDaysStr(cur.from, -1) };
    const out = { current: cur, previous: prev, total: 0, students: [] as AttentionStudent[] };

    const classes = await scopeClasses(actor, schoolId);
    if (!classes.length) return out;
    const className = new Map(classes.map((c) => [String(c._id), c.name]));
    const students = await activeStudents(
      schoolId,
      classes.map((c) => c._id),
      'fullName classId',
    );
    if (!students.length) return out;
    const ids = students.map((s) => s._id);
    const sid = oid(schoolId);

    const [scoring, negTypes] = await Promise.all([
      settingsService.getEffectiveScoring(schoolId),
      BehaviorType.find({ kind: 'negative', schoolId: { $in: [null, sid] } })
        .select('_id')
        .lean(),
    ]);
    const [dayRows, negRows, unexRows] = await Promise.all([
      loadDayRows(schoolId, { from: prev.from, to: cur.to }, scoring, ids),
      negTypes.length
        ? Score.aggregate<{ _id: Types.ObjectId; n: number }>([
            {
              $match: {
                schoolId: sid,
                isDeleted: false,
                date: { $gte: cur.from, $lte: cur.to },
                studentId: { $in: ids },
                behaviorTypeId: { $in: negTypes.map((t) => t._id) },
              },
            },
            { $group: { _id: '$studentId', n: { $sum: 1 } } },
          ] as never)
        : Promise.resolve([]),
      // Kuniga bir marta: sababsiz yo'q yozuvi bor kun = shu kunning eng og'ir holati sababsiz yo'q
      AttendanceRecord.aggregate<{ _id: Types.ObjectId; days: number }>([
        {
          $match: {
            schoolId: sid,
            isDeleted: false,
            category: 'absent_unexcused',
            date: { $gte: cur.from, $lte: cur.to },
            studentId: { $in: ids },
          },
        },
        { $group: { _id: { s: '$studentId', d: '$date' } } },
        { $group: { _id: '$_id.s', days: { $sum: 1 } } },
      ] as never),
    ]);

    const win = new Map<string, { cur: number[]; prev: number[] }>();
    for (const r of dayRows) {
      const w = win.get(r.studentId) ?? { cur: [], prev: [] };
      (r.date >= cur.from ? w.cur : w.prev).push(r.day);
      win.set(r.studentId, w);
    }
    const neg = new Map(negRows.map((r) => [String(r._id), r.n]));
    const unex = new Map(unexRows.map((r) => [String(r._id), r.days]));

    const flagged: (AttentionStudent & { drop: number })[] = [];
    for (const s of students) {
      const id = String(s._id);
      const reasons: AttentionReason[] = [];
      let drop = 0;
      const w = win.get(id);
      if (w && w.cur.length >= A.minScoredDays && w.prev.length >= A.minScoredDays) {
        const from = round2(mean(w.prev)!);
        const to = round2(mean(w.cur)!);
        if (from - to >= A.dropPoints) {
          drop = round2(from - to);
          reasons.push({ type: 'drop', from, to, delta: round2(to - from) });
        }
      }
      if ((neg.get(id) ?? 0) >= A.negativeCount) {
        reasons.push({ type: 'negative', count: neg.get(id)! });
      }
      if ((unex.get(id) ?? 0) >= A.unexcusedDays) {
        reasons.push({ type: 'unexcused', days: unex.get(id)! });
      }
      if (reasons.length) {
        flagged.push({
          studentId: id,
          fullName: s.fullName,
          classId: String(s.classId),
          className: className.get(String(s.classId)) ?? '',
          reasons,
          drop,
        });
      }
    }
    flagged.sort(
      (a, b) =>
        b.reasons.length - a.reasons.length ||
        b.drop - a.drop ||
        a.fullName.localeCompare(b.fullName),
    );
    out.total = flagged.length;
    out.students = flagged.slice(0, A.limit).map((f) => ({
      studentId: f.studentId,
      fullName: f.fullName,
      classId: f.classId,
      className: f.className,
      reasons: f.reasons,
    }));
    return out;
  },

  /**
   * Oxirgi 30 kunlik kunlik davomat foizi. Har o'quvchi kunda bitta guruhga tushadi (dayStatus — dashboard
   * "Bugungi davomat" kartasi bilan bir xil). Foiz = (keldi + kechikdi) / davomat olingan o'quvchilar.
   * Faqat davomat olingan ish kunlari qaytadi.
   */
  async attendanceTrend(actor: AuthUser, schoolId: string) {
    const today = todayTashkent();
    const from = addDaysStr(today, -(ATTENDANCE_TREND_DAYS - 1));
    const out = {
      from,
      to: today,
      average: null as number | null,
      days: [] as AttendanceDay[],
    };
    const classes = await scopeClasses(actor, schoolId);
    if (!classes.length) return out;
    const students = await activeStudents(
      schoolId,
      classes.map((c) => c._id),
      '_id',
    );
    if (!students.length) return out;

    const settings = await getAttendanceSettings(schoolId);
    const rows = await AttendanceRecord.aggregate<{
      _id: { d: string; s: Types.ObjectId };
      cats: AttendanceCategory[];
    }>([
      {
        $match: {
          schoolId: oid(schoolId),
          isDeleted: false,
          date: { $gte: from, $lte: today },
          studentId: { $in: students.map((s) => s._id) },
        },
      },
      { $group: { _id: { d: '$date', s: '$studentId' }, cats: { $addToSet: '$category' } } },
    ] as never).allowDiskUse(true);

    const per = new Map<string, AttendanceDay>();
    for (const r of rows) {
      const date = r._id.d;
      if (!isWorkingDay(settings, date)) continue;
      const d = per.get(date) ?? {
        date,
        rate: 0,
        present: 0,
        late: 0,
        partial: 0,
        absentExcused: 0,
        absentUnexcused: 0,
        total: 0,
      };
      const st = dayStatus(r.cats);
      if (st === 'present') d.present++;
      else if (st === 'late') d.late++;
      else if (st === 'partial') d.partial++;
      else if (st === 'absent_excused') d.absentExcused++;
      else d.absentUnexcused++;
      d.total++;
      per.set(date, d);
    }
    out.days = [...per.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, rate: round2(((d.present + d.late) / d.total) * 100) }));
    out.average = out.days.length ? round2(mean(out.days.map((d) => d.rate))!) : null;
    return out;
  },
};

export type AttentionReason =
  | { type: 'drop'; from: number; to: number; delta: number }
  | { type: 'negative'; count: number }
  | { type: 'unexcused'; days: number };

export interface AttentionStudent {
  studentId: string;
  fullName: string;
  classId: string;
  className: string;
  reasons: AttentionReason[];
}

export interface AttendanceDay {
  date: string;
  rate: number;
  present: number;
  late: number;
  partial: number;
  absentExcused: number;
  absentUnexcused: number;
  total: number;
}
