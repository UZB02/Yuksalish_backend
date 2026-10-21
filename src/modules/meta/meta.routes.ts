import { Router } from 'express';
import { PERMISSION_CATALOG } from '../../constants/permissions';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';

export const metaRouter = Router();

// Ruxsatlar katalogi
metaRouter.get('/permissions', authenticate, (_req, res) => {
  ok(
    res,
    PERMISSION_CATALOG.map(({ key, group, label, roles }) => ({ key, group, label, roles })),
  );
});
