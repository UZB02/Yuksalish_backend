import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx, reqMeta } from '../../core/context';
import { ok } from '../../core/response';
import { authService } from './auth.service';

export const REFRESH_COOKIE = 'refreshToken';

const cookieBase: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProd,
  path: '/api/v1/auth',
};

const setRefreshCookie = (res: Response, token: string) =>
  res.cookie(REFRESH_COOKIE, token, {
    ...cookieBase,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });

const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, cookieBase);

export const login = asyncHandler(async (req, res) => {
  const { accessToken, refreshToken, user } = await authService.login(req.body, reqMeta(req));
  setRefreshCookie(res, refreshToken);
  ok(res, { accessToken, user });
});

export const refresh = asyncHandler(async (req, res) => {
  try {
    const { accessToken, refreshToken, user } = await authService.refresh(
      req.cookies?.[REFRESH_COOKIE],
      reqMeta(req),
    );
    setRefreshCookie(res, refreshToken);
    ok(res, { accessToken, user });
  } catch (e) {
    clearRefreshCookie(res);
    throw e;
  }
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  ok(res, { loggedOut: true });
});

export const logoutAll = asyncHandler(async (req, res) => {
  await authService.logoutAll(getCtx(req));
  clearRefreshCookie(res);
  ok(res, { loggedOut: true });
});

export const me = asyncHandler(async (req, res) => {
  ok(res, await authService.me(getCtx(req).actor.id));
});

export const setOwnPhoto = asyncHandler(async (req, res) => {
  ok(res, await authService.setOwnPhoto(getCtx(req), req.file));
});

export const removeOwnPhoto = asyncHandler(async (req, res) => {
  ok(res, await authService.removeOwnPhoto(getCtx(req)));
});

export const changePassword = asyncHandler(async (req, res) => {
  const data = await authService.changePassword(
    getCtx(req),
    req.body,
    req.cookies?.[REFRESH_COOKIE],
  );
  ok(res, data);
});
