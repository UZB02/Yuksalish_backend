import type { ErrorDetail } from '../../core/errors';
import type { BehaviorTypeDoc } from '../../models/BehaviorType';
import type { Ctx } from '../../core/context';
import { addDaysStr } from '../../utils/clock';
import type { ScoringSettings } from '../settings/scoring.settings';

type Actor = Ctx['actor'];

/** Istalgan bahoni istalgan vaqtda o'zgartira oladimi (scores.edit) */
export const canEditAny = (a: Actor): boolean =>
  a.role === 'superadmin' || (a.role === 'school_admin' && a.permissions.includes('scores.edit'));

/** Baho yaratilganidan boshlab tahrir oynasi ichidami */
export const withinEditWindow = (createdAt: Date, s: ScoringSettings, now: Date): boolean =>
  now.getTime() - createdAt.getTime() <= s.editWindowHours * 3_600_000;

export const isEditable = (
  score: { teacherId: unknown; createdAt: Date },
  actor: Actor,
  s: ScoringSettings,
  now: Date,
): boolean =>
  canEditAny(actor) ||
  (String(score.teacherId) === actor.id && withinEditWindow(score.createdAt, s, now));

/** Sana: kelajakda emas va backdateDays dan eski emas */
export function checkDate(s: ScoringSettings, date: string, today: string): ErrorDetail[] {
  if (date > today) return [{ path: 'date', message: "Kelajak sanasiga baho qo'yib bo'lmaydi" }];
  if (date < addDaysStr(today, -s.backdateDays)) {
    return [
      {
        path: 'date',
        message: `Baho ko'pi bilan ${s.backdateDays} kun oldingi sanaga qo'yilishi mumkin`,
      },
    ];
  }
  return [];
}

export interface ScoreValues {
  value: number;
  behaviorTypeId: string | null;
  comment: string | null;
}

/**
 * Ball, xulq turi va izoh qoidalarini tekshiradi.
 * @param keepInactiveId tahrirda o'zgarmagan (eski, nofaol bo'lib qolgan) tur ruxsat etiladi
 */
export function checkValues(
  s: ScoringSettings,
  v: ScoreValues,
  types: Map<string, BehaviorTypeDoc>,
  keepInactiveId: string | null = null,
): ErrorDetail[] {
  const errs: ErrorDetail[] = [];
  if (!Number.isInteger(v.value) || v.value < s.minScore || v.value > s.maxScore) {
    errs.push({
      path: 'value',
      message: `Ball ${s.minScore} dan ${s.maxScore} gacha butun son bo'lishi kerak`,
    });
  }
  if (!v.behaviorTypeId) {
    if (s.requireBehaviorType) errs.push({ path: 'behaviorTypeId', message: 'Xulq turi majburiy' });
  } else {
    const t = types.get(v.behaviorTypeId);
    if (!t) errs.push({ path: 'behaviorTypeId', message: 'Xulq turi topilmadi' });
    else if (!t.isActive && v.behaviorTypeId !== keepInactiveId) {
      errs.push({ path: 'behaviorTypeId', message: 'Xulq turi faol emas' });
    }
  }
  if (s.commentRequiredBelow !== null && v.value < s.commentRequiredBelow && !v.comment) {
    errs.push({
      path: 'comment',
      message: `Ball ${s.commentRequiredBelow} dan past bo'lganda izoh majburiy`,
    });
  }
  return errs;
}
