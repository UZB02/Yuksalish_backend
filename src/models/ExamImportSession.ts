import { Schema, Types, model } from 'mongoose';

export interface IExamImportSession {
  schoolId: Types.ObjectId;
  userId: Types.ObjectId;
  kind: 'excel' | 'word';
  /** Import nishoni: savollar shu mavzuga qo'shiladi */
  topicId: Types.ObjectId;
  fileName: string;
  /** Oldindan ko'rish: tahlil qilingan savollar (ImportItem[]) */
  items: unknown;
  warnings: string[];
  /** Bajarilgan (atomik). Qayta bajarish natijani qaytaradi, ikkinchi marta yaratmaydi */
  consumed: boolean;
  result: unknown;
  expiresAt: Date;
  createdAt: Date;
}

// Talabalar importi (ImportSession) dan ALOHIDA model
const schema = new Schema<IExamImportSession>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['excel', 'word'], required: true },
    topicId: { type: Schema.Types.ObjectId, ref: 'ExamTopic', required: true },
    fileName: { type: String, default: '' },
    items: { type: Schema.Types.Mixed, default: [] },
    warnings: { type: [String], default: [] },
    consumed: { type: Boolean, default: false },
    result: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// ~30 daqiqadan so'ng avtomatik o'chiriladi (TTL)
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ExamImportSession = model<IExamImportSession>('ExamImportSession', schema);
