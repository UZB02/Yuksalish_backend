import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import {
  blendComponents,
  buildStudentRows,
  GRADE_TO_100,
  type StudentAgg,
} from '../src/modules/ratings/rating.calc';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { RATING_DEFAULTS, validateRating } from '../src/modules/settings/rating.settings';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  Score,
  SubjectGrade,
  app,
  assignSubject,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

const students = [
  { id: 'a', fullName: 'A', classId: 'c' },
  { id: 'b', fullName: 'B', classId: 'c' },
];
const opts = { method: 'average' as const, minScoresCount: 3 };
const agg = (p: Partial<StudentAgg>): StudentAgg => ({
  daysCount: 0,
  scoresCount: 0,
  sumDays: 0,
  ...p,
});

describe('Reyting og`irliklari: toza hisob', () => {
  it('blendComponents: ulushlar, bitta komponent bo`lsa o`zi, ikkalasi bo`lmasa 0', () => {
    const w = { conduct: 50, subjects: 50 };
    expect(blendComponents(80, 100, w)).toBe(90);
    expect(blendComponents(80, 100, { conduct: 70, subjects: 30 })).toBe(86);
    expect(blendComponents(80, 100, { conduct: 100, subjects: 0 })).toBe(80);
    expect(blendComponents(80, 100, { conduct: 0, subjects: 100 })).toBe(100);
    expect(blendComponents(80, null, w)).toBe(80); // faqat xulq
    expect(blendComponents(null, 90, w)).toBe(90); // faqat fan
    expect(blendComponents(null, 90, { conduct: 100, subjects: 0 })).toBe(90); // ulushi 0 bo`lsa ham yagona komponent
    expect(blendComponents(null, null, w)).toBe(0);
    expect(blendComponents(83.333, 66.666, w)).toBe(75);
  });

  it('fan bahosi ×20: 5→100, 4→80, 3→60, 2→40', () => {
    expect(GRADE_TO_100).toBe(20);
    const rows = buildStudentRows(
      students,
      new Map([
        ['a', agg({ gradesCount: 2, gradesSum: 9, activeDays: 4 })], // o`rtacha 4.5 -> 90
        ['b', agg({ gradesCount: 3, gradesSum: 6, activeDays: 3 })], // 2.0 -> 40
      ]),
      opts,
    );
    expect(rows.map((r) => r.score)).toEqual([90, 40]);
    expect(rows.map((r) => r.scoresCount)).toEqual([2, 3]);
  });

  it('ikkala komponent: xulq o`rtachasi × wc + fan o`rtachasi×20 × ws; sum usuli', () => {
    const a = agg({
      daysCount: 3,
      scoresCount: 3,
      sumDays: 240,
      gradesCount: 2,
      gradesSum: 10,
      activeDays: 4,
    });
    const aggs = new Map([['a', a]]);
    const avg = buildStudentRows(students, aggs, {
      ...opts,
      weights: { conduct: 50, subjects: 50 },
    });
    expect(avg[0].score).toBe(90); // xulq 80, fan 5*20=100
    expect(avg[0].daysCount).toBe(4); // birlashgan faol kunlar
    expect(avg[0].scoresCount).toBe(5);
    expect(avg[0].eligible).toBe(true);
    const w73 = buildStudentRows(students, aggs, {
      ...opts,
      weights: { conduct: 70, subjects: 30 },
    });
    expect(w73[0].score).toBe(86);
    // standart ulush 50/50
    expect(buildStudentRows(students, aggs, opts)[0].score).toBe(90);
    // sum usuli: xulq yig`indisi 240, fan yig`indisi 10*20=200
    const sum = buildStudentRows(students, aggs, {
      method: 'sum',
      minScoresCount: 3,
      weights: { conduct: 50, subjects: 50 },
    });
    expect(sum[0].score).toBe(220);
  });

  it('yagona komponent: faqat xulq (eski Score hujjatlar) yoki faqat fan — qayta normallashtiriladi', () => {
    const rows = buildStudentRows(
      students,
      new Map([
        ['a', agg({ daysCount: 3, scoresCount: 3, sumDays: 240 })], // faqat xulq: 80 (fan yo`q -> 50% emas)
        ['b', agg({ gradesCount: 3, gradesSum: 15, activeDays: 3 })], // faqat fan: 100
      ]),
      { ...opts, weights: { conduct: 30, subjects: 70 } },
    );
    expect(rows.map((r) => r.score)).toEqual([80, 100]);
    expect(rows.every((r) => r.eligible)).toBe(true);
  });

  it('eligible: faol kunlar (xulq ∪ fan) minScoresCount ga yetishi kerak', () => {
    const rows = buildStudentRows(
      students,
      new Map([
        [
          'a',
          agg({
            daysCount: 2,
            scoresCount: 2,
            sumDays: 160,
            gradesCount: 1,
            gradesSum: 5,
            activeDays: 3,
          }),
        ],
        ['b', agg({ daysCount: 2, scoresCount: 2, sumDays: 160 })],
      ]),
      opts,
    );
    expect(rows.map((r) => r.eligible)).toEqual([true, false]);
  });

  it('validateRating: ulushlar yig`indisi 100 bo`lishi shart; standart 50/50', () => {
    expect(RATING_DEFAULTS.weights).toEqual({ conduct: 50, subjects: 50 });
    expect(() => validateRating({ ...RATING_DEFAULTS })).not.toThrow();
    expect(() =>
      validateRating({ ...RATING_DEFAULTS, weights: { conduct: 60, subjects: 50 } }),
    ).toThrow();
    expect(() =>
      validateRating({ ...RATING_DEFAULTS, weights: { conduct: 100, subjects: 0 } }),
    ).not.toThrow();
  });
});

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z';
let school: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Awaited<ReturnType<typeof makeClass>>;
let s1: Doc, s2: Doc, s3: Doc;
let teacher: Doc;
let math: Doc;
let root: string, rep: string, schoolAdmin: string;
let btype: Doc;

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('a');
  year = await makeYear(school.id);
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({
    username: 'sadmin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'grades.create', 'grades.edit'],
  });
  c5 = await makeClass(school.id, year.id, '5-A', [teacher.id], { homeroomTeacherId: teacher.id });
  math = await makeSubject('Matematika');
  await assignSubject(school.id, c5, math.id, teacher.id);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  btype = await makeBehaviorType('Namunali xulq');
  [root, rep, schoolAdmin] = await Promise.all(
    ['root', 'rep', 'sadmin'].map(async (u) => (await login(u)).token),
  );
});

