import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorDetail } from '../../core/errors';
import { AcademicYear, type AcademicYearDoc } from '../../models/AcademicYear';
import { ClassModel } from '../../models/Class';
import { fmtDate } from '../../utils/dates';
import { isDuplicateKeyError, isId } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';

export const toYearDto = (y: AcademicYearDoc) => ({
  id: y.id,
  name: y.name,
  startDate: fmtDate(y.startDate),
  endDate: fmtDate(y.endDate),
  isActive: y.isActive,
  periods: y.periods.map((p) => ({
    id: String(p._id),
    name: p.name,
    startDate: fmtDate(p.startDate),
    endDate: fmtDate(p.endDate),
  })),
  createdAt: y.createdAt,
});

interface PeriodInput {
  id?: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

/** startDate<endDate; davrlar yil ichida va o'zaro kesishmaydi */
function validateDates(startDate: Date, endDate: Date, periods: PeriodInput[]) {
  const errs: ErrorDetail[] = [];
  if (startDate >= endDate) {
    errs.push({
      path: 'endDate',
      message: "Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak",
    });
  }
  periods.forEach((p, i) => {
    if (p.startDate >= p.endDate) {
      errs.push({
        path: `periods.${i}.endDate`,
        message: "Davr tugash sanasi boshlanish sanasidan keyin bo'lishi kerak",
      });
    }
    if (p.startDate < startDate || p.endDate > endDate) {
      errs.push({ path: `periods.${i}`, message: "Davr o'quv yili ichida bo'lishi kerak" });
    }
  });
  const sorted = periods.map((p, i) => ({ ...p, i })).sort((a, b) => +a.startDate - +b.startDate);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].startDate <= sorted[k - 1].endDate) {
      errs.push({
        path: `periods.${sorted[k].i}`,
        message: 'Davrlar bir-biri bilan kesishmasligi kerak',
      });
    }
  }
  if (errs.length) throw AppError.validation("Ma'lumotlar noto'g'ri", errs);
}

const toPeriods = (periods: PeriodInput[]) =>
  periods.map((p) => ({
    ...(p.id ? { _id: new Types.ObjectId(p.id) } : {}),
    name: p.name,
    startDate: p.startDate,
    endDate: p.endDate,
  }));

const snapshot = (y: AcademicYearDoc) => {
  const { id: _id, createdAt: _c, ...rest } = toYearDto(y);
  return rest;
};

async function findOrFail(schoolId: string, id: string): Promise<AcademicYearDoc> {
  const year = isId(id) ? await AcademicYear.findOne({ _id: id, schoolId }) : null;
  if (!year) throw AppError.notFound("O'quv yili topilmadi");
  return year;
}

const nameTaken = () =>
  AppError.conflict("Bu nomli o'quv yili mavjud", [{ path: 'name', message: 'Bu nom band' }]);

export const academicYearsService = {
  async list(schoolId: string) {
    const years = await AcademicYear.find({ schoolId }).sort({ startDate: -1 });
    return years.map(toYearDto);
  },

  async create(
    ctx: Ctx,
    schoolId: string,
    input: { name: string; startDate: Date; endDate: Date; periods: PeriodInput[] },
  ) {
    validateDates(input.startDate, input.endDate, input.periods);
    if (await AcademicYear.exists({ schoolId, name: input.name })) throw nameTaken();

    let year: AcademicYearDoc;
    try {
      year = await AcademicYear.create({
        schoolId,
        name: input.name,
        startDate: input.startDate,
        endDate: input.endDate,
        periods: toPeriods(input.periods),
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'academic_year.create',
      entity: 'academic_year',
      entityId: year.id,
      after: snapshot(year),
      ip: ctx.ip,
    });
    return toYearDto(year);
  },

  async update(
    ctx: Ctx,
    schoolId: string,
    id: string,
    patch: { name?: string; startDate?: Date; endDate?: Date; periods?: PeriodInput[] },
  ) {
    const year = await findOrFail(schoolId, id);
    const before = snapshot(year);
    const startDate = patch.startDate ?? year.startDate;
    const endDate = patch.endDate ?? year.endDate;
    const periods =
      patch.periods ??
      year.periods.map((p) => ({
        id: String(p._id),
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
      }));
    validateDates(startDate, endDate, periods);

    if (patch.name && patch.name !== year.name) {
      if (await AcademicYear.exists({ schoolId, name: patch.name, _id: { $ne: year._id } }))
        throw nameTaken();
      year.name = patch.name;
    }
    year.startDate = startDate;
    year.endDate = endDate;
    if (patch.periods) year.set('periods', toPeriods(patch.periods));
    try {
      await year.save();
    } catch (e) {
      if (isDuplicateKeyError(e)) throw nameTaken();
      throw e;
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'academic_year.update',
      entity: 'academic_year',
      entityId: year.id,
      before,
      after: snapshot(year),
      ip: ctx.ip,
    });
    return toYearDto(year);
  },

  /** Faol yilni almashtiradi: avval boshqalar nofaol qilinadi, so'ng bu yil (partial unique indeks himoyasi bilan) */
  async activate(ctx: Ctx, schoolId: string, id: string) {
    const year = await findOrFail(schoolId, id);
    if (!year.isActive) {
      const previous = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id name');
      await AcademicYear.updateMany(
        { schoolId, isActive: true, _id: { $ne: year._id } },
        { isActive: false },
      );
      year.isActive = true;
      try {
        await year.save();
      } catch (e) {
        if (isDuplicateKeyError(e))
          throw AppError.conflict("Faol yil bir vaqtda o'zgartirilmoqda, qayta urinib ko'ring");
        throw e;
      }
      await auditService.log({
        userId: ctx.actor.id,
        schoolId,
        action: 'academic_year.activate',
        entity: 'academic_year',
        entityId: year.id,
        before: { activeYear: previous ? { id: previous.id, name: previous.name } : null },
        after: { activeYear: { id: year.id, name: year.name } },
        ip: ctx.ip,
      });
    }
    return toYearDto(year);
  },

  async remove(ctx: Ctx, schoolId: string, id: string) {
    const year = await findOrFail(schoolId, id);
    if (await ClassModel.exists({ schoolId, academicYearId: year._id })) {
      throw AppError.conflict("O'quv yilida sinflar mavjud, o'chirib bo'lmaydi");
    }
    const before = snapshot(year);
    await year.deleteOne();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'academic_year.delete',
      entity: 'academic_year',
      entityId: id,
      before,
      ip: ctx.ip,
    });
  },

  async getActive(schoolId: string): Promise<AcademicYearDoc | null> {
    return AcademicYear.findOne({ schoolId, isActive: true });
  },
};
