import type { Ctx } from '../../core/context';
import type { ErrorDetail } from '../../core/errors';
import { GRADE_MAX, GRADE_MIN } from '../../models/SubjectGrade';
import type { ScoringSettings } from '../settings/scoring.settings';
import { withinEditWindow } from '../scores/scores.rules';

type Actor = Ctx['actor'];

export { checkDate } from '../scores/scores.rules';

/** Istalgan fan bahosini istalgan vaqtda o'zgartira oladimi (grades.edit) */
export const canEditAnyGrade = (a: Actor): boolean =>
  a.role === 'superadmin' || (a.role === 'school_admin' && a.permissions.includes('grades.edit'));

export const isGradeEditable = (
  grade: { teacherId: unknown; createdAt: Date },
  actor: Actor,
  s: ScoringSettings,
  now: Date,
): boolean =>
  canEditAnyGrade(actor) ||
  (String(grade.teacherId) === actor.id && withinEditWindow(grade.createdAt, s, now));

/** Baho 2–5 oralig'idagi butun son */
export function checkGradeValue(value: number): ErrorDetail[] {
  if (!Number.isInteger(value) || value < GRADE_MIN || value > GRADE_MAX) {
    return [
      {
        path: 'value',
        message: `Baho ${GRADE_MIN} dan ${GRADE_MAX} gacha butun son bo'lishi kerak`,
      },
    ];
  }
  return [];
}
