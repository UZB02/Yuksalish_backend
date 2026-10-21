import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { ok } from '../../core/response';
import { objectIdSchema } from '../../core/validators';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { tenantOptional } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { SETTING_DEFS, type WriteBody } from './registry';
import { settingsService } from './settings.service';

export const settingsRouter = Router();

settingsRouter.use(authenticate);

// Har bir sozlama turi uchun: GET /settings/<key>, PUT /settings/<key> (scoring | rating | public | attendance)
for (const def of Object.values(SETTING_DEFS)) {
  const path = `/${def.key}`;

  // Barcha rollar effective ni ko'radi. Default: global hammaga, override — faqat superadmin.
  // detailAccess berilgan sozlamada (attendance) global/override faqat huquqi borlarga.
  settingsRouter.get(
    path,
    tenantOptional,
    asyncHandler(async (req, res) => {
      const actor = req.user as NonNullable<typeof req.user>;
      const detail = def.detailAccess ? def.detailAccess(actor) : actor.role === 'superadmin';
      const data = await settingsService.get(def.key, req.schoolId, detail);
      ok(res, def.detailAccess && !detail ? { ...data, global: null } : data);
    }),
  );

  const putBody = z.object({
    scope: z.enum(['global', 'school']),
    schoolId: objectIdSchema.optional(),
    values: def.valuesSchema.nullable(),
  });
  settingsRouter.put(
    path,
    authorize(...(def.writeRoles ?? ['superadmin'])),
    validate({ body: putBody }),
    asyncHandler(async (req, res) => {
      const actor = req.user as NonNullable<typeof req.user>;
      const body: WriteBody = def.guardWrite ? def.guardWrite(actor, req.body) : req.body;
      ok(res, await settingsService.put(getCtx(req), def.key, body));
    }),
  );
}
