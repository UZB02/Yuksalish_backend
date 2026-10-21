import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { tenantOptional } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './behavior-types.controller';
import { createBody, listQuery, updateBody } from './behavior-types.schema';

export const behaviorTypesRouter = Router();

behaviorTypesRouter.use(authenticate);

// O'qish: barcha maktab rollari (global + o'z maktabi); superadmin headersiz hammasini ko'radi
behaviorTypesRouter.get('/', tenantOptional, validate({ query: listQuery }), c.list);

// Yozish: faqat superadmin (o'chirish yo'q — nofaol qilinadi)
behaviorTypesRouter.use(authorize('superadmin'));
behaviorTypesRouter.post('/', validate({ body: createBody }), c.create);
behaviorTypesRouter.patch('/:id', validate({ body: updateBody }), c.update);
behaviorTypesRouter.post('/:id/activate', c.activate);
behaviorTypesRouter.post('/:id/deactivate', c.deactivate);
