import { Router } from 'express';
import { authorize } from '../../middlewares/authorize';
import { uploadPhoto } from '../photos/photos.upload';
import { authenticate } from '../../middlewares/authenticate';
import {
  loginLimiter,
  passwordResetCompleteLimiter,
  passwordResetInfoLimiter,
  passwordResetRequestIpLimiter,
  passwordResetRequestUserLimiter,
  passwordResetVerifyLimiter,
  profileUpdateLimiter,
  usernameCheckLimiter,
} from '../../middlewares/rateLimiters';
import { validate } from '../../middlewares/validate';
import * as c from './auth.controller';
import {
  changePasswordBody,
  loginBody,
  passwordResetCompleteBody,
  passwordResetRequestBody,
  passwordResetVerifyBody,
  updateMeBody,
  usernameAvailableQuery,
} from './auth.schema';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validate({ body: loginBody }), c.login);
authRouter.post('/refresh', loginLimiter, c.refresh);
authRouter.post('/logout', c.logout);
authRouter.post('/logout-all', authenticate, c.logoutAll);
authRouter.get('/me', authenticate, c.me);
authRouter.patch(
  '/me',
  authenticate,
  profileUpdateLimiter,
  validate({ body: updateMeBody }),
  c.updateMe,
);
authRouter.get(
  '/username-available',
  authenticate,
  usernameCheckLimiter,
  validate({ query: usernameAvailableQuery }),
  c.usernameAvailable,
);
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

// Parolni Telegram bot orqali tiklash (ommaviy; autentifikatsiyasiz)
authRouter.get('/password-reset/info', passwordResetInfoLimiter, c.passwordResetInfo);
authRouter.post(
  '/password-reset/request',
  passwordResetRequestIpLimiter,
  validate({ body: passwordResetRequestBody }),
  passwordResetRequestUserLimiter,
  c.passwordResetRequest,
);
authRouter.post(
  '/password-reset/verify',
  passwordResetVerifyLimiter,
  validate({ body: passwordResetVerifyBody }),
  c.passwordResetVerify,
);
authRouter.post(
  '/password-reset/complete',
  passwordResetCompleteLimiter,
  validate({ body: passwordResetCompleteBody }),
  c.passwordResetComplete,
);
