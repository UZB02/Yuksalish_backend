import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requireAnyPermission, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './students.controller';
import { studentSummary as attendanceStudentSummary } from '../attendance/attendance.controller';
import { rangeQuery as attendanceRangeQuery } from '../attendance/attendance.schema';
import { studentSummary } from '../scores/scores.controller';
import { summaryQuery } from '../scores/scores.schema';
import { studentSummary as gradeStudentSummary } from '../grades/grades.controller';
import { summaryQuery as gradeSummaryQuery } from '../grades/grades.schema';
import {
  confirmBody,
  createBody,
  exportQuery,
  listQuery,
  previewBody,
  transferBody,
  updateBody,
} from './students.schema';
import { uploadXlsx } from './students.upload';

export const studentsRouter = Router();

studentsRouter.use(authenticate);

// O'qish: students.view yoki scores.create (o'qituvchi faqat o'z sinflari)
const read = [requireAnyPermission('students.view', 'scores.create'), tenant];
// Yozish: students.manage
const write = [
  authorize('superadmin', 'school_admin'),
  requirePermission('students.manage'),
  tenant,
];

// Statik yo'llar /:id dan oldin
studentsRouter.get('/export', ...read, validate({ query: exportQuery }), c.exportXlsx);
studentsRouter.get('/import/template', ...write, c.importTemplate);
studentsRouter.post(
  '/import/preview',
  ...write,
  uploadXlsx,
  validate({ body: previewBody }),
  c.importPreview,
);
studentsRouter.post('/import/confirm', ...write, validate({ body: confirmBody }), c.importConfirm);
studentsRouter.get('/import/:importId/errors', ...write, c.importErrors);

studentsRouter.get('/', ...read, validate({ query: listQuery }), c.list);
studentsRouter.post('/', ...write, validate({ body: createBody }), c.create);
studentsRouter.get('/:id', ...read, c.get);
studentsRouter.get(
  '/:id/attendance-summary',
  requireAnyPermission('attendance.view', 'attendance.take', 'students.view'),
  tenant,
  validate({ query: attendanceRangeQuery }),
  attendanceStudentSummary,
);
studentsRouter.get(
  '/:id/score-summary',
  requireAnyPermission('students.view', 'scores.create', 'scores.edit', 'reports.view'),
  tenant,
  validate({ query: summaryQuery }),
  studentSummary,
);
studentsRouter.get(
  '/:id/grade-summary',
  requireAnyPermission(
    'students.view',
    'scores.create',
    'grades.create',
    'grades.edit',
    'reports.view',
  ),
  tenant,
  validate({ query: gradeSummaryQuery }),
  gradeStudentSummary,
);
studentsRouter.patch('/:id', ...write, validate({ body: updateBody }), c.update);
studentsRouter.delete('/:id', ...write, c.remove);
studentsRouter.post('/:id/transfer', ...write, validate({ body: transferBody }), c.transfer);
