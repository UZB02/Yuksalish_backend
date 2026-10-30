import { HydratedDocument, Schema, Types, model } from 'mongoose';

export const TIMETABLE_STATUSES = ['draft', 'active', 'superseded'] as const;
export type TimetableStatus = (typeof TIMETABLE_STATUSES)[number];

export const MAX_WEEKDAY = 7;
export const MAX_LESSON_NO = 12;

export interface ITimetableEntry {
  /** ISO hafta kuni: 1 = dushanba */
  weekday: number;
  lessonNo: number;
  subjectId: Types.ObjectId;
  teacherId: Types.ObjectId;
  /** Guruh kaliti (hozircha doim null; guruhlar P5 da) */
  groupKey: string | null;
  room: string | null;
}

/**
 * Sinfning dars jadvali versiyasi (yozuvlar hujjat ichida — saqlash atomik, tranzaksiyasiz).
 * Sanalar "YYYY-MM-DD" satr (Toshkent kuni). `validTo` — kesh: rechain() hisoblaydi.
 * status: draft | active (zanjirdagi oxirgi, validTo=null) | superseded (keyingi versiya bor).
 */
export interface ITimetableVersion {
  schoolId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  classId: Types.ObjectId;
  status: TimetableStatus;
  validFrom: string;
  validTo: string | null;
  weekPattern: 'weekly';
  entries: ITimetableEntry[];
  note: string | null;
  basedOnVersionId: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  activatedBy: Types.ObjectId | null;
  activatedAt: Date | null;
  /** To'qnashuv bo'lsa ham majburan faollashtirilgan */
  forced: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type TimetableVersionDoc = HydratedDocument<ITimetableVersion>;

const entrySchema = new Schema<ITimetableEntry>(
  {
    weekday: { type: Number, required: true, min: 1, max: MAX_WEEKDAY },
    lessonNo: { type: Number, required: true, min: 1, max: MAX_LESSON_NO },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    groupKey: { type: String, default: null },
    room: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const timetableVersionSchema = new Schema<ITimetableVersion>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    status: { type: String, enum: TIMETABLE_STATUSES, default: 'draft', required: true },
    validFrom: { type: String, required: true },
    validTo: { type: String, default: null },
    weekPattern: { type: String, enum: ['weekly'], default: 'weekly' },
    entries: { type: [entrySchema], default: [] },
    note: { type: String, trim: true, default: null },
    basedOnVersionId: { type: Schema.Types.ObjectId, ref: 'TimetableVersion', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    forced: { type: Boolean, default: false },
  },
  { timestamps: true },
);

timetableVersionSchema.index({ schoolId: 1, classId: 1, status: 1, validFrom: 1 });
// Faollashtirilgan (active/superseded) versiyalarda sinf uchun validFrom takrorlanmaydi
timetableVersionSchema.index(
  { classId: 1, validFrom: 1 },
  {
    unique: true,
    partialFilterExpression: { activatedAt: { $type: 'date' } },
    name: 'unique_activated_class_validfrom',
  },
);
timetableVersionSchema.index({ 'entries.teacherId': 1 });

export const TimetableVersion = model<ITimetableVersion>(
  'TimetableVersion',
  timetableVersionSchema,
);
