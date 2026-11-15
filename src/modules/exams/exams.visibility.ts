import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { Question } from '../../models/Question';
import type { ExamScope } from './exams.scope';

type Actor = Ctx['actor'];
const oid = (s: string) => new Types.ObjectId(s);

/**
 * Menga ulashilgan savollar shartlari (arxivlanmagan): 'subject' - shu fanni o'qitadigan o'qituvchilarga
 * (ma'muriyat uchun barcha fan), 'users' - ro'yxatga kiritilgan o'qituvchilarga.
 * Hamma id lar ObjectId (aggregate ham ishlashi uchun).
 */
export function sharedWithClauses(actor: Actor, scope: ExamScope): Record<string, unknown>[] {
  const bySubject: Record<string, unknown> = {
    'sharing.mode': 'subject',
    status: { $ne: 'archived' },
  };
  if (!scope.all) bySubject.subjectId = { $in: scope.subjectIds.map(oid) };
  return [
    bySubject,
    { 'sharing.mode': 'users', 'sharing.userIds': oid(actor.id), status: { $ne: 'archived' } },
  ];
}

/** Foydalanuvchi ko'ra oladigan savollar sharti (maktab + o'chirilmagan + doira) */
export function visibilityFilter(
  actor: Actor,
  schoolId: string,
  scope: ExamScope,
): Record<string, unknown>[] {
  const and: Record<string, unknown>[] = [
    { schoolId: oid(schoolId) },
    { isDeleted: { $ne: true } },
  ];
  if (!scope.all) {
    // O'qituvchi: o'z fanlari doirasidagi o'z savollari + o'ziga ULASHILGAN savollar (muallif ruxsati bilan).
    // Ulashilmagan (private) boshqa muallif savoli: ko'rinmaydi (404).
    and.push({
      $or: [
        { authorId: oid(actor.id), subjectId: { $in: scope.subjectIds.map(oid) } },
        ...sharedWithClauses(actor, scope),
      ],
    });
  }
  return and;
}

/** Fan yoki mavzu bo'yicha ko'rinadigan savollar soni: { id -> son } */
export async function visibleCounts(
  actor: Actor,
  schoolId: string,
  scope: ExamScope,
  by: 'subjectId' | 'topicId',
  extra: Record<string, unknown>[] = [],
): Promise<Map<string, number>> {
  const rows = await Question.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { $and: [...visibilityFilter(actor, schoolId, scope), ...extra] } },
    { $group: { _id: `$${by}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}
