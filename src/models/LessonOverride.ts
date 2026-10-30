import { HydratedDocument, Schema, Types, model } from 'mongoose';
import { MAX_LESSON_NO } from './TimetableVersion';

export const OVERRIDE_TYPES = ['substitute', 'cancel', 'replace', 'extra'] as const;
export type LessonOverrideType = (typeof OVERRIDE_TYPES)[number];

/**
 * Bir martalik dars o'zgarishi (o'rinbosar, bekor qilish, fan almashtirish, qo'shimcha dars).
 * Sana "YYYY-MM-DD" satr (Toshkent kuni). Bir slotga (sinf, sana, dars raqami, guruh) bittadan ko'p bo'lmaydi.
 * `moveGroupId` — ko'chirishda cancel + extra juftligini bog'laydi.
 */
export interface ILessonOverride {
  schoolId: Types.ObjectId;
  classId: Types.ObjectId;
  date: string;
  lessonNo: number;
  groupKey: string | null;
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

// Bir slotga bitta o'zgarish
lessonOverrideSchema.index(
  { schoolId: 1, classId: 1, date: 1, lessonNo: 1, groupKey: 1 },
  { unique: true },
);
lessonOverrideSchema.index({ schoolId: 1, date: 1 });
lessonOverrideSchema.index({ schoolId: 1, teacherId: 1, date: 1 });
lessonOverrideSchema.index({ schoolId: 1, moveGroupId: 1 }, { sparse: true });

export const LessonOverride = model<ILessonOverride>('LessonOverride', lessonOverrideSchema);
