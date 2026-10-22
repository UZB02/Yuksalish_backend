import { HydratedDocument, Schema, Types, model } from 'mongoose';

export const STUDENT_STATUSES = ['active', 'transferred', 'graduated'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];
export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

export interface IClassHistory {
  classId: Types.ObjectId;
  from: Date;
  to: Date | null;
}

export interface IStudent {
  schoolId: Types.ObjectId;
  fullName: string;
  /** Normalizatsiyalangan ism (dublikat qidirish uchun) */
  nameKey: string;
  studentCode: string | null;
  birthDate: Date | null;
  gender: Gender | null;
  classId: Types.ObjectId;
  parentPhone: string | null;
  photoUrl: string | null;
  /** Yuklangan rasm (Photo kolleksiyasi); photoUrl — eski, tashqi havola */
  photoId: Types.ObjectId | null;
  status: StudentStatus;
  classHistory: IClassHistory[];
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type StudentDoc = HydratedDocument<IStudent>;

const studentSchema = new Schema<IStudent>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    fullName: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    studentCode: { type: String, trim: true, default: null },
    birthDate: { type: Date, default: null },
    gender: { type: String, enum: GENDERS, default: null },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    parentPhone: { type: String, trim: true, default: null },
    photoUrl: { type: String, trim: true, default: null },
    photoId: { type: Schema.Types.ObjectId, ref: 'Photo', default: null },
    status: { type: String, enum: STUDENT_STATUSES, default: 'active' },
    classHistory: {
      type: [
        new Schema<IClassHistory>(
          {
            classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
            from: { type: Date, required: true },
            to: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

studentSchema.index({ schoolId: 1, classId: 1 });
studentSchema.index({ schoolId: 1, nameKey: 1, birthDate: 1 });
// ID maktab ichida unique (faqat berilgan va o'chirilmagan o'quvchilar uchun)
studentSchema.index(
  { schoolId: 1, studentCode: 1 },
  {
    unique: true,
    partialFilterExpression: { studentCode: { $type: 'string' }, isDeleted: false },
    name: 'school_student_code_unique',
  },
);

export const Student = model<IStudent>('Student', studentSchema);
