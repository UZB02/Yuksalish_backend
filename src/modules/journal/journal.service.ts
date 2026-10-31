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
import {
  loadVersionSlices,
  subjectLessonsInRange,
  versionOn,
} from '../timetable/timetable.resolver';
import { JOURNAL_MAX_DAYS, type GridQuery } from './journal.schema';
import type {
  Absence,
  JournalCell,
  JournalColumn,
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
  /** Fanning shu sinfdagi o'qituvchilari (jurnal juftligi); biriktirilmagan fan uchun bo'sh */
  teachers: { id: string; fullName: string }[];
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
    const teacherNames = new Map(
      (
        await User.find({ _id: { $in: uniq(rows.map((r) => String(r.teacherId))) } })
          .select('fullName')
          .lean()
      ).map((u) => [String(u._id), u.fullName]),
    );
    const teachersOf = (cid: string, sid: string, only?: string) =>
      uniq(
        rows
          .filter(
            (r) =>
              String(r.classId) === cid &&
              String(r.subjectId) === sid &&
              (!only || String(r.teacherId) === only),
          )
          .map((r) => String(r.teacherId)),
      )
        .map((id) => ({ id, fullName: teacherNames.get(id) ?? '' }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'uz'));

    const out = classes
      .map((c) => {
        const cid = String(c._id);
        const homeroom = !!c.homeroomTeacherId && String(c.homeroomTeacherId) === actor.id;
        const assignedIds = uniq(
          rows
            .filter((r) => String(r.classId) === cid)
            .map((r) => String(r.subjectId))
            .filter((i) => subj.has(i)),
        );
        const opt = (id: string, only?: string): SubjectOpt => ({
          id,
          name: subj.get(id) ?? '',
          assigned: true,
          teachers: teachersOf(cid, id, only),
        });
        let list: SubjectOpt[];
        if (actor.role === 'teacher') {
          // Sinf rahbari barcha juftliklarni, oddiy o'qituvchi faqat o'z juftligini ko'radi
          list = homeroom
            ? assignedIds.map((i) => opt(i)).sort(byName)
            : uniq(
                mine
                  .filter((m) => m.classId === cid && subj.has(m.subjectId))
                  .map((m) => m.subjectId),
              )
                .map((i) => opt(i, actor.id))
                .sort(byName);
        } else {
          const set = new Set(assignedIds);
          const rest = subjects
            .filter((s) => !set.has(String(s._id)))
            .map((s) => ({ id: String(s._id), name: s.name, assigned: false, teachers: [] }))
            .sort(byName);
          list = [...assignedIds.map((i) => opt(i)).sort(byName), ...rest];
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

    const [school, attendance, assignments] = await Promise.all([
      School.findById(schoolId).select('name').lean(),
      settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
      ClassSubject.find({ classId: cls._id, subjectId: subject._id }).lean(),
    ]);
    const assignedIds = uniq(assignments.map((a) => String(a.teacherId)));
    const teacherUsers = assignedIds.length
      ? await User.find({ _id: { $in: assignedIds } })
          .select('fullName')
          .lean()
      : [];
    const teachers = teacherUsers
      .map((t) => ({ id: String(t._id), fullName: t.fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'uz'));

    // Jurnal juftligi (fan, o'qituvchi): fanning bir nechta o'qituvchisi bo'lsagina ustun/baho/davomat
    // o'sha o'qituvchi bo'yicha ajratiladi; bitta o'qituvchi bo'lsa avvalgidek.
    const multi = assignedIds.length > 1;
    let pairId: string | null = null;
    if (q.teacherId) {
      if (actor.role === 'teacher' && !isHomeroom(cls, actor) && q.teacherId !== actor.id) {
        throw AppError.forbidden("Boshqa o'qituvchining jurnalini ko'rishga ruxsat yo'q");
      }
      if (multi && !assignedIds.includes(q.teacherId)) {
        throw AppError.validation("O'qituvchi noto'g'ri", [
          { path: 'teacherId', message: "Bu o'qituvchi shu sinfda bu fanga biriktirilmagan" },
        ]);
      }
      pairId = q.teacherId;
    } else if (multi && actor.role === 'teacher' && assignedIds.includes(actor.id)) {
      pairId = actor.id;
    }
    const filterTid = multi ? pairId : null;
    const teacherDoc = pairId
      ? (teachers.find((t) => t.id === pairId) ??
        (await User.findById(pairId)
          .select('fullName')
          .lean()
          .then((u) => (u ? { id: String(u._id), fullName: u.fullName } : null))))
      : multi
        ? null
        : (teachers[0] ?? null);
    const teacher = teacherDoc ? { _id: teacherDoc.id, fullName: teacherDoc.fullName } : null;
    // Boshqa (bir kursdagi) o'qituvchilar: ularning baholari bu jurnalga tushmaydi
    const rivals = new Set(assignedIds.filter((i) => i !== filterTid));

    const workDays = enumerateWorkingDays(q.from, q.to, attendance.workingWeekdays);

    // Jadval: shu fanning davrdagi darslari (bekor qilinganlari ham) va jadval qamragan kunlar
    const subjectKey = String(subject._id);
    const [allLessons, slices] = await Promise.all([
      subjectLessonsInRange(schoolId, String(cls._id), subjectKey, q.from, q.to),
      loadVersionSlices(schoolId, { classIds: [String(cls._id)] }, q.from, q.to),
    ]);
    // Juftlik jurnali: shu o'qituvchining darslari (o'rinbosar qo'yilgan asl darsi ham o'zinikida qoladi)
    const lessons = filterTid
      ? allLessons.filter((l) => l.teacherId === filterTid || l.originalTeacherId === filterTid)
      : allLessons;
    const colMap = new Map<string, JournalColumn>();
    const addCol = (c: JournalColumn) => {
      if (!colMap.has(c.key)) colMap.set(c.key, c);
    };
    const keyOf = (date: string, lessonNo: number) => (lessonNo > 0 ? `${date}#${lessonNo}` : date);
    for (const l of lessons) {
      addCol({
        key: keyOf(l.date, l.lessonNo),
        date: l.date,
        weekday: l.weekday,
        lessonNo: l.lessonNo,
        source: 'timetable',
        cancelled: l.cancelled,
      });
    }
    for (const d of workDays) {
      if (versionOn(slices, String(cls._id), d.date)) continue; // jadval kuni: ustunlar darslardan
      addCol({
        key: d.date,
        date: d.date,
        weekday: d.weekday,
        lessonNo: 0,
        source: 'workday',
        cancelled: false,
      });
    }

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
    const allGrades = await SubjectGrade.find({
      schoolId,
      subjectId: subject._id,
      isDeleted: false,
      date: { $gte: q.from, $lte: q.to },
      $or: [{ classId: cls._id }, { studentId: { $in: active.map((s) => s._id) } }],
    })
      .select('studentId value date lessonNo teacherId')
      .lean();
    // Juftlik jurnali: shu o'qituvchi qo'ygan baholar; o'rinbosar/admin qo'ygan baho esa
    // (boshqa kurs o'qituvchisi bo'lmasa) shu o'qituvchining dars ustuniga mos kelsa
    const lessonKeys = new Set(lessons.map((l) => keyOf(l.date, l.lessonNo)));
    const grades = filterTid
      ? allGrades.filter((g) => {
          const tid = String(g.teacherId);
          if (tid === filterTid) return true;
          if (rivals.has(tid)) return false;
          return (g.lessonNo ?? 0) > 0 && lessonKeys.has(keyOf(g.date, g.lessonNo ?? 0));
        })
      : allGrades;
    // Hech bir ustunga tushmagan baho yo'qolmasin: record ustuni
    for (const g of grades) {
      const lessonNo = g.lessonNo ?? 0;
      addCol({
        key: keyOf(g.date, lessonNo),
        date: g.date,
        weekday: isoWeekday(g.date),
        lessonNo,
        source: 'record',
        cancelled: false,
      });
    }
    const columns = [...colMap.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.lessonNo - b.lessonNo,
    );

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

    // Davomat (faqat ko'rsatish uchun). Qoidalar:
    // - kunlik rejim yozuvi (lessonNo 0): shu kunning barcha ustunlarida ko'rinadi;
    // - dars ustuni (lessonNo n): shu fan uchun shu raqamdagi dars yozuvi;
    //   shu kunda shu fanning hech bir dars yozuvi bo'lmasa - eski (fansiz) dars yozuvlari kun darajasida;
    // - ish kuni ustuni (lessonNo 0): shu fanning kundagi barcha dars yozuvlari (yoki eski fansiz yozuvlar);
    // - boshqa fan uchun dars yozuvi: e'tiborga olinmaydi.
    const colDates = new Set(columns.map((c) => c.date));
    const att = columns.length
      ? await AttendanceRecord.find({
          schoolId,
          studentId: { $in: studentIds },
          isDeleted: false,
          date: { $gte: q.from, $lte: q.to },
        })
          .select('studentId date category lessonNo subjectId teacherId')
          .lean()
      : [];
    type Tally = { total: number; unexcused: number; excused: number };
    const tallyOf = (): Tally => ({ total: 0, unexcused: 0, excused: 0 });
    const add = (e: Tally, cat: string) => {
      e.total++;
      if (cat === 'absent_unexcused') e.unexcused++;
      else if (cat === 'absent_excused') e.excused++;
    };
    const merge = (a: Tally, b: Tally): Tally => ({
      total: a.total + b.total,
      unexcused: a.unexcused + b.unexcused,
      excused: a.excused + b.excused,
    });
    interface Bucket {
      daily: Tally;
      ownAll: Tally;
      ownByNo: Map<number, Tally>;
      legacy: Tally;
    }
    const buckets = new Map<string, Bucket>();
    for (const r of att) {
      if (!colDates.has(r.date)) continue;
      // Juftlik jurnali: boshqa o'qituvchi darsidagi davomat bu jurnalga tushmaydi
      if (filterTid && r.teacherId && String(r.teacherId) !== filterTid && r.subjectId) continue;
      const k = `${r.studentId}|${r.date}`;
      let b = buckets.get(k);
      if (!b) {
        b = { daily: tallyOf(), ownAll: tallyOf(), ownByNo: new Map(), legacy: tallyOf() };
        buckets.set(k, b);
      }
      if (r.lessonNo === 0) add(b.daily, r.category);
      else if (!r.subjectId) add(b.legacy, r.category);
      else if (String(r.subjectId) === subjectKey) {
        add(b.ownAll, r.category);
        const t = b.ownByNo.get(r.lessonNo) ?? tallyOf();
        add(t, r.category);
        b.ownByNo.set(r.lessonNo, t);
      }
    }
    const tallyFor = (b: Bucket, col: JournalColumn): Tally => {
      if (col.lessonNo === 0) return merge(b.daily, b.ownAll.total ? b.ownAll : b.legacy);
      if (b.ownAll.total) return merge(b.daily, b.ownByNo.get(col.lessonNo) ?? tallyOf());
      return merge(b.daily, b.legacy);
    };

    const cells: Record<string, Record<string, JournalCell>> = {};
    const cellOf = (sid: string, key: string): JournalCell => {
      cells[sid] ??= {};
      return (cells[sid][key] ??= {});
    };
    for (const g of grades) {
      const c = cellOf(String(g.studentId), keyOf(g.date, g.lessonNo ?? 0));
      c.grade = g.value;
      c.gradeId = String(g._id);
    }
    const perStudent: Record<string, JournalSummaryRow> = {};
    const sums: Record<string, number> = {};
    for (const sid of studentIds) {
      perStudent[sid] = { avg: null, count: 0, absentN: 0, absentB: 0 };
      sums[sid] = 0;
    }
    for (const [k, b] of buckets) {
      const [sid, date] = k.split('|');
      for (const col of columns) {
        if (col.date !== date) continue;
        const e = tallyFor(b, col);
        const absent = e.unexcused + e.excused;
        if (!absent) continue;
        // Faqat HAMMA yozuv yo'qlik bo'lsa yo'qlik hisoblanadi, aks holda "qisman"
        let absence: Absence;
        if (absent < e.total) absence = 'partial';
        else absence = e.unexcused ? 'N' : 'B';
        cellOf(sid, col.key).absence = absence;
        if (absence === 'N') perStudent[sid].absentN++;
        else if (absence === 'B') perStudent[sid].absentB++;
      }
    }

    const colAgg: Record<string, { sum: number; n: number }> = {};
    let totalSum = 0;
    let totalN = 0;
    for (const sid of Object.keys(cells)) {
      for (const [key, c] of Object.entries(cells[sid])) {
        if (c.grade === undefined) continue;
        sums[sid] += c.grade;
        perStudent[sid].count++;
        const a = (colAgg[key] ??= { sum: 0, n: 0 });
        a.sum += c.grade;
        a.n++;
        totalSum += c.grade;
        totalN++;
      }
    }
    for (const sid of studentIds) perStudent[sid].avg = avgOf(sums[sid], perStudent[sid].count);
    const perColumn: Record<string, { avg: number | null; count: number }> = {};
    for (const c of columns) {
      const a = colAgg[c.key];
      perColumn[c.key] = { avg: a ? avgOf(a.sum, a.n) : null, count: a?.n ?? 0 };
    }

    return {
      class: { id: cls.id as string, name: cls.name },
      subject: { id: subject.id as string, name: subject.name },
      teacher: teacher ? { id: String(teacher._id), fullName: teacher.fullName } : null,
      teachers,
      school: { id: schoolId, name: school?.name ?? '' },
      from: q.from,
      to: q.to,
      columns,
      students,
      cells,
      summary: { perStudent, perColumn, classAvg: avgOf(totalSum, totalN, 2), classCount: totalN },
    };
  },
};
