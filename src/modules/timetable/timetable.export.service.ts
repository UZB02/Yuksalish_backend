import { AppError } from '../../core/errors';
import type { Ctx } from '../../core/context';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel } from '../../models/Class';
import { School } from '../../models/School';
import { Subject } from '../../models/Subject';
import { TimetableVersion } from '../../models/TimetableVersion';
import { User } from '../../models/User';
import { todayTashkent } from '../../utils/clock';
import { isId, uniq } from '../../utils/helpers';
import {
  cellKey,
  shortName,
  validityText,
  type ExportCell,
  type TimetableDoc,
} from './timetable.export';
import {
  loadResolverSettings,
  loadVersionSlices,
  versionOn,
  type ResolverSettings,
  type SliceEntry,
  type VersionSlice,
} from './timetable.resolver';
import { canManage, canViewAll } from './timetable.service';

type Actor = Ctx['actor'];
const idStr = (v: unknown) => String(v);

interface Names {
  subjects: Map<string, string>;
  teachers: Map<string, string>;
}

/** Fan va o'qituvchi nomlari: ikkita so'rov (N+1 yo'q) */
async function loadNames(entries: SliceEntry[]): Promise<Names> {
  const [subjects, teachers] = await Promise.all([
    Subject.find({ _id: { $in: uniq(entries.map((e) => e.subjectId)) } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: uniq(entries.map((e) => e.teacherId)) } })
      .select('fullName')
      .lean(),
  ]);
  return {
    subjects: new Map(subjects.map((s) => [idStr(s._id), s.name])),
    teachers: new Map(teachers.map((t) => [idStr(t._id), t.fullName])),
  };
}

interface Common {
  schoolName: string;
  yearName: string | null;
  settings: ResolverSettings;
}

async function loadCommon(schoolId: string, yearId?: unknown): Promise<Common> {
  const [school, year, settings] = await Promise.all([
    School.findById(schoolId).select('name').lean(),
    yearId
      ? AcademicYear.findById(yearId).select('name').lean()
      : AcademicYear.findOne({ schoolId, isActive: true }).select('name').lean(),
    loadResolverSettings(schoolId),
  ]);
  return { schoolName: school?.name ?? '', yearName: year?.name ?? null, settings };
}

interface Lesson {
  entry: SliceEntry;
  cell: ExportCell;
  /** Teacher hujjatida tartiblash uchun */
  sort: string;
}

function buildDoc(
  kind: 'class' | 'teacher',
  title: string,
  common: Common,
  lessons: Lesson[],
  validity: string,
  draft: boolean,
): TimetableDoc {
  const days = new Set(common.settings.workingWeekdays);
  for (const l of lessons) days.add(l.entry.weekday);
  const used = Math.max(0, ...lessons.map((l) => l.entry.lessonNo));
  const cells: Record<string, ExportCell[]> = {};
  for (const l of [...lessons].sort((a, b) => a.sort.localeCompare(b.sort, 'uz'))) {
    const k = cellKey(l.entry.weekday, l.entry.lessonNo);
    (cells[k] ??= []).push(l.cell);
  }
  return {
    kind,
    title,
    schoolName: common.schoolName,
    yearName: common.yearName,
    validity,
    draft,
    weekdays: [...days].sort((a, b) => a - b),
    rows: Math.max(common.settings.lessonsPerDay, used, 1),
    cells,
    lessonCount: lessons.length,
  };
}

const classLessons = (entries: SliceEntry[], names: Names): Lesson[] =>
  entries.map((e) => ({
    entry: e,
    sort: names.teachers.get(e.teacherId) ?? '',
    cell: {
      subject: names.subjects.get(e.subjectId) ?? '?',
      detail: shortName(names.teachers.get(e.teacherId) ?? '?'),
      room: e.room,
    },
  }));

