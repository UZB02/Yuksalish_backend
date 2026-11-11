import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel } from '../../models/Class';
import { Subject } from '../../models/Subject';
import { User } from '../../models/User';
import { addDaysStr } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
import { uniq } from '../../utils/helpers';
import { overrideClassIdsOfTeacher } from '../timetable/overrides.loader';
import {
  loadVersionSlices,
  resolveClassesRange,
  type ResolvedLesson,
} from '../timetable/timetable.resolver';
import { dateLongUz, dayMonthUz, escapeHtml as esc, weekdayCapUz } from './telegram.format';
import { getTelegramSettings, nextWorkday } from './telegram.schedule';

/**
 * O'qituvchining bitta kundagi bitta dars qatori. `className`/`subjectName` — xom matn (render paytida escape
 * qilinadi); `suffix` — allaqachon HTML-xavfsiz belgi ("  ❌ bekor qilindi" va h.k.).
 */
export interface DayLine {
  date: string;
  lessonNo: number;
  className: string;
  subjectName: string;
  suffix: string;
  cancelled: boolean;
}

const idStr = (v: unknown) => String(v);

/**
 * O'qituvchilarning [from, to] davridagi darslari — o'qituvchi kunlik endpointi bilan bir xil aniqlash
 * (jadval versiyalari + almashtirishlar). `teacherIds = null` — maktabning hamma o'qituvchilari.
 * Qaytadi: o'qituvchi -> qatorlar (sana, soat bo'yicha tartiblangan).
 */
export async function loadTeacherLines(
  schoolId: string,
  teacherIds: string[] | null,
  from: string,
  to: string,
): Promise<Map<string, DayLine[]>> {
  const out = new Map<string, DayLine[]>();
  const year = await AcademicYear.findOne({ schoolId, isActive: true }).lean();
  if (!year) return out;
  const classes = await ClassModel.find({ schoolId, academicYearId: year._id, isArchived: false })
    .select('name')
    .lean();
  let classIds = classes.map((c) => idStr(c._id));
  if (teacherIds?.length === 1) {
    // Bitta o'qituvchi: faqat u bog'liq sinflar (jadval yoki almashtirish orqali)
    const id = teacherIds[0] as string;
    const [slices, ovClasses] = await Promise.all([
      loadVersionSlices(schoolId, { teacherId: id }, from, to),
      overrideClassIdsOfTeacher(schoolId, id, from, to),
    ]);
    const mine = new Set([...slices.map((s) => s.classId), ...ovClasses]);
    classIds = classIds.filter((c) => mine.has(c));
  }
  if (!classIds.length) return out;
  const want = teacherIds ? new Set(teacherIds) : null;
  const lessons = (await resolveClassesRange(schoolId, classIds, from, to)).filter(
    (l) => !want || want.has(l.teacherId) || (l.originalTeacherId && want.has(l.originalTeacherId)),
  );
  if (!lessons.length) return out;

  const [subjects, users] = await Promise.all([
    Subject.find({
      _id: {
        $in: uniq(
          lessons.flatMap((l) => [l.subjectId, l.originalSubjectId]).filter(Boolean) as string[],
        ),
      },
    })
      .select('name')
      .lean(),
    User.find({
      _id: {
        $in: uniq(
          lessons.flatMap((l) => [l.teacherId, l.originalTeacherId]).filter(Boolean) as string[],
        ),
      },
    })
      .select('fullName')
      .lean(),
  ]);
  const cName = new Map(classes.map((c) => [idStr(c._id), c.name]));
  const sName = new Map(subjects.map((s) => [idStr(s._id), s.name]));
  const uName = new Map(users.map((u) => [idStr(u._id), u.fullName]));

  const push = (
    teacherId: string,
    l: ResolvedLesson,
    subjectId: string,
    suffix: string,
    cancelled = false,
  ) => {
    const className = cName.get(l.classId) ?? '?';
    const list = out.get(teacherId) ?? [];
    list.push({
      date: l.date,
      lessonNo: l.lessonNo,
      className,
      subjectName: sName.get(subjectId) ?? '?',
      suffix,
      cancelled,
    });
    out.set(teacherId, list);
  };

  for (const l of lessons) {
    const orig = l.originalTeacherId;
    if (!want || want.has(l.teacherId)) {
      let suffix = '';
      if (l.cancelled) suffix = '  ❌ bekor qilindi';
      else if (l.overrideType === 'substitute' && orig) {
        suffix = `  🔁 ${esc(uName.get(orig) ?? '?')} o'rniga`;
      } else if (l.overrideType === 'replace') {
        const was = l.originalSubjectId ? sName.get(l.originalSubjectId) : null;
        suffix = was ? `  🔄 ${esc(was)} o'rniga` : '  🔄 dars o‘zgargan';
      } else if (l.overrideType === 'extra') suffix = "  ➕ qo'shimcha dars";
      push(l.teacherId, l, l.subjectId, suffix, !!l.cancelled);
    }
    // Asl o'qituvchi: darsiga boshqasi kiradi
    if (orig && orig !== l.teacherId && (!want || want.has(orig))) {
      push(
        orig,
        l,
        l.originalSubjectId ?? l.subjectId,
        `  🔁 ${esc(uName.get(l.teacherId) ?? '?')} kiradi`,
      );
    }
  }
  for (const list of out.values()) {
    list.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.lessonNo - b.lessonNo ||
        a.className.localeCompare(b.className, 'uz'),
    );
  }
  return out;
}

