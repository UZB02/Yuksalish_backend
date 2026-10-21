import crypto from 'crypto';
import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import { AcademicYear } from '../../models/AcademicYear';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { ClassModel } from '../../models/Class';
import {
  Rating,
  RatingDailyRank,
  RatingState,
  type IRating,
  type RatingScope,
} from '../../models/Rating';
import { School } from '../../models/School';
import { Score } from '../../models/Score';
import { Student } from '../../models/Student';
import { fmtDate } from '../../utils/dates';
import { clock, todayTashkent } from '../../utils/clock';
import { round2 } from '../../utils/dayScore';
import { logger } from '../../core/logger';
import { publicCache } from '../public/public.cache';
import {
  ATTENDANCE_KEY,
  type RatingImpact,
  type AttendanceSettings,
} from '../settings/attendance.settings';
import type { RatingSettings } from '../settings/rating.settings';
import type { ScoringSettings } from '../settings/scoring.settings';
import { settingsService } from '../settings/settings.service';
import {
  buildClassRows,
  applyPenalties,
  buildSchoolRow,
  buildStudentRows,
  penaltyOf,
  rankClasses,
  rankSchools,
  rankStudents,
  type ClassInfo,
  type ClassRow,
  type SchoolRow,
  type StudentAgg,
  type StudentRow,
} from './rating.calc';
import { resolvePeriod, type ActiveYearInfo, type RatingPeriod } from './rating.period';

const oid = (id: string) => new Types.ObjectId(id);

/** Boshqa modullar (events) ulanadigan nuqta */
export const ratingHooks: { afterSchoolRecalc?: (schoolId: string) => void } = {};

// ---------- Kontekst ----------

export async function loadActiveYear(schoolId: string): Promise<ActiveYearInfo | null> {
  const y = await AcademicYear.findOne({ schoolId, isActive: true });
  if (!y) return null;
  return {
    id: y.id,
    name: y.name,
    startDate: fmtDate(y.startDate) as string,
    endDate: fmtDate(y.endDate) as string,
    periods: y.periods.map((p) => ({
      id: String(p._id),
      name: p.name,
      startDate: fmtDate(p.startDate) as string,
      endDate: fmtDate(p.endDate) as string,
    })),
  };
}

export async function resolveSchoolPeriod(schoolId: string) {
  const [rating, year] = await Promise.all([
    settingsService.getEffectiveRating(schoolId),
    loadActiveYear(schoolId),
  ]);
  return { rating, period: resolvePeriod(rating, year, todayTashkent()) };
}

// ---------- Hisoblash (DB dan o'qish) ----------

interface Computed {
  students: StudentRow[];
  classes: ClassRow[];
  totalStudents: number;
}

export interface DayRow {
  studentId: string;
  date: string;
  /** Kunlik ball (dailyAggregation bo'yicha, barcha o'qituvchilar baholaridan) */
  day: number;
  /** Shu kundagi baholar soni */
  n: number;
}

/**
 * Bitta aggregation: (o'quvchi, kun) bo'yicha guruhlash; JS da kunlik ball (dailyAggregation).
 * Reyting va hisobotlar uchun yagona kunlik ball manbai. N+1 so'rovsiz.
 */
export async function loadDayRows(
  schoolId: string,
  period: { from: string; to: string },
  scoring: Pick<ScoringSettings, 'dailyAggregation'>,
  studentIds?: Types.ObjectId[],
): Promise<DayRow[]> {
  const mode = scoring.dailyAggregation;
  const match: Record<string, unknown> = {
    schoolId: oid(schoolId),
    isDeleted: false,
    date: { $gte: period.from, $lte: period.to },
  };
  if (studentIds) match.studentId = { $in: studentIds };
  const pipeline: Record<string, unknown>[] = [{ $match: match }];
  if (mode === 'last') pipeline.push({ $sort: { createdAt: 1 } });
  pipeline.push({
    $group: {
      _id: { s: '$studentId', d: '$date' },
      avg: { $avg: '$value' },
      min: { $min: '$value' },
      last: { $last: '$value' },
      n: { $sum: 1 },
    },
  });
  const rows = await Score.aggregate<{
    _id: { s: Types.ObjectId; d: string };
    avg: number;
    min: number;
    last: number;
    n: number;
  }>(pipeline as never).allowDiskUse(true);

  return rows.map((r) => ({
    studentId: String(r._id.s),
    date: r._id.d,
    day: mode === 'average' ? round2(r.avg) : mode === 'min' ? r.min : r.last,
    n: r.n,
  }));
}

