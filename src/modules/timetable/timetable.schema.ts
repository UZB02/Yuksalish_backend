import { z } from 'zod';
import { dateStrSchema, objectIdSchema, optionalText } from '../../core/validators';
import { MAX_LESSON_NO, MAX_WEEKDAY } from '../../models/TimetableVersion';

export const entryInput = z.object({
  weekday: z.number().int().min(1).max(MAX_WEEKDAY),
  lessonNo: z.number().int().min(1).max(MAX_LESSON_NO),
  subjectId: objectIdSchema,
  teacherId: objectIdSchema,
  /** Guruhlar hozircha qo'llab-quvvatlanmaydi: faqat null */
  groupKey: z.null({ error: "Guruhlar hozircha qo'llab-quvvatlanmaydi" }).optional(),
  room: optionalText(30),
});
export type EntryInput = z.infer<typeof entryInput>;

export const entriesInput = z.array(entryInput).max(MAX_WEEKDAY * MAX_LESSON_NO);

const note = optionalText(500);

export const classIdParams = z.object({ classId: objectIdSchema });
export const versionIdParams = z.object({ id: objectIdSchema });
export const teacherIdParams = z.object({ teacherId: objectIdSchema });

export const createVersionBody = z.object({
  validFrom: dateStrSchema.optional(),
  copyFrom: z
    .union([z.literal('active'), objectIdSchema, z.object({ classId: objectIdSchema })])
    .optional(),
  note,
});

export const updateVersionBody = z.object({
  entries: entriesInput,
  validFrom: dateStrSchema.optional(),
  note,
});

export const busyTeachersQuery = z.object({
  weekday: z.coerce.number().int().min(1).max(MAX_WEEKDAY),
  lessonNo: z.coerce.number().int().min(1).max(MAX_LESSON_NO),
  validFrom: dateStrSchema.optional(),
});
export const versionQuery = z.object({ validFrom: dateStrSchema.optional() });

const activateFields = {
  validFrom: dateStrSchema,
  force: z.boolean().optional(),
  note,
  syncAssignments: z.boolean().optional(),
  confirmPast: z.boolean().optional(),
};
export const activateBody = z.object(activateFields);
export const activateBulkBody = z.object({
  ...activateFields,
  versionIds: z.array(objectIdSchema).min(1).max(200),
});

export const correctBody = z.object({
  entries: entriesInput,
  force: z.boolean().optional(),
  note,
  syncAssignments: z.boolean().optional(),
});

export const weekQuery = z.object({ date: dateStrSchema.optional() });
export const dayQuery = z.object({ date: dateStrSchema.optional() });
export const teacherDayQuery = z.object({
  date: dateStrSchema.optional(),
  teacherId: objectIdSchema.optional(),
});
export const lessonsQuery = z.object({ classId: objectIdSchema, date: dateStrSchema });
export const optionsQuery = z.object({ classId: objectIdSchema.optional() });
export const bulkPreviewBody = z.object({
  versionIds: z.array(objectIdSchema).min(1).max(200),
  validFrom: dateStrSchema,
});

// --- P4: dars almashtirishlari ---
const lessonNoSchema = z.number().int().min(1).max(MAX_LESSON_NO);
const slotInput = z.object({ date: dateStrSchema, lessonNo: lessonNoSchema });

export const overrideDateQuery = z.object({ date: dateStrSchema });
export const freeTeachersQuery = z.object({
  date: dateStrSchema,
  lessonNo: z.coerce.number().int().min(1).max(MAX_LESSON_NO),
  subjectId: objectIdSchema.optional(),
});
export const createOverrideBody = z.object({
  classId: objectIdSchema,
  date: dateStrSchema,
  lessonNo: lessonNoSchema,
  type: z.enum(['substitute', 'replace', 'cancel', 'extra']),
  subjectId: objectIdSchema.nullish(),
  teacherId: objectIdSchema.nullish(),
  room: optionalText(30),
  reason: optionalText(200),
});
export type CreateOverrideInput = z.infer<typeof createOverrideBody>;
export const moveOverrideBody = z.object({
  classId: objectIdSchema,
  from: slotInput,
  to: slotInput,
  teacherId: objectIdSchema.nullish(),
  reason: optionalText(200),
});
export type MoveOverrideInput = z.infer<typeof moveOverrideBody>;
export const overrideIdParams = z.object({ id: objectIdSchema });
