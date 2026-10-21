import { HydratedDocument, Schema, Types, model } from 'mongoose';

export interface ISubject {
  /** null = global (barcha maktablar uchun) */
  schoolId: Types.ObjectId | null;
  name: string;
  nameKey: string;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type SubjectDoc = HydratedDocument<ISubject>;

const subjectSchema = new Schema<ISubject>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Nom scope (global yoki maktab) ichida unique
subjectSchema.index({ schoolId: 1, nameKey: 1 }, { unique: true });

export const Subject = model<ISubject>('Subject', subjectSchema);
