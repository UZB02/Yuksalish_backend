import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { objectIdSchema } from '../../core/validators';
import { ExamTopic, type ExamTopicDoc } from '../../models/ExamTopic';
import { Question } from '../../models/Question';
import { Subject } from '../../models/Subject';
import { User } from '../../models/User';
import { isDuplicateKeyError, isId, uniq } from '../../utils/helpers';
import { cleanText, nameKeyOf } from '../../utils/text';
import { auditService } from '../audit/audit.service';
import { resolveExamScope, type ExamScope } from './exams.scope';
import { visibleCounts } from './exams.visibility';

type Actor = Ctx['actor'];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
export const topicBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Mavzu nomi bo'sh bo'lmasligi kerak")
      .max(150, 'Mavzu nomi 150 belgidan oshmasligi kerak')
      .refine((v) => !CONTROL.test(v), "Nomda boshqaruv belgilari bo'lmasligi kerak"),
    description: z
      .string()
      .trim()
      .max(500, 'Tavsif 500 belgidan oshmasligi kerak')
      .refine((v) => !CONTROL.test(v), "Tavsifda boshqaruv belgilari bo'lmasligi kerak")
      .optional(),
  })
  .strict();
export const topicPatchBody = topicBody.partial().strict();
export const reorderBody = z
  .object({ subjectId: objectIdSchema, ids: z.array(objectIdSchema).min(1).max(500) })
  .strict();

const notFound = () => AppError.notFound('Mavzu topilmadi');
const dupName = () =>
  AppError.conflict('Bunday nomli mavzu bu fanda mavjud', [
    { path: 'name', message: 'Bu nom band' },
  ]);

/** Ma'muriyat hamma fanni, o'qituvchi faqat o'z fanlarini ishlata oladi */
export function assertSubjectInScope(scope: ExamScope, subjectId: string) {
  if (!scope.all && !scope.subjectIds.includes(subjectId)) {
    throw AppError.forbidden('Bu fan sizga biriktirilmagan');
  }
}

/**
 * Savol yaratish/ko'chirish nishoni: mavzu shu maktabda mavjud bo'lishi (aks holda 400), o'qituvchi uchun
 * mavzu fani o'zi o'qitadigan fan bo'lishi (aks holda 403) shart.
 */
export async function loadTargetTopic(
  schoolId: string,
  scope: ExamScope,
  id: string,
): Promise<ExamTopicDoc> {
  const t = isId(id)
    ? await ExamTopic.findOne({ _id: id, schoolId, isDeleted: { $ne: true } })
    : null;
  if (!t) {
    throw AppError.validation('Mavzu topilmadi', [{ path: 'topicId', message: 'Mavzu topilmadi' }]);
  }
  assertSubjectInScope(scope, String(t.subjectId));
  return t;
}

/** Mavzuni yuklaydi: boshqa maktab, o'chirilgan yoki o'qituvchi doirasidan tashqari fan: 404 */
export async function loadTopic(
  schoolId: string,
  scope: ExamScope,
  id: string,
): Promise<ExamTopicDoc> {
  const t = isId(id)
    ? await ExamTopic.findOne({ _id: id, schoolId, isDeleted: { $ne: true } })
    : null;
  if (!t || (!scope.all && !scope.subjectIds.includes(String(t.subjectId)))) throw notFound();
  return t;
}

const canEditTopic = (actor: Actor, scope: ExamScope, t: ExamTopicDoc) =>
  scope.all || String(t.createdBy) === actor.id;

const summary = (t: ExamTopicDoc) => ({
  subjectId: String(t.subjectId),
  name: t.name,
  hasDescription: !!t.description,
  order: t.order,
});

const audit = (
  ctx: Ctx,
  schoolId: string,
  action: string,
  id: string,
  before: unknown,
  after: unknown,
) =>
  auditService.log({
    userId: ctx.actor.id,
    schoolId,
    action,
    entity: 'exam_topic',
    entityId: id,
    before,
    after,
    ip: ctx.ip,
  });

async function subjectOrFail(schoolId: string, subjectId: string, activeOnly: boolean) {
  const s = isId(subjectId)
    ? await Subject.findOne({ _id: subjectId, $or: [{ schoolId: null }, { schoolId }] })
    : null;
  if (!s || (activeOnly && !s.isActive)) throw AppError.notFound('Fan topilmadi');
  return s;
}

