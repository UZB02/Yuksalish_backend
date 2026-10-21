import { HydratedDocument, Schema, Types, model } from 'mongoose';

export interface IClass {
  schoolId: Types.ObjectId;
  name: string;
  grade: number;
  section: string | null;
  academicYearId: Types.ObjectId;
  homeroomTeacherId: Types.ObjectId | null;
  teacherIds: Types.ObjectId[];
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type ClassDoc = HydratedDocument<IClass>;

const classSchema = new Schema<IClass>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    name: { type: String, required: true, trim: true },
    grade: { type: Number, required: true, min: 1, max: 11 },
    section: { type: String, trim: true, default: null },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    homeroomTeacherId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    teacherIds: { type: [Schema.Types.ObjectId], default: [] },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

classSchema.index({ schoolId: 1, academicYearId: 1, name: 1 }, { unique: true });
classSchema.index({ schoolId: 1, teacherIds: 1 });

export const ClassModel = model<IClass>('Class', classSchema);
