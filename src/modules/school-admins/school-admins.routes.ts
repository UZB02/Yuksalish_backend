import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import * as c from './school-admins.controller';
import {
  createBody,
  listQuery,
  permissionsBody,
  resetPasswordBody,
  updateBody,
} from './school-admins.schema';

export const schoolAdminsRouter = Router();

schoolAdminsRouter.use(authenticate, authorize('superadmin'));

schoolAdminsRouter.get('/', validate({ query: listQuery }), c.list);
schoolAdminsRouter.post('/', validate({ body: createBody }), c.create);
schoolAdminsRouter.get('/:id', c.get);
schoolAdminsRouter.patch('/:id', validate({ body: updateBody }), c.update);
schoolAdminsRouter.put('/:id/permissions', validate({ body: permissionsBody }), c.setPermissions);
schoolAdminsRouter.post(
  '/:id/reset-password',
  validate({ body: resetPasswordBody }),
  c.resetPassword,
);
