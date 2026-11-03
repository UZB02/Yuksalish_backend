import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { superadminActionLimiter } from '../../middlewares/rateLimiters';
import { validate } from '../../middlewares/validate';
import * as c from './superadmins.controller';
import { createBody, transferBody, updateBody } from './superadmins.schema';

export const superadminsRouter = Router();

superadminsRouter.use(authenticate, authorize('superadmin'));

// Ro'yxat — har qanday superadmin; qolganlari faqat asosiy superadmin (servisda tekshiriladi)
superadminsRouter.get('/', c.list);
superadminsRouter.post('/', superadminActionLimiter, validate({ body: createBody }), c.create);
superadminsRouter.patch('/:id', superadminActionLimiter, validate({ body: updateBody }), c.update);
superadminsRouter.post(
  '/:id/transfer-ownership',
  superadminActionLimiter,
  validate({ body: transferBody }),
  c.transferOwnership,
);
