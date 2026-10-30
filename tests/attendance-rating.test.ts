import { ObjectId } from 'mongodb';
import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ratingEvents } from '../src/modules/ratings/ratings.events';
import {
  applyPenalties,
  buildStudentRows,
  penaltyOf,
  rankStudents,
} from '../src/modules/ratings/rating.calc';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
import { clock } from '../src/utils/clock';
import {
  AttendanceRecord,
  Score,
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

describe('Davomat jarimasi: toza funksiyalar', () => {
  const rates = { penaltyLate: 1, penaltyAbsentExcused: 2, penaltyAbsentUnexcused: 5 };

  it('penaltyOf: kategoriya soni x jarima, 2 xonagacha', () => {
    expect(penaltyOf({ late: 0, absentExcused: 0, absentUnexcused: 0 }, rates)).toBe(0);
    expect(penaltyOf({ late: 2, absentExcused: 1, absentUnexcused: 3 }, rates)).toBe(19);
    expect(
      penaltyOf(
        { late: 3, absentExcused: 0, absentUnexcused: 0 },
        { ...rates, penaltyLate: 0.333 },
      ),
    ).toBe(1);
    expect(
      penaltyOf({ late: 7, absentExcused: 0, absentUnexcused: 0 }, { ...rates, penaltyLate: 0.15 }),
    ).toBe(1.05);
    expect(
      penaltyOf(
        { late: 5, absentExcused: 5, absentUnexcused: 5 },
        { penaltyLate: 0, penaltyAbsentExcused: 0, penaltyAbsentUnexcused: 0 },
      ),
    ).toBe(0);
  });

  it("applyPenalties: ball kamayadi, 0 dan past tushmaydi; eligible/daysCount/scoresCount o'zgarmaydi", () => {
    const students = [
      { id: 'a', fullName: 'Ali', classId: 'c' },
      { id: 'b', fullName: 'Bobur', classId: 'c' },
      { id: 'c', fullName: 'Chori', classId: 'c' },
      { id: 'd', fullName: 'Dilnoza', classId: 'c' },
    ];
    const aggs = new Map([
      ['a', { daysCount: 3, scoresCount: 4, sumDays: 270 }], // 90
      ['b', { daysCount: 3, scoresCount: 3, sumDays: 240 }], // 80
      ['c', { daysCount: 3, scoresCount: 3, sumDays: 30 }], // 10
      ['d', { daysCount: 1, scoresCount: 1, sumDays: 50 }], // eligible emas
    ]);
    const base = buildStudentRows(students, aggs, { method: 'average', minScoresCount: 3 });
    const out = applyPenalties(
      base,
      new Map([
        ['a', 14.5],
        ['c', 50],
        ['d', 5],
      ]),
    );
    const by = new Map(out.map((r) => [r.studentId, r]));
    expect(by.get('a')).toMatchObject({
      score: 75.5,
      penalty: 14.5,
      daysCount: 3,
      scoresCount: 4,
      eligible: true,
    });
    expect(by.get('b')).toMatchObject({ score: 80, penalty: 0 });
    expect(by.get('c')).toMatchObject({ score: 0, penalty: 50, eligible: true }); // 0 dan pastga tushmaydi
    expect(by.get('d')).toMatchObject({ eligible: false, daysCount: 1 });
    expect(base[0].score).toBe(90); // asl qatorlar o'zgarmaydi (immutable)

    // Tartib jarimali ballar bo'yicha
    const ranked = rankStudents(out, ['daysCount', 'alphabetical']);
    expect(ranked.map((r) => [r.studentId, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 3],
      ['d', null],
    ]);
  });
});

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z';

let school: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let cls: Doc;
let s1: Doc, s2: Doc;
let teacher: Doc;
let statuses: Record<AttendanceCategory, Doc>;
let root: string, rep: string, t1: string;

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('demo-r');
  year = await makeYear(school.id);
  teacher = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  cls = await makeClass(school.id, year.id, '5-A', [teacher.id]);
  s1 = await makeStudent(school.id, cls.id, 'Aliyev Ali');
  s2 = await makeStudent(school.id, cls.id, 'Valiyev Vali');
  statuses = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus("Sababli yo'q", 'absent_excused'),
    absent_unexcused: await makeStatus("Sababsiz yo'q", 'absent_unexcused'),
  };
  const bt = await makeBehaviorType('Namunali xulq');
  const give = (st: Doc, values: number[]) =>
    Score.insertMany(
      values.map((v, i) => ({
        schoolId: school.id,
        studentId: st._id,
        classId: cls._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: bt._id,
        value: v,
        date: `2026-10-0${i + 1}`,
      })),
    );
  await give(s1, [90, 90, 90]); // 90
  await give(s2, [80, 80, 80]); // 80
  [root, rep, t1] = await Promise.all(
    ['root', 'rep', 'teacher1'].map(async (u) => (await login(u)).token),
  );
});

