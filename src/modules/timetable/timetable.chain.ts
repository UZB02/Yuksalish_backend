import type { Types } from 'mongoose';
import { TimetableVersion } from '../../models/TimetableVersion';
import { addDaysStr } from '../../utils/clock';

/**
 * Sinfning faollashtirilgan versiyalar zanjirini qayta hisoblaydi (idempotent):
 * - har bir versiyaning `validTo` = keyingi versiya `validFrom` dan bir kun oldin (oxirgisida null);
 * - oxirgisi `active`, qolganlari `superseded`.
 * Faqat o'zgargan hujjatlar yoziladi; qaytgan son — yangilanganlar soni.
 */
export async function rechain(classId: Types.ObjectId | string): Promise<number> {
  const rows = await TimetableVersion.find({ classId, activatedAt: { $type: 'date' } })
    .sort({ validFrom: 1 })
    .select('validFrom validTo status')
    .lean();
  const ops = [];
  for (let i = 0; i < rows.length; i++) {
    const next = rows[i + 1];
    const validTo = next ? addDaysStr(next.validFrom, -1) : null;
    const status = next ? 'superseded' : 'active';
    if (rows[i].validTo !== validTo || rows[i].status !== status) {
      ops.push({
        updateOne: { filter: { _id: rows[i]._id }, update: { $set: { validTo, status } } },
      });
    }
  }
  if (ops.length) await TimetableVersion.bulkWrite(ops);
  return ops.length;
}
