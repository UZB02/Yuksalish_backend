import type { Request } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { created, ok } from '../../core/response';
import { buildCredentialsFile, buildTeachersTemplate } from './teachers.excel';
import { teachersImportService } from './teachers-import.service';
import { teachersService } from './teachers.service';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await teachersService.list(sid(req), req.query as never);
  ok(res, items, meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await teachersService.get(sid(req), id(req)));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await teachersService.create(getCtx(req), sid(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await teachersService.update(getCtx(req), sid(req), id(req), req.body));
});

export const setPhoto = asyncHandler(async (req, res) => {
  ok(res, await teachersService.setPhoto(getCtx(req), sid(req), id(req), req.file));
});

export const removePhoto = asyncHandler(async (req, res) => {
  ok(res, await teachersService.removePhoto(getCtx(req), sid(req), id(req)));
});

export const setPermissions = asyncHandler(async (req, res) => {
  ok(
    res,
    await teachersService.setPermissions(getCtx(req), sid(req), id(req), req.body.permissions),
  );
});

export const setClasses = asyncHandler(async (req, res) => {
  ok(res, await teachersService.setClasses(getCtx(req), sid(req), id(req), req.body.classIds));
});

export const resetPassword = asyncHandler(async (req, res) => {
  await teachersService.resetPassword(getCtx(req), sid(req), id(req), req.body.newPassword);
  ok(res, { reset: true });
});

const requireFile = (req: Request) => {
  if (!req.file) {
    throw AppError.validation('Fayl yuklanmagan', [
      { path: 'file', message: "'file' maydoni majburiy" },
    ]);
  }
  return req.file;
};

export const importTemplate = asyncHandler(async (_req, res) => {
  const buf = await buildTeachersTemplate();
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="oqituvchilar-shablon.xlsx"',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  });
  res.send(buf);
});

export const importPreview = asyncHandler(async (req, res) => {
  ok(res, await teachersImportService.preview(sid(req), requireFile(req)));
});

export const importConfirm = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, await teachersImportService.confirm(getCtx(req), sid(req), requireFile(req)));
});

export const importCredentials = asyncHandler(async (req, res) => {
  const rows = (req.body.rows as Parameters<typeof buildCredentialsFile>[0]).map((r) => ({
    fullName: r.fullName,
    phone: r.phone ?? null,
    login: r.login ?? null,
    password: r.password ?? null,
    status: r.status,
  }));
  const buf = await buildCredentialsFile(rows);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="login-parollar.xlsx"',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  });
  res.send(buf);
});
