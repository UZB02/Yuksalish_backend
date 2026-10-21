import { HydratedDocument, Schema, Types, model } from 'mongoose';
import {
  ATTENDANCE_CATEGORIES,
  type AttendanceCategory,
} from '../modules/settings/attendance.settings';

export interface IAttendanceStatus {
  /** null = global */
  schoolId: Types.ObjectId | null;
  name: string;
  nameKey: string;
  shortName: string;
  color: string;
  category: AttendanceCategory;
  isDefault: boolean;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type AttendanceStatusDoc = HydratedDocument<IAttendanceStatus>;

const schema = new Schema<IAttendanceStatus>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    shortName: { type: String, required: true, trim: true },
    color: { type: String, required: true },
    category: { type: String, enum: ATTENDANCE_CATEGORIES, required: true },
    isDefault: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

schema.index({ schoolId: 1, nameKey: 1 }, { unique: true });
// Scope (global yoki maktab) ichida standart holat bitta
schema.index(
  { schoolId: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true },
    name: 'one_default_status_per_scope',
  },
);

export const AttendanceStatus = model<IAttendanceStatus>('AttendanceStatus', schema);
