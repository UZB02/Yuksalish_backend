import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { RatingResult } from '../../models/RatingResult';
import { School } from '../../models/School';
import { addDaysStr, clock, todayTashkent } from '../../utils/clock';
import { escapeRegex } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { allowedClassIds } from '../classes/classes.service';
import { publicCache } from '../public/public.cache';
import { settingsService } from '../settings/settings.service';
import { rankChange } from './rating.calc';
import { createRatingResult } from './rating.results';
import { notifyRatingResults } from '../telegram/telegram.rating-results';
import {
  computeLive,
  findClassRatings,
  findSchoolRatings,
  findStudentRatings,
  getSchoolsSnapshot,
  getSnapshot,
  peekSnapshot,
  recalculateAll,
  recalculateSchool,
  recalculateSchools,
  resolveSchoolPeriod,
} from './ratings.service';

type Actor = Ctx['actor'];

function assertRange(from?: string, to?: string): { from: string; to: string } | null {
  if (!from && !to) return null;
  if (!from || !to) {
    throw AppError.validation("Davr to'liq emas", [
      { path: from ? 'to' : 'from', message: "'from' va 'to' birga berilishi kerak" },
    ]);
  }
  if (from > to) {
    throw AppError.validation("Davr noto'g'ri", [
      { path: 'from', message: "'from' sanasi 'to' dan keyin bo'lmasligi kerak" },
    ]);
  }
  if (addDaysStr(from, 366) < to) {
    throw AppError.validation('Davr juda uzun', [
      { path: 'to', message: 'Davr 366 kundan oshmasligi kerak' },
    ]);
  }
  return { from, to };
}

const periodOut = (p: {
  type: string;
  from: string | null;
  to: string | null;
  key?: string;
  label: string;
  fallback?: boolean;
}) => ({
  type: p.type,
  from: p.from,
  to: p.to,
  key: p.key,
  label: p.label,
  ...(p.fallback ? { fallback: true } : {}),
});

const resultMeta = (r: {
  _id: unknown;
  periodType: string;
  periodKey: string;
  label: string;
  from: string;
  to: string;
  periodTo: string;
  announcedAt: Date;
  manual: boolean;
  studentsCount: number;
  classesCount: number;
}) => ({
  id: String(r._id),
  periodType: r.periodType,
  periodKey: r.periodKey,
  label: r.label,
  from: r.from,
  to: r.to,
  periodTo: r.periodTo,
  announcedAt: r.announcedAt,
  manual: r.manual,
  studentsCount: r.studentsCount,
  classesCount: r.classesCount,
});

