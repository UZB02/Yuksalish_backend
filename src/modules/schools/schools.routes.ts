import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import * as c from './schools.controller';
import { createBody, listQuery, updateBody } from './schools.schema';

export const schoolsRouter = Router();

schoolsRouter.use(authenticate, authorize('superadmin'));

schoolsRouter.get('/', validate({ query: listQuery }), c.list);
schoolsRouter.post('/', validate({ body: createBody }), c.create);
schoolsRouter.get('/:id', c.get);
schoolsRouter.patch('/:id', validate({ body: updateBody }), c.update);
