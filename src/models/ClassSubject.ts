import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Sinf + fan + o'qituvchi (masalan "7-A: Ingliz tili — Aliyeva"). Bir sinfda bir fanga bir nechta
 * o'qituvchi biriktirilishi mumkin: har bir (fan, o'qituvchi) juftligi alohida kurs sifatida ishlaydi.
 */
export interface IClassSubject {
  schoolId: Types.ObjectId;
  classId: Types.ObjectId;
  subjectId: Types.ObjectId;
  teacherId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
export type ClassSubjectDoc = HydratedDocument<IClassSubject>;

/** Bir o'qituvchi davridagi unique indeks (classId+subjectId) nomi — ishga tushishda o'chiriladi */
export const LEGACY_CLASS_SUBJECT_INDEX = 'classId_1_subjectId_1';
export const CLASS_SUBJECT_UNIQUE_INDEX = 'unique_class_subject_teacher';

const classSubjectSchema = new Schema<IClassSubject>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
  },
  { timestamps: true },
);

// Aynan bir xil (fan, o'qituvchi) juftligi sinfga bir marta biriktiriladi
classSubjectSchema.index(
  { classId: 1, subjectId: 1, teacherId: 1 },
  { unique: true, name: CLASS_SUBJECT_UNIQUE_INDEX },
);
classSubjectSchema.index({ schoolId: 1, teacherId: 1 });
classSubjectSchema.index({ schoolId: 1, subjectId: 1 });

export const ClassSubject = model<IClassSubject>('ClassSubject', classSubjectSchema);
