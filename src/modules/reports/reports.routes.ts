import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { getCtx } from '../../core/context';
import { AppError } from '../../core/errors';
import { ok } from '../../core/response';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import { auditService } from '../audit/audit.service';
import { renderExcel } from './reports.excel';
import {
  contentDisposition,
  contentTypeOf,
  safeFileName,
  type ExportFormat,
} from './reports.files';
import { renderPdf } from './reports.pdf';
import { REPORTS, type ReportDef } from './reports.registry';

export const reportsRouter = Router();

reportsRouter.use(authenticate);

const formatSchema = z.enum(['xlsx', 'pdf']);

/** `format` so'rov parametrini validate() dan oldin ajratib oladi (hisobot sxemasi uni olib tashlaydi) */
const readFormat: RequestHandler = (req, res, next) => {
  const parsed = formatSchema.safeParse(req.query.format ?? 'xlsx');
  if (!parsed.success) {
    return next(
      AppError.validation("Format noto'g'ri", [
        { path: 'format', message: "format 'xlsx' yoki 'pdf' bo'lishi kerak" },
      ]),
    );
  }
  res.locals.format = parsed.data;
  next();
};

const idOf = (req: { params: Record<string, unknown> }) =>
  req.params.id ? String(req.params.id) : undefined;
const schoolOf = (def: ReportDef, req: { schoolId?: string }) =>
  def.schoolScoped ? (req.schoolId as string) : null;

function guards(def: ReportDef, exporting: boolean): RequestHandler[] {
  const roles = def.superOnly
    ? (['superadmin'] as const)
    : def.teacherAllowed
      ? (['superadmin', 'school_admin', 'teacher'] as const)
      : (['superadmin', 'school_admin'] as const);
  const chain: RequestHandler[] = [
    authorize(...roles),
    requirePermission(exporting ? 'reports.export' : 'reports.view'),
  ];
  // Eksportda ko'rish ruxsati ham shart
  if (exporting) chain.splice(1, 0, requirePermission('reports.view'));
  if (def.schoolScoped) chain.push(tenant);
  return chain;
}

function send(res: Response, name: string, format: ExportFormat, buf: Buffer) {
  res.set({
    'Content-Type': contentTypeOf(format),
    'Content-Disposition': contentDisposition(name),
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  });
  res.send(buf);
}

for (const def of REPORTS) {
  // JSON
  reportsRouter.get(
    def.path,
    ...guards(def, false),
    validate({ query: def.schema }),
    asyncHandler(async (req, res) => {
      const r = await def.run(getCtx(req).actor, schoolOf(def, req), req.query as never, idOf(req));
      ok(res, r.data);
    }),
  );

  // Eksport: Excel / PDF
  reportsRouter.get(
    `${def.path}/export`,
    ...guards(def, true),
    readFormat,
    validate({ query: def.schema }),
    asyncHandler(async (req, res) => {
      const format = res.locals.format as ExportFormat;
      const ctx = getCtx(req);
      const q = req.query as unknown as Record<string, string>;
      const r = await def.run(ctx.actor, schoolOf(def, req), q, idOf(req));
      const buf = format === 'pdf' ? await renderPdf(r.layout) : await renderExcel(r.layout);
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: schoolOf(def, req),
        action: 'reports.export',
        entity: 'report',
        entityId: def.key,
        after: { type: def.key, format, params: r.params, rowCount: r.rowCount },
        ip: ctx.ip,
      });
      send(res, safeFileName(r.layout.fileBase, q.from, q.to, format), format, buf);
    }),
  );
}