const rec = (
  student: Doc,
  date: string,
  category: AttendanceCategory,
  extra: Record<string, unknown> = {},
) =>
  AttendanceRecord.create({
    schoolId: school.id,
    studentId: student._id,
    classId: cls._id,
    academicYearId: year._id,
    date,
    lessonNo: 0,
    statusId: statuses[category]._id,
    category,
    markedBy: teacher._id,
    updatedBy: teacher._id,
    ...extra,
  });
const put = (key: string, body: object) =>
  request(app).put(`/api/v1/settings/${key}`).set(bearer(root)).send(body);
const setImpact = (impact: object) =>
  put('attendance', { scope: 'school', schoolId: school.id, values: { ratingImpact: impact } });
const students = async (q = '') =>
  (
    await request(app)
      .get(`/api/v1/ratings/students${q}`)
      .set(bearer(rep))
      .set('X-School-Id', school.id)
  ).body.data.items;
const wait = () => new Promise((r) => setTimeout(r, 50));

async function seedRecords() {
  await rec(s1, '2026-10-12', 'late');
  await rec(s1, '2026-10-13', 'late');
  await rec(s1, '2026-10-14', 'absent_excused');
  await rec(s1, '2026-10-05', 'absent_unexcused');
  await rec(s2, '2026-10-12', 'present');
}