async function loadAggregates(
  schoolId: string,
  period: { from: string; to: string },
  scoring: Pick<ScoringSettings, 'dailyAggregation'>,
): Promise<Map<string, StudentAgg>> {
  const out = new Map<string, StudentAgg>();
  for (const r of await loadDayRows(schoolId, period, scoring)) {
    const cur = out.get(r.studentId);
    if (cur) {
      cur.daysCount += 1;
      cur.scoresCount += r.n;
      cur.sumDays += r.day;
    } else out.set(r.studentId, { daysCount: 1, scoresCount: r.n, sumDays: r.day });
  }
  return out;
}

/** Davr ichidagi davomat yozuvlaridan o'quvchi jarimalari (faqat ratingImpact.enabled bo'lsa chaqiriladi) */
async function loadPenalties(
  schoolId: string,
  period: { from: string; to: string },
  impact: RatingImpact,
): Promise<Map<string, number>> {
  const rows = await AttendanceRecord.aggregate<{
    _id: { s: Types.ObjectId; c: string };
    n: number;
  }>([
    {
      $match: {
        schoolId: oid(schoolId),
        isDeleted: false,
        category: { $ne: 'present' },
        date: { $gte: period.from, $lte: period.to },
      },
    },
    { $group: { _id: { s: '$studentId', c: '$category' }, n: { $sum: 1 } } },
  ]);
  const counts = new Map<
    string,
    { late: number; absentExcused: number; absentUnexcused: number }
  >();
  for (const r of rows) {
    const key = String(r._id.s);
    const c = counts.get(key) ?? { late: 0, absentExcused: 0, absentUnexcused: 0 };
    if (r._id.c === 'late') c.late += r.n;
    else if (r._id.c === 'absent_excused') c.absentExcused += r.n;
    else if (r._id.c === 'absent_unexcused') c.absentUnexcused += r.n;
    counts.set(key, c);
  }
  return new Map([...counts].map(([k, c]) => [k, penaltyOf(c, impact)]));
}

async function compute(
  schoolId: string,
  period: { from: string; to: string },
  rating: RatingSettings,
  scoring: Pick<ScoringSettings, 'dailyAggregation'>,
  withClasses = true,
  impact: RatingImpact | null = null,
): Promise<Computed> {
  const [studentDocs, classDocs, aggs] = await Promise.all([
    Student.find({ schoolId, isDeleted: false, status: 'active' })
      .select('fullName classId')
      .lean(),
    withClasses ? ClassModel.find({ schoolId }).select('name grade').lean() : Promise.resolve([]),
    loadAggregates(schoolId, period, scoring),
  ]);
  const infos = studentDocs.map((s) => ({
    id: String(s._id),
    fullName: s.fullName,
    classId: String(s.classId),
  }));
  // Sinf = o'quvchining HOZIRGI sinfi (baho snapshotidagi classId emas)
  let base = buildStudentRows(infos, aggs, rating);
  if (impact?.enabled) base = applyPenalties(base, await loadPenalties(schoolId, period, impact));
  const rows = rankStudents(base, rating.tieBreak);

  let classes: ClassRow[] = [];
  if (withClasses) {
    const classMap = new Map<string, ClassInfo>(
      classDocs.map((c) => [String(c._id), { id: String(c._id), name: c.name, grade: c.grade }]),
    );
    const total = new Map<string, number>();
    for (const s of infos) total.set(s.classId, (total.get(s.classId) ?? 0) + 1);
    classes = rankClasses(buildClassRows(rows, classMap, total));
  }
  return { students: rows, classes, totalStudents: infos.length };
}

