import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { AttendanceStatus, type AttendanceStatusDoc } from '../../models/AttendanceStatus';
import { School } from '../../models/School';
import { isDuplicateKeyError, isId } from '../../utils/helpers';
import { cleanText, nameKeyOf } from '../../utils/text';
import { auditService } from '../audit/audit.service';
import type { AttendanceCategory } from '../settings/attendance.settings';

export const toStatusDto = (s: AttendanceStatusDoc) => ({
  id: s.id as string,
  schoolId: s.schoolId ? String(s.schoolId) : null,
  name: s.name,
  shortName: s.shortName,
  color: s.color,
  category: s.category,
  isDefault: s.isDefault,
  order: s.order,
  isActive: s.isActive,
  createdAt: s.createdAt,
});

const snapshot = (s: AttendanceStatusDoc) => {
  const { id: _id, createdAt: _c, ...rest } = toStatusDto(s);
  return rest;
};

const nameTaken = () =>
  AppError.conflict('Bunday nomli davomat holati mavjud', [
    { path: 'name', message: 'Bu nom band' },
  ]);

async function findOrFail(id: string): Promise<AttendanceStatusDoc> {
  const doc = isId(id) ? await AttendanceStatus.findById(id) : null;
  if (!doc) throw AppError.notFound('Davomat holati topilmadi');
  return doc;
}

/** Nom to'qnashuvi: maktab holati global bilan ham, global holat esa istalgan maktab holati bilan ham to'qnashadi */
async function assertNameFree(schoolId: string | null, nameKey: string, exceptId?: string) {
  const filter: Record<string, unknown> = { nameKey };
  if (schoolId) filter.schoolId = { $in: [null, schoolId] };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await AttendanceStatus.exists(filter)) throw nameTaken();
}

/** Scope ichida standart holat bitta: yangisi belgilanganda eskisidan olinadi */
async function makeDefault(schoolId: string | null, exceptId?: string) {
  const filter: Record<string, unknown> = { schoolId, isDefault: true };
  if (exceptId) filter._id = { $ne: exceptId };
  await AttendanceStatus.updateMany(filter, { isDefault: false });
}

const defaultRule = () =>
  AppError.validation("Standart holat faol va 'present' kategoriyasida bo'lishi kerak", [
    {
      path: 'isDefault',
      message: "Standart holat faol va 'present' kategoriyasida bo'lishi kerak",
    },
  ]);

export interface StatusInput {
  name: string;
  shortName: string;
  color: string;
  category: AttendanceCategory;
  isDefault?: boolean;
  order?: number;
}

export const attendanceStatusesService = {
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
    const docs = await AttendanceStatus.find(filter).sort({ order: 1, name: 1 });
    return docs.map(toStatusDto);
  },

  async create(ctx: Ctx, input: StatusInput & { schoolId?: string | null }) {
    const schoolId = input.schoolId ?? null;
    if (schoolId && !(isId(schoolId) && (await School.exists({ _id: schoolId })))) {
      throw AppError.validation('Maktab topilmadi', [
        { path: 'schoolId', message: 'Maktab topilmadi' },
      ]);
    }
    if (input.isDefault && input.category !== 'present') throw defaultRule();
    const name = cleanText(input.name);
    const nameKey = nameKeyOf(name);
    await assertNameFree(schoolId, nameKey);

    let order = input.order;
    if (order === undefined) {
      const last = await AttendanceStatus.findOne({ schoolId }).sort({ order: -1 }).select('order');
      order = last ? last.order + 1 : 1;
    }
    if (input.isDefault) await makeDefault(schoolId);
    let doc: AttendanceStatusDoc;
    try {
      doc = await AttendanceStatus.create({
        schoolId,
        name,
        nameKey,
        shortName: input.shortName,
        color: input.color,
        category: input.category,
        isDefault: input.isDefault ?? false,
        order,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'attendance_status.create',
      entity: 'attendance_status',
      entityId: doc.id,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    return toStatusDto(doc);
  },

  async update(ctx: Ctx, id: string, patch: Partial<StatusInput>) {
    const doc = await findOrFail(id);
    const before = snapshot(doc);
    const schoolId = doc.schoolId ? String(doc.schoolId) : null;

    if (patch.category !== undefined && patch.category !== doc.category) {
      if (await AttendanceRecord.exists({ statusId: doc._id })) {
        throw AppError.conflict(
          "Bu holat bilan davomat yozuvlari mavjud, kategoriyani o'zgartirib bo'lmaydi",
          [{ path: 'category', message: "Yozuvlar mavjud — kategoriya o'zgarmaydi" }],
        );
      }
      doc.category = patch.category;
    }
    if (patch.name !== undefined) {
      const name = cleanText(patch.name);
      const nameKey = nameKeyOf(name);
      await assertNameFree(schoolId, nameKey, doc.id);
      doc.name = name;
      doc.nameKey = nameKey;
    }
    if (patch.shortName !== undefined) doc.shortName = patch.shortName;
    if (patch.color !== undefined) doc.color = patch.color;
    if (patch.order !== undefined) doc.order = patch.order;
    if (patch.isDefault !== undefined) doc.isDefault = patch.isDefault;
    if (doc.isDefault && (doc.category !== 'present' || !doc.isActive)) throw defaultRule();

    if (patch.isDefault) await makeDefault(schoolId, doc.id);
    try {
      await doc.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'attendance_status.update',
      entity: 'attendance_status',
      entityId: doc.id,
      before,
      after: snapshot(doc),
      ip: ctx.ip,
    });
    return toStatusDto(doc);
  },

  async setActive(ctx: Ctx, id: string, isActive: boolean) {
    const doc = await findOrFail(id);
    if (doc.isActive !== isActive) {
      if (!isActive && doc.isDefault) {
        throw AppError.conflict(
          "Standart holatni nofaol qilib bo'lmaydi: avval boshqasini standart qiling",
        );
      }
      doc.isActive = isActive;
      await doc.save();
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: doc.schoolId ? String(doc.schoolId) : null,
        action: isActive ? 'attendance_status.activate' : 'attendance_status.deactivate',
        entity: 'attendance_status',
        entityId: doc.id,
        before: { isActive: !isActive },
        after: { isActive },
        ip: ctx.ip,
      });
    }
    return toStatusDto(doc);
  },
};