describe("Davomatning reytingga ta'siri", () => {
  it("o'chiq (standart): ball o'zgarmaydi, penalty har doim bor va 0", async () => {
    await seedRecords();
    const items = await students();
    expect(
      items.map((i: { studentId: string; score: number; penalty: number; rank: number }) => [
        i.studentId,
        i.score,
        i.penalty,
        i.rank,
      ]),
    ).toEqual([
      [s1.id, 90, 0, 1],
      [s2.id, 80, 0, 2],
    ]);
  });

  it("yoqilganda: jarima formulasi, tartib, daysCount o'zgarmaydi, sinf balli jarimali ballardan", async () => {
    await seedRecords();
    expect((await students())[0].score).toBe(90);
    // late*1 + excused*2 + unexcused*10: davr ichida 2 late + 1 excused + 1 unexcused (5-oktyabr ham oktyabrda)
    expect(
      (
        await setImpact({
          enabled: true,
          penaltyLate: 1,
          penaltyAbsentExcused: 2,
          penaltyAbsentUnexcused: 10,
        })
      ).status,
    ).toBe(200);
    await ratingEvents.flushAll();
    let items = await students();
    // 90 - (2*1 + 1*2 + 1*10) = 76 -> s2 (80) birinchi
    expect(
      items.map((i: { studentId: string; score: number; penalty: number; rank: number }) => [
        i.studentId,
        i.score,
        i.penalty,
        i.rank,
      ]),
    ).toEqual([
      [s2.id, 80, 0, 1],
      [s1.id, 76, 14, 2],
    ]);
    expect(items[1]).toMatchObject({ daysCount: 3, scoresCount: 3, eligible: true });
    const cl = (
      await request(app)
        .get('/api/v1/ratings/classes')
        .set(bearer(rep))
        .set('X-School-Id', school.id)
    ).body.data.items[0];
    expect(cl).toMatchObject({ score: 78, ratedStudents: 2 }); // (76 + 80) / 2

    // Davr tashqarisidagi (sentyabr) va o'chirilgan yozuvlar hisobga olinmaydi
    await rec(s1, '2026-09-20', 'absent_unexcused');
    const deleted = await rec(s2, '2026-10-13', 'absent_unexcused', { isDeleted: true });
    expect(deleted.isDeleted).toBe(true);
    await request(app)
      .post('/api/v1/ratings/recalculate')
      .set(bearer(root))
      .set('X-School-Id', school.id);
    items = await students();
    expect(items.map((i: { score: number }) => i.score)).toEqual([80, 76]);

    // 0 dan pastga tushmaydi
    await setImpact({
      enabled: true,
      penaltyLate: 1,
      penaltyAbsentExcused: 2,
      penaltyAbsentUnexcused: 100,
    });
    await ratingEvents.flushAll();
    items = await students();
    expect(items.find((i: { studentId: string }) => i.studentId === s1.id)).toMatchObject({
      score: 0,
      penalty: 104,
      rank: 2,
    });

    // Yig'indi usuli: jarima yig'indidan ayiriladi
    await put('rating', { scope: 'school', schoolId: school.id, values: { method: 'sum' } });
    await setImpact({
      enabled: true,
      penaltyLate: 1,
      penaltyAbsentExcused: 2,
      penaltyAbsentUnexcused: 10,
    });
    await ratingEvents.flushAll();
    items = await students();
    expect(items.find((i: { studentId: string }) => i.studentId === s1.id)).toMatchObject({
      score: 256,
      penalty: 14,
    }); // 270 - 14
    expect(items.find((i: { studentId: string }) => i.studentId === s2.id)).toMatchObject({
      score: 240,
    });

    // O'chirsak asl holat qaytadi
    await setImpact({
      enabled: false,
      penaltyLate: 1,
      penaltyAbsentExcused: 2,
      penaltyAbsentUnexcused: 10,
    });
    await ratingEvents.flushAll();
    expect(
      (await students()).find((i: { studentId: string }) => i.studentId === s1.id),
    ).toMatchObject({ score: 270, penalty: 0 });
  });

  it('jonli (from/to) hisob ham jarimani hisobga oladi', async () => {
    await seedRecords();
    await setImpact({
      enabled: true,
      penaltyLate: 5,
      penaltyAbsentExcused: 0,
      penaltyAbsentUnexcused: 0,
    });
    const live = await students('?from=2026-10-01&to=2026-10-14');
    expect(live.find((i: { studentId: string }) => i.studentId === s1.id)).toMatchObject({
      score: 80,
      penalty: 10,
    });
    // Davr 1-3 oktyabr: davomat yozuvlari yo'q (12-14 oktyabr) — jarima 0
    const early = await students('?from=2026-10-01&to=2026-10-04');
    expect(early.find((i: { studentId: string }) => i.studentId === s1.id)).toMatchObject({
      score: 90,
      penalty: 0,
    });
  });

  it("ochiq (public) javobda davomat/jarima tafsilotlari chiqmaydi (kalitlar to'plami o'zgarmagan), lekin ball jarimali", async () => {
    await seedRecords();
    await put('public', { scope: 'school', schoolId: school.id, values: { enabled: true } });
    const get = async () => request(app).get('/api/v1/public/demo-r/rating/students');
    const before = await get();
    expect(before.body.data.items.map((i: { score: number }) => i.score)).toEqual([90, 80]);

    await setImpact({
      enabled: true,
      penaltyLate: 1,
      penaltyAbsentExcused: 2,
      penaltyAbsentUnexcused: 10,
    });
    await ratingEvents.flushAll();
    const after = await get();
    expect(after.status).toBe(200);
    expect(after.body.data.items.map((i: { score: number }) => i.score)).toEqual([80, 76]);
    for (const item of after.body.data.items) {
      expect(Object.keys(item).sort()).toEqual([
        'className',
        'fullName',
        'rank',
        'rankChange',
        'score',
        'studentKey',
      ]);
    }
    const cls2 = await request(app).get('/api/v1/public/demo-r/rating/classes');
    expect(Object.keys(cls2.body.data.items[0]).sort()).toEqual(
      ['className', 'classId', 'grade', 'rank', 'rankChange', 'ratedStudents', 'score'].sort(),
    );
    const cfg = await request(app).get('/api/v1/public/demo-r/config');
    // Hech bir joyda davomat/jarima kaliti yo'q (kalit nomlari bo'yicha)
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(x);
        }
      }
    };
    walk([after.body, cls2.body, cfg.body]);
    for (const k of [
      'penalty',
      'attendance',
      'ratingimpact',
      'category',
      'minuteslate',
      'statusid',
      'absent',
      'late',
    ]) {
      expect(keys.has(k), k).toBe(false);
    }
  });
});

