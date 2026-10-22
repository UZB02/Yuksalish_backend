import { Router } from 'express';
import { authorize } from '../../middlewares/authorize';
import { uploadPhoto } from '../photos/photos.upload';
import { authenticate } from '../../middlewares/authenticate';
import { loginLimiter } from '../../middlewares/rateLimiters';
import { validate } from '../../middlewares/validate';
import * as c from './auth.controller';
import { changePasswordBody, loginBody } from './auth.schema';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validate({ body: loginBody }), c.login);
authRouter.post('/refresh', loginLimiter, c.refresh);
authRouter.post('/logout', c.logout);
authRouter.post('/logout-all', authenticate, c.logoutAll);
authRouter.get('/me', authenticate, c.me);
// O'z rasmi: faqat maktab xodimi (o'qituvchi / maktab admini), faqat o'zinikini
authRouter.put(
  '/me/photo',
  authenticate,
  authorize('teacher', 'school_admin'),
  uploadPhoto,
  c.setOwnPhoto,
);
authRouter.delete(
  '/me/photo',
  authenticate,
  authorize('teacher', 'school_admin'),
  c.removeOwnPhoto,
);
authRouter.patch(
  '/password',
  authenticate,
  validate({ body: changePasswordBody }),
  c.changePassword,
);
