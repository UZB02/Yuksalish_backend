import { HydratedDocument, Schema, Types, model } from 'mongoose';
import {
  ATTENDANCE_CATEGORIES,
  type AttendanceCategory,
} from '../modules/settings/attendance.settings';

export interface IAttendanceRecord {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  /** Yozuv paytidagi o'quvchi sinfi (snapshot) */
  classId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  /** Asia/Tashkent kuni: YYYY-MM-DD */
  date: string;
  /** Kunlik rejimda 0; dars rejimida 1..lessonsPerDay */
  lessonNo: number;
  statusId: Types.ObjectId;
  /** Holat kategoriyasi (denormalizatsiya; holat kategoriyasi o'zgarmaydi) */
  category: AttendanceCategory;
  minutesLate: number | null;
  note: string | null;
  markedBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type AttendanceRecordDoc = HydratedDocument<IAttendanceRecord>;

const schema = new Schema<IAttendanceRecord>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    date: { type: String, required: true },
    lessonNo: { type: Number, default: 0 },
    statusId: { type: Schema.Types.ObjectId, ref: 'AttendanceStatus', required: true },
    category: { type: String, enum: ATTENDANCE_CATEGORIES, required: true },
    minutesLate: { type: Number, default: null },
    note: { type: String, default: null },
    markedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

schema.index({ schoolId: 1, classId: 1, date: 1, lessonNo: 1 });
schema.index({ schoolId: 1, studentId: 1, date: 1 });
schema.index(
  { schoolId: 1, studentId: 1, date: 1, lessonNo: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: 'one_attendance_per_student_unit',
  },
);

export const AttendanceRecord = model<IAttendanceRecord>('AttendanceRecord', schema);
