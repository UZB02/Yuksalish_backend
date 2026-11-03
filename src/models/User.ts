import { HydratedDocument, Schema, Types, model } from 'mongoose';
import { ROLES, type Role } from '../constants/roles';

export interface IUserTelegram {
  chatId: number | null;
  username: string | null;
  linkedAt: Date | null;
}

export interface IUser {
  schoolId: Types.ObjectId | null;
  fullName: string;
  username: string;
  passwordHash: string;
  role: Role;
  phone: string | null;
  photoId: Types.ObjectId | null;
  permissions: string[];
  isActive: boolean;
  /** Asosiy superadmin (faqat bittasi). Faqat role=superadmin uchun ma'noga ega */
  isOwner: boolean;
  lastLoginAt: Date | null;
  failedLoginCount: number;
  lockUntil: Date | null;
  passwordChangedAt: Date | null;
  telegram: IUserTelegram;
  createdAt: Date;
  updatedAt: Date;
}
export type UserDoc = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    fullName: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    phone: { type: String, trim: true, default: null },
    photoId: { type: Schema.Types.ObjectId, ref: 'Photo', default: null },
    permissions: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    isOwner: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    telegram: {
      // chatId tasodifan API ga chiqib ketmasligi uchun select:false; servislar '+telegram.chatId' bilan oladi
      chatId: { type: Number, default: null, select: false },
      username: { type: String, default: null },
      linkedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

userSchema.index({ schoolId: 1, role: 1 });
// Asosiy superadmin faqat bitta bo'la oladi (ikkinchisini yozish DB darajasida rad etiladi)
userSchema.index({ isOwner: 1 }, { unique: true, partialFilterExpression: { isOwner: true } });
// Bitta Telegram chat faqat bitta foydalanuvchiga ulanishi mumkin
userSchema.index(
  { 'telegram.chatId': 1 },
  { unique: true, partialFilterExpression: { 'telegram.chatId': { $type: 'number' } } },
);

export const User = model<IUser>('User', userSchema);
