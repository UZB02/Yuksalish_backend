import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Savol rasmi (imtihon moduli). Photo dan ALOHIDA: Photo "bitta egada bitta" mantiqiga ega.
 * Rasm qayta kodlangan (WebP, metadata yo'q) holda saqlanadi, maktab ichida hash bo'yicha dedup.
 */
export interface IExamAsset {
  schoolId: Types.ObjectId;
  /** Qayta kodlangan baytlarning sha256 (hex, 64 belgi) */
  hash: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
  data: Buffer;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamAssetDoc = HydratedDocument<IExamAsset>;

const examAssetSchema = new Schema<IExamAsset>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    hash: { type: String, required: true },
    contentType: { type: String, default: 'image/webp' },
    size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    data: { type: Buffer, required: true, select: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Maktab ichida bir xil rasm bir marta saqlanadi (dedup). Hash qayta kodlangan baytlardan hisoblanadi,
// shuning uchun bu indeks keyinchalik o'zgarmaydi.
examAssetSchema.index({ schoolId: 1, hash: 1 }, { unique: true });

export const ExamAsset = model<IExamAsset>('ExamAsset', examAssetSchema);
