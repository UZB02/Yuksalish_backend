import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * "Fayl + kalit" bloki test fayli (IMTIHON_REJA §23): baytlar MongoDB'da EMAS, diskda (EXAM_FILES_DIR);
 * bu yerda faqat kichik yozuv. Har yuklash o'z yozuvi va o'z diskdagi fayliga ega (dedup yo'q), shuning uchun
 * fayl aniq BIR imtihonga (`sessionId`) tegishli: umr sikli (o'chirish) shu bo'yicha hisoblanadi, umumiy fayl yo'q.
 *  - pending: yuklanmoqda (kvota ajratilgan, fayl hali joyida emas); ready: diskda; expired: baytlar o'chirilgan
 *    (imtihon yopilgandan 14 kun keyin), yozuv qoladi: kalit/natijalar ishlaydi, ko'rinishlarda "fayl muddati tugagan".
 *  - bound: blok kalitiga (fileTest) biriktirilgan; aks holda 24 soatdan keyin o'chiriladi.
 */
export const FILE_KINDS = ['pdf', 'image'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const FILE_STATES = ['pending', 'ready', 'expired'] as const;
export type FileState = (typeof FILE_STATES)[number];

export interface IExamFile {
  schoolId: Types.ObjectId;
  sessionId: Types.ObjectId;
  blockId: string;
  /** Diskdagi nom: serverda yaratilgan 32 hex (foydalanuvchi kiritgan hech narsa yo'lga tushmaydi) */
  storageName: string;
  /** Saqlangan baytlarning sha256 (ETag uchun) */
  hash: string;
  kind: FileKind;
  contentType: string;
  size: number;
  width: number;
  height: number;
  pages: number;
  state: FileState;
  bound: boolean;
  createdBy: Types.ObjectId | null;
  expiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamFileDoc = HydratedDocument<IExamFile>;

const schema = new Schema<IExamFile>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'ExamSession', required: true },
    blockId: { type: String, required: true },
    storageName: { type: String, required: true },
    hash: { type: String, default: '' },
    kind: { type: String, enum: FILE_KINDS, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    pages: { type: Number, default: 0 },
    state: { type: String, enum: FILE_STATES, default: 'pending' },
    bound: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    expiredAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ storageName: 1 }, { unique: true });
schema.index({ schoolId: 1, sessionId: 1 });
// Sweeper: holat bo'yicha (yetim/yuklanayotgan/muddati o'tgan)
schema.index({ state: 1, bound: 1, createdAt: 1 });

export const ExamFile = model<IExamFile>('ExamFile', schema);
