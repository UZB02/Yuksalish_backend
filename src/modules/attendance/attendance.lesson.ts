import type { Ctx } from '../../core/context';
import type { ClassDoc } from '../../models/Class';
import { Subject } from '../../models/Subject';
import { User } from '../../models/User';
import { uniq } from '../../utils/helpers';
import type { AttendanceSettings } from '../settings/attendance.settings';
import { settingsService } from '../settings/settings.service';
import { TIMETABLE_KEY, type TimetableSettings } from '../settings/timetable.settings';
import { resolveClassDay, type ResolvedLesson } from '../timetable/timetable.resolver';
import { HARD_MAX_LESSON_NO } from './attendance.rules';

type Actor = Ctx['actor'];

export const getTimetableSettings = (schoolId: string) =>
  settingsService.getEffective<TimetableSettings>(TIMETABLE_KEY, schoolId);

/** Sinf + sana uchun dars jadvali konteksti (davomat nuqtai nazaridan) */
export interface SlotContext {
  /** Jadval davomatga ta'sir qiladimi (dars rejimi va enforcement != off) */
  enforced: boolean;
  tt: TimetableSettings;
  /** Sinfda shu sana uchun amaldagi jadval versiyasi bor */
  hasVersion: boolean;
  lessons: ResolvedLesson[];
  /** Ruxsat etilgan eng katta dars raqami (dars rejimi) */
  maxNo: number;
}

export async function loadSlotContext(
  schoolId: string,
  classId: string,
  date: string,
  att: AttendanceSettings,
): Promise<SlotContext> {
  const tt = await getTimetableSettings(schoolId);
  const enforced = att.mode === 'lesson' && tt.enforcement !== 'off';
  if (!enforced) {
    return { enforced, tt, hasVersion: false, lessons: [], maxNo: att.lessonsPerDay };
  }
  const day = await resolveClassDay(schoolId, classId, date);
  const highest = day.lessons.reduce((m, l) => Math.max(m, l.lessonNo), 0);
  return {
    enforced,
    tt,
    hasVersion: day.hasVersion,
    lessons: day.lessons,
    maxNo: Math.min(Math.max(att.lessonsPerDay, highest), HARD_MAX_LESSON_NO),
  };
}

/** Dars raqamiga mos dars (guruhsiz birinchi, bo'lmasa istalgani) */
export const pickLesson = (ctx: SlotContext, lessonNo: number): ResolvedLesson | null => {
  const at = ctx.lessons.filter((l) => l.lessonNo === lessonNo);
  return at.find((l) => l.groupKey === null) ?? at[0] ?? null;
};

export const isHomeroomOf = (cls: Pick<ClassDoc, 'homeroomTeacherId'>, actor: Actor) =>
  !!cls.homeroomTeacherId && String(cls.homeroomTeacherId) === actor.id;

export const isAdminActor = (actor: Actor) => actor.role !== 'teacher';

export interface TakeDecision {
  canTake: boolean;
  /** canTake=false bo'lsa foydalanuvchiga ko'rsatiladigan sabab */
  reason: string | null;
  /** Rad etish turi: 403 yoki 409 */
  denial: 'forbidden' | 'conflict' | null;
  /** Aniqlangan darsdan boshqa fan tanlash mumkin (admin/sinf rahbari, faqat suggest) */
  canOverride: boolean;
  /** Fan jadvaldan emas, qo'lda tanlanadi (jadvalsiz sinf yoki bo'sh slot) */
  manual: boolean;
}

const ok = (manual: boolean, canOverride: boolean): TakeDecision => ({
  canTake: true,
  reason: null,
  denial: null,
  canOverride,
  manual,
});
const deny = (denial: 'forbidden' | 'conflict', reason: string): TakeDecision => ({
  canTake: false,
  reason,
  denial,
  canOverride: false,
  manual: false,
});

/** Kim, qaysi darsga davomat ola oladi (reja 4.2) */
export function decideTake(
  actor: Actor,
  cls: Pick<ClassDoc, 'homeroomTeacherId'>,
  ctx: SlotContext,
  lesson: ResolvedLesson | null,
): TakeDecision {
  if (!ctx.enforced) return ok(true, true);
  const strict = ctx.tt.enforcement === 'strict';
  const admin = isAdminActor(actor);
  const homeroom = isHomeroomOf(cls, actor) && ctx.tt.homeroomCanTakeAnyLesson;
  const privileged = admin || homeroom;

  if (lesson) {
    if (lesson.cancelled) return deny('conflict', 'Bu dars bekor qilingan');
    const mine = lesson.teacherId === actor.id;
    if (!mine && !privileged) {
      return deny('forbidden', "Bu dars boshqa o'qituvchiga biriktirilgan");
    }
    return ok(false, !strict && privileged);
  }
  if (ctx.hasVersion) {
    if (strict) {
      return deny(
        'forbidden',
        "Bu soatda jadvalda dars yo'q. Davomat olish uchun avval qo'shimcha dars qo'shing",
      );
    }
    if (privileged) return ok(true, true);
    return deny('forbidden', "Bu soatda jadvalda dars yo'q");
  }
  if (strict && ctx.tt.strictNoTimetable === 'block') {
    return deny('forbidden', 'Bu sinf uchun dars jadvali kiritilmagan, davomat olinmaydi');
  }
  return ok(true, true);
}

/**
 * Sinfga shu sanada kirish: sinfga biriktirilgan o'qituvchi, sinf rahbari yoki
 * (jadval yoqilgan bo'lsa) shu kuni jadvalda darsi bor o'qituvchi — faqat shu sana uchun.
 */
export async function canAccessClassOn(
  actor: Actor,
  schoolId: string,
  cls: Pick<ClassDoc, '_id' | 'teacherIds' | 'homeroomTeacherId'>,
  date: string,
  att: AttendanceSettings,
): Promise<boolean> {
  if (actor.role !== 'teacher') return true;
  if (cls.teacherIds.some((t) => String(t) === actor.id) || isHomeroomOf(cls, actor)) return true;
  if (att.mode !== 'lesson') return false;
  const ctx = await loadSlotContext(schoolId, String(cls._id), date, att);
  return ctx.enforced && ctx.lessons.some((l) => l.teacherId === actor.id && !l.cancelled);
}

export interface LessonDto extends ResolvedLesson {
  subject: { id: string; name: string } | null;
  teacher: { id: string; fullName: string } | null;
  mine: boolean;
}

/** Dars nomlari (fan, o'qituvchi) bilan boyitiladi */
export async function enrichLessons(lessons: ResolvedLesson[], actor: Actor): Promise<LessonDto[]> {
  if (!lessons.length) return [];
  const [subjects, users] = await Promise.all([
    Subject.find({ _id: { $in: uniq(lessons.map((l) => l.subjectId)) } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: uniq(lessons.map((l) => l.teacherId)) } })
      .select('fullName')
      .lean(),
  ]);
  const sMap = new Map(subjects.map((s) => [String(s._id), s.name]));
  const uMap = new Map(users.map((u) => [String(u._id), u.fullName]));
  return lessons.map((l) => ({
    ...l,
    subject: { id: l.subjectId, name: sMap.get(l.subjectId) ?? '' },
    teacher: { id: l.teacherId, fullName: uMap.get(l.teacherId) ?? '' },
    mine: l.teacherId === actor.id,
  }));
}
