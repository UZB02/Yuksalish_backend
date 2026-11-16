import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Kirish imtihoni nomzodi (hali o'quvchi emas). Student bilan bog'lanmaydi.
 * Shaxsiy ma'lumotlar (telefon, tug'ilgan sana) saqlash muddatidan keyin tozalanadi (piiPurgedAt).
 */
export interface IExamCandidate {
  schoolId: Types.ObjectId;
  fullName: string;
  birthDate: Date | null;
  targetGrade: number | null;
  parentPhone: string | null;
  notes: string;
  piiPurgedAt: Date | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamCandidateDoc = HydratedDocument<IExamCandidate>;

const schema = new Schema<IExamCandidate>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    fullName: { type: String, required: true, trim: true },
    birthDate: { type: Date, default: null },
    targetGrade: { type: Number, default: null },
    parentPhone: { type: String, default: null },
    notes: { type: String, default: '' },
    piiPurgedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ schoolId: 1, createdAt: -1 });
// Tozalash vazifasi uchun: hali tozalanmaganlar
schema.index({ schoolId: 1, piiPurgedAt: 1, createdAt: 1 });

export const ExamCandidate = model<IExamCandidate>('ExamCandidate', schema);
