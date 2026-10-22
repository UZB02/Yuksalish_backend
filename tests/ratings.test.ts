import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { Rating, RatingDailyRank, RatingState } from '../src/models/Rating';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import { clock } from '../src/utils/clock';
import {
  ADMIN_PERMS,
  Score,
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z'; // Toshkent: 2026-10-14
const setNow = (iso = NOW) => clock.set(() => new Date(iso));

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc;
let s1: Doc, s2: Doc, s3: Doc, s4: Doc;
let teacherUser: Doc;
let root: string, rep: string, exp: string, none: string, tch: string, tchNoRep: string;
let btype: Doc;

beforeEach(async () => {
  setNow();
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  teacherUser = await makeUser({
    username: 'teacher1',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({ username: 'tnorep', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({
    username: 'exp',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view', 'reports.export'],
  });
  await makeUser({
    username: 'none',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [teacherUser.id], {
    homeroomTeacherId: teacherUser.id,
  });
  c6 = await makeClass(school.id, year.id, '6-A');
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  s4 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  btype = await makeBehaviorType('Namunali xulq');
  [root, rep, exp, none, tch, tchNoRep] = await Promise.all(
    ['root', 'rep', 'exp', 'none', 'teacher1', 'tnorep'].map(async (u) => (await login(u)).token),
  );
});

/** Talaba uchun ketma-ket kunlarga (2026-10-01 dan) baholar yozadi */
async function give(
  student: Doc,
  cls: Doc,
  values: number[],
  opts: { startDay?: number; teacher?: Doc; schoolId?: string; yearId?: string } = {},
) {
  const start = opts.startDay ?? 1;
  await Score.insertMany(
    values.map((v, i) => ({
      schoolId: opts.schoolId ?? school.id,
      studentId: student._id,
      classId: cls._id,
      teacherId: (opts.teacher ?? teacherUser)._id,
      academicYearId: opts.yearId ?? year.id,
      behaviorTypeId: btype._id,
      value: v,
      date: `2026-10-${String(start + i).padStart(2, '0')}`,
    })),
  );
}

const H = (id?: string): Record<string, string> => (id ? { 'X-School-Id': id } : {});
const get = (t: string, path: string, h: Record<string, string> = {}) =>
  request(app).get(`/api/v1${path}`).set(bearer(t)).set(h);
const put = (path: string, body: object) =>
  request(app).put(`/api/v1/settings/${path}`).set(bearer(root)).send(body);
const recalc = (t = root, h: Record<string, string> = H(school.id)) =>
  request(app).post('/api/v1/ratings/recalculate').set(bearer(t)).set(h);

async function seedBasic() {
  await give(s1, c5, [90, 80, 70]); // 80
  await give(s2, c5, [100, 100, 100]); // 100
  await give(s3, c5, [50, 50]); // 2 kun: eligible emas
  await give(s4, c6, [60, 60, 60]); // 60
}

describe('Reyting hisoblash va ichki endpointlar', () => {
  it("o'quvchi/sinf ball formulalari, eligible, rank; lazy hisoblash (recalculate chaqirilmagan)", async () => {
    await seedBasic();
    const res = await get(rep, '/ratings/students', H());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.period).toMatchObject({
      type: 'month',
      from: '2026-10-01',
      to: '2026-10-31',
      label: '2026-yil oktyabr',
    });
    expect(d.calculatedAt).toBeTruthy();
    expect(
      d.items.map((i: { studentId: string; rank: number; score: number }) => [
        i.studentId,
        i.rank,
        i.score,
      ]),
    ).toEqual([
      [s2.id, 1, 100],
      [s1.id, 2, 80],
      [s4.id, 3, 60],
    ]);
    expect(d.items[0]).toMatchObject({
      fullName: 'Valiyev Vali',
      classId: c5.id,
      className: '5-A',
      daysCount: 3,
      scoresCount: 3,
      eligible: true,
      previousRank: null,
      rankChange: null,
    });
    expect(res.body.meta).toMatchObject({ total: 3, page: 1, limit: 50 });

    const all = await get(rep, '/ratings/students?includeIneligible=true');
    const last = all.body.data.items[3];
    expect(last).toMatchObject({ studentId: s3.id, rank: null, eligible: false, daysCount: 2 });

    const cls = (await get(rep, '/ratings/classes')).body.data.items;
    expect(
      cls.map(
        (c: {
          classId: string;
          rank: number;
          score: number;
          ratedStudents: number;
          totalStudents: number;
        }) => [c.classId, c.rank, c.score, c.ratedStudents, c.totalStudents],
      ),
    ).toEqual([
      [c5.id, 1, 90, 2, 3],
      [c6.id, 2, 60, 1, 1],
    ]);
    expect(
      (await get(rep, '/ratings/classes?grade=6')).body.data.items.map(
        (c: { classId: string }) => c.classId,
      ),
    ).toEqual([c6.id]);
  });

  it('filtrlar: classId, grade, search, sahifalash; method=sum va minScoresCount sozlamalari qayta hisoblanadi', async () => {
    await seedBasic();
    const q = async (s: string) =>
      (await get(rep, `/ratings/students${s}`)).body.data.items.map(
        (i: { studentId: string }) => i.studentId,
      );
    expect(await q(`?classId=${c6.id}`)).toEqual([s4.id]);
    expect(await q('?grade=5')).toEqual([s2.id, s1.id]);
    expect(await q('?search=VALI')).toEqual([s2.id]);
    expect(await q('?limit=1&page=2')).toEqual([s1.id]);

    expect(
      (await put('rating', { scope: 'global', values: { method: 'sum', minScoresCount: 2 } }))
        .status,
    ).toBe(200);
    await ratingEvents.flushAll();
    const items = (await get(rep, '/ratings/students')).body.data.items;
    expect(
      items.map((i: { studentId: string; score: number; rank: number }) => [
        i.studentId,
        i.score,
        i.rank,
      ]),
    ).toEqual([
      [s2.id, 300, 1],
      [s1.id, 240, 2],
      [s4.id, 180, 3],
      [s3.id, 100, 4],
    ]);
    // Sinf balli: method qanday bo'lmasin eligible o'quvchilar ballarining arifmetik o'rtachasi
    const c = (await get(rep, '/ratings/classes')).body.data.items;
    expect(c[0]).toMatchObject({ classId: c5.id, score: 213.33, ratedStudents: 3 });
  });

  it('teng ballarda tartib: tie-break sozlamasi (daysCount) va alifbo', async () => {
    await give(s1, c5, [80, 80, 80]); // 3 kun
    await give(s2, c5, [80, 80, 80]); // 3 kun
    await give(s3, c5, [80, 80, 80, 80]); // 4 kun
    const order = async () =>
      (await get(rep, '/ratings/students')).body.data.items.map(
        (i: { studentId: string }) => i.studentId,
      );
    expect(await order()).toEqual([s3.id, s1.id, s2.id]); // 4 kun birinchi, so'ng alifbo
    await put('rating', { scope: 'global', values: { tieBreak: ['alphabetical'] } });
    await ratingEvents.flushAll();
    expect(await order()).toEqual([s1.id, s3.id, s2.id]); // Aliyev, Bekov, Valiyev
    expect((await get(rep, '/settings/rating')).body.data.effective.tieBreak).toEqual([
      'alphabetical',
    ]);
  });

  it('previousRank / rankChange: oldingi kalendar kunning rank i', async () => {
    await give(s1, c5, [90, 90, 90]);
    await give(s2, c5, [80, 80, 80]);
    await recalc(); // 14-oktyabr: s1=1, s2=2
    expect(
      (await get(rep, '/ratings/students')).body.data.items.map(
        (i: { rank: number; previousRank: number | null }) => [i.rank, i.previousRank],
      ),
    ).toEqual([
      [1, null],
      [2, null],
    ]);

    // Bir xil kunda qayta hisoblash previousRank ni o'zgartirmaydi
    await recalc();
    expect((await get(rep, '/ratings/students')).body.data.items[0].previousRank).toBeNull();

    // Ertasi kuni s2 oldinga chiqadi
    setNow('2026-10-15T07:00:00Z');
    await give(s2, c5, [100, 100, 100, 100], { startDay: 4 });
    await recalc();
    const items = (await get(rep, '/ratings/students')).body.data.items;
    expect(
      items.map(
        (i: { studentId: string; rank: number; previousRank: number; rankChange: number }) => [
          i.studentId,
          i.rank,
          i.previousRank,
          i.rankChange,
        ],
      ),
    ).toEqual([
      [s2.id, 1, 2, 1],
      [s1.id, 2, 1, -1],
    ]);
    const cls = (await get(rep, '/ratings/classes')).body.data.items[0];
    expect(cls).toMatchObject({ rank: 1, previousRank: 1, rankChange: 0 });
    // Faqat oxirgi oldingi kun va bugun saqlanadi
    expect(await RatingDailyRank.countDocuments({ scope: 'student', date: '2026-10-14' })).toBe(2);
  });

  it("baho o'zgarganda snapshot yangilanadi (realtime: debounce -> flush), nightly rejimda esa yo'q", async () => {
    const type = await makeBehaviorType('Faol', 'positive', { nameKey: 'faol-x' });
    await give(s1, c5, [70, 70]);
    await recalc();
    const first = (await get(rep, '/ratings/students')).body.data;
    expect(first.items).toHaveLength(0); // hali 2 kun

    const post = (day: string, value: number) =>
      request(app)
        .post('/api/v1/scores')
        .set(bearer(tch))
        .send({ studentId: s1.id, value, behaviorTypeId: type.id, date: day });
    expect((await post('2026-10-14', 90)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(ratingEvents.pending).toContain(school.id);
    await ratingEvents.flushAll();
    const after = (await get(rep, '/ratings/students')).body.data.items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ studentId: s1.id, score: 76.67, daysCount: 3 });

    // nightly: faqat jadval bo'yicha
    await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { refreshMode: 'nightly' },
    });
    await ratingEvents.flushAll();
    expect(ratingEvents.pending).toEqual([]);
    expect((await post('2026-10-13', 100)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(ratingEvents.pending).not.toContain(school.id);
    await recalc();
    expect((await get(rep, '/ratings/students')).body.data.items[0].daysCount).toBe(4);
  });

  it("dailyAggregation va bir kundagi bir necha o'qituvchi bahosi", async () => {
    const t2 = await makeUser({ username: 'tt2', role: 'teacher', schoolId: school.id });
    await give(s1, c5, [100, 100, 100]);
    await give(s1, c5, [60, 60, 60], { teacher: t2 });
    expect((await get(rep, '/ratings/students')).body.data.items[0]).toMatchObject({
      score: 80,
      daysCount: 3,
      scoresCount: 6,
    }); // o'rtacha
    await put('scoring', { scope: 'global', values: { dailyAggregation: 'min' } });
    await ratingEvents.flushAll();
    expect((await get(rep, '/ratings/students')).body.data.items[0].score).toBe(60);
  });

  it("boshqa davr: week / custom / academic_year, faol yil yo'q bo'lsa fallback", async () => {
    await give(s1, c5, [90, 90, 90], { startDay: 12 }); // shu hafta
    await give(s1, c5, [50, 50, 50], { startDay: 1 }); // oy boshida
    const one = async () => (await get(rep, '/ratings/students')).body.data;

    expect((await one()).items[0]).toMatchObject({ score: 70, daysCount: 6 }); // oy
    await put('rating', { scope: 'global', values: { periodType: 'week' } });
    await ratingEvents.flushAll();
    let d = await one();
    expect(d.period).toMatchObject({
      type: 'week',
      from: '2026-10-12',
      to: '2026-10-18',
      label: '12–18-oktyabr',
    });
    expect(d.items[0]).toMatchObject({ score: 90, daysCount: 3 });

    await put('rating', {
      scope: 'global',
      values: { periodType: 'custom', customFrom: '2026-10-01', customTo: '2026-10-03' },
    });
    await ratingEvents.flushAll();
    d = await one();
    expect(d.period).toMatchObject({ type: 'custom', from: '2026-10-01', to: '2026-10-03' });
    expect(d.items[0]).toMatchObject({ score: 50, daysCount: 3 });

    await put('rating', { scope: 'global', values: { periodType: 'academic_year' } });
    await ratingEvents.flushAll();
    expect((await one()).period).toMatchObject({
      type: 'academic_year',
      from: '2026-09-01',
      label: '2026-2027',
    });
    await year.updateOne({ isActive: false });
    const cfg = (await get(rep, '/ratings/config')).body.data;
    expect(cfg.period).toMatchObject({ type: 'month', fallback: true });
    expect(cfg.settings).toMatchObject({
      periodType: 'academic_year',
      method: 'average',
      minScoresCount: 3,
    });
    expect((await one()).period).toMatchObject({ type: 'month', fallback: true }); // davr kaliti o'zgardi -> lazy qayta hisob
  });

  it('jonli (maxsus) davr: from/to snapshotsiz hisoblanadi va chegaralanadi', async () => {
    await give(s1, c5, [90, 90, 90]);
    await give(s1, c5, [10, 10, 10], { startDay: 5 });
    const live = await get(rep, '/ratings/students?from=2026-10-01&to=2026-10-03');
    expect(live.status).toBe(200);
    expect(live.body.data.period).toMatchObject({
      type: 'custom',
      from: '2026-10-01',
      to: '2026-10-03',
    });
    expect(live.body.data.items[0]).toMatchObject({
      studentId: s1.id,
      score: 90,
      previousRank: null,
      rankChange: null,
    });
    expect(
      (await get(rep, '/ratings/classes?from=2026-10-05&to=2026-10-07')).body.data.items[0],
    ).toMatchObject({ score: 10 });
    expect((await get(rep, '/ratings/students?from=2026-10-01')).status).toBe(400);
    expect((await get(rep, '/ratings/students?from=2026-10-09&to=2026-10-01')).status).toBe(400);
    expect((await get(rep, '/ratings/students?from=2024-01-01&to=2026-10-01')).status).toBe(400);
  });
});

describe('Ruxsatlar, tenant va scoping', () => {
  it("reports.view kerak; o'qituvchi faqat o'z sinflari, lekin rank butun maktab bo'yicha", async () => {
    await give(s1, c5, [80, 80, 80]);
    await give(s2, c5, [70, 70, 70]);
    await give(s4, c6, [95, 95, 95]); // begona sinf, umumiy rank 1
    expect((await get(none, '/ratings/students')).status).toBe(403);
    expect((await get(tchNoRep, '/ratings/students')).status).toBe(403);
    expect((await request(app).get('/api/v1/ratings/students')).status).toBe(401);

    const t = await get(tch, '/ratings/students');
    expect(t.status).toBe(200);
    expect(
      t.body.data.items.map((i: { studentId: string; rank: number }) => [i.studentId, i.rank]),
    ).toEqual([
      [s1.id, 2],
      [s2.id, 3],
    ]);
    expect(t.body.meta.total).toBe(2);
    expect((await get(tch, `/ratings/students?classId=${c6.id}`)).body.data.items).toEqual([]);
    const classes = (await get(tch, '/ratings/classes')).body.data.items;
    expect(classes.map((c: { classId: string; rank: number }) => [c.classId, c.rank])).toEqual(
      [[c6.id, 1]].slice(1).concat([[c5.id, 2]]),
    );
    expect(
      (await get(tch, '/ratings/students?from=2026-10-01&to=2026-10-31')).body.data.items.map(
        (i: { rank: number }) => i.rank,
      ),
    ).toEqual([2, 3]);
  });

  it("tenant: boshqa maktab admini faqat o'z maktabini ko'radi; superadmin X-School-Id bilan", async () => {
    await give(s1, c5, [80, 80, 80]);
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const os = await makeStudent(other.id, oc.id, 'Chet Maktab');
    await Score.insertMany(
      [1, 2, 3].map((d) => ({
        schoolId: other.id,
        studentId: os._id,
        classId: oc._id,
        teacherId: teacherUser._id,
        academicYearId: oy.id,
        value: 99,
        date: `2026-10-0${d}`,
      })),
    );
    await makeUser({
      username: 'orep',
      role: 'school_admin',
      schoolId: other.id,
      permissions: ['reports.view'],
    });
    const ot = (await login('orep')).token;

    const mine = (await get(ot, '/ratings/students')).body.data.items;
    expect(mine.map((i: { fullName: string }) => i.fullName)).toEqual(['Chet Maktab']);
    expect(mine[0].rank).toBe(1);
    expect((await get(ot, `/ratings/students?classId=${c5.id}`)).body.data.items).toEqual([]);
    expect((await get(root, '/ratings/students')).status).toBe(400);
    const a = await get(root, '/ratings/students', H(school.id));
    expect(a.body.data.items.map((i: { fullName: string }) => i.fullName)).toEqual(['Aliyev Ali']);
    expect((await get(root, '/ratings/students', H(other.id))).body.data.items).toHaveLength(1);
  });

  it("maktablar reytingi: faqat superadmin; maktab balli = barcha eligible o'quvchilar o'rtachasi; davr GLOBAL sozlamadan", async () => {
    await give(s1, c5, [100, 100, 100]); // A maktab: 5-A da 1 o'quvchi (100)
    await give(s4, c6, [60, 60, 60]); // 6-A da 3 o'quvchi (60)
    const extra1 = await makeStudent(school.id, c6.id, 'Qoshimcha Bir');
    const extra2 = await makeStudent(school.id, c6.id, 'Qoshimcha Ikki');
    await give(extra1, c6, [60, 60, 60]);
    await give(extra2, c6, [60, 60, 60]);
    // B maktab: 1 o'quvchi, 75
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const os = await makeStudent(other.id, oc.id, 'Chet Maktab');
    await Score.insertMany(
      [1, 2, 3].map((d) => ({
        schoolId: other.id,
        studentId: os._id,
        classId: oc._id,
        teacherId: teacherUser._id,
        academicYearId: oy.id,
        value: 75,
        date: `2026-10-0${d}`,
      })),
    );
    // C maktab: baholarsiz -> reytingga kirmaydi
    await makeSchool('c');

    expect((await get(rep, '/ratings/schools')).status).toBe(403);
    expect((await get(tch, '/ratings/schools')).status).toBe(403);
    const res = await get(root, '/ratings/schools'); // X-School-Id shart emas
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    // sinflar o'rtachasi (100+60)/2 = 80 bo'lardi; o'quvchilar o'rtachasi (100+60*3)/4 = 70
    expect(
      items.map((i: { slug: string; rank: number | null; score: number }) => [
        i.slug,
        i.rank,
        i.score,
      ]),
    ).toEqual([
      ['b', 1, 75],
      ['a', 2, 70],
      ['c', null, 0],
    ]);
    expect(items[1]).toMatchObject({
      schoolId: school.id,
      ratedStudents: 4,
      totalStudents: 6,
      enabled: false,
    });
    expect(res.body.data.period).toMatchObject({ type: 'month', from: '2026-10-01' });

    // Global davr turi (maktab override i hisobga olinmaydi)
    await put('rating', { scope: 'global', values: { periodType: 'week' } });
    await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { periodType: 'custom', customFrom: '2026-10-01', customTo: '2026-10-03' },
    });
    await ratingEvents.flushAll();
    const week = (await get(root, '/ratings/schools')).body.data;
    expect(week.period).toMatchObject({ type: 'week', from: '2026-10-12' });
    expect(week.items.every((i: { rank: number | null }) => i.rank === null)).toBe(true); // shu haftada baho yo'q
  });

  it('qayta hisoblash: superadmin yoki reports.export li admin; audit', async () => {
    await give(s1, c5, [80, 80, 80]);
    expect((await recalc(rep, {})).status).toBe(403);
    expect((await recalc(tch, {})).status).toBe(403);
    expect((await recalc(none, {})).status).toBe(403);
    const ok = await recalc(exp, {});
    expect(ok.status).toBe(200);
    expect(ok.body.data.recalculatedAt).toBeTruthy();
    expect((await recalc(root, {})).status).toBe(200); // headersiz: hamma maktab
    expect((await recalc(root, H('64b64b64b64b64b64b64b64b'))).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'ratings.recalculate' })).toBe(2);
    expect(await RatingState.countDocuments({ kind: 'school' })).toBe(2);
    expect(await RatingState.countDocuments({ kind: 'schools' })).toBe(1);
    // Atomik almashtirish: eski calcId yozuvlari qolmaydi
    await recalc(exp, {});
    const ids = await Rating.distinct('calcId', { schoolId: school._id, scope: 'student' });
    expect(ids).toHaveLength(1);
  });
});

describe('Sozlamalar: rating va public', () => {
  it("standart qiymatlar, tieBreak normallashtirish, override faqat superadmin ko'radi", async () => {
    const r = await get(rep, '/settings/rating');
    expect(r.body.data.effective).toEqual({
      periodType: 'month',
      customFrom: null,
      customTo: null,
      method: 'average',
      minScoresCount: 3,
      tieBreak: ['daysCount', 'alphabetical'],
      refreshMode: 'realtime',
      weights: { conduct: 50, subjects: 50 },
    });
    const p = await get(rep, '/settings/public');
    expect(p.body.data.effective).toEqual({
      enabled: false,
      showScope: 'own',
      includeInGlobal: true,
      showClasses: true,
      showStudents: true,
      topStudents: 20,
      showScores: true,
      showMedals: true,
      showTrend: true,
      showPhotos: false,
      title: null,
      subtitle: null,
      primaryColor: null,
      autoRefreshSeconds: 120,
      tvSlideSeconds: 15,
      globalRatingEnabled: false,
    });
    const set = await put('rating', {
      scope: 'school',
      schoolId: school.id,
      values: { tieBreak: ['alphabetical', 'scoresCount'], minScoresCount: 5 },
    });
    expect(set.status).toBe(200);
    expect(set.body.data.override).toEqual({
      tieBreak: ['scoresCount', 'alphabetical'],
      minScoresCount: 5,
    });
    expect((await get(rep, '/settings/rating')).body.data.override).toBeNull();
    expect((await get(rep, '/settings/rating')).body.data.effective).toMatchObject({
      minScoresCount: 5,
      tieBreak: ['scoresCount', 'alphabetical'],
    });
    expect((await get(root, '/settings/rating', H(school.id))).body.data.override).toMatchObject({
      minScoresCount: 5,
    });
    expect(
      (await get(root, '/settings/rating', H(other.id))).body.data.effective.minScoresCount,
    ).toBe(3);
    expect(
      (await put('rating', { scope: 'school', schoolId: school.id, values: null })).body.data
        .override,
    ).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'settings.update' })).toBe(2);
    expect((await get(rep, '/settings/nope')).status).toBe(404);
  });

  it('validatsiya (rating)', async () => {
    const bad = async (values: object, scope: object = { scope: 'global' }) => {
      const r = await put('rating', { ...scope, values });
      expect(r.status, JSON.stringify(values)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    };
    await bad({ periodType: 'custom' });
    await bad({ periodType: 'custom', customFrom: '2026-10-10', customTo: '2026-10-01' });
    await bad({ periodType: 'daily' });
    await bad({ tieBreak: ['daysCount', 'daysCount'] });
    await bad({ tieBreak: ['x'] });
    await bad({ minScoresCount: 0 });
    await bad({ minScoresCount: 1.5 });
    await bad({ method: 'median' });
    await bad({ refreshMode: 'hourly' });
    await bad({ customFrom: '14.10.2026' });
    await bad({ periodType: 'custom' }, { scope: 'school', schoolId: school.id });
    expect(
      (
        await put('rating', {
          scope: 'global',
          values: { periodType: 'custom', customFrom: '2026-10-01', customTo: '2026-10-01' },
        })
      ).status,
    ).toBe(200);
    const nonSuper = await request(app)
      .put('/api/v1/settings/rating')
      .set(bearer(rep))
      .send({ scope: 'global', values: {} });
    expect(nonSuper.status).toBe(403);
  });

  it('validatsiya (public): diapazonlar, rang, globalRatingEnabled faqat global scope da', async () => {
    const bad = async (values: object, scope: object = { scope: 'global' }) =>
      expect((await put('public', { ...scope, values })).status, JSON.stringify(values)).toBe(400);
    await bad({ topStudents: 0 });
    await bad({ topStudents: 501 });
    await bad({ title: 'x'.repeat(81) });
    await bad({ subtitle: 'x'.repeat(161) });
    await bad({ primaryColor: 'blue' });
    await bad({ autoRefreshSeconds: 29 });
    await bad({ autoRefreshSeconds: 3601 });
    await bad({ tvSlideSeconds: 4 });
    await bad({ tvSlideSeconds: 121 });
    await bad({ showScope: 'world' });
    const sch = { scope: 'school', schoolId: school.id };
    const r = await put('public', { ...sch, values: { globalRatingEnabled: true } });
    expect(r.status).toBe(400);
    expect(r.body.error.details[0].path).toBe('values.globalRatingEnabled');
    expect((await put('public', { ...sch, values: { globalRatingEnabled: false } })).status).toBe(
      400,
    );

    const ok = await put('public', {
      scope: 'global',
      values: {
        globalRatingEnabled: true,
        topStudents: null,
        primaryColor: '#abcdef',
        title: ' Sarlavha ',
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.global).toMatchObject({
      globalRatingEnabled: true,
      topStudents: null,
      primaryColor: '#ABCDEF',
      title: 'Sarlavha',
    });
    expect(
      (await put('public', { ...sch, values: { enabled: true, topStudents: 5 } })).status,
    ).toBe(200);
  });
});
