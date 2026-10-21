import { Types } from 'mongoose';
import { AuditLog } from '../../models/AuditLog';
import { logger } from '../../core/logger';

export interface AuditEntry {
  userId?: string | null;
  schoolId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const toOid = (v?: string | null) =>
  v && Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null;

export const auditService = {
  /** Audit yozuvi. Xato yuz bersa asosiy amalni to'xtatmaydi, faqat logga yozadi. */
  async log(e: AuditEntry): Promise<void> {
    try {
      await AuditLog.create({
        userId: toOid(e.userId),
        schoolId: toOid(e.schoolId),
        action: e.action,
        entity: e.entity,
        entityId: e.entityId ?? null,
        before: e.before ?? null,
        after: e.after ?? null,
        ip: e.ip ?? null,
      });
    } catch (err) {
      logger.error({ err, action: e.action }, 'Audit yozilmadi');
    }
  },
};
