import { Types } from 'mongoose';
import { logger } from '../../core/logger';
import { TimetableVersion } from '../../models/TimetableVersion';
import { clock } from '../../utils/clock';
import { auditService } from '../audit/audit.service';

/** Almashtirilgan versiya va qoralama shuncha kundan keyin avtomatik o'chiriladi */
export const TIMETABLE_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface PurgeResult {
  /** O'chirilgan hujjatlar soni */
  deleted: number;
  replaced: number;
  drafts: number;
  /** schoolId -> o'chirilgan soni */
  bySchool: Record<string, number>;
}

/** Aniq o'chiriladigan sana (replacedAt / updatedAt + 30 kun) */
export const purgeDateOf = (from: Date): Date =>
  new Date(from.getTime() + TIMETABLE_RETENTION_DAYS * DAY_MS);

/**
 * Eskirgan dars jadvali versiyalarini qattiq o'chiradi (idempotent):
 *  - `replaced` va replacedAt 30 kundan eski;
 *  - hech qachon faollashtirilmagan qoralama (`draft`) va updatedAt 30 kundan eski.
 * `superseded`, `active` va kelajakdagi (`active`) versiyalarga TEGILMAYDI — jurnal, davomat
 * tuzatishlari, o'tgan hafta ko'rinishlari va eksport shularga tayanadi.
 * O'chirishdan oldin boshqa hujjatlardagi havolalar (`basedOnVersionId`, `replacedBy`) tozalanadi.
 * Tranzaksiya yo'q: tartib xavfsiz — avval id lar tanlanadi, havolalar tozalanadi, so'ng o'chiriladi;
 * oraliqda uzilish bo'lsa keyingi ishga tushishda davom etadi.
 */
export async function purgeStaleTimetableVersions(now: Date = clock.now()): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - TIMETABLE_RETENTION_DAYS * DAY_MS);
  const rows = await TimetableVersion.find({
    $or: [
      { status: 'replaced', replacedAt: { $type: 'date', $lt: cutoff } },
      { status: 'draft', activatedAt: null, updatedAt: { $lt: cutoff } },
    ],
  })
    .select('schoolId classId status validFrom replacedAt updatedAt entries')
    .lean();

  const result: PurgeResult = { deleted: 0, replaced: 0, drafts: 0, bySchool: {} };
  if (!rows.length) return result;

  const ids = rows.map((r) => r._id as Types.ObjectId);
  await TimetableVersion.updateMany(
    { basedOnVersionId: { $in: ids } },
    { $set: { basedOnVersionId: null } },
  );
  await TimetableVersion.updateMany(
    { replacedBy: { $in: ids }, _id: { $nin: ids } },
    { $set: { replacedBy: null } },
  );
  // Qayta tekshiruv bilan o'chirish: oraliqda holat o'zgargan bo'lsa (masalan, qoralama faollashtirilgan) tegilmaydi
  const del = await TimetableVersion.deleteMany({
    _id: { $in: ids },
    $or: [
      { status: 'replaced', replacedAt: { $lt: cutoff } },
      { status: 'draft', activatedAt: null, updatedAt: { $lt: cutoff } },
    ],
  });
  result.deleted = del.deletedCount ?? 0;

  const perSchool = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = String(r.schoolId);
    perSchool.set(k, [...(perSchool.get(k) ?? []), r]);
  }
  for (const [schoolId, list] of perSchool) {
    result.bySchool[schoolId] = list.length;
    const replaced = list.filter((r) => r.status === 'replaced');
    const drafts = list.filter((r) => r.status === 'draft');
    result.replaced += replaced.length;
    result.drafts += drafts.length;
    await auditService.log({
      userId: null,
      schoolId,
      action: 'timetable.version_purged',
      entity: 'timetable',
      entityId: null,
      before: {
        retentionDays: TIMETABLE_RETENTION_DAYS,
        replaced: replaced.length,
        drafts: drafts.length,
        versions: list.map((r) => ({
          id: String(r._id),
          classId: String(r.classId),
          status: r.status,
          validFrom: r.validFrom,
        })),
      },
    });
  }
  return result;
}

/** Ishga tushishda va keyin sutkada bir marta chaqiriladi; xato jarayonni to'xtatmaydi */
export async function runTimetablePurge(): Promise<PurgeResult | null> {
  try {
    const r = await purgeStaleTimetableVersions();
    if (r.deleted) {
      logger.info(
        { deleted: r.deleted, replaced: r.replaced, drafts: r.drafts },
        "Eskirgan dars jadvali versiyalari o'chirildi",
      );
    }
    return r;
  } catch (err) {
    logger.error({ err }, 'Dars jadvali versiyalarini tozalashda xato');
    return null;
  }
}
