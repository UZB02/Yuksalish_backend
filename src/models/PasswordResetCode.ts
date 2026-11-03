import { Schema, Types, model } from 'mongoose';

export interface IPasswordResetCode {
  userId: Types.ObjectId;
  /** sha256(userId:kod) — ochiq kod saqlanmaydi */
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  /** Ishlatilgan yoki bekor qilingan (5 ta xato urinish / kod tasdiqlanib token berilgan) */
  usedAt: Date | null;
  /** Kod to'g'ri kiritilgan vaqt; shundan so'ng resetToken beriladi */
  verifiedAt: Date | null;
  /** sha256(resetToken); ochiq token saqlanmaydi */
  resetTokenHash: string | null;
  resetTokenExpiresAt: Date | null;
  createdAt: Date;
}

const schema = new Schema<IPasswordResetCode>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    resetTokenHash: { type: String, default: null },
    resetTokenExpiresAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index(
  { resetTokenHash: 1 },
  { unique: true, partialFilterExpression: { resetTokenHash: { $type: 'string' } } },
);
// Token muddati kod muddatidan keyinroq tugashi mumkin, shuning uchun TTL ga zaxira beriladi
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 15 * 60 });

export const PasswordResetCode = model<IPasswordResetCode>('PasswordResetCode', schema);
