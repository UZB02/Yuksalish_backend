import { asyncHandler } from '../../core/asyncHandler';
import { AppError } from '../../core/errors';
import { requireAnyPermission } from '../../middlewares/authorize';
import { EXAMS_KEY, type ExamsSettings } from '../settings/exams.settings';
import { settingsService } from '../settings/settings.service';

/**
 * Imtihon moduli maktab uchun yoqilganmi (`exams.enabled`, standart: o'chiq). O'chiq bo'lsa barcha
 * /exams/* endpointlari 403 qaytaradi. Zanjir: authenticate -> tenant -> requireExamsEnabled -> ruxsat.
 *
 * O'qituvchida `exams.questions` doim bor (TEACHER_BASE_PERMISSIONS), shuning uchun xavfsizlik
 * aynan shu darvoza bilan ta'minlanadi.
 */
export const requireExamsEnabled = asyncHandler(async (req, _res, next) => {
  const s = await settingsService.getEffective<ExamsSettings>(EXAMS_KEY, req.schoolId);
  if (!s.enabled) throw AppError.forbidden('Imtihon moduli bu maktab uchun yoqilmagan');
  next();
});

/** Savollar bankiga kirish: exams.questions yoki exams.manage (superadmin o'tadi) */
export const requireQuestionsAccess = requireAnyPermission('exams.questions', 'exams.manage');
