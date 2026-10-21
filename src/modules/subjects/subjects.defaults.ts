import { Subject } from '../../models/Subject';
import { nameKeyOf } from '../../utils/text';

export const DEFAULT_SUBJECTS: string[] = [
  'Ona tili',
  'Adabiyot',
  'Matematika',
  'Algebra',
  'Geometriya',
  'Fizika',
  'Kimyo',
  'Biologiya',
  'Tarix',
  'Geografiya',
  'Ingliz tili',
  'Rus tili',
  'Informatika',
  'Jismoniy tarbiya',
  'Tarbiya',
  'Musiqa',
  "Tasviriy san'at",
  'Texnologiya',
];

/** Standart global fanlarni yaratadi (mavjudlariga tegmaydi) */
export async function ensureDefaultSubjects(): Promise<number> {
  let created = 0;
  for (const [i, name] of DEFAULT_SUBJECTS.entries()) {
    const nameKey = nameKeyOf(name);
    const res = await Subject.updateOne(
      { schoolId: null, nameKey },
      { $setOnInsert: { name, nameKey, order: i + 1, isActive: true } },
      { upsert: true },
    );
    if (res.upsertedCount) created++;
  }
  return created;
}
