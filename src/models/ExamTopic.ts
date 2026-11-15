import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Savollar bankidagi mavzu (Fan -> Mavzu -> Savol). Maktab va fanga bog'langan.
 * Nom (nameKey) fan ichida faol (o'chirilmagan) mavzular orasida noyob.
 */
export interface IExamTopic {
  schoolId: Types.ObjectId;
  subjectId: Types.ObjectId;
  name: string;
  /** Solishtirish kaliti: katta-kichik harf va ortiqcha bo'shliqlarsiz */
  nameKey: string;
  description: string;
  order: number;
  createdBy: Types.ObjectId;
  isDeleted: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamTopicDoc = HydratedDocument<IExamTopic>;

const schema = new Schema<IExamTopic>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    description: { type: String, default: '' },
    order: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Ro'yxat: fan ichida tartib bo'yicha
schema.index({ schoolId: 1, subjectId: 1, isDeleted: 1, order: 1 });
// Nom noyobligi: faqat o'chirilmagan mavzular orasida (o'chirilgan nom qayta ishlatilishi mumkin).
// Yangi kolleksiya: indeks parametrlari birinchi deployda to'g'ri tanlangan, keyin o'zgartirilmaydi
// (o'zgartirish IndexOptionsConflict beradi, BACKEND_XARITA 9.2).
schema.index(
  { schoolId: 1, subjectId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, name: 'unique_topic_name_active' },
);

export const ExamTopic = model<IExamTopic>('ExamTopic', schema);
