import { Router } from 'express';
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
authRouter.patch(
  '/password',
  authenticate,
  validate({ body: changePasswordBody }),
  c.changePassword,
);
