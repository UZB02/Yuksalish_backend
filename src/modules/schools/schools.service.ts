import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { School, type SchoolDoc } from '../../models/School';
import { escapeRegex, isDuplicateKeyError, isId } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';

export const toSchoolDto = (s: SchoolDoc) => ({
  id: s.id,
  name: s.name,
  slug: s.slug,
  address: s.address ?? null,
  phone: s.phone ?? null,
  logoUrl: s.logoUrl ?? null,
  isActive: s.isActive,
  createdAt: s.createdAt,
});

const snapshot = (s: SchoolDoc) => {
  const { id: _id, createdAt: _c, ...rest } = toSchoolDto(s);
  return rest;
};

async function findOrFail(id: string): Promise<SchoolDoc> {
  const school = isId(id) ? await School.findById(id) : null;
  if (!school) throw AppError.notFound('Maktab topilmadi');
  return school;
}

export const schoolsService = {
  async list(q: { page: number; limit: number; search?: string; isActive?: boolean }) {
    const filter: Record<string, unknown> = {};
    if (q.isActive !== undefined) filter.isActive = q.isActive;
    if (q.search) {
      const re = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ name: re }, { slug: re }];
    }
    const [items, total] = await Promise.all([
      School.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      School.countDocuments(filter),
    ]);
    return { items: items.map(toSchoolDto), meta: buildMeta(q.page, q.limit, total) };
  },

  async get(id: string) {
    return toSchoolDto(await findOrFail(id));
  },

  async create(
    ctx: Ctx,
    input: {
      name: string;
      slug: string;
      address?: string | null;
      phone?: string | null;
      logoUrl?: string | null;
    },
  ) {
    const slugTaken = AppError.conflict('Bu slug band', [
      { path: 'slug', message: 'Bu slug band' },
    ]);
    if (await School.exists({ slug: input.slug })) throw slugTaken;

    let school: SchoolDoc;
    try {
      school = await School.create({
        name: input.name,
        slug: input.slug,
        address: input.address ?? null,
        phone: input.phone ?? null,
        logoUrl: input.logoUrl ?? null,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw slugTaken;
      throw e;
    }

    await auditService.log({
      userId: ctx.actor.id,
      schoolId: school.id,
      action: 'school.create',
      entity: 'school',
      entityId: school.id,
      after: snapshot(school),
      ip: ctx.ip,
    });
    return toSchoolDto(school);
  },

  async update(
    ctx: Ctx,
    id: string,
    patch: {
      name?: string;
      address?: string | null;
      phone?: string | null;
      logoUrl?: string | null;
      isActive?: boolean;
    },
  ) {
    const school = await findOrFail(id);
    const before = snapshot(school);
    school.set(patch);
    await school.save();

    await auditService.log({
      userId: ctx.actor.id,
      schoolId: school.id,
      action: 'school.update',
      entity: 'school',
      entityId: school.id,
      before,
      after: snapshot(school),
      ip: ctx.ip,
    });
    return toSchoolDto(school);
  },
};