const conduct = (student: Doc, values: number[]) =>
  Score.insertMany(
    values.map((v, i) => ({
      schoolId: school.id,
      studentId: student._id,
      classId: c5._id,
      teacherId: teacher._id,
      academicYearId: year.id,
      behaviorTypeId: btype._id,
      value: v,
      date: `2026-10-${String(1 + i).padStart(2, '0')}`,
    })),
  );
const grades = (student: Doc, values: number[], startDay = 1) =>
  SubjectGrade.insertMany(
    values.map((v, i) => ({
      schoolId: school.id,
      studentId: student._id,
      classId: c5._id,
      subjectId: math._id,
      teacherId: teacher._id,
      academicYearId: year.id,
      value: v,
      date: `2026-10-${String(startDay + i).padStart(2, '0')}`,
    })),
  );
const get = (t: string, path: string) => request(app).get(`/api/v1${path}`).set(bearer(t));
const put = (values: object | null, extra: object = { scope: 'global' }, t = root) =>
  request(app)
    .put('/api/v1/settings/rating')
    .set(bearer(t))
    .send({ ...extra, values });
const scoreOf = async (id: string) =>
  (await get(rep, '/ratings/students?includeIneligible=true')).body.data.items.find(
    (i: { studentId: string }) => i.studentId === id,
  );

