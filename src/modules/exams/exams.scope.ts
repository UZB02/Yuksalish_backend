import type { Ctx } from '../../core/context';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassSubject } from '../../models/ClassSubject';

type Actor = Ctx['actor'];

/**
 * Savollar bankidagi doira:
 * - `all`: superadmin, school_admin va exams.manage li foydalanuvchi: maktabning hamma fanlari;
 * - aks holda (o'qituvchi): faqat faol o'quv yilida ClassSubject orqali o'zi o'qitadigan fanlar.
 */
export type ExamScope = { all: true } | { all: false; subjectIds: string[] };

export async function resolveExamScope(actor: Actor, schoolId: string): Promise<ExamScope> {
  if (
    actor.role === 'superadmin' ||
    actor.role === 'school_admin' ||
    actor.permissions.includes('exams.manage')
  ) {
    return { all: true };
  }
  const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  if (!year) return { all: false, subjectIds: [] };
  const ids = await ClassSubject.distinct('subjectId', {
    schoolId,
    teacherId: actor.id,
    academicYearId: year._id,
  });
  return { all: false, subjectIds: ids.map(String) };
}
