import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uploadLogo } from '../branding/branding.upload';
import * as c from './schools.controller';
import { createBody, listQuery, updateBody } from './schools.schema';

export const schoolsRouter = Router();

schoolsRouter.use(authenticate);

// Maktab logosi: superadmin istalgan maktab, school_admin faqat o'z maktabi (controllerda tekshiriladi)
const logoAccess = authorize('superadmin', 'school_admin');
// school_admin o'z maktabi ma'lumotini (logo holatini) o'qiy oladi
schoolsRouter.get('/:id', logoAccess, c.ownSchoolOnly, c.get);
schoolsRouter.post('/:id/logo', logoAccess, c.ownSchoolOnly, uploadLogo, c.setLogo);
schoolsRouter.delete('/:id/logo', logoAccess, c.ownSchoolOnly, c.deleteLogo);

schoolsRouter.use(authorize('superadmin'));

schoolsRouter.get('/', validate({ query: listQuery }), c.list);
schoolsRouter.post('/', validate({ body: createBody }), c.create);
schoolsRouter.patch('/:id', validate({ body: updateBody }), c.update);
