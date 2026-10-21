import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './academic-years.controller';
import { createBody, updateBody } from './academic-years.schema';

export const academicYearsRouter = Router();

academicYearsRouter.use(authenticate);

// O'qish: barcha maktab rollari
academicYearsRouter.get('/', tenant, c.list);

// Yozish: classes.manage
const write = [
  authorize('superadmin', 'school_admin'),
  requirePermission('classes.manage'),
  tenant,
];
academicYearsRouter.post('/', ...write, validate({ body: createBody }), c.create);
academicYearsRouter.patch('/:id', ...write, validate({ body: updateBody }), c.update);
academicYearsRouter.post('/:id/activate', ...write, c.activate);
academicYearsRouter.delete('/:id', ...write, c.remove);
