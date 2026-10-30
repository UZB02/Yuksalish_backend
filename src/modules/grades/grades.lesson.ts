import type { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ClassSubject } from '../../models/ClassSubject';
import { User } from '../../models/User';
import { resolveClassDay } from '../timetable/timetable.resolver';

type Actor = Ctx['actor'];

/** Fanning shu sanadagi darsi (dars jadvali bo'yicha, almashtirishlar hisobga olingan) */
export interface SubjectDayLesson {
  lessonNo: number;
  teacherId: string;
  cancelled: boolean;
  room: string | null;
}

export interface SubjectDay {
  /** Sinfda shu sana uchun amaldagi jadval versiyasi bor */
  hasTimetable: boolean;
  lessons: SubjectDayLesson[];
}

/** Sinf+fan+sana: fanning shu kundagi darslari (dars raqami bo'yicha, guruhlar birlashtiriladi) */
export async function subjectDay(
  schoolId: string,
  classId: string,
  subjectId: string,
  date: string,
): Promise<SubjectDay> {
  const day = await resolveClassDay(schoolId, classId, date);
  const byNo = new Map<number, SubjectDayLesson>();
  for (const l of day.lessons) {
    if (l.subjectId !== subjectId) continue;
    const prev = byNo.get(l.lessonNo);
    // Bir raqamda bir nechta guruh bo'lsa: bekor qilinmagani va guruhsizi ustun
    if (prev && (!prev.cancelled || l.cancelled)) continue;
    byNo.set(l.lessonNo, {
      lessonNo: l.lessonNo,
      teacherId: l.teacherId,
      cancelled: l.cancelled,
      room: l.room,
    });
  }
  return {
    hasTimetable: day.hasVersion,
    lessons: [...byNo.values()].sort((a, b) => a.lessonNo - b.lessonNo),
  };
}

const bad = (message: string) => AppError.validation(message, [{ path: 'lessonNo', message }]);

/**
 * Baholanadigan dars raqamini aniqlaydi va tekshiradi.
 * - fanning shu kunda darsi yo'q: faqat 0 (jadvalsiz / eski xatti-harakat);
 * - bitta dars bo'lsa sukut bo'yicha shu; bir nechta bo'lsa mijoz tanlashi shart;
 * - ko'rsatilgan raqam shu fanning shu kundagi darslaridan biri bo'lishi va bekor qilinmagan bo'lishi kerak.
 * `strict=false` (varaq): bir nechta darsda tanlanmagan bo'lsa null qaytaradi.
 */
export function pickLessonNo(
  day: SubjectDay,
  requested: number | undefined,
  strict: boolean,
): number | null {
  if (!day.lessons.length) {
    if (requested === undefined || requested === 0) return 0;
    throw bad("Bu fanning shu kunda darsi yo'q (dars raqami 0 bo'lishi kerak)");
  }
  if (requested === undefined) {
    if (day.lessons.length === 1) return pickLessonNo(day, day.lessons[0].lessonNo, strict);
    if (strict) throw bad('Shu kunda fanning bir nechta darsi bor: dars raqamini tanlang');
    return null;
  }
  const lesson = day.lessons.find((l) => l.lessonNo === requested);
  if (!lesson) throw bad("Bu raqamdagi dars shu fanning shu kundagi darslari orasida yo'q");
  if (lesson.cancelled) throw bad('Bu dars bekor qilingan');
  return requested;
}

/**
 * Baholash huquqi: ClassSubject orqali biriktirilgan o'qituvchi YOKI shu sana va dars raqamidagi
 * jadval (o'rinbosar) o'qituvchisi. Sinf rahbari fan baholash huquqini olmaydi.
 * Admin rollari (grades.create marshrutda tekshiriladi) cheklanmaydi.
 * `lessonNo=null` (dars hali tanlanmagan): shu kuni fanning istalgan darsi o'qituvchiga tegishli bo'lsa yetarli.
 */
export async function assertCanGradeOn(
  actor: Actor,
  classId: Types.ObjectId,
  subjectId: Types.ObjectId,
  day: SubjectDay,
  lessonNo: number | null,
) {
  if (actor.role !== 'teacher') return;
  const assigned = await ClassSubject.exists({ classId, subjectId, teacherId: actor.id });
  if (assigned) return;
  const mine = day.lessons.some(
    (l) => l.teacherId === actor.id && (lessonNo === null || l.lessonNo === lessonNo),
  );
  if (!mine) {
    throw AppError.forbidden(
      "Siz bu sinfda bu fan o'qituvchisi sifatida biriktirilmagansiz va bu dars sizniki emas",
    );
  }
}

/** Varaqdagi `lessons[]` javobi */
export async function lessonOptions(day: SubjectDay, actor: Actor) {
  const users = day.lessons.length
    ? await User.find({ _id: { $in: day.lessons.map((l) => l.teacherId) } })
        .select('fullName')
        .lean()
    : [];
  const names = new Map(users.map((u) => [String(u._id), u.fullName]));
  return day.lessons.map((l) => ({
    lessonNo: l.lessonNo,
    teacher: { id: l.teacherId, fullName: names.get(l.teacherId) ?? '' },
    cancelled: l.cancelled,
    room: l.room,
    mine: l.teacherId === actor.id,
  }));
}
