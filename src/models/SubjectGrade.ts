import { HydratedDocument, Schema, Types, model } from 'mongoose';

export const GRADE_MIN = 2;
export const GRADE_MAX = 5;

/** Fan bahosi (bilim bahosi, 2–5) */
export interface ISubjectGrade {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  /** Baho paytidagi o'quvchi sinfi (snapshot) */
  classId: Types.ObjectId;
  subjectId: Types.ObjectId;
  teacherId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  value: number;
  comment: string | null;
  /** Asia/Tashkent bo'yicha kun: YYYY-MM-DD */
  date: string;
  /** Dars raqami (dars jadvali): 0 = darsga bog'lanmagan (jadvalsiz / eski baho) */
  lessonNo: number;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type SubjectGradeDoc = HydratedDocument<ISubjectGrade>;

const subjectGradeSchema = new Schema<ISubjectGrade>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    value: { type: Number, required: true, min: GRADE_MIN, max: GRADE_MAX },
    comment: { type: String, default: null },
    date: { type: String, required: true },
    lessonNo: { type: Number, default: 0, min: 0 },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

subjectGradeSchema.index({ schoolId: 1, classId: 1, subjectId: 1, date: 1 });
subjectGradeSchema.index({ schoolId: 1, date: 1 });
subjectGradeSchema.index({ schoolId: 1, studentId: 1, date: 1 });
subjectGradeSchema.index({ schoolId: 1, teacherId: 1, date: 1 });
// Bir o'quvchiga bir fandan bir darsga bitta baho (o'chirilganlar hisobga olinmaydi).
// lessonNo = 0 — jadvalsiz holat: kuniga bitta (avvalgidek).
subjectGradeSchema.index(
  { schoolId: 1, studentId: 1, subjectId: 1, date: 1, lessonNo: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: 'one_grade_per_student_subject_day_lesson',
  },
);

/** P3 dan oldingi (kuniga bitta baho) indeks nomi — mavjud bazalarda ishga tushishda o'chiriladi */
export const LEGACY_GRADE_INDEX = 'one_grade_per_student_subject_day';

export const SubjectGrade = model<ISubjectGrade>('SubjectGrade', subjectGradeSchema);
