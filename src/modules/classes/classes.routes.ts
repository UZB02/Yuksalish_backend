import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize, requireAnyPermission, requirePermission } from '../../middlewares/authorize';
import { tenant } from '../../middlewares/tenant';
import { validate } from '../../middlewares/validate';
import * as c from './classes.controller';
import { sheet as attendanceSheet } from '../attendance/attendance.controller';
import { sheetQuery as attendanceSheetQuery } from '../attendance/attendance.schema';
import { scoringSheet } from '../scores/scores.controller';
import { sheetQuery } from '../scores/scores.schema';
import { createBody, listQuery, subjectsBody, teachersBody, updateBody } from './classes.schema';

export const classesRouter = Router();

classesRouter.use(authenticate);

// O'qish: o'qituvchi (faqat o'z sinflari) yoki tegishli ruxsatli admin
const read = [requireAnyPermission('classes.manage', 'students.view', 'scores.create'), tenant];
classesRouter.get('/', ...read, validate({ query: listQuery }), c.list);
classesRouter.get('/:id', ...read, c.get);

// Baholash varag'i (scores.create yoki scores.edit; o'qituvchi faqat biriktirilgan sinf)
// Davomat varag'i (attendance.take | attendance.view | attendance.edit; o'qituvchi faqat biriktirilgan sinf)
classesRouter.get(
  '/:id/attendance-sheet',
  requireAnyPermission('attendance.take', 'attendance.view', 'attendance.edit'),
  tenant,
  validate({ query: attendanceSheetQuery }),
  attendanceSheet,
);

classesRouter.get(
  '/:id/scoring-sheet',
  requireAnyPermission('scores.create', 'scores.edit'),
  tenant,
  validate({ query: sheetQuery }),
  scoringSheet,
);

// Yozish: classes.manage
const write = [
  authorize('superadmin', 'school_admin'),
  requirePermission('classes.manage'),
  tenant,
];
classesRouter.post('/', ...write, validate({ body: createBody }), c.create);
classesRouter.patch('/:id', ...write, validate({ body: updateBody }), c.update);
classesRouter.post('/:id/archive', ...write, c.archive);
classesRouter.post('/:id/unarchive', ...write, c.unarchive);
classesRouter.put('/:id/subjects', ...write, validate({ body: subjectsBody }), c.setSubjects);
classesRouter.put('/:id/teachers', ...write, validate({ body: teachersBody }), c.setTeachers);
