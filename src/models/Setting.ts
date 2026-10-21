import { Schema, Types, model } from 'mongoose';

export interface ISetting {
  scope: 'global' | 'school';
  /** scope=global bo'lsa null */
  schoolId: Types.ObjectId | null;
  key: string;
  value: unknown;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    scope: { type: String, enum: ['global', 'school'], required: true },
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

settingSchema.index({ scope: 1, schoolId: 1, key: 1 }, { unique: true });

export const Setting = model<ISetting>('Setting', settingSchema);