/** Mavzulardagi (o'chirilmagan) barcha savollar soni, ko'rinishdan qat'i nazar (o'chirish qoidasi uchun) */
export async function totalInTopics(schoolId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await Question.aggregate<{ _id: Types.ObjectId; n: number }>([
    {
      $match: {
        schoolId: new Types.ObjectId(schoolId),
        topicId: { $in: ids.map((i) => new Types.ObjectId(i)) },
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: '$topicId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function toDto(
  ctx: Ctx,
  scope: ExamScope,
  schoolId: string,
  docs: ExamTopicDoc[],
  subjectName: string | null,
) {
  const ids = docs.map((d) => d.id as string);
  const [visible, totals, users] = await Promise.all([
    visibleCounts(ctx.actor, schoolId, scope, 'topicId'),
    totalInTopics(schoolId, ids),
    User.find({ _id: { $in: uniq(docs.map((d) => String(d.createdBy))) } })
      .select('fullName')
      .lean(),
  ]);
  const names = new Map(users.map((u) => [String(u._id), u.fullName]));
  return docs.map((d) => {
    const edit = canEditTopic(ctx.actor, scope, d);
    const empty = (totals.get(d.id as string) ?? 0) === 0;
    return {
      id: d.id as string,
      subjectId: String(d.subjectId),
      subjectName,
      name: d.name,
      description: d.description ?? '',
      order: d.order,
      createdBy: String(d.createdBy),
      createdByName: names.get(String(d.createdBy)) ?? null,
      isMine: String(d.createdBy) === ctx.actor.id,
      /** Hozirgi foydalanuvchiga ko'rinadigan savollar soni */
      questionsCount: visible.get(d.id as string) ?? 0,
      isEmpty: empty,
      canEdit: edit,
      canDelete: edit && empty,
      createdAt: d.createdAt,
    };
  });
}

export const topicsService = {
  async list(ctx: Ctx, schoolId: string, subjectId: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    assertSubjectInScope(scope, subjectId);
    const subject = await subjectOrFail(schoolId, subjectId, false);
    const docs = await ExamTopic.find({ schoolId, subjectId, isDeleted: { $ne: true } }).sort({
      order: 1,
      _id: 1,
    });
    return {
      subject: { id: subject.id as string, name: subject.name, isActive: subject.isActive },
      topics: await toDto(ctx, scope, schoolId, docs, subject.name),
    };
  },

  async get(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const t = await loadTopic(schoolId, scope, id);
    const subject = await Subject.findById(t.subjectId).select('name').lean();
    const [dto] = await toDto(ctx, scope, schoolId, [t], subject?.name ?? null);
    return dto!;
  },

  async create(ctx: Ctx, schoolId: string, subjectId: string, body: z.infer<typeof topicBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    assertSubjectInScope(scope, subjectId);
    const subject = await subjectOrFail(schoolId, subjectId, true);
    const name = cleanText(body.name);
    const nameKey = nameKeyOf(name);
    if (await ExamTopic.exists({ schoolId, subjectId, nameKey, isDeleted: { $ne: true } })) {
      throw dupName();
    }
    const last = await ExamTopic.findOne({ schoolId, subjectId, isDeleted: { $ne: true } })
      .sort({ order: -1 })
      .select('order');
    let doc: ExamTopicDoc;
    try {
      doc = await ExamTopic.create({
        schoolId,
        subjectId,
        name,
        nameKey,
        description: body.description ?? '',
        order: last ? last.order + 1 : 1,
        createdBy: ctx.actor.id,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw dupName();
      throw e;
    }
    await audit(ctx, schoolId, 'exam.topic.create', doc.id, null, summary(doc));
    const [dto] = await toDto(ctx, scope, schoolId, [doc], subject.name);
    return dto!;
  },

  async update(ctx: Ctx, schoolId: string, id: string, body: z.infer<typeof topicPatchBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const t = await loadTopic(schoolId, scope, id);
    if (!canEditTopic(ctx.actor, scope, t)) {
      throw AppError.forbidden("Mavzuni faqat yaratuvchisi yoki ma'muriyat o'zgartira oladi");
    }
    const before = summary(t);
    if (body.name !== undefined) {
      const name = cleanText(body.name);
      const nameKey = nameKeyOf(name);
      if (
        await ExamTopic.exists({
          schoolId,
          subjectId: t.subjectId,
          nameKey,
          isDeleted: { $ne: true },
          _id: { $ne: t._id },
        })
      ) {
        throw dupName();
      }
      t.name = name;
      t.nameKey = nameKey;
    }
    if (body.description !== undefined) t.description = body.description;
    try {
      await t.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw dupName();
      throw e;
    }
    await audit(ctx, schoolId, 'exam.topic.update', t.id, before, summary(t));
    const subject = await Subject.findById(t.subjectId).select('name').lean();
    const [dto] = await toDto(ctx, scope, schoolId, [t], subject?.name ?? null);
    return dto!;
  },

  /** Yumshoq o'chirish: faqat mavzuda (o'chirilmagan) savol bo'lmasa */
  async remove(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const t = await loadTopic(schoolId, scope, id);
    if (!canEditTopic(ctx.actor, scope, t)) {
      throw AppError.forbidden("Mavzuni faqat yaratuvchisi yoki ma'muriyat o'chira oladi");
    }
    if ((await totalInTopics(schoolId, [t.id as string])).get(t.id as string)) {
      throw AppError.conflict('Mavzuda savollar bor');
    }
    const before = summary(t);
    t.isDeleted = true;
    t.deletedAt = new Date();
    await t.save();
    await audit(ctx, schoolId, 'exam.topic.delete', t.id, before, null);
    return { id: t.id as string, deleted: true };
  },

  /** Tartib: ma'muriyat yoki ro'yxatdagi barcha mavzuni yaratgan o'qituvchi */
  async reorder(ctx: Ctx, schoolId: string, body: z.infer<typeof reorderBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    assertSubjectInScope(scope, body.subjectId);
    const ids = uniq(body.ids);
    const docs = await ExamTopic.find({
      _id: { $in: ids },
      schoolId,
      subjectId: body.subjectId,
      isDeleted: { $ne: true },
    });
    if (docs.length !== ids.length) throw notFound();
    if (!docs.every((d) => canEditTopic(ctx.actor, scope, d))) {
      throw AppError.forbidden(
        "Tartibni faqat ma'muriyat yoki mavzularning yaratuvchisi o'zgartira oladi",
      );
    }
    await ExamTopic.bulkWrite(
      ids.map((id, i) => ({
        updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } },
      })),
    );
    return this.list(ctx, schoolId, body.subjectId);
  },
};