describe('Qayta hisoblash faqat ratingImpact yoqilganda', () => {
  const bulk = (body: object, t = root) =>
    request(app)
      .post('/api/v1/attendance/bulk')
      .set(bearer(t))
      .set('X-School-Id', school.id)
      .send(body);

  it("davomat yozuvi: o'chiq bo'lsa qayta hisoblash rejalashtirilmaydi, yoqilsa bulk/PATCH/DELETE rejalashtiradi", async () => {
    await ratingEvents.flushAll();
    const r1 = await bulk({
      classId: cls.id,
      items: [{ studentId: s1.id, statusId: statuses.late.id }],
    });
    expect(r1.body.data.created).toBe(1);
    await wait();
    expect(ratingEvents.pending).not.toContain(school.id);

    await setImpact({
      enabled: true,
      penaltyLate: 2,
      penaltyAbsentExcused: 0,
      penaltyAbsentUnexcused: 0,
    });
    await ratingEvents.flushAll(); // sozlama o'zgarishi o'zi qayta hisoblaydi
    expect(ratingEvents.pending).toEqual([]);

    const r2 = await bulk({
      classId: cls.id,
      items: [{ studentId: s2.id, statusId: statuses.late.id }],
    });
    expect(r2.body.data.created).toBe(1);
    // dataChanged asinxron rejalashtiriladi: qat'iy 50 ms o'rniga rejalashtirilguncha kutamiz
    await vi.waitFor(() => expect(ratingEvents.pending).toContain(school.id));
    await ratingEvents.flushAll();
    expect(
      (await students()).find((i: { studentId: string }) => i.studentId === s2.id),
    ).toMatchObject({ penalty: 2, score: 78 });

    const id = (await AttendanceRecord.findOne({ studentId: s2._id }))!.id as string;
    const patch = await request(app)
      .patch(`/api/v1/attendance/${id}`)
      .set(bearer(root))
      .set('X-School-Id', school.id)
      .send({ statusId: statuses.present.id });
    expect(patch.status).toBe(200);
    // dataChanged asinxron rejalashtiriladi: qat'iy 50 ms o'rniga rejalashtirilguncha kutamiz
    await vi.waitFor(() => expect(ratingEvents.pending).toContain(school.id));
    await ratingEvents.flushAll();
    expect(
      (await students()).find((i: { studentId: string }) => i.studentId === s2.id),
    ).toMatchObject({ penalty: 0, score: 80 });

    const del = await request(app)
      .delete(`/api/v1/attendance/${(await AttendanceRecord.findOne({ studentId: s1._id }))!.id}`)
      .set(bearer(root))
      .set('X-School-Id', school.id);
    expect(del.status).toBe(200);
    // dataChanged asinxron rejalashtiriladi: qat'iy 50 ms o'rniga rejalashtirilguncha kutamiz
    await vi.waitFor(() => expect(ratingEvents.pending).toContain(school.id));
    await ratingEvents.flushAll();
    expect(
      (await students()).find((i: { studentId: string }) => i.studentId === s1.id),
    ).toMatchObject({ penalty: 0, score: 90 });
    expect(new ObjectId(school.id)).toBeTruthy();
  });

  it("davomat sozlamasi: faqat ratingImpact/workingWeekdays o'zgarsa qayta hisoblanadi", async () => {
    await ratingEvents.flushAll();
    const set = (values: object) =>
      put('attendance', { scope: 'school', schoolId: school.id, values });
    await set({ editWindowHours: 48 });
    await set({ mode: 'lesson', lessonsPerDay: 3, backdateDays: 5 });
    expect(ratingEvents.pending).toEqual([]);

    await set({ mode: 'lesson', lessonsPerDay: 3, backdateDays: 5, workingWeekdays: [1, 2, 3] });
    expect(ratingEvents.pending).toContain(school.id);
    await ratingEvents.flushAll();

    await set({ workingWeekdays: [1, 2, 3], ratingImpact: { enabled: true, penaltyLate: 1 } });
    expect(ratingEvents.pending).toContain(school.id);
    await ratingEvents.flushAll();
    // O'zgarmagan qayta yuborish — hisoblanmaydi
    await set({ workingWeekdays: [1, 2, 3], ratingImpact: { enabled: true, penaltyLate: 1 } });
    expect(ratingEvents.pending).toEqual([]);
    expect(t1).toBeTruthy();
  });
});
