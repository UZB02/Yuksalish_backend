import { Schema, Types, model } from 'mongoose';

export interface IRatingResultStudent {
  studentId: Types.ObjectId;
  fullName: string;
  classId: Types.ObjectId;
  className: string | null;
  grade: number | null;
  score: number;
  rank: number;
  daysCount: number;
  scoresCount: number;
}

export interface IRatingResultClass {
  classId: Types.ObjectId;
  name: string;
  grade: number;
  score: number;
  rank: number;
  ratedStudents: number;
}

/**
 * Reyting davrining muzlatilgan (e'lon qilingan) yakuniy natijasi. Faqat reytingga kirgan
 * (eligible, rank bor) o'quvchilar saqlanadi. Yozilgach o'zgarmaydi.
 */
export interface IRatingResult {
  schoolId: Types.ObjectId;
  periodType: string;
  /** rating.period dagi kalit (week:2026-11-09, month:2026-11 ...) */
  periodKey: string;
  /** Davr boshi */
  from: string;
  /** Muzlatilgan oraliqning oxiri (e'lon kuni; davr oxiridan oshmaydi) */
  to: string;
  /** Davrning to'liq oxiri (to <= periodTo) */
  periodTo: string;
  label: string;
  announcedAt: Date;
  /** Qo'lda (superadmin) e'lon qilingan */
  manual: boolean;
  settings: {
    method: string;
    weights: { conduct: number; subjects: number };
    minScoresCount: number;
    tieBreak: string[];
  };
  studentsCount: number;
  classesCount: number;
  students: IRatingResultStudent[];
  classes: IRatingResultClass[];
  /** Yumshoq o'chirish (tombstone): o'chirilgan arxiv ro'yxat/ochiq saytda ko'rinmaydi, lekin (schoolId, periodKey) ni band qilib turadi — minutlik vazifa qayta yaratmaydi. Eski hujjatlarda maydon yo'q. */
  deletedAt?: Date | null;
  deletedBy?: Types.ObjectId | null;
}

const studentSub = new Schema<IRatingResultStudent>(
  {
    studentId: { type: Schema.Types.ObjectId, required: true },
    fullName: { type: String, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    className: { type: String, default: null },
    grade: { type: Number, default: null },
    score: { type: Number, required: true },
    rank: { type: Number, required: true },
    daysCount: { type: Number, default: 0 },
    scoresCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const classSub = new Schema<IRatingResultClass>(
  {
    classId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    grade: { type: Number, required: true },
    score: { type: Number, required: true },
    rank: { type: Number, required: true },
    ratedStudents: { type: Number, default: 0 },
  },
  { _id: false },
);

const ratingResultSchema = new Schema<IRatingResult>(
  {
    schoolId: { type: Schema.Types.ObjectId, required: true },
    periodType: { type: String, required: true },
    periodKey: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    periodTo: { type: String, required: true },
    label: { type: String, required: true },
    announcedAt: { type: Date, required: true },
    manual: { type: Boolean, default: false },
    settings: { type: Schema.Types.Mixed, required: true },
    studentsCount: { type: Number, default: 0 },
    classesCount: { type: Number, default: 0 },
    students: { type: [studentSub], default: [] },
    classes: { type: [classSub], default: [] },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { versionKey: false },
);

ratingResultSchema.index({ schoolId: 1, periodKey: 1 }, { unique: true });
ratingResultSchema.index({ schoolId: 1, announcedAt: -1 });

export const RatingResult = model<IRatingResult>('RatingResult', ratingResultSchema);
