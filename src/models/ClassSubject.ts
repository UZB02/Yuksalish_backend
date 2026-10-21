import { HydratedDocument, Schema, Types, model } from 'mongoose';

/** Sinf + fan = bitta o'qituvchi (masalan "7-A: Matematika — Aliyev") */
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

// Sinfdagi har bir fanga bittadan o'qituvchi
classSubjectSchema.index({ classId: 1, subjectId: 1 }, { unique: true });
classSubjectSchema.index({ schoolId: 1, teacherId: 1 });
classSubjectSchema.index({ schoolId: 1, subjectId: 1 });

export const ClassSubject = model<IClassSubject>('ClassSubject', classSubjectSchema);
