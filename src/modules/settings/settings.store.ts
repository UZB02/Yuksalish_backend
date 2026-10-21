import { Setting } from '../../models/Setting';

/** Umumiy key-value sozlamalar ombori (scope: global | school). Yangi sozlama turlari shu orqali qo'shiladi. */
export const settingsStore = {
  async get<T>(
    scope: 'global' | 'school',
    schoolId: string | null,
    key: string,
  ): Promise<T | null> {
    const doc = await Setting.findOne({
      scope,
      schoolId: scope === 'global' ? null : schoolId,
      key,
    });
    return doc ? (doc.value as T) : null;
  },

  async set(
    scope: 'global' | 'school',
    schoolId: string | null,
    key: string,
    value: unknown,
    userId: string,
  ): Promise<void> {
    await Setting.updateOne(
      { scope, schoolId: scope === 'global' ? null : schoolId, key },
      { $set: { value, updatedBy: userId } },
      { upsert: true },
    );
  },

  async remove(scope: 'global' | 'school', schoolId: string | null, key: string): Promise<void> {
    await Setting.deleteOne({ scope, schoolId: scope === 'global' ? null : schoolId, key });
  },

  /** Berilgan kalitning barcha maktab override lari */
  async listSchoolOverrides<T>(key: string): Promise<{ schoolId: string; value: T }[]> {
    const docs = await Setting.find({ scope: 'school', key });
    return docs.map((d) => ({ schoolId: String(d.schoolId), value: d.value as T }));
  },
};
