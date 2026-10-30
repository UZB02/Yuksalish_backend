import type { Types } from 'mongoose';
import { TimetableVersion } from '../../models/TimetableVersion';
import { addDaysStr } from '../../utils/clock';

export interface RechainResult {
  /** Yangilangan hujjatlar soni */
  updated: number;
  /** Hozir `replaced` holatidagi versiyalar (id -> uni almashtirgan versiya id) */
  replaced: { id: string; replacedBy: string }[];
  /** Shu chaqiruvda yangi `replaced` bo'lganlar soni */
  newlyReplaced: number;
}

/**
 * Sinfning faollashtirilgan versiyalar zanjirini noldan qayta hisoblaydi (idempotent).
 * Qoida: "versiya o'z boshlanish sanasidan to yangilanguncha amal qiladi" — oxirgi faollashtirilgan
 * versiya o'z `validFrom` idan boshlab g'olib:
 *  1) versiyalar `activatedAt` tartibida (teng bo'lsa `_id`) ko'riladi; har biri o'zidan oldin
 *     faollashtirilgan va `validFrom >= o'z validFrom` bo'lgan versiyalarni almashtiradi (`replaced`);
 *  2) qolganlari `validFrom` bo'yicha zanjir: `validTo` = keyingisining `validFrom` dan bir kun oldin
 *     (oxirgisida null); oxirgisi `active`, qolganlari `superseded`.
 * Almashtirilgan versiya o'chirilmaydi: status `replaced`, validTo null, replacedAt/replacedBy yoziladi.
 * Faqat o'zgargan hujjatlar yoziladi.
 */
export async function rechainDetailed(classId: Types.ObjectId | string): Promise<RechainResult> {
  const rows = await TimetableVersion.find({ classId, activatedAt: { $type: 'date' } })
    .select('validFrom validTo status activatedAt replacedAt replacedBy')
    .lean();
  rows.sort(
    (a, b) =>
      (a.activatedAt as Date).getTime() - (b.activatedAt as Date).getTime() ||
      String(a._id).localeCompare(String(b._id)),
  );

  let alive: typeof rows = [];
  const replacedBy = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const keep: typeof rows = [];
    for (const w of alive) {
      if (w.validFrom >= r.validFrom) replacedBy.set(String(w._id), r);
      else keep.push(w);
    }
    keep.push(r);
    alive = keep;
  }
  alive.sort((a, b) => a.validFrom.localeCompare(b.validFrom));

  const ops = [];
  let newlyReplaced = 0;
  for (const r of rows) {
    const by = replacedBy.get(String(r._id));
    if (!by) continue;
    const same = r.status === 'replaced' && String(r.replacedBy ?? '') === String(by._id);
    if (r.status !== 'replaced') newlyReplaced++;
    if (same && r.validTo === null) continue;
    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: {
            status: 'replaced',
            validTo: null,
            replacedBy: by._id,
            replacedAt: same && r.replacedAt ? r.replacedAt : by.activatedAt,
          },
        },
      },
    });
  }
  for (let i = 0; i < alive.length; i++) {
    const r = alive[i] as (typeof rows)[number];
    const next = alive[i + 1];
    const validTo = next ? addDaysStr(next.validFrom, -1) : null;
    const status = next ? 'superseded' : 'active';
    if (r.validTo !== validTo || r.status !== status || r.replacedBy || r.replacedAt) {
      ops.push({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { validTo, status, replacedAt: null, replacedBy: null } },
        },
      });
    }
  }
  if (ops.length) await TimetableVersion.bulkWrite(ops);
  return {
    updated: ops.length,
    replaced: [...replacedBy].map(([id, by]) => ({ id, replacedBy: String(by._id) })),
    newlyReplaced,
  };
}

/** `rechainDetailed` ning qisqa shakli: yangilangan hujjatlar soni */
export async function rechain(classId: Types.ObjectId | string): Promise<number> {
  return (await rechainDetailed(classId)).updated;
}

/** Faollashtirilgan versiyasi bor barcha sinflar uchun zanjirni qayta hisoblaydi (migratsiya) */
export async function rechainAllClasses(): Promise<{ classes: number; replaced: number }> {
  const classIds = await TimetableVersion.distinct('classId', { activatedAt: { $type: 'date' } });
  let replaced = 0;
  for (const id of classIds) replaced += (await rechainDetailed(id)).newlyReplaced;
  return { classes: classIds.length, replaced };
}

/**
 * Sinfda `validFrom` (X) dan faollashtirilsa almashtiriladigan versiyalar:
 * hozir almashtirilmagan, faollashtirilgan va `validFrom >= X` (o'zi — excludeId — hisobga olinmaydi).
 */
export async function versionsToReplace(
  classId: Types.ObjectId | string,
  validFrom: string,
  excludeId?: string,
) {
  const q: Record<string, unknown> = {
    classId,
    activatedAt: { $type: 'date' },
    status: { $ne: 'replaced' },
    validFrom: { $gte: validFrom },
  };
  if (excludeId) q._id = { $ne: excludeId };
  const rows = await TimetableVersion.find(q)
    .sort({ validFrom: 1 })
    .select('validFrom validTo')
    .lean();
  return rows.map((r) => ({ id: String(r._id), validFrom: r.validFrom, validTo: r.validTo }));
}
