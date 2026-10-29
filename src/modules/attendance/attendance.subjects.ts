import type { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import type { ClassDoc } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { Subject } from '../../models/Subject';
import { isId } from '../../utils/helpers';

type Actor = Ctx['actor'];

export interface LessonSubjectOption {
  id: string;
  name: string;
  /** Foydalanuvchi shu fanni bu sinfda o'zi o'tadi (ClassSubject) */
  assigned: boolean;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'uz');

const isHomeroom = (cls: Pick<ClassDoc, 'homeroomTeacherId'>, actor: Actor) =>
  !!cls.homeroomTeacherId && String(cls.homeroomTeacherId) === actor.id;

/**
 * Dars davomati uchun tanlanadigan fanlar.
 * - Sinfga fanlar biriktirilgan bo'lsa (ClassSubject): admin va sinf rahbari — shu fanlarning hammasi,
 *   oddiy o'qituvchi — faqat o'ziga biriktirilganlari.
 * - Sinfga hech qanday fan biriktirilmagan bo'lsa: biriktirish ma'lumoti yo'q, shuning uchun
 *   maktabning barcha faol fanlari ruxsat etiladi (o'qituvchi uchun ham).
 * `keepIds` — nofaol bo'lib qolgan, lekin shu dars uchun allaqachon ishlatilgan fan ham ro'yxatda qoladi.
 */
export async function lessonSubjectOptions(
  actor: Actor,
  schoolId: string,
  cls: Pick<ClassDoc, '_id' | 'homeroomTeacherId'>,
  keepIds: string[] = [],
): Promise<LessonSubjectOption[]> {
  const [rows, subjects] = await Promise.all([
    ClassSubject.find({ classId: cls._id }).select('subjectId teacherId').lean(),
    Subject.find({ $or: [{ schoolId: null }, { schoolId }] })
      .select('name isActive')
      .lean(),
  ]);
  const usable = (s: { _id: unknown; isActive: boolean }) =>
    s.isActive || keepIds.includes(String(s._id));
  const byId = new Map(subjects.filter(usable).map((s) => [String(s._id), s.name]));
  const mineIds = new Set(
    rows.filter((r) => String(r.teacherId) === actor.id).map((r) => String(r.subjectId)),
  );

  let ids: string[];
  if (!rows.length) ids = [...byId.keys()];
  else if (actor.role === 'teacher' && !isHomeroom(cls, actor)) ids = [...mineIds];
  else ids = rows.map((r) => String(r.subjectId));

  return [...new Set(ids)]
    .filter((i) => byId.has(i))
    .map((i) => ({ id: i, name: byId.get(i) as string, assigned: mineIds.has(i) }))
    .sort(byName);
}

/**
 * Dars uchun fanni tekshiradi: maktabga tegishli, faol (yoki shu dars uchun allaqachon ishlatilgan),
 * sinfga biriktirilgan va (o'qituvchi uchun) shu fanga biriktirilgan yoki sinf rahbari.
 * Qaytaradi: fan nomi.
 */
export async function assertLessonSubject(
  actor: Actor,
  schoolId: string,
  cls: Pick<ClassDoc, '_id' | 'homeroomTeacherId'>,
  subjectId: string,
  keepIds: string[] = [],
): Promise<string> {
  const subject = isId(subjectId)
    ? await Subject.findOne({ _id: subjectId, $or: [{ schoolId: null }, { schoolId }] })
        .select('name isActive')
        .lean()
    : null;
  if (!subject) {
    throw AppError.validation("Ma'lumotlar noto'g'ri", [
      { path: 'subjectId', message: 'Fan topilmadi' },
    ]);
  }
  if (!subject.isActive && !keepIds.includes(subjectId)) {
    throw AppError.validation("Ma'lumotlar noto'g'ri", [
      { path: 'subjectId', message: 'Fan faol emas' },
    ]);
  }
  const rows = await ClassSubject.find({ classId: cls._id }).select('subjectId teacherId').lean();
  if (rows.length) {
    const row = rows.find((r) => String(r.subjectId) === subjectId);
    if (!row) {
      throw AppError.validation("Ma'lumotlar noto'g'ri", [
        { path: 'subjectId', message: 'Bu fan sinfga biriktirilmagan' },
      ]);
    }
    if (actor.role === 'teacher' && !isHomeroom(cls, actor) && String(row.teacherId) !== actor.id) {
      throw AppError.forbidden("Bu fandan dars uchun davomat olishga ruxsat yo'q");
    }
  }
  return subject.name;
}

/**
 * Bitta dars (sinf + sana + dars raqami) yozuvlari boshqa fan uchun olingan bo'lsa 409.
 * `except` — o'zgartirilayotgan yozuvning o'zi (PATCH) hisobga olinmaydi.
 */
export async function assertLessonSubjectFree(
  schoolId: string,
  classId: Types.ObjectId,
  date: string,
  lessonNo: number,
  subjectId: string,
  except?: Types.ObjectId,
) {
  const other = await AttendanceRecord.findOne({
    schoolId,
    classId,
    date,
    lessonNo,
    isDeleted: false,
    subjectId: { $nin: [null, subjectId] },
    ...(except ? { _id: { $ne: except } } : {}),
  })
    .select('subjectId')
    .lean();
  if (!other?.subjectId) return;
  const name = (await Subject.findById(other.subjectId).select('name').lean())?.name ?? '';
  throw AppError.conflict(`Bu dars allaqachon ${name} uchun olingan`);
}
