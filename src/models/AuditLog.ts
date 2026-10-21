import { Schema, Types, model } from 'mongoose';
import { env } from '../config/env';

export interface IAuditLog {
  userId: Types.ObjectId | null;
  schoolId: Types.ObjectId | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ schoolId: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
// ENV AUDIT_RETENTION_DAYS berilsa eski yozuvlar avtomatik o'chiriladi (TTL)
if (env.AUDIT_RETENTION_DAYS) {
  auditLogSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: env.AUDIT_RETENTION_DAYS * 86_400, name: 'audit_retention_ttl' },
  );
}

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
