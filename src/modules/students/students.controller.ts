import type { Request, Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { created, ok } from '../../core/response';
import { buildExport, buildTemplate } from './students.excel';
import { studentsImportService } from './students-import.service';
import { studentsService as s } from './students.service';

const sid = (req: Request) => req.schoolId as string;
const id = (req: Request) => String(req.params.id);

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sendXlsx = (res: Response, filename: string, buf: Buffer) => {
  res.set({
    'Content-Type': XLSX,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  });
  res.send(buf);
};

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.list(getCtx(req).actor, sid(req), req.query as never);
  ok(res, items, meta);
});
export const get = asyncHandler(async (req, res) => {
  ok(res, await s.get(getCtx(req).actor, sid(req), id(req)));
});
export const create = asyncHandler(async (req, res) => {
  created(res, await s.create(getCtx(req), sid(req), req.body));
});
export const update = asyncHandler(async (req, res) => {
  ok(res, await s.update(getCtx(req), sid(req), id(req), req.body));
});
export const remove = asyncHandler(async (req, res) => {
  await s.remove(getCtx(req), sid(req), id(req));
  ok(res, { deleted: true });
});
export const transfer = asyncHandler(async (req, res) => {
  ok(res, await s.transfer(getCtx(req), sid(req), id(req), req.body.classId));
});

export const exportXlsx = asyncHandler(async (req, res) => {
  const classId = (req.query as { classId?: string }).classId;
  const rows = await s.exportRows(getCtx(req).actor, sid(req), classId);
  sendXlsx(res, 'oquvchilar.xlsx', await buildExport(rows));
});

export const importTemplate = asyncHandler(async (_req, res) => {
  sendXlsx(res, 'oquvchilar-shablon.xlsx', await buildTemplate());
});

export const importPreview = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw AppError.validation('Fayl yuklanmagan', [
      { path: 'file', message: "'file' maydoni majburiy" },
    ]);
  }
  ok(res, await studentsImportService.preview(getCtx(req), sid(req), req.file, req.body.classId));
});

export const importConfirm = asyncHandler(async (req, res) => {
  ok(res, await studentsImportService.confirm(getCtx(req), sid(req), req.body));
});

export const importErrors = asyncHandler(async (req, res) => {
  const buf = await studentsImportService.errorsFile(
    getCtx(req),
    sid(req),
    String(req.params.importId),
  );
  sendXlsx(res, 'import-xatolar.xlsx', buf);
});
