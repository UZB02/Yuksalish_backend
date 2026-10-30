import { SubjectGrade, LEGACY_GRADE_INDEX } from '../models/SubjectGrade';
import { logger } from '../core/logger';

/** MongoDB: NamespaceNotFound (26) yoki IndexNotFound (27) */
const isMissing = (e: unknown) => {
  const code = (e as { code?: number } | null)?.code;
  return code === 26 || code === 27;
};

/**
 * Ishga tushishda bajariladigan idempotent migratsiyalar (ensureIndexes() chaqiradi).
 * P3: SubjectGrade kuniga bitta baho -> darsga bitta baho.
 *  1) eski hujjatlarga lessonNo = 0 yoziladi (yangi unique indeksda null va 0 farq qilmasligi uchun);
 *  2) eski unique indeks (student+subject+date) o'chiriladi — aks holda bir kunda ikkinchi baho rad etiladi;
 *  3) yangi indeksni keyin ensureIndexes() yaratadi.
 */
export async function runMigrations(): Promise<void> {
  const col = SubjectGrade.collection;
  try {
    const r = await col.updateMany({ lessonNo: { $exists: false } }, { $set: { lessonNo: 0 } });
    if (r.modifiedCount) logger.info({ n: r.modifiedCount }, 'SubjectGrade.lessonNo = 0 yozildi');
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  try {
    await col.dropIndex(LEGACY_GRADE_INDEX);
    logger.info({ index: LEGACY_GRADE_INDEX }, "Eski SubjectGrade indeksi o'chirildi");
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}
