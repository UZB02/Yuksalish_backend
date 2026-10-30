import { HydratedDocument, Schema, Types, model } from 'mongoose';
import {
  ATTENDANCE_CATEGORIES,
  type AttendanceCategory,
} from '../modules/settings/attendance.settings';

export const ATTENDANCE_SOURCES = ['timetable', 'override', 'manual'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export interface IAttendanceRecord {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  /** Yozuv paytidagi o'quvchi sinfi (snapshot) */
  classId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  /** Asia/Tashkent kuni: YYYY-MM-DD */
  date: string;
  /** Kunlik rejimda 0; dars rejimida 1..12 (lessonsPerDay yoki jadvaldagi eng katta dars raqami) */
  lessonNo: number;
  /**
   * Dars rejimida: dars qaysi fandan bo'lgan (Subject). Kunlik rejimda va eski (fan biriktirilmagan)
   * dars yozuvlarida null.
   */
  subjectId: Types.ObjectId | null;
  /**
   * Snapshot: dars o'qituvchisi (jadvaldan aniqlangan, qo'lda olinganda o'qituvchi o'zi, aks holda null).
   * Keyingi jadval o'zgarishlari yozuvni qayta yozmaydi.
   */
  teacherId: Types.ObjectId | null;
  /** Fan/o'qituvchi qayerdan: jadval, almashtirish (override) yoki qo'lda. Kunlik va eski yozuvlarda null */
  source: AttendanceSource | null;
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
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    source: { type: String, enum: ATTENDANCE_SOURCES, default: null },
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
