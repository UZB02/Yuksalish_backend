import type { Ctx } from '../../core/context';
import { buildMeta, skipOf } from '../../core/pagination';
import { AuditLog } from '../../models/AuditLog';
import { School } from '../../models/School';
import { User } from '../../models/User';
import { escapeRegex, uniq } from '../../utils/helpers';
import { sanitizeAuditValue } from './audit.sanitize';

type Actor = Ctx['actor'];

/** Toshkent (UTC+5) kun chegaralari */
export const dayStart = (d: string) => new Date(`${d}T00:00:00+05:00`);
export const dayEnd = (d: string) => new Date(`${d}T23:59:59.999+05:00`);

export interface AuditQuery {
  from?: string;
  to?: string;
  userId?: string;
  action?: string;
  entity?: string;
  schoolId?: string;
  search?: string;
  page: number;
  limit: number;
  sort: 'createdAt' | '-createdAt';
}

/** school_admin: faqat o'z maktabi (schoolId filtri e'tiborga olinmaydi); superadmin: ixtiyoriy schoolId */
function scopeFilter(actor: Actor, schoolId?: string): Record<string, unknown> {
  if (actor.role === 'superadmin') return schoolId ? { schoolId } : {};
  return { schoolId: actor.schoolId };
}

export const auditReadService = {
  async list(actor: Actor, q: AuditQuery) {
    const filter: Record<string, unknown> = scopeFilter(actor, q.schoolId);
    if (q.userId) filter.userId = q.userId;
    if (q.entity) filter.entity = q.entity;
    if (q.action) {
      // 'scores.' kabi nuqta bilan tugasa — prefiks, aks holda aniq qiymat
      filter.action = q.action.endsWith('.') ? new RegExp(`^${escapeRegex(q.action)}`) : q.action;
    }
    if (q.from || q.to) {
      filter.createdAt = {
        ...(q.from ? { $gte: dayStart(q.from) } : {}),
        ...(q.to ? { $lte: dayEnd(q.to) } : {}),
      };
    }
    if (q.search) {
      const re = new RegExp(escapeRegex(q.search), 'i');
      const users = await User.find({ $or: [{ fullName: re }, { username: re }] })
        .select('_id')
        .limit(200)
        .lean();
      filter.$or = [{ action: re }, { entity: re }, { userId: { $in: users.map((u) => u._id) } }];
    }

    const dir = q.sort === 'createdAt' ? 1 : -1;
    const [docs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: dir, _id: dir })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    const userIds = uniq(docs.filter((d) => d.userId).map((d) => String(d.userId)));
    const schoolIds = uniq(docs.filter((d) => d.schoolId).map((d) => String(d.schoolId)));
    const [users, schools] = await Promise.all([
      User.find({ _id: { $in: userIds } })
        .select('fullName username role')
        .lean(),
      School.find({ _id: { $in: schoolIds } })
        .select('name')
        .lean(),
    ]);
    const uMap = new Map(users.map((u) => [String(u._id), u]));
    const sMap = new Map(schools.map((s) => [String(s._id), s]));

    const items = docs.map((d) => {
      const u = d.userId ? uMap.get(String(d.userId)) : undefined;
      const s = d.schoolId ? sMap.get(String(d.schoolId)) : undefined;
      const before = sanitizeAuditValue(d.before);
      const after = sanitizeAuditValue(d.after);
      return {
        id: String(d._id),
        createdAt: d.createdAt,
        user: u
          ? { id: String(u._id), fullName: u.fullName, username: u.username, role: u.role }
          : null,
        schoolId: d.schoolId ? String(d.schoolId) : null,
        school: s ? { id: String(s._id), name: s.name } : null,
        action: d.action,
        entity: d.entity ?? null,
        entityId: d.entityId ?? null,
        before: before.value,
        after: after.value,
        truncated: before.truncated || after.truncated,
        ip: d.ip ?? null,
      };
    });
    return { items, meta: buildMeta(q.page, q.limit, total) };
  },

  async filters(actor: Actor, schoolId?: string) {
    const scope = scopeFilter(actor, schoolId);
    const [actions, entities, userIds] = await Promise.all([
      AuditLog.distinct('action', scope),
      AuditLog.distinct('entity', scope),
      AuditLog.distinct('userId', { ...scope, userId: { $ne: null } }),
    ]);
    const users = await User.find({ _id: { $in: userIds.slice(0, 1000) } })
      .select('fullName username role')
      .sort({ fullName: 1 })
      .limit(200)
      .lean();
    return {
      actions: (actions as string[]).filter(Boolean).sort(),
      entities: (entities as string[]).filter(Boolean).sort(),
      users: users.map((u) => ({
        id: String(u._id),
        fullName: u.fullName,
        username: u.username,
        role: u.role,
      })),
    };
  },
};
