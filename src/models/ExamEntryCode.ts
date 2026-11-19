import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Shaxsiy kirish kodi qidiruv indeksi (har ishtirokchiga bitta). Kodning O'ZI saqlanmaydi: faqat
 * `codeHash` = HMAC-SHA256(EXAM_PIN_SECRET dan kalit, normallashgan kod). Kod maktablar va sessiyalar bo'yicha
 * GLOBAL noyob (kod ichida maktab ko'rsatilmaydi), shuning uchun alohida kolleksiya va noyob indeks.
 * Faollik sessiya holatidan kirishda tekshiriladi; `expiresAt` (TTL) faqat tozalash uchun.
 * Maktab o'chirilganda schoolPurge ro'yxatidan tozalanadi.
 */
export interface IExamEntryCode {
  codeHash: string;
  schoolId: Types.ObjectId;
  sessionId: Types.ObjectId;
  participantKey: string;
  expiresAt: Date;
  createdAt: Date;
}
export type ExamEntryCodeDoc = HydratedDocument<IExamEntryCode>;

const schema = new Schema<IExamEntryCode>(
  {
    codeHash: { type: String, required: true },
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'ExamSession', required: true },
    participantKey: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// Yangi kolleksiya: indekslar birinchi deployda to'g'ri tanlangan (keyin o'zgartirib bo'lmaydi, XARITA 9.2)
schema.index({ codeHash: 1 }, { unique: true });
schema.index({ sessionId: 1, participantKey: 1 });
schema.index({ schoolId: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ExamEntryCode = model<IExamEntryCode>('ExamEntryCode', schema);