export const ratingsApi = {
  /** Muzlatilgan (e'lon qilingan) davr natijalari arxivi, yangisi birinchi */
  async resultsList(schoolId: string, q: { page: number; limit: number }) {
    const filter = { schoolId, deletedAt: null };
    const [docs, total] = await Promise.all([
      RatingResult.find(filter)
        .select('-students -classes')
        .sort({ announcedAt: -1, from: -1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit)
        .lean(),
      RatingResult.countDocuments(filter),
    ]);
    return { data: docs.map(resultMeta), meta: buildMeta(q.page, q.limit, total) };
  },

  /** Bitta arxiv. O'qituvchi faqat o'z sinflari qatorlarini ko'radi (o'rinlar maktab bo'yicha) */
  async resultDetail(actor: Actor, schoolId: string, id: string) {
    const doc = await RatingResult.findOne({ _id: id, schoolId, deletedAt: null }).lean();
    if (!doc) throw AppError.notFound('Yakuniy natija topilmadi');
    const scope = await allowedClassIds(actor, schoolId);
    const inScope = (classId: unknown) => !scope || scope.includes(String(classId));
    return {
      ...resultMeta(doc),
      settings: doc.settings,
      students: doc.students
        .filter((s) => inScope(s.classId))
        .map((s) => ({ ...s, studentId: String(s.studentId), classId: String(s.classId) })),
      classes: doc.classes
        .filter((c) => inScope(c.classId))
        .map((c) => ({ ...c, classId: String(c.classId) })),
    };
  },

  /** Joriy davr natijasini hoziroq (qo'lda) e'lon qilish — faqat superadmin */
  async announceNow(ctx: Ctx, schoolId: string) {
    const { period } = await resolveSchoolPeriod(schoolId);
    const today = todayTashkent();
    const to = today < period.to ? today : period.to;
    const doc = await createRatingResult(schoolId, period, to, {
      manual: true,
      replaceDeleted: true,
    });
    if (!doc) throw AppError.conflict("Bu davr natijasi allaqachon e'lon qilingan");
    await notifyRatingResults(schoolId, doc);
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'ratings.announce',
      entity: 'rating_result',
      entityId: String(doc._id),
      after: { periodKey: period.key, from: period.from, to },
      ip: ctx.ip,
    });
    return resultMeta(doc as never);
  },

  /** Arxivni yumshoq o'chirish (tombstone) — faqat superadmin. Davr avtomatik qayta e'lon qilinmaydi */
  async resultDelete(ctx: Ctx, schoolId: string, id: string) {
    const doc = await RatingResult.findOneAndUpdate(
      { _id: id, schoolId, deletedAt: null },
      { $set: { deletedAt: clock.now(), deletedBy: ctx.actor.id } },
      { projection: { students: 0, classes: 0 } },
    ).lean();
    if (!doc) throw AppError.notFound('Yakuniy natija topilmadi');
    publicCache.clear();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'ratings.results.delete',
      entity: 'rating_result',
      entityId: String(doc._id),
      before: { periodKey: doc.periodKey, label: doc.label, studentsCount: doc.studentsCount },
      ip: ctx.ip,
    });
    return { id: String(doc._id) };
  },

  async config(schoolId: string) {
    const { rating, period } = await resolveSchoolPeriod(schoolId);
    const snap = await peekSnapshot(schoolId);
    return {
      period: periodOut(period),
      settings: rating,
      calculatedAt: snap?.calculatedAt ?? null,
    };
  },

  async students(
    actor: Actor,
    schoolId: string,
    q: {
      classId?: string;
      grade?: number;
      search?: string;
      includeIneligible?: boolean;
      page: number;
      limit: number;
      from?: string;
      to?: string;
    },
  ) {
    const scope = await allowedClassIds(actor, schoolId); // o'qituvchi: faqat o'z sinflari
    const range = assertRange(q.from, q.to);

    if (range) {
      const live = await computeLive(schoolId, range.from, range.to);
      let rows = live.data.students.filter((r) => q.includeIneligible || r.eligible);
      if (scope) rows = rows.filter((r) => scope.includes(r.classId));
      if (q.classId) rows = rows.filter((r) => r.classId === q.classId);
      if (q.grade) rows = rows.filter((r) => live.classNames.get(r.classId)?.grade === q.grade);
      if (q.search) {
        const re = new RegExp(escapeRegex(q.search), 'i');
        rows = rows.filter((r) => re.test(r.fullName));
      }
      const page = rows.slice(skipOf(q.page, q.limit), skipOf(q.page, q.limit) + q.limit);
      return {
        data: {
          period: periodOut(live.period),
          calculatedAt: clock.now(),
          items: page.map((r) => ({
            rank: r.rank,
            previousRank: null,
            rankChange: null,
            studentId: r.studentId,
            fullName: r.fullName,
            classId: r.classId,
            className: live.classNames.get(r.classId)?.name ?? null,
            score: r.score,
            daysCount: r.daysCount,
            scoresCount: r.scoresCount,
            eligible: r.eligible,
            penalty: r.penalty,
            behaviorPenalty: r.behaviorPenalty,
          })),
        },
        meta: buildMeta(q.page, q.limit, rows.length),
      };
    }

    const snap = await getSnapshot(schoolId);
    const { docs, total } = await findStudentRatings(schoolId, snap.calcId, {
      classIds: scope,
      classId: q.classId,
      grade: q.grade,
      search: q.search,
      includeIneligible: q.includeIneligible,
      skip: skipOf(q.page, q.limit),
      limit: q.limit,
    });
    return {
      data: {
        period: periodOut(snap.period),
        calculatedAt: snap.calculatedAt,
        items: docs.map((d) => ({
          rank: d.rank,
          previousRank: d.previousRank,
          rankChange: rankChange(d.rank, d.previousRank),
          studentId: String(d.refId),
          fullName: d.name,
          classId: d.classId ? String(d.classId) : null,
          className: d.className,
          score: d.score,
          daysCount: d.daysCount,
          scoresCount: d.scoresCount,
          eligible: d.eligible,
          penalty: d.penalty ?? 0,
          behaviorPenalty: d.behaviorPenalty ?? 0,
        })),
      },
      meta: buildMeta(q.page, q.limit, total),
    };
  },

  async classes(actor: Actor, schoolId: string, q: { grade?: number; from?: string; to?: string }) {
    const scope = await allowedClassIds(actor, schoolId);
    const range = assertRange(q.from, q.to);
    if (range) {
      const live = await computeLive(schoolId, range.from, range.to);
      let rows = live.data.classes;
      if (scope) rows = rows.filter((c) => scope.includes(c.classId));
      if (q.grade) rows = rows.filter((c) => c.grade === q.grade);
      return {
        period: periodOut(live.period),
        calculatedAt: clock.now(),
        items: rows.map((c) => ({
          rank: c.rank,
          previousRank: null,
          rankChange: null,
          classId: c.classId,
          className: c.className,
          grade: c.grade,
          score: c.score,
          ratedStudents: c.ratedStudents,
          totalStudents: c.totalStudents,
        })),
      };
    }
    const snap = await getSnapshot(schoolId);
    const docs = await findClassRatings(schoolId, snap.calcId, { classIds: scope, grade: q.grade });
    return {
      period: periodOut(snap.period),
      calculatedAt: snap.calculatedAt,
      items: docs.map((d) => ({
        rank: d.rank,
        previousRank: d.previousRank,
        rankChange: rankChange(d.rank, d.previousRank),
        classId: String(d.refId),
        className: d.name,
        grade: d.grade,
        score: d.score,
        ratedStudents: d.ratedStudents,
        totalStudents: d.totalStudents,
      })),
    };
  },

  /** Maktablar reytingi (faqat superadmin) */
  async schools() {
    const snap = await getSchoolsSnapshot();
    const docs = await findSchoolRatings(snap.calcId);
    const items = await Promise.all(
      docs.map(async (d) => {
        const pub = await settingsService.getEffectivePublic(String(d.refId));
        return {
          rank: d.rank,
          previousRank: d.previousRank,
          rankChange: rankChange(d.rank, d.previousRank),
          schoolId: String(d.refId),
          name: d.name,
          slug: d.slug,
          score: d.score,
          ratedStudents: d.ratedStudents,
          totalStudents: d.totalStudents,
          enabled: pub.enabled,
        };
      }),
    );
    return { period: snap.period, calculatedAt: snap.calculatedAt, items };
  },

  /** Qo'lda qayta hisoblash. schoolId yo'q (faqat superadmin) — barcha maktablar */
  async recalculate(ctx: Ctx, schoolId?: string) {
    let at: Date;
    if (schoolId) {
      if (!(await School.exists({ _id: schoolId }))) throw AppError.notFound('Maktab topilmadi');
      at = await recalculateSchool(schoolId);
      await recalculateSchools();
    } else {
      at = await recalculateAll();
    }
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: schoolId ?? null,
      action: 'ratings.recalculate',
      entity: 'rating',
      entityId: schoolId ?? 'all',
      after: { calculatedAt: at, date: todayTashkent() },
      ip: ctx.ip,
    });
    return { recalculatedAt: at };
  },
};
