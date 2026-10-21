import { AttendanceStatus } from '../../models/AttendanceStatus';
import { nameKeyOf } from '../../utils/text';
import type { AttendanceCategory } from '../settings/attendance.settings';

export const DEFAULT_ATTENDANCE_STATUSES: {
  name: string;
  shortName: string;
  category: AttendanceCategory;
  color: string;
  isDefault: boolean;
}[] = [
  { name: 'Keldi', shortName: 'K', category: 'present', color: '#16A34A', isDefault: true },
  { name: 'Kechikdi', shortName: 'Ke', category: 'late', color: '#EAB308', isDefault: false },
  {
    name: "Sababli yo'q",
    shortName: 'S',
    category: 'absent_excused',
    color: '#2563EB',
    isDefault: false,
  },
  {
    name: "Sababsiz yo'q",
    shortName: 'Y',
    category: 'absent_unexcused',
    color: '#DC2626',
    isDefault: false,
  },
];

/** Standart global davomat holatlarini yaratadi (mavjudlariga tegmaydi) */
export async function ensureDefaultAttendanceStatuses(): Promise<number> {
  let created = 0;
  // Mavjud global standart holat bor bo'lsa, yangi standart belgilanmaydi
  const hasDefault = await AttendanceStatus.exists({ schoolId: null, isDefault: true });
  for (const [i, def] of DEFAULT_ATTENDANCE_STATUSES.entries()) {
    const nameKey = nameKeyOf(def.name);
    const res = await AttendanceStatus.updateOne(
      { schoolId: null, nameKey },
      {
        $setOnInsert: {
          ...def,
          isDefault: def.isDefault && !hasDefault,
          nameKey,
          order: i + 1,
          isActive: true,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) created++;
  }
  return created;
}
