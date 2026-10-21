import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { tenantOptional } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './subjects.controller';
import { createBody, listQuery, updateBody } from './subjects.schema';

export const subjectsRouter = Router();

subjectsRouter.use(authenticate);

// O'qish: barcha maktab rollari (global + o'z maktabi); superadmin headersiz hammasini ko'radi
subjectsRouter.get('/', tenantOptional, validate({ query: listQuery }), c.list);

// Yozish: superadmin (global yoki istalgan maktab) yoki subjects.manage li maktab admini (faqat o'z maktabi)
const write = [authorize('superadmin', 'school_admin'), requirePermission('subjects.manage')];
subjectsRouter.post('/', ...write, validate({ body: createBody }), c.create);
subjectsRouter.patch('/:id', ...write, validate({ body: updateBody }), c.update);
subjectsRouter.post('/:id/activate', ...write, c.activate);
subjectsRouter.post('/:id/deactivate', ...write, c.deactivate);
subjectsRouter.delete('/:id', ...write, c.remove);