// ---------- Saqlash (snapshot) ----------

async function loadPrevRanks(
  schoolId: string,
  scope: RatingScope,
  periodKey: string,
  today: string,
): Promise<Map<string, number>> {
  const last = await RatingDailyRank.findOne({ schoolId, scope, periodKey, date: { $lt: today } })
    .sort({ date: -1 })
    .select('date')
    .lean();
  if (!last) return new Map();
  const rows = await RatingDailyRank.find({ schoolId, scope, periodKey, date: last.date })
    .select('refId rank')
    .lean();
  return new Map(rows.map((r) => [String(r.refId), r.rank]));
}

async function writeDailyRanks(
  schoolId: string,
  scope: RatingScope,
  periodKey: string,
  today: string,
  ranked: { refId: string; rank: number }[],
) {
  if (ranked.length) {
    await RatingDailyRank.collection.bulkWrite(
      ranked.map((r) => ({
        updateOne: {
          filter: { schoolId: oid(schoolId), scope, periodKey, date: today, refId: oid(r.refId) },
          update: { $set: { rank: r.rank } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  // Faqat eng so'nggi oldingi kun (previousRank uchun) va bugun saqlanadi
  const prev = await RatingDailyRank.findOne({ schoolId, scope, periodKey, date: { $lt: today } })
    .sort({ date: -1 })
    .select('date')
    .lean();
  await RatingDailyRank.deleteMany({
    schoolId,
    scope,
    $or: [
      { periodKey: { $ne: periodKey } },
      ...(prev ? [{ periodKey, date: { $lt: prev.date } }] : []),
    ],
  });
}

const running = new Map<string, { dirty: boolean; promise: Promise<Date> }>();

/** Bir kalit uchun bir vaqtda bitta hisob; hisob davomida kelgan so'rov tugagach yana bir marta bajariladi */
function singleFlight(key: string, work: () => Promise<Date>): Promise<Date> {
  const cur = running.get(key);
  if (cur) {
    cur.dirty = true;
    return cur.promise;
  }
  const entry = { dirty: false, promise: undefined as unknown as Promise<Date> };
  entry.promise = (async () => {
    try {
      let res: Date;
      do {
        entry.dirty = false;
        res = await work();
      } while (entry.dirty);
      return res;
    } finally {
      running.delete(key);
    }
  })();
  running.set(key, entry);
  return entry.promise;
}

async function doRecalculateSchool(schoolId: string): Promise<Date> {
  const today = todayTashkent();
  const [rating, scoring, year, attendance] = await Promise.all([
    settingsService.getEffectiveRating(schoolId),
    settingsService.getEffectiveScoring(schoolId),
    loadActiveYear(schoolId),
    settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
  ]);
  const period = resolvePeriod(rating, year, today);
  const data = await compute(schoolId, period, rating, scoring, true, attendance.ratingImpact);

  const [prevStudents, prevClasses] = await Promise.all([
    loadPrevRanks(schoolId, 'student', period.key, today),
    loadPrevRanks(schoolId, 'class', period.key, today),
  ]);
  const calcId = crypto.randomBytes(8).toString('hex');
  const calculatedAt = clock.now();
  const classInfo = new Map<string, { name: string; grade: number }>();
  for (const c of data.classes) classInfo.set(c.classId, { name: c.className, grade: c.grade });
  // Reytingda bo'lmagan sinflar (hamma o'quvchi eligible emas) nomi uchun
  const classNames = new Map(
    (await ClassModel.find({ schoolId }).select('name grade').lean()).map((c) => [
      String(c._id),
      c,
    ]),
  );

  const base = { schoolId: oid(schoolId), periodKey: period.key, calcId, calculatedAt };
  const docs: Record<string, unknown>[] = [];
  for (const r of data.students) {
    const cls = classNames.get(r.classId);
    docs.push({
      ...base,
      scope: 'student',
      refId: oid(r.studentId),
      score: r.score,
      daysCount: r.daysCount,
      scoresCount: r.scoresCount,
      ratedStudents: null,
      totalStudents: null,
      eligible: r.eligible,
      penalty: r.penalty,
      rank: r.rank,
      previousRank: r.rank !== null ? (prevStudents.get(r.studentId) ?? null) : null,
      name: r.fullName,
      classId: oid(r.classId),
      className: cls?.name ?? null,
      grade: cls?.grade ?? null,
      slug: null,
    });
  }
  for (const c of data.classes) {
    docs.push({
      ...base,
      scope: 'class',
      refId: oid(c.classId),
      score: c.score,
      daysCount: 0,
      scoresCount: 0,
      ratedStudents: c.ratedStudents,
      totalStudents: c.totalStudents,
      eligible: true,
      rank: c.rank,
      previousRank: c.rank !== null ? (prevClasses.get(c.classId) ?? null) : null,
      name: c.className,
      classId: null,
      className: c.className,
      grade: c.grade,
      slug: null,
    });
  }
  if (docs.length) await Rating.collection.insertMany(docs, { ordered: false });

  // Atomik almashtirish: avval yangi calcId "ko'rinadigan" bo'ladi, keyin eskilari o'chadi
  await RatingState.updateOne(
    { kind: 'school', schoolId: oid(schoolId) },
    { $set: { periodKey: period.key, calcId, calculatedAt, period } },
    { upsert: true },
  );
  await Rating.deleteMany({
    schoolId,
    scope: { $in: ['student', 'class'] },
    calcId: { $ne: calcId },
  });

  await writeDailyRanks(
    schoolId,
    'student',
    period.key,
    today,
    data.students
      .filter((r) => r.rank !== null)
      .map((r) => ({ refId: r.studentId, rank: r.rank as number })),
  );
  await writeDailyRanks(
    schoolId,
    'class',
    period.key,
    today,
    data.classes.map((c) => ({ refId: c.classId, rank: c.rank as number })),
  );

  publicCache.clear();
  ratingHooks.afterSchoolRecalc?.(schoolId);
  return calculatedAt;
}

export function recalculateSchool(schoolId: string): Promise<Date> {
  return singleFlight(`school:${schoolId}`, () => doRecalculateSchool(schoolId));
}

// ---------- Maktablar reytingi (umumiy) ----------

export interface SchoolsPeriodInfo {
  type: string;
  from: string | null;
  to: string | null;
  label: string;
}

/**
 * Umumiy reytingda davr turi GLOBAL RatingSettings dan olinadi (maktab override i hisobga olinmaydi).
 * week/month/custom — bir xil sana oralig'i; quarter/academic_year — har bir maktab o'z faol yili bo'yicha.
 */
async function schoolsContext() {
  const rating = await settingsService.getEffectiveRating(null);
  const today = todayTashkent();
  const relative = ['quarter', 'academic_year'].includes(rating.periodType);
  const shared = relative ? null : resolvePeriod(rating, null, today);
  const histKey = shared ? shared.key : `schools:${rating.periodType}`;
  const info: SchoolsPeriodInfo = shared
    ? { type: shared.type, from: shared.from, to: shared.to, label: shared.label }
    : {
        type: rating.periodType,
        from: null,
        to: null,
        label: rating.periodType === 'quarter' ? 'Joriy chorak' : "O'quv yili",
      };
  return { rating, today, histKey, stateKey: `${histKey}|${today}`, info };
}

async function doRecalculateSchools(): Promise<Date> {
  const ctx = await schoolsContext();
  const scoring = await settingsService.getEffectiveScoring(null);
  // Umumiy reytingda davomat jarimasi GLOBAL davomat sozlamasidan (maktablar solishtirma bo'lishi uchun)
  const impact = (await settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, null))
    .ratingImpact;
  const schools = await School.find({ isActive: true }).select('name slug').lean();

  const rows: SchoolRow[] = [];
  for (const s of schools) {
    const id = String(s._id);
    const period = ctx.info.from
      ? { from: ctx.info.from, to: ctx.info.to as string }
      : resolvePeriod(ctx.rating, await loadActiveYear(id), ctx.today);
    const data = await compute(id, period, ctx.rating, scoring, false, impact);
    rows.push(
      buildSchoolRow({ id, name: s.name, slug: s.slug }, data.students, data.totalStudents),
    );
  }
  const ranked = rankSchools(rows);

  const calcId = crypto.randomBytes(8).toString('hex');
  const calculatedAt = clock.now();
  const prevByRef = new Map<string, number>();
  // previousRank: har bir maktab uchun alohida tarix (schoolId = maktabning o'zi)
  await Promise.all(
    ranked.map(async (r) => {
      const prev = await loadPrevRanks(r.schoolId, 'school', ctx.histKey, ctx.today);
      const v = prev.get(r.schoolId);
      if (v !== undefined) prevByRef.set(r.schoolId, v);
    }),
  );
  const docs = ranked.map((r) => ({
    schoolId: oid(r.schoolId),
    scope: 'school',
    refId: oid(r.schoolId),
    periodKey: ctx.histKey,
    calcId,
    calculatedAt,
    score: r.score,
    daysCount: 0,
    scoresCount: 0,
    ratedStudents: r.ratedStudents,
    totalStudents: r.totalStudents,
    eligible: r.rank !== null,
    rank: r.rank,
    previousRank: r.rank !== null ? (prevByRef.get(r.schoolId) ?? null) : null,
    name: r.name,
    classId: null,
    className: null,
    grade: null,
    slug: r.slug,
  }));
  if (docs.length) await Rating.collection.insertMany(docs, { ordered: false });
  await RatingState.updateOne(
    { kind: 'schools', schoolId: null },
    {
      $set: {
        periodKey: ctx.stateKey,
        calcId,
        calculatedAt,
        period: { ...ctx.info, key: ctx.histKey },
      },
    },
    { upsert: true },
  );
  await Rating.deleteMany({ scope: 'school', calcId: { $ne: calcId } });
  for (const r of ranked) {
    if (r.rank === null) continue;
    await writeDailyRanks(r.schoolId, 'school', ctx.histKey, ctx.today, [
      { refId: r.schoolId, rank: r.rank },
    ]);
  }
  publicCache.clear();
  return calculatedAt;
}

export function recalculateSchools(): Promise<Date> {
  return singleFlight('schools', doRecalculateSchools);
}

/** Barcha faol maktablar + umumiy reyting (kechasi / qo'lda) */
export async function recalculateAll(): Promise<Date> {
  const schools = await School.find({ isActive: true }).select('_id').lean();
  for (const s of schools) {
    try {
      await recalculateSchool(String(s._id));
    } catch (err) {
      logger.error({ err, schoolId: String(s._id) }, 'Maktab reytingi hisoblanmadi');
    }
  }
  return recalculateSchools();
}

// ---------- O'qish ----------

export interface SchoolSnapshot {
  calcId: string;
  calculatedAt: Date;
  period: RatingPeriod;
}

/** Joriy snapshot; yo'q yoki davr o'zgargan bo'lsa lazy hisoblanadi */
export async function getSnapshot(schoolId: string): Promise<SchoolSnapshot> {
  const { period } = await resolveSchoolPeriod(schoolId);
  let state = await RatingState.findOne({ kind: 'school', schoolId }).lean();
  if (!state || state.periodKey !== period.key) {
    await recalculateSchool(schoolId);
    state = await RatingState.findOne({ kind: 'school', schoolId }).lean();
  }
  if (!state) throw AppError.notFound('Reyting topilmadi');
  return {
    calcId: state.calcId,
    calculatedAt: state.calculatedAt,
    period: state.period as RatingPeriod,
  };
}

export async function peekSnapshot(schoolId: string): Promise<{ calculatedAt: Date } | null> {
  const state = await RatingState.findOne({ kind: 'school', schoolId }).lean();
  return state ? { calculatedAt: state.calculatedAt } : null;
}

export async function getSchoolsSnapshot(): Promise<{
  calcId: string;
  calculatedAt: Date;
  period: SchoolsPeriodInfo;
}> {
  const ctx = await schoolsContext();
  let state = await RatingState.findOne({ kind: 'schools', schoolId: null }).lean();
  if (!state || state.periodKey !== ctx.stateKey) {
    await recalculateSchools();
    state = await RatingState.findOne({ kind: 'schools', schoolId: null }).lean();
  }
  if (!state) throw AppError.notFound('Reyting topilmadi');
  return { calcId: state.calcId, calculatedAt: state.calculatedAt, period: ctx.info };
}

export type RatingLean = Omit<IRating, 'refId' | 'schoolId' | 'classId'> & {
  _id: Types.ObjectId;
  refId: Types.ObjectId;
  schoolId: Types.ObjectId;
  classId: Types.ObjectId | null;
};

export interface StudentFilter {
  classIds?: string[] | null;
  classId?: string;
  grade?: number;
  search?: string;
  includeIneligible?: boolean;
  /** topStudents kabi cheklov uchun */
  skip?: number;
  limit?: number;
}

function studentFilter(
  schoolId: string,
  calcId: string,
  f: StudentFilter,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { schoolId: oid(schoolId), scope: 'student', calcId };
  if (!f.includeIneligible) filter.eligible = true;
  if (f.grade) filter.grade = f.grade;
  const ids = f.classIds
    ? f.classId
      ? f.classIds.filter((c) => c === f.classId)
      : f.classIds
    : f.classId
      ? [f.classId]
      : null;
  if (ids) filter.classId = { $in: ids.map(oid) };
  return filter;
}

export async function findStudentRatings(schoolId: string, calcId: string, f: StudentFilter) {
  const filter = studentFilter(schoolId, calcId, f);
  if (f.search) {
    const esc = f.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = new RegExp(esc, 'i');
  }
  let q = Rating.find(filter).sort({ eligible: -1, rank: 1, name: 1 });
  if (f.skip) q = q.skip(f.skip);
  if (f.limit) q = q.limit(f.limit);
  const [docs, total] = await Promise.all([
    q.lean() as unknown as Promise<RatingLean[]>,
    Rating.countDocuments(filter),
  ]);
  return { docs, total };
}

export async function findClassRatings(
  schoolId: string,
  calcId: string,
  f: { classIds?: string[] | null; grade?: number },
) {
  const filter: Record<string, unknown> = { schoolId: oid(schoolId), scope: 'class', calcId };
  if (f.grade) filter.grade = f.grade;
  if (f.classIds) filter.refId = { $in: f.classIds.map(oid) };
  return (await Rating.find(filter).sort({ rank: 1 }).lean()) as unknown as RatingLean[];
}

export async function findSchoolRatings(calcId: string) {
  return (await Rating.find({ scope: 'school', calcId })
    .sort({ eligible: -1, rank: 1, name: 1 })
    .lean()) as unknown as RatingLean[];
}

/** Maxsus davr uchun jonli hisob (snapshotsiz) */
export async function computeLive(schoolId: string, from: string, to: string) {
  const [rating, scoring, attendance] = await Promise.all([
    settingsService.getEffectiveRating(schoolId),
    settingsService.getEffectiveScoring(schoolId),
    settingsService.getEffective<AttendanceSettings>(ATTENDANCE_KEY, schoolId),
  ]);
  const data = await compute(
    schoolId,
    { from, to },
    rating,
    scoring,
    true,
    attendance.ratingImpact,
  );
  const classNames = new Map(
    (await ClassModel.find({ schoolId }).select('name grade').lean()).map((c) => [
      String(c._id),
      c,
    ]),
  );
  return {
    period: {
      type: 'custom',
      from,
      to,
      key: `custom:${from}:${to}`,
      label: `${from} – ${to}`,
    } as RatingPeriod,
    data,
    classNames,
  };
}