describe('Reyting og`irliklari: butun tizim', () => {
  it('xulq + fan bahosi aralashmasi, yagona komponent fallback, sinf balli talabalardan', async () => {
    await conduct(s1, [80, 80, 80]); // xulq 80
    await grades(s1, [5, 5, 5]); // fan 100  -> 90
    await conduct(s2, [60, 60, 60]); // faqat xulq -> 60 (eski ma'lumotlar bilan mos)
    await grades(s3, [4, 4, 4]); // faqat fan 80
    const r1 = await scoreOf(s1.id);
    expect(r1).toMatchObject({ score: 90, daysCount: 3, scoresCount: 6, eligible: true });
    expect((await scoreOf(s2.id)).score).toBe(60);
    expect((await scoreOf(s3.id)).score).toBe(80);
    const items = (await get(rep, '/ratings/students')).body.data.items;
    expect(items.map((i: { studentId: string }) => i.studentId)).toEqual([s1.id, s3.id, s2.id]);
    // sinf balli = o`quvchilar o`rtachasi: (90 + 80 + 60) / 3
    const cls = (await get(rep, '/ratings/classes')).body.data.items;
    expect(cls[0]).toMatchObject({ classId: c5.id, score: 76.67, ratedStudents: 3 });
  });

  it('og`irlik o`zgarsa qayta hisoblanadi (global va maktab override); 5→100 va 4→80', async () => {
    await conduct(s1, [80, 80, 80]);
    await grades(s1, [4, 4, 4]); // fan 80
    await conduct(s2, [60, 60, 60]);
    await grades(s2, [5, 5, 5]); // fan 100
    expect((await scoreOf(s1.id)).score).toBe(80);
    expect((await scoreOf(s2.id)).score).toBe(80);

    expect((await put({ weights: { conduct: 20, subjects: 80 } })).status).toBe(200);
    await ratingEvents.flushAll();
    expect((await scoreOf(s1.id)).score).toBe(80); // 80*.2 + 80*.8
    expect((await scoreOf(s2.id)).score).toBe(92); // 60*.2 + 100*.8

    // maktab override: faqat xulq
    const ov = await put(
      { weights: { conduct: 100, subjects: 0 } },
      { scope: 'school', schoolId: school.id },
    );
    expect(ov.status).toBe(200);
    await ratingEvents.flushAll();
    expect((await scoreOf(s2.id)).score).toBe(60);
    const cfg = await get(rep, '/ratings/config');
    expect(cfg.body.data.settings.weights).toEqual({ conduct: 100, subjects: 0 });
    expect(await AuditLog.countDocuments({ action: 'settings.update', entityId: 'rating' })).toBe(
      2,
    );
  });

  it('baho qo`yilganda/o`chirilganda reyting yangilanadi (events), jonli davr hisobi ham fan bahosini hisobga oladi', async () => {
    await conduct(s1, [80, 80, 80]);
    await ratingEvents.flushAll();
    expect((await scoreOf(s1.id)).score).toBe(80);
    const post = (date: string, value: number) =>
      request(app)
        .post('/api/v1/grades')
        .set(bearer(schoolAdmin))
        .send({ studentId: s1.id, subjectId: math.id, date, value });
    const g1 = await post('2026-10-13', 5);
    expect(g1.status).toBe(201);
    // dataChanged asinxron (void) rejalashtiriladi: qat'iy kutish o'rniga rejalashtirilguncha kutamiz
    await vi.waitFor(() => expect(ratingEvents.pending).toContain(school.id));
    await ratingEvents.flushAll();
    expect((await scoreOf(s1.id)).score).toBe(90);
    // o`chirilganda yana 80
    expect(
      (await request(app).delete(`/api/v1/grades/${g1.body.data.id}`).set(bearer(schoolAdmin)))
        .status,
    ).toBe(200);
    await vi.waitFor(() => expect(ratingEvents.pending).toContain(school.id));
    await ratingEvents.flushAll();
    expect((await scoreOf(s1.id)).score).toBe(80);

    await grades(s1, [3, 3, 3], 5);
    const live = await get(rep, '/ratings/students?from=2026-10-01&to=2026-10-31');
    const mine = live.body.data.items.find((i: { studentId: string }) => i.studentId === s1.id);
    expect(mine.score).toBe(70); // 80*.5 + 60*.5
  });

  it('public API shakli o`zgarmaydi va individual baho/izoh oshkor bo`lmaydi', async () => {
    await put({ weights: { conduct: 50, subjects: 50 } });
    await conduct(s1, [80, 80, 80]);
    await SubjectGrade.insertMany(
      [1, 2, 3].map((d) => ({
        schoolId: school.id,
        studentId: s1._id,
        classId: c5._id,
        subjectId: math._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        value: 5,
        comment: 'MAXFIY IZOH',
        date: `2026-10-0${d}`,
      })),
    );
    await request(app)
      .put('/api/v1/settings/public')
      .set(bearer(root))
      .send({ scope: 'school', schoolId: school.id, values: { enabled: true } });
    const text = JSON.stringify(
      await Promise.all(
        ['students', 'classes'].map(async (p) => {
          const r = await request(app).get(`/api/v1/public/${school.slug}/rating/${p}`);
          expect(r.status).toBe(200);
          return r.body;
        }),
      ),
    );
    expect(text).toContain('Aliyev Ali');
    expect(text).not.toContain('MAXFIY IZOH');
    expect(text).not.toContain('subjectId');
    expect(text).not.toContain('gradesSum');
  });
});

describe('Reyting sozlamalari: weights validatsiyasi', () => {
  it('yig`indi 100 bo`lishi, butun son, 0–100 oralig`i; to`liq obyekt talab qilinadi', async () => {
    const bad = async (values: object, scope: object = { scope: 'global' }) => {
      const r = await put(values, scope);
      expect(r.status, JSON.stringify(values)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    };
    await bad({ weights: { conduct: 60, subjects: 50 } });
    await bad({ weights: { conduct: 40, subjects: 40 } });
    await bad({ weights: { conduct: 50.5, subjects: 49.5 } });
    await bad({ weights: { conduct: -10, subjects: 110 } });
    await bad({ weights: { conduct: 101, subjects: -1 } });
    await bad({ weights: { conduct: 100 } });
    await bad({ weights: { conduct: '50', subjects: '50' } });
    await bad({ weights: { conduct: 60, subjects: 50 } }, { scope: 'school', schoolId: school.id });
    const ok = await put({ weights: { conduct: 70, subjects: 30 } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.effective.weights).toEqual({ conduct: 70, subjects: 30 });
    expect(ok.body.data.global.weights).toEqual({ conduct: 70, subjects: 30 });
    // faqat superadmin yozadi
    expect(
      (await put({ weights: { conduct: 50, subjects: 50 } }, undefined, schoolAdmin)).status,
    ).toBe(403);
    // standartga qaytarish
    const reset = await put(null);
    expect(reset.body.data.effective.weights).toEqual({ conduct: 50, subjects: 50 });
  });
});