const lineText = (l: DayLine) => `${l.lessonNo}-soat ─ ${esc(l.className)}${l.suffix}`;

/** Bir kunlik qatorlarni fan bo'yicha guruhlaydi: guruhlar birinchi dars soati bo'yicha, ichida soat/sinf bo'yicha */
function groupBySubject(lines: DayLine[]): { subject: string; lines: DayLine[] }[] {
  const sorted = [...lines].sort(
    (a, b) => a.lessonNo - b.lessonNo || a.className.localeCompare(b.className, 'uz'),
  );
  const groups: { subject: string; lines: DayLine[] }[] = [];
  for (const l of sorted) {
    const g = groups.find((x) => x.subject === l.subjectName);
    if (g) g.lines.push(l);
    else groups.push({ subject: l.subjectName, lines: [l] });
  }
  return groups;
}

const subjectHeader = (name: string) => `📘 <b>${esc(name)}</b>`;

/** Fan guruhlari bloki: "📘 Fan" + qatorlar, guruhlar orasida bo'sh qator */
function groupedBlock(lines: DayLine[]): string[] {
  const out: string[] = [];
  for (const g of groupBySubject(lines)) {
    if (out.length) out.push('');
    out.push(subjectHeader(g.subject), ...g.lines.map(lineText));
  }
  return out;
}

/**
 * Bir kun xabari (ixcham ro'yxat): sana, darslar soni, fan bo'yicha guruhlangan darslar.
 * `title` — "Bugun" / "Ertaga" bo'lsa sanoq qatorida ko'rsatiladi. `greeting` — faqat ertalabki xabar uchun.
 */
export function dayMessage(
  title: string,
  date: string,
  lines: DayLine[],
  opts: { greeting?: boolean } = {},
): string {
  const active = lines.filter((l) => !l.cancelled).length;
  const cancelled = lines.length - active;
  const when = title === 'Bugun' || title === 'Ertaga' ? `${title} ` : '';
  const count =
    `📚 ${when}${active} ta dars` + (cancelled ? ` (${cancelled} tasi bekor qilingan)` : '');
  const parts = [
    `📅 ${weekdayCapUz(date)}, ${dayMonthUz(date)}`,
    count,
    '',
    ...groupedBlock(lines),
  ];
  if (opts.greeting) parts.push('', 'Yaxshi kun tilaymiz! 🌤');
  return parts.join('\n');
}

export type TeacherCommand = 'bugun' | 'ertaga' | 'hafta';
export const TEACHER_COMMANDS: TeacherCommand[] = ['bugun', 'ertaga', 'hafta'];

/** /bugun, /ertaga, /hafta javobi (HTML). `today` — Toshkent bugungi sanasi */
export async function teacherCommandReply(
  user: { id: string; schoolId: string | null },
  cmd: TeacherCommand,
  today: string,
): Promise<string> {
  if (!user.schoolId) return 'Hisobingiz maktabga bog‘lanmagan.';
  const schoolId = user.schoolId;
  const { workdays } = await getTelegramSettings(schoolId);

  if (cmd === 'hafta') {
    const monday = addDaysStr(today, -(isoWeekday(today) - 1));
    const last = Math.max(...workdays);
    const end = addDaysStr(monday, last - 1);
    const lines = (await loadTeacherLines(schoolId, [user.id], monday, end)).get(user.id) ?? [];
    const parts = [`🗓 <b>Hafta jadvali (${dayMonthUz(monday)} – ${dayMonthUz(end)})</b>`];
    // Hafta davomida bitta fan bo'lsa — fan bir marta tepada, kunlarda faqat soat va sinf
    const subjects = uniq(lines.map((l) => l.subjectName));
    const single = subjects.length === 1;
    if (single) parts.push('', subjectHeader(subjects[0] as string));
    for (let d = monday; d <= end; d = addDaysStr(d, 1)) {
      const wd = isoWeekday(d);
      if (!workdays.includes(wd)) continue;
      const day = lines.filter((l) => l.date === d);
      parts.push(
        '',
        `<b>${weekdayCapUz(d)}, ${dayMonthUz(d)}</b>${d === today ? ' · bugun' : ''}`,
        ...(!day.length
          ? ['dars yo‘q']
          : subjects.length > 1
            ? groupedBlock(day)
            : day.map(lineText)),
      );
    }
    return parts.join('\n');
  }

  let date = today;
  let intro = '';
  let title = 'Bugun';
  if (cmd === 'ertaga') {
    const tomorrow = addDaysStr(today, 1);
    if (workdays.includes(isoWeekday(tomorrow))) {
      date = tomorrow;
      title = 'Ertaga';
    } else {
      date = nextWorkday(today, workdays);
      title = 'Keyingi ish kuni';
      intro = `Ertaga dam olish kuni. Keyingi ish kuni — ${dateLongUz(date)}.\n\n`;
    }
  } else if (!workdays.includes(isoWeekday(today))) {
    return 'Bugun dam olish kuni.';
  }
  const lines = (await loadTeacherLines(schoolId, [user.id], date, date)).get(user.id) ?? [];
  if (!lines.length) {
    return `${intro}${cmd === 'bugun' ? 'Bugun' : dateLongUz(date)} uchun darsingiz yo‘q.`;
  }
  return intro + dayMessage(title, date, lines);
}
