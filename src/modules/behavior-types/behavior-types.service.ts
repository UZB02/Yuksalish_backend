import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { BehaviorType, type BehaviorKind, type BehaviorTypeDoc } from '../../models/BehaviorType';
import { School } from '../../models/School';
import { isDuplicateKeyError, isId } from '../../utils/helpers';
import { cleanText, nameKeyOf } from '../../utils/text';
import { auditService } from '../audit/audit.service';

export const toBehaviorTypeDto = (b: BehaviorTypeDoc) => ({
  id: b.id,
  schoolId: b.schoolId ? String(b.schoolId) : null,
  name: b.name,
  kind: b.kind,
  color: b.color,
  order: b.order,
  minScore: b.minScore ?? null,
  maxScore: b.maxScore ?? null,
  isActive: b.isActive,
  createdAt: b.createdAt,
});

const snapshot = (b: BehaviorTypeDoc) => {
  const { id: _id, createdAt: _c, ...rest } = toBehaviorTypeDto(b);
  return rest;
};

const nameTaken = () =>
  AppError.conflict('Bunday nomli xulq turi mavjud', [
    { path: 'name', message: 'Bu nom shu doirada band' },
  ]);

function assertRange(min: number | null | undefined, max: number | null | undefined) {
  if (min != null && max != null && min > max) {
    throw AppError.validation("Ball oralig'i noto'g'ri", [
      { path: 'maxScore', message: "Maksimal ball minimaldan kichik bo'lmasligi kerak" },
    ]);
  }
}

async function findOrFail(id: string): Promise<BehaviorTypeDoc> {
  const doc = isId(id) ? await BehaviorType.findById(id) : null;
  if (!doc) throw AppError.notFound('Xulq turi topilmadi');
  return doc;
}

export interface BehaviorInput {
  name: string;
  kind: BehaviorKind;
  color: string;
  order?: number;
  minScore?: number | null;
  maxScore?: number | null;
}

export const behaviorTypesService = {
  /**
   * @param schoolId  aniqlangan maktab (maktab rollari yoki X-School-Id); superadmin headersiz — undefined
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
    const docs = await BehaviorType.find(filter).sort({ order: 1, name: 1 });
    return docs.map(toBehaviorTypeDto);
  },

  async create(ctx: Ctx, input: BehaviorInput & { schoolId?: string | null }) {
    assertRange(input.minScore, input.maxScore);
    const schoolId = input.schoolId ?? null;
    if (schoolId && !(isId(schoolId) && (await School.exists({ _id: schoolId })))) {
      throw AppError.validation('Maktab topilmadi', [
        { path: 'schoolId', message: 'Maktab topilmadi' },
      ]);
    }
    const name = cleanText(input.name);
    const nameKey = nameKeyOf(name);
    if (await BehaviorType.exists({ schoolId, nameKey })) throw nameTaken();

    let order = input.order;
    if (order === undefined) {
      const last = await BehaviorType.findOne({ schoolId }).sort({ order: -1 }).select('order');
      order = last ? last.order + 1 : 1;
    }
    let doc: BehaviorTypeDoc;
    try {
      doc = await BehaviorType.create({
        schoolId,
        name,
        nameKey,
        kind: input.kind,
        color: input.color,
        order,
        minScore: input.minScore ?? null,
        maxScore: input.maxScore ?? null,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'behavior_type.create',
      entity: 'behavior_type',
      entityId: doc.id,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    return toBehaviorTypeDto(doc);
  },

  async update(ctx: Ctx, id: string, patch: Partial<BehaviorInput>) {
    const doc = await findOrFail(id);
    const before = snapshot(doc);
    if (patch.name !== undefined) {
      const name = cleanText(patch.name);
      const nameKey = nameKeyOf(name);
      if (await BehaviorType.exists({ schoolId: doc.schoolId, nameKey, _id: { $ne: doc._id } })) {
        throw nameTaken();
      }
      doc.name = name;
      doc.nameKey = nameKey;
    }
    if (patch.kind !== undefined) doc.kind = patch.kind;
    if (patch.color !== undefined) doc.color = patch.color;
    if (patch.order !== undefined) doc.order = patch.order;
    if (patch.minScore !== undefined) doc.minScore = patch.minScore;
    if (patch.maxScore !== undefined) doc.maxScore = patch.maxScore;
    assertRange(doc.minScore, doc.maxScore);
    try {
      await doc.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: doc.schoolId ? String(doc.schoolId) : null,
      action: 'behavior_type.update',
      entity: 'behavior_type',
      entityId: doc.id,
      before,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    return toBehaviorTypeDto(doc);
  },

  async setActive(ctx: Ctx, id: string, isActive: boolean) {
    const doc = await findOrFail(id);
    if (doc.isActive !== isActive) {
      doc.isActive = isActive;
      await doc.save();
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: doc.schoolId ? String(doc.schoolId) : null,
        action: isActive ? 'behavior_type.activate' : 'behavior_type.deactivate',
        entity: 'behavior_type',
        entityId: doc.id,
        before: { isActive: !isActive },
        after: { isActive },
        ip: ctx.ip,
      });
    }
    return toBehaviorTypeDto(doc);
  },
};
