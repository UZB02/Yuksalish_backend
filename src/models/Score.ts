import { HydratedDocument, Schema, Types, model } from 'mongoose';

export interface IScore {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  /** Baho paytidagi o'quvchi sinfi (snapshot) */
  classId: Types.ObjectId;
  teacherId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  behaviorTypeId: Types.ObjectId | null;
  value: number;
  comment: string | null;
  /** Asia/Tashkent bo'yicha kun: YYYY-MM-DD */
  date: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type ScoreDoc = HydratedDocument<IScore>;

const scoreSchema = new Schema<IScore>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    behaviorTypeId: { type: Schema.Types.ObjectId, ref: 'BehaviorType', default: null },
    value: { type: Number, required: true },
    comment: { type: String, default: null },
    date: { type: String, required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

scoreSchema.index({ schoolId: 1, classId: 1, date: 1 });
scoreSchema.index({ schoolId: 1, date: 1 });
scoreSchema.index({ schoolId: 1, studentId: 1, date: 1 });
scoreSchema.index({ schoolId: 1, teacherId: 1, date: 1 });
// Bir o'qituvchi bir o'quvchiga bir kunda bitta baho (o'chirilganlar hisobga olinmaydi)
scoreSchema.index(
  { schoolId: 1, studentId: 1, teacherId: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: 'one_score_per_teacher_student_day',
  },
);

export const Score = model<IScore>('Score', scoreSchema);
