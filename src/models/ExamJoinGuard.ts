import { HydratedDocument, Schema, model } from 'mongoose';

/**
 * Kirishdagi noto'g'ri urinishlar hisoblagichi (brute-force himoyasi), DB da: restartda yo'qolmaydi.
 * `key`: "dev:<kod>:<deviceId>" (qurilma bo'yicha qattiq) yoki "ip:<kod>:<ip>" (maktab NAT'i uchun saxiy).
 * Maktab/foydalanuvchi bilan bog'lanmagan (maktab noma'lum bo'lgan bosqich), shuning uchun purge
 * ro'yxatida emas; yozuvlar TTL bilan o'zi o'chadi.
 */
export interface IExamJoinGuard {
  key: string;
  count: number;
  windowStart: Date;
  blockedUntil: Date | null;
  expiresAt: Date;
}
export type ExamJoinGuardDoc = HydratedDocument<IExamJoinGuard>;

const schema = new Schema<IExamJoinGuard>({
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  windowStart: { type: Date, required: true },
  blockedUntil: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});
schema.index({ key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ExamJoinGuard = model<IExamJoinGuard>('ExamJoinGuard', schema);
