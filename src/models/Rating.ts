import { Schema, Types, model } from 'mongoose';

export type RatingScope = 'student' | 'class' | 'school';

/** Reyting snapshoti (oldindan hisoblangan natija) */
export interface IRating {
  /** scope=school bo'lsa — maktabning o'zi */
  schoolId: Types.ObjectId;
  scope: RatingScope;
  refId: Types.ObjectId;
  periodKey: string;
  /** Qayta hisoblash identifikatori: faqat RatingState.calcId dagi yozuvlar "ko'rinadi" */
  calcId: string;
  score: number;
  daysCount: number;
  scoresCount: number;
  ratedStudents: number | null;
  totalStudents: number | null;
  eligible: boolean;
  /** Davomat jarimasi (faqat o'quvchi reytingi) */
  penalty: number;
  rank: number | null;
  previousRank: number | null;
  calculatedAt: Date;
  // Denormalizatsiya
  name: string;
  classId: Types.ObjectId | null;
  className: string | null;
  grade: number | null;
  slug: string | null;
}

const ratingSchema = new Schema<IRating>(
  {
    schoolId: { type: Schema.Types.ObjectId, required: true },
    scope: { type: String, enum: ['student', 'class', 'school'], required: true },
    refId: { type: Schema.Types.ObjectId, required: true },
    periodKey: { type: String, required: true },
    calcId: { type: String, required: true },
    score: { type: Number, default: 0 },
    daysCount: { type: Number, default: 0 },
    scoresCount: { type: Number, default: 0 },
    ratedStudents: { type: Number, default: null },
    totalStudents: { type: Number, default: null },
    eligible: { type: Boolean, default: false },
    penalty: { type: Number, default: 0 },
    rank: { type: Number, default: null },
    previousRank: { type: Number, default: null },
    calculatedAt: { type: Date, required: true },
    name: { type: String, default: '' },
    classId: { type: Schema.Types.ObjectId, default: null },
    className: { type: String, default: null },
    grade: { type: Number, default: null },
    slug: { type: String, default: null },
  },
  { versionKey: false },
);

ratingSchema.index({ schoolId: 1, scope: 1, periodKey: 1, rank: 1 });
ratingSchema.index({ schoolId: 1, scope: 1, calcId: 1, eligible: -1, rank: 1 });
ratingSchema.index({ scope: 1, calcId: 1, rank: 1 });

export const Rating = model<IRating>('Rating', ratingSchema);

/** Maktab yoki "maktablar" reytingining joriy (ko'rinadigan) holati */
export interface IRatingState {
  kind: 'school' | 'schools';
  schoolId: Types.ObjectId | null;
  periodKey: string;
  calcId: string;
  calculatedAt: Date;
  period: {
    type: string;
    from: string | null;
    to: string | null;
    key: string;
    label: string;
    fallback?: boolean;
  };
}

const ratingStateSchema = new Schema<IRatingState>(
  {
    kind: { type: String, enum: ['school', 'schools'], required: true },
    schoolId: { type: Schema.Types.ObjectId, default: null },
    periodKey: { type: String, required: true },
    calcId: { type: String, required: true },
    calculatedAt: { type: Date, required: true },
    period: { type: Schema.Types.Mixed, required: true },
  },
  { versionKey: false },
);
ratingStateSchema.index({ kind: 1, schoolId: 1 }, { unique: true });

export const RatingState = model<IRatingState>('RatingState', ratingStateSchema);

/** Kunlik rank tarixi (previousRank uchun) */
export interface IRatingDailyRank {
  schoolId: Types.ObjectId;
  scope: RatingScope;
  refId: Types.ObjectId;
  periodKey: string;
  date: string;
  rank: number;
}

const dailyRankSchema = new Schema<IRatingDailyRank>(
  {
    schoolId: { type: Schema.Types.ObjectId, required: true },
    scope: { type: String, enum: ['student', 'class', 'school'], required: true },
    refId: { type: Schema.Types.ObjectId, required: true },
    periodKey: { type: String, required: true },
    date: { type: String, required: true },
    rank: { type: Number, required: true },
  },
  { versionKey: false },
);
dailyRankSchema.index({ schoolId: 1, scope: 1, periodKey: 1, date: 1 });
dailyRankSchema.index({ schoolId: 1, scope: 1, periodKey: 1, date: 1, refId: 1 }, { unique: true });

export const RatingDailyRank = model<IRatingDailyRank>('RatingDailyRank', dailyRankSchema);
