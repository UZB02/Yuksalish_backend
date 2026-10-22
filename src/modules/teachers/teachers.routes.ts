import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { uploadPhoto } from '../photos/photos.upload';
import * as c from './teachers.controller';
import {
  classesBody,
  createBody,
  listQuery,
  permissionsBody,
  resetPasswordBody,
  updateBody,
} from './teachers.schema';

export const teachersRouter = Router();

// superadmin (X-School-Id bilan) yoki teachers.manage ruxsatli school_admin
teachersRouter.use(
  authenticate,
  authorize('superadmin', 'school_admin'),
  requirePermission('teachers.manage'),
  tenant,
);

teachersRouter.get('/', validate({ query: listQuery }), c.list);
teachersRouter.post('/', validate({ body: createBody }), c.create);
teachersRouter.get('/:id', c.get);
teachersRouter.patch('/:id', validate({ body: updateBody }), c.update);
teachersRouter.put('/:id/photo', uploadPhoto, c.setPhoto);
teachersRouter.delete('/:id/photo', c.removePhoto);
teachersRouter.put('/:id/permissions', validate({ body: permissionsBody }), c.setPermissions);
teachersRouter.put('/:id/classes', validate({ body: classesBody }), c.setClasses);
teachersRouter.post('/:id/reset-password', validate({ body: resetPasswordBody }), c.resetPassword);
