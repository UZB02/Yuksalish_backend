import { HydratedDocument, Schema, Types, model } from 'mongoose';

export interface IPeriod {
  _id: Types.ObjectId;
  name: string;
  startDate: Date;
  endDate: Date;
}

export interface IAcademicYear {
  schoolId: Types.ObjectId;
  name: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  periods: IPeriod[];
  createdAt: Date;
  updatedAt: Date;
}
export type AcademicYearDoc = HydratedDocument<IAcademicYear>;

const periodSchema = new Schema<IPeriod>({
  name: { type: String, required: true, trim: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
});

const academicYearSchema = new Schema<IAcademicYear>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    name: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: false },
    periods: { type: [periodSchema], default: [] },
  },
  { timestamps: true },
);

academicYearSchema.index({ schoolId: 1, name: 1 }, { unique: true });
// Maktabda faqat bitta faol yil
academicYearSchema.index(
  { schoolId: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: 'one_active_year_per_school' },
);

export const AcademicYear = model<IAcademicYear>('AcademicYear', academicYearSchema);
