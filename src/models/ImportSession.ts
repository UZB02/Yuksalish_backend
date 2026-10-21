import { Schema, Types, model } from 'mongoose';

export interface ImportRow {
  row: number;
  status: 'valid' | 'invalid' | 'duplicate';
  data: {
    fullName: string;
    className: string;
    birthDate: string | null;
    gender: 'male' | 'female' | null;
    studentCode: string | null;
    parentPhone: string | null;
  };
  resolvedClassId: string | null;
  duplicateOfStudentId: string | null;
  errors: string[];
}

export interface IImportSession {
  schoolId: Types.ObjectId;
  userId: Types.ObjectId;
  fileName: string;
  rows: ImportRow[];
  consumed: boolean;
  expiresAt: Date;
  createdAt: Date;
}

const importSessionSchema = new Schema<IImportSession>(
  {
    schoolId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    fileName: { type: String, default: '' },
    rows: { type: Schema.Types.Mixed, default: [] },
    consumed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// 30 daqiqadan so'ng avtomatik o'chiriladi
importSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ImportSession = model<IImportSession>('ImportSession', importSessionSchema);
