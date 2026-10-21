import { HydratedDocument, Schema, Types, model } from 'mongoose';
import { ROLES, type Role } from '../constants/roles';

export interface IUser {
  schoolId: Types.ObjectId | null;
  fullName: string;
  username: string;
  passwordHash: string;
  role: Role;
  phone: string | null;
  permissions: string[];
  isActive: boolean;
  lastLoginAt: Date | null;
  failedLoginCount: number;
  lockUntil: Date | null;
  passwordChangedAt: Date | null;
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
    permissions: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ schoolId: 1, role: 1 });

export const User = model<IUser>('User', userSchema);
