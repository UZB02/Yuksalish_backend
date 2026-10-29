import { Router, type RequestHandler, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { auditService } from '../audit/audit.service';
import {
  contentDisposition,
  contentTypeOf,
  safeFileName,
  type ExportFormat,
} from '../reports/reports.files';
import { renderJournalExcel, renderJournalPdf } from './journal.export';
import { gridQuery, type GridQuery } from './journal.schema';
import { journalService } from './journal.service';

export const journalRouter = Router();

journalRouter.use(authenticate, authorize('superadmin', 'school_admin', 'teacher'));

/**
 * Jurnalni ko'rish: o'qituvchi (sinf/fan bo'yicha servisda cheklanadi);
 * maktab admini uchun grades.create, grades.edit yoki reports.view dan biri kerak.
 * Eksport ham xuddi shu huquq bilan (alohida reports.export talab qilinmaydi; audit esa reports.export).
 */
const viewGuard: RequestHandler = (req, _res, next) => {
  const u = req.user;
  if (u?.role !== 'school_admin') return next();
  const ok = ['grades.create', 'grades.edit', 'reports.view'].some((p) =>
    u.permissions.includes(p),
  );
  return ok ? next() : next(AppError.forbidden());
};

const send = (res: Response, name: string, format: ExportFormat, buf: Buffer) => {
  res.set({
    'Content-Type': contentTypeOf(format),
    'Content-Disposition': contentDisposition(name),
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  });
  res.send(buf);
};

journalRouter.get(
  '/options',
  viewGuard,
  tenant,
  asyncHandler(async (req, res) => {
    ok(res, await journalService.options(getCtx(req).actor, req.schoolId as string));
  }),
);

journalRouter.get(
  '/subject',
  viewGuard,
  tenant,
  validate({ query: gridQuery }),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await journalService.grid(getCtx(req).actor, req.schoolId as string, req.query as never),
    );
  }),
);

function exporter(format: ExportFormat): RequestHandler[] {
  return [
    viewGuard,
    tenant,
    validate({ query: gridQuery }),
    asyncHandler(async (req, res) => {
      const ctx = getCtx(req);
      const q = req.query as unknown as GridQuery;
      const grid = await journalService.grid(ctx.actor, req.schoolId as string, q);
      const buf = format === 'pdf' ? await renderJournalPdf(grid) : await renderJournalExcel(grid);
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: req.schoolId as string,
        action: 'reports.export',
        entity: 'report',
        entityId: 'journal_subject',
        after: {
          type: 'journal_subject',
          format,
          params: { classId: q.classId, subjectId: q.subjectId, from: q.from, to: q.to },
          rowCount: grid.students.length,
        },
        ip: ctx.ip,
      });
      send(
        res,
        safeFileName(`jurnal-${grid.class.name}-${grid.subject.name}`, q.from, q.to, format),
        format,
        buf,
      );
    }),
  ];
}

journalRouter.get('/subject/export.xlsx', ...exporter('xlsx'));
journalRouter.get('/subject/export.pdf', ...exporter('pdf'));
