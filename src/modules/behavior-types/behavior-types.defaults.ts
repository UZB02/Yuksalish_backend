import { BehaviorType, type BehaviorKind } from '../../models/BehaviorType';
import { nameKeyOf } from '../../utils/text';

const GREEN = '#16A34A';
const RED = '#DC2626';
const GRAY = '#6B7280';

export const DEFAULT_BEHAVIOR_TYPES: { name: string; kind: BehaviorKind; color: string }[] = [
  { name: 'Namunali xulq', kind: 'positive', color: GREEN },
  { name: 'Faollik va tashabbus', kind: 'positive', color: '#0D9488' },
  { name: "Yordam ko'rsatish", kind: 'positive', color: '#2563EB' },
  { name: 'Darsga kechikish', kind: 'negative', color: '#F59E0B' },
  { name: 'Dars paytida bezovtalik', kind: 'negative', color: '#EA580C' },
  { name: 'Forma qoidasini buzish', kind: 'negative', color: '#DB2777' },
  { name: 'Janjal/nizo', kind: 'negative', color: RED },
  { name: 'Oddiy kun', kind: 'neutral', color: GRAY },
];

/** Standart global xulq turlarini yaratadi (mavjudlariga tegmaydi) */
export async function ensureDefaultBehaviorTypes(): Promise<number> {
  let created = 0;
  for (const [i, def] of DEFAULT_BEHAVIOR_TYPES.entries()) {
    const nameKey = nameKeyOf(def.name);
    const res = await BehaviorType.updateOne(
      { schoolId: null, nameKey },
      { $setOnInsert: { ...def, nameKey, order: i + 1, isActive: true } },
      { upsert: true },
    );
    if (res.upsertedCount) created++;
  }
  return created;
}
