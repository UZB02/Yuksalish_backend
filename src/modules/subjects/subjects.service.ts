import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ClassSubject } from '../../models/ClassSubject';
import { School } from '../../models/School';
import { Subject, type SubjectDoc } from '../../models/Subject';
import { SubjectGrade } from '../../models/SubjectGrade';
import { isDuplicateKeyError, isId } from '../../utils/helpers';
import { cleanText, nameKeyOf } from '../../utils/text';
import { auditService } from '../audit/audit.service';

type Actor = Ctx['actor'];

export const toSubjectDto = (s: SubjectDoc) => ({
  id: s.id as string,
  schoolId: s.schoolId ? String(s.schoolId) : null,
  name: s.name,
  order: s.order,
  isActive: s.isActive,
  createdAt: s.createdAt,
});

const snapshot = (s: SubjectDoc) => {
  const { id: _id, createdAt: _c, ...rest } = toSubjectDto(s);
  return rest;
};

const nameTaken = () =>
  AppError.conflict('Bunday nomli fan mavjud', [{ path: 'name', message: 'Bu nom band' }]);

/**
 * Yozish huquqi: superadmin — hammasi; school_admin (subjects.manage) — faqat o'z maktabi fanlari
 * (global fanlar uchun 403, boshqa maktab fani uchun 404).
 */
function assertCanWrite(actor: Actor, doc: SubjectDoc) {
  if (actor.role === 'superadmin') return;
  if (!doc.schoolId) throw AppError.forbidden("Umumiy fanlarni faqat superadmin o'zgartiradi");
  if (String(doc.schoolId) !== actor.schoolId) throw AppError.notFound('Fan topilmadi');
}

async function findOrFail(id: string): Promise<SubjectDoc> {
  const doc = isId(id) ? await Subject.findById(id) : null;
  if (!doc) throw AppError.notFound('Fan topilmadi');
  return doc;
}

export const subjectsService = {
  /**
   * @param q.schoolId  aniqlangan maktab (maktab rollari yoki X-School-Id); superadmin headersiz — undefined
   */
  async list(q: { schoolId?: string; isActive?: boolean; scope?: 'global' | 'school' | 'all' }) {
    const scope = q.scope ?? 'all';
    const filter: Record<string, unknown> = {};
    if (q.isActive !== undefined) filter.isActive = q.isActive;
    if (q.schoolId) {
      if (scope === 'global') filter.schoolId = null;
      else if (scope === 'school') filter.schoolId = q.schoolId;
      else filter.$or = [{ schoolId: null }, { schoolId: q.schoolId }];
    } else if (scope === 'global') filter.schoolId = null;
    else if (scope === 'school') filter.schoolId = { $ne: null };
    const docs = await Subject.find(filter).sort({ order: 1, name: 1 });
    return docs.map(toSubjectDto);
  },

  async create(ctx: Ctx, input: { name: string; order?: number; schoolId?: string | null }) {
    let schoolId: string | null;
    if (ctx.actor.role === 'superadmin') {
      schoolId = input.schoolId ?? null;
      if (schoolId && !(isId(schoolId) && (await School.exists({ _id: schoolId })))) {
        throw AppError.validation('Maktab topilmadi', [
          { path: 'schoolId', message: 'Maktab topilmadi' },
        ]);
      }
    } else {
      if (!ctx.actor.schoolId) throw AppError.forbidden();
      if (input.schoolId != null && input.schoolId !== ctx.actor.schoolId) {
        throw AppError.forbidden("Fanni faqat o'z maktabingiz uchun qo'sha olasiz");
      }
      schoolId = ctx.actor.schoolId;
    }
    const name = cleanText(input.name);
    const nameKey = nameKeyOf(name);
    if (await Subject.exists({ schoolId, nameKey })) throw nameTaken();
    // Maktab fani umumiy ro'yxatdagi nomni takrorlamasin
    if (schoolId && (await Subject.exists({ schoolId: null, nameKey }))) throw nameTaken();

    let order = input.order;
    if (order === undefined) {
      const last = await Subject.findOne({ schoolId }).sort({ order: -1 }).select('order');
      order = last ? last.order + 1 : 1;
    }
    let doc: SubjectDoc;
    try {
      doc = await Subject.create({ schoolId, name, nameKey, order });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'subject.create',
      entity: 'subject',
      entityId: doc.id,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    return toSubjectDto(doc);
  },

  async update(ctx: Ctx, id: string, patch: { name?: string; order?: number }) {
    const doc = await findOrFail(id);
    assertCanWrite(ctx.actor, doc);
    const before = snapshot(doc);
    if (patch.name !== undefined) {
      const name = cleanText(patch.name);
      const nameKey = nameKeyOf(name);
      if (await Subject.exists({ schoolId: doc.schoolId, nameKey, _id: { $ne: doc._id } })) {
        throw nameTaken();
      }
      if (doc.schoolId && (await Subject.exists({ schoolId: null, nameKey }))) throw nameTaken();
      doc.name = name;
      doc.nameKey = nameKey;
    }
    if (patch.order !== undefined) doc.order = patch.order;
    try {
      await doc.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: doc.schoolId ? String(doc.schoolId) : null,
      action: 'subject.update',
      entity: 'subject',
      entityId: doc.id,
      before,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    return toSubjectDto(doc);
  },

  async setActive(ctx: Ctx, id: string, isActive: boolean) {
    const doc = await findOrFail(id);
    assertCanWrite(ctx.actor, doc);
    if (doc.isActive !== isActive) {
      doc.isActive = isActive;
      await doc.save();
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: doc.schoolId ? String(doc.schoolId) : null,
        action: isActive ? 'subject.activate' : 'subject.deactivate',
        entity: 'subject',
        entityId: doc.id,
        before: { isActive: !isActive },
        after: { isActive },
        ip: ctx.ip,
      });
    }
    return toSubjectDto(doc);
  },

  /** Foydalanilmagan fanni o'chiradi; sinfga biriktirilgan yoki baholangan bo'lsa — nofaol qilish kerak */
  async remove(ctx: Ctx, id: string) {
    const doc = await findOrFail(id);
    assertCanWrite(ctx.actor, doc);
    const used =
      (await ClassSubject.exists({ subjectId: doc._id })) ||
      (await SubjectGrade.exists({ subjectId: doc._id }));
    if (used) {
      throw AppError.conflict("Fan ishlatilgan — o'chirib bo'lmaydi, nofaol qiling", [
        { path: 'id', message: 'Fan sinflarga biriktirilgan yoki baholarda ishlatilgan' },
      ]);
    }
    const before = snapshot(doc);
    await doc.deleteOne();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: doc.schoolId ? String(doc.schoolId) : null,
      action: 'subject.delete',
      entity: 'subject',
      entityId: doc.id,
      before,
      ip: ctx.ip,
    });
  },
};
