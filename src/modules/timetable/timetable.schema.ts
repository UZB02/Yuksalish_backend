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
export const lessonsQuery = z.object({ classId: objectIdSchema, date: dateStrSchema });
export const optionsQuery = z.object({ classId: objectIdSchema.optional() });
export const bulkPreviewBody = z.object({
  versionIds: z.array(objectIdSchema).min(1).max(200),
  validFrom: dateStrSchema,
});
