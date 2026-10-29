import type { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { AcademicYear } from '../../models/AcademicYear';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { School } from '../../models/School';
import { Student } from '../../models/Student';
import { Subject, type SubjectDoc } from '../../models/Subject';
import { SubjectGrade } from '../../models/SubjectGrade';
import { User } from '../../models/User';
import { addDaysStr, todayTashkent } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
import { isId, uniq } from '../../utils/helpers';
import { photoUrl } from '../photos/photos.url';
import { settingsService } from '../settings/settings.service';
import { ATTENDANCE_KEY, type AttendanceSettings } from '../settings/attendance.settings';
import { JOURNAL_MAX_DAYS, type GridQuery } from './journal.schema';
import type {
  Absence,
  JournalCell,
  JournalGrid,
  JournalStudent,
  JournalSummaryRow,
} from './journal.types';

type Actor = Ctx['actor'];

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
const avgOf = (sum: number, n: number, digits = 1) => (n ? round(sum / n, digits) : null);

/** O'qituvchi bu sinfning sinf rahbarimi */
const isHomeroom = (cls: Pick<ClassDoc, 'homeroomTeacherId'>, actor: Actor) =>
  !!cls.homeroomTeacherId && String(cls.homeroomTeacherId) === actor.id;

/**
 * Jurnalni ko'rish huquqi (marshrutda rol/ruxsat tekshirilgan):
 * - superadmin / school_admin: maktabdagi istalgan sinf va fan;
 * - o'qituvchi: ClassSubject orqali o'ziga biriktirilgan sinf+fan, yoki o'zi sinf rahbari bo'lgan sinfning istalgan fani.
 */
async function assertCanView(actor: Actor, cls: ClassDoc, subjectId: Types.ObjectId) {
  if (actor.role !== 'teacher') return;
  if (isHomeroom(cls, actor)) return;
  const assigned = await ClassSubject.exists({
    classId: cls._id,
    subjectId,
    teacherId: actor.id,
  });
  if (!assigned) throw AppError.forbidden("Bu sinf jurnalini ko'rishga ruxsat yo'q");
}

export function enumerateWorkingDays(from: string, to: string, weekdays: number[]) {
  const out: { date: string; weekday: number }[] = [];
  for (let d = from; d <= to; d = addDaysStr(d, 1)) {
    const weekday = isoWeekday(d);
    if (weekdays.includes(weekday)) out.push({ date: d, weekday });
  }
  return out;
}

function checkRange(from: string, to: string) {
  if (from > to) {
    throw AppError.validation("Davr noto'g'ri", [
      { path: 'from', message: "'from' sanasi 'to' dan keyin bo'lmasligi kerak" },
    ]);
  }
  if (addDaysStr(from, JOURNAL_MAX_DAYS - 1) < to) {
    throw AppError.validation('Davr juda uzun', [
      { path: 'to', message: `Davr ${JOURNAL_MAX_DAYS} kundan oshmasligi kerak` },
    ]);
  }
}

async function loadClass(schoolId: string, classId: string): Promise<ClassDoc> {
  const cls = isId(classId) ? await ClassModel.findOne({ _id: classId, schoolId }) : null;
  if (!cls) throw AppError.notFound('Sinf topilmadi');
  return cls;
}

async function loadSubject(schoolId: string, subjectId: string): Promise<SubjectDoc> {
  const doc = isId(subjectId)
    ? await Subject.findOne({ _id: subjectId, $or: [{ schoolId: null }, { schoolId }] })
    : null;
  if (!doc) throw AppError.notFound('Fan topilmadi');
  return doc;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'uz');

interface SubjectOpt {
  id: string;
  name: string;
  assigned: boolean;
}

export const journalService = {
  /** Filtr uchun: foydalanuvchi ko'ra oladigan sinflar/fanlar, chorak davrlari, ish kunlari, bugun */
  async options(actor: Actor, schoolId: string) {
    const [year, attendance] = await Promise.all([
      AcademicYear.findOne({ schoolId, isActive: true }).lean(),
      settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
    ]);
    const base = {
      today: todayTashkent(),
      workingWeekdays: attendance.workingWeekdays,
      periods: (year?.periods ?? []).map((p) => ({
        id: String(p._id),
        name: p.name,
        from: ymd(p.startDate),
        to: ymd(p.endDate),
      })),
      mode: actor.role === 'teacher' ? ('assigned' as const) : ('all' as const),
    };
    if (!year) return { ...base, classes: [] };

    const classFilter: Record<string, unknown> = {
      schoolId,
      academicYearId: year._id,
      isArchived: false,
    };
    const csFilter = { schoolId, academicYearId: year._id };

    let mine: { classId: string; subjectId: string }[] = [];
    if (actor.role === 'teacher') {
      const own = await ClassSubject.find({ ...csFilter, teacherId: actor.id }).lean();
      mine = own.map((r) => ({ classId: String(r.classId), subjectId: String(r.subjectId) }));
      classFilter.$or = [
        { homeroomTeacherId: actor.id },
        { _id: { $in: uniq(mine.map((m) => m.classId)) } },
      ];
    }
    const classes = await ClassModel.find(classFilter)
      .select('name grade homeroomTeacherId')
      .lean();
    const [rows, subjects] = await Promise.all([
      ClassSubject.find({ ...csFilter, classId: { $in: classes.map((c) => c._id) } }).lean(),
      Subject.find({ $or: [{ schoolId: null }, { schoolId }], isActive: true })
        .select('name order')
        .lean(),
    ]);
    const subj = new Map(subjects.map((s) => [String(s._id), s.name]));
    const opt = (id: string): SubjectOpt => ({ id, name: subj.get(id) ?? '', assigned: true });

    const out = classes
      .map((c) => {
        const cid = String(c._id);
        const homeroom = !!c.homeroomTeacherId && String(c.homeroomTeacherId) === actor.id;
        const assignedIds = rows
          .filter((r) => String(r.classId) === cid)
          .map((r) => String(r.subjectId))
          .filter((i) => subj.has(i));
        let list: SubjectOpt[];
        if (actor.role === 'teacher') {
          const ids = homeroom
            ? assignedIds
            : mine
                .filter((m) => m.classId === cid && subj.has(m.subjectId))
                .map((m) => m.subjectId);
          list = ids.map(opt).sort(byName);
        } else {
          const set = new Set(assignedIds);
          const rest = subjects
            .filter((s) => !set.has(String(s._id)))
            .map((s) => ({ id: String(s._id), name: s.name, assigned: false }))
            .sort(byName);
          list = [...assignedIds.map(opt).sort(byName), ...rest];
        }
        return { id: cid, name: c.name, grade: c.grade, homeroom, subjects: list };
      })
      .sort((a, b) => a.grade - b.grade || a.name.localeCompare(b.name, 'uz'));
    return { ...base, classes: out };
  },

  async grid(actor: Actor, schoolId: string, q: GridQuery): Promise<JournalGrid> {
    checkRange(q.from, q.to);
    const cls = await loadClass(schoolId, q.classId);
    const subject = await loadSubject(schoolId, q.subjectId);
    await assertCanView(actor, cls, subject._id);

    const [school, attendance, assignment] = await Promise.all([
      School.findById(schoolId).select('name').lean(),
      settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
      ClassSubject.findOne({ classId: cls._id, subjectId: subject._id }).lean(),
    ]);
    const teacher = assignment
      ? await User.findById(assignment.teacherId).select('fullName').lean()
      : null;

    const dates = enumerateWorkingDays(q.from, q.to, attendance.workingWeekdays);
    const dateSet = new Set(dates.map((d) => d.date));

    // Joriy sinfdagi faol o'quvchilar
    const active = await Student.find({
      schoolId,
      classId: cls._id,
      isDeleted: false,
      status: 'active',
    })
      .select('fullName studentCode photoId')
      .lean();

    // Davrdagi baholar: shu sinf snapshotida yoki sinfning joriy o'quvchilariniki (bitta so'rov)
    const grades = await SubjectGrade.find({
      schoolId,
      subjectId: subject._id,
      isDeleted: false,
      date: { $gte: q.from, $lte: q.to },
      $or: [{ classId: cls._id }, { studentId: { $in: active.map((s) => s._id) } }],
    })
      .select('studentId value date')
      .lean();

    const activeSet = new Set(active.map((s) => String(s._id)));
    const extraIds = uniq(grades.map((g) => String(g.studentId)).filter((i) => !activeSet.has(i)));
    const extra = extraIds.length
      ? await Student.find({ _id: { $in: extraIds }, schoolId, isDeleted: false })
          .select('fullName studentCode photoId')
          .lean()
      : [];

    const students: JournalStudent[] = [
      ...active.map((s) => ({ s, transferred: false })),
      ...extra.map((s) => ({ s, transferred: true })),
    ]
      .map(({ s, transferred }) => ({
        id: String(s._id),
        fullName: s.fullName,
        studentCode: s.studentCode ?? null,
        photo: photoUrl(s.photoId),
        transferred,
      }))
      .sort(
        (a, b) =>
          Number(a.transferred) - Number(b.transferred) ||
          a.fullName.localeCompare(b.fullName, 'uz') ||
          a.id.localeCompare(b.id),
      );
    const studentIds = students.map((s) => s.id);

    // Davomat (faqat ko'rsatish uchun)
    const att = dates.length
      ? await AttendanceRecord.find({
          schoolId,
          studentId: { $in: studentIds },
          isDeleted: false,
          date: { $gte: q.from, $lte: q.to },
        })
          .select('studentId date category')
          .lean()
      : [];
    const attByDay = new Map<string, { total: number; unexcused: number; excused: number }>();
    for (const r of att) {
      if (!dateSet.has(r.date)) continue;
      const k = `${r.studentId}|${r.date}`;
      const e = attByDay.get(k) ?? { total: 0, unexcused: 0, excused: 0 };
      e.total++;
      if (r.category === 'absent_unexcused') e.unexcused++;
      else if (r.category === 'absent_excused') e.excused++;
      attByDay.set(k, e);
    }

    const cells: Record<string, Record<string, JournalCell>> = {};
    const cellOf = (sid: string, date: string): JournalCell => {
      cells[sid] ??= {};
      return (cells[sid][date] ??= {});
    };
    for (const g of grades) {
      if (!dateSet.has(g.date)) continue;
      const c = cellOf(String(g.studentId), g.date);
      c.grade = g.value;
      c.gradeId = String(g._id);
    }
    const perStudent: Record<string, JournalSummaryRow> = {};
    const sums: Record<string, number> = {};
    for (const sid of studentIds) {
      perStudent[sid] = { avg: null, count: 0, absentN: 0, absentB: 0 };
      sums[sid] = 0;
    }
    for (const [k, e] of attByDay) {
      const [sid, date] = k.split('|');
      const absent = e.unexcused + e.excused;
      if (!absent) continue;
      // Dars rejimida kun faqat HAMMA dars yozuvi yo'qlik bo'lsa yo'qlik hisoblanadi
      let absence: Absence;
      if (absent < e.total) absence = 'partial';
      else absence = e.unexcused ? 'N' : 'B';
      cellOf(sid, date).absence = absence;
      if (absence === 'N') perStudent[sid].absentN++;
      else if (absence === 'B') perStudent[sid].absentB++;
    }

    const dateAgg: Record<string, { sum: number; n: number }> = {};
    let totalSum = 0;
    let totalN = 0;
    for (const sid of Object.keys(cells)) {
      for (const [date, c] of Object.entries(cells[sid])) {
        if (c.grade === undefined) continue;
        sums[sid] += c.grade;
        perStudent[sid].count++;
        const a = (dateAgg[date] ??= { sum: 0, n: 0 });
        a.sum += c.grade;
        a.n++;
        totalSum += c.grade;
        totalN++;
      }
    }
    for (const sid of studentIds) perStudent[sid].avg = avgOf(sums[sid], perStudent[sid].count);
    const perDate: Record<string, { avg: number | null; count: number }> = {};
    for (const d of dates) {
      const a = dateAgg[d.date];
      perDate[d.date] = { avg: a ? avgOf(a.sum, a.n) : null, count: a?.n ?? 0 };
    }

    return {
      class: { id: cls.id as string, name: cls.name },
      subject: { id: subject.id as string, name: subject.name },
      teacher: teacher ? { id: String(teacher._id), fullName: teacher.fullName } : null,
      school: { id: schoolId, name: school?.name ?? '' },
      from: q.from,
      to: q.to,
      dates,
      students,
      cells,
      summary: { perStudent, perDate, classAvg: avgOf(totalSum, totalN, 2), classCount: totalN },
    };
  },
};
