import { HydratedDocument, Schema, Types, model } from 'mongoose';
import { MAX_LESSON_NO } from './TimetableVersion';

/** Bir slotga bitta o'zgarish davridagi unique indeks nomi — ishga tushishda o'chiriladi */
export const LEGACY_OVERRIDE_INDEX = 'schoolId_1_classId_1_date_1_lessonNo_1_groupKey_1';
export const OVERRIDE_UNIQUE_INDEX = 'unique_override_per_lesson';

export const OVERRIDE_TYPES = ['substitute', 'cancel', 'replace', 'extra'] as const;
export type LessonOverrideType = (typeof OVERRIDE_TYPES)[number];

/**
 * Bir martalik dars o'zgarishi (o'rinbosar, bekor qilish, fan almashtirish, qo'shimcha dars).
 * Sana "YYYY-MM-DD" satr (Toshkent kuni). Bir slotda bir nechta dars bo'lishi mumkin (bir sinfda bir vaqtda
 * bir nechta o'qituvchi), shuning uchun o'zgartirish aniq bir darsga qaratiladi: `targetTeacherId` —
 * jadvaldagi ASL dars o'qituvchisi (substitute/replace/cancel), extra uchun qo'shilayotgan dars o'qituvchisi.
 * (Bir sinfda bir o'qituvchi bir slotda ikki marta bo'lmaydi, shuning uchun o'qituvchi darsni yagona aniqlaydi.)
 * Eski yozuvlarda target yo'q (null) — ular slotdagi birinchi darsga qo'llanadi.
 * `moveGroupId` — ko'chirishda cancel + extra juftligini bog'laydi.
 */
export interface ILessonOverride {
  schoolId: Types.ObjectId;
  classId: Types.ObjectId;
  date: string;
  lessonNo: number;
  groupKey: string | null;
  /** Qaysi darsga qaratilgan: asl (jadval) dars o'qituvchisi / qo'shimcha dars o'qituvchisi */
  targetTeacherId: Types.ObjectId | null;
  targetSubjectId: Types.ObjectId | null;
  type: LessonOverrideType;
  subjectId: Types.ObjectId | null;
  teacherId: Types.ObjectId | null;
  room: string | null;
  moveGroupId: string | null;
  reason: string | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
export type LessonOverrideDoc = HydratedDocument<ILessonOverride>;

const lessonOverrideSchema = new Schema<ILessonOverride>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    date: { type: String, required: true },
    lessonNo: { type: Number, required: true, min: 1, max: MAX_LESSON_NO },
    groupKey: { type: String, default: null },
    targetTeacherId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetSubjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    type: { type: String, enum: OVERRIDE_TYPES, required: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    room: { type: String, trim: true, default: null },
    moveGroupId: { type: String, default: null },
    reason: { type: String, trim: true, maxlength: 200, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Bir darsga (slot + o'qituvchi) bitta o'zgarish
lessonOverrideSchema.index(
  { schoolId: 1, classId: 1, date: 1, lessonNo: 1, groupKey: 1, targetTeacherId: 1 },
  { unique: true, name: OVERRIDE_UNIQUE_INDEX },
);
lessonOverrideSchema.index({ schoolId: 1, date: 1 });
lessonOverrideSchema.index({ schoolId: 1, teacherId: 1, date: 1 });
lessonOverrideSchema.index({ schoolId: 1, moveGroupId: 1 }, { sparse: true });

export const LessonOverride = model<ILessonOverride>('LessonOverride', lessonOverrideSchema);