const teacherLessons = (list: { entry: SliceEntry; className: string }[], names: Names) =>
  list.map(({ entry: e, className }): Lesson => ({
    entry: e,
    sort: className,
    cell: { subject: names.subjects.get(e.subjectId) ?? '?', detail: className, room: e.room },
  }));

/** Bir nechta versiya uchun umumiy amal qilish oralig'i (kesishma) */
function overlap(versions: Pick<VersionSlice, 'validFrom' | 'validTo'>[]): string {
  if (!versions.length) return '';
  const from = versions.map((v) => v.validFrom).sort()[versions.length - 1];
  const tos = versions.map((v) => v.validTo).filter((x): x is string => !!x);
  const to = tos.length ? tos.sort()[0] : null;
  return validityText(from, to);
}

function assertView(actor: Actor) {
  if (!canViewAll(actor)) throw AppError.forbidden();
}

export interface ExportResult {
  docs: TimetableDoc[];
  /** Fayl nomi uchun asos (slug qilinmagan) */
  label: string;
  date: string;
  draft: boolean;
}

export const timetableExportService = {
  /** Sinfning haftalik jadvali: `date` da amal qiladigan versiya yoki aniq `versionId` (qoralama ham) */
  async classDoc(
    actor: Actor,
    schoolId: string,
    classId: string,
    opts: { date?: string; versionId?: string },
  ): Promise<ExportResult> {
    assertView(actor);
    const cls = isId(classId) ? await ClassModel.findOne({ _id: classId, schoolId }).lean() : null;
    if (!cls) throw AppError.notFound('Sinf topilmadi');
    const date = opts.date ?? todayTashkent();

    let entries: SliceEntry[];
    let validFrom: string;
    let validTo: string | null;
    let draft = false;
    if (opts.versionId) {
      const v = await TimetableVersion.findOne({
        _id: opts.versionId,
        schoolId,
        classId: cls._id,
      }).lean();
      // Qoralamalarni faqat timetable.manage ko'radi (getVersion bilan bir xil)
      if (!v || (v.status === 'draft' && !canManage(actor))) {
        throw AppError.notFound('Jadval versiyasi topilmadi');
      }
      draft = v.status === 'draft';
      validFrom = v.validFrom;
      validTo = v.validTo;
      entries = v.entries.map((e) => ({
        weekday: e.weekday,
        lessonNo: e.lessonNo,
        subjectId: idStr(e.subjectId),
        teacherId: idStr(e.teacherId),
        groupKey: e.groupKey ?? null,
        room: e.room ?? null,
      }));
    } else {
      const slices = await loadVersionSlices(schoolId, { classIds: [classId] }, date, date);
      const v = versionOn(slices, classId, date);
      if (!v) throw AppError.notFound('Bu sinf uchun jadval topilmadi');
      ({ validFrom, validTo, entries } = v);
    }

    const [common, names] = await Promise.all([
      loadCommon(schoolId, cls.academicYearId),
      loadNames(entries),
    ]);
    const doc = buildDoc(
      'class',
      cls.name,
      common,
      classLessons(entries, names),
      validityText(validFrom, validTo),
      draft,
    );
    return { docs: [doc], label: cls.name, date, draft };
  },

  /** O'qituvchining haftalik jadvali (barcha sinflar bo'yicha, `date` da amal qiladigan versiyalar) */
  async teacherDoc(
    actor: Actor,
    schoolId: string,
    teacherId: string,
    date?: string,
  ): Promise<ExportResult> {
    if (!canViewAll(actor) && actor.id !== teacherId) throw AppError.forbidden();
    const teacher = isId(teacherId)
      ? await User.findOne({ _id: teacherId, schoolId, role: 'teacher' }).select('fullName').lean()
      : null;
    if (!teacher) throw AppError.notFound("O'qituvchi topilmadi");
    const day = date ?? todayTashkent();

    const slices = await loadVersionSlices(schoolId, { teacherId }, day, day);
    const classIds = uniq(slices.map((s) => s.classId));
    const classes = classIds.length
      ? await ClassModel.find({ _id: { $in: classIds }, schoolId, isArchived: false })
          .select('name')
          .lean()
      : [];
    const mine: { entry: SliceEntry; className: string }[] = [];
    const versions: VersionSlice[] = [];
    for (const c of classes) {
      const v = versionOn(slices, idStr(c._id), day);
      if (!v) continue;
      const own = v.entries.filter((e) => e.teacherId === teacherId);
      if (!own.length) continue;
      versions.push(v);
      own.forEach((entry) => mine.push({ entry, className: c.name }));
    }
    if (!mine.length) throw AppError.notFound("O'qituvchining bu sana uchun darslari topilmadi");

    const [common, names] = await Promise.all([
      loadCommon(schoolId),
      loadNames(mine.map((m) => m.entry)),
    ]);
    const doc = buildDoc(
      'teacher',
      teacher.fullName,
      common,
      teacherLessons(mine, names),
      overlap(versions),
      false,
    );
    return {
      docs: [doc],
      label: shortName(teacher.fullName) || teacher.fullName,
      date: day,
      draft: false,
    };
  },

  /** Butun maktab: faol o'quv yilidagi sinflar yoki o'qituvchilar (bir nechta so'rov, N+1 yo'q) */
  async schoolDocs(
    actor: Actor,
    schoolId: string,
    kind: 'classes' | 'teachers',
    date?: string,
  ): Promise<ExportResult> {
    assertView(actor);
    const day = date ?? todayTashkent();
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id').lean();
    const classes = year
      ? await ClassModel.find({ schoolId, academicYearId: year._id, isArchived: false })
          .select('name grade')
          .lean()
      : [];
    classes.sort((a, b) => a.grade - b.grade || a.name.localeCompare(b.name, 'uz'));
    const slices = classes.length
      ? await loadVersionSlices(schoolId, { classIds: classes.map((c) => c._id) }, day, day)
      : [];
    const withVersion = classes
      .map((c) => ({ c, v: versionOn(slices, idStr(c._id), day) }))
      .filter(
        (x): x is { c: (typeof classes)[number]; v: VersionSlice } =>
          !!x.v && x.v.entries.length > 0,
      );
    if (!withVersion.length) throw AppError.notFound('Bu sana uchun dars jadvali topilmadi');

    const [common, names] = await Promise.all([
      loadCommon(schoolId, year?._id),
      loadNames(withVersion.flatMap((x) => x.v.entries)),
    ]);

    if (kind === 'classes') {
      const docs = withVersion.map(({ c, v }) =>
        buildDoc(
          'class',
          c.name,
          common,
          classLessons(v.entries, names),
          validityText(v.validFrom, v.validTo),
          false,
        ),
      );
      return { docs, label: 'maktab-sinflar', date: day, draft: false };
    }

    const byTeacher = new Map<string, { entry: SliceEntry; className: string }[]>();
    const spans = new Map<string, VersionSlice[]>();
    for (const { c, v } of withVersion) {
      for (const entry of v.entries) {
        const list = byTeacher.get(entry.teacherId) ?? [];
        list.push({ entry, className: c.name });
        byTeacher.set(entry.teacherId, list);
        const vs = spans.get(entry.teacherId) ?? [];
        if (!vs.includes(v)) vs.push(v);
        spans.set(entry.teacherId, vs);
      }
    }
    const docs = [...byTeacher.entries()]
      .map(([tid, list]) => ({ name: names.teachers.get(tid) ?? '?', tid, list }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uz'))
      .map(({ name, tid, list }) =>
        buildDoc(
          'teacher',
          name,
          common,
          teacherLessons(list, names),
          overlap(spans.get(tid) ?? []),
          false,
        ),
      );
    return { docs, label: 'maktab-oqituvchilar', date: day, draft: false };
  },
};
