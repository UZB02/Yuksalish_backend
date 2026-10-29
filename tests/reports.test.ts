import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { AuditLog } from '../src/models/AuditLog';
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

type Doc = { id: string; _id: Types.ObjectId };
const NOW = '2026-10-14T07:00:00Z'; // Toshkent: 2026-10-14 (chorshanba)
const Q = 'from=2026-10-01&to=2026-10-14';

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Doc, c6: Doc;
let s1: Doc, s2: Doc, s3: Doc, s4: Doc;
let t1u: Doc, t2u: Doc, t3u: Doc;
let pos: Doc, neg: Doc;
let statuses: Record<AttendanceCategory, Doc>;
let root: string,
  admin: string,
  rep: string,
  noview: string,
  t1: string,
  t2: string,
  tNoRep: string;

beforeEach(async () => {
  clock.set(() => new Date(NOW));
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  t1u = await makeUser({
    username: 'teacher1',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view', 'reports.export'],
  });
  t2u = await makeUser({
    username: 'teacher2',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  t3u = await makeUser({
    username: 'teacher3',
    role: 'teacher',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({ username: 'tnorep', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view', 'reports.export'],
  });
  await makeUser({
    username: 'rep',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['reports.view'],
  });
  await makeUser({
    username: 'noview',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  c5 = await makeClass(school.id, year.id, '5-A', [t1u.id, t3u.id], { homeroomTeacherId: t1u._id });
  c6 = await makeClass(school.id, year.id, '6-A', [t2u.id]);
  s1 = await makeStudent(school.id, c5.id, 'Aliyev Ali', {
    studentCode: 'A-1',
    parentPhone: '+998901112233',
    birthDate: new Date('2013-03-15'),
    gender: 'male',
  });
  s2 = await makeStudent(school.id, c5.id, 'Valiyev Vali');
  s3 = await makeStudent(school.id, c5.id, 'Bekov Bek');
  s4 = await makeStudent(school.id, c6.id, 'Cholpon Chol');
  pos = await makeBehaviorType('Namunali xulq', 'positive', { color: '#16A34A' });
  neg = await makeBehaviorType('Darsga kechikish', 'negative', { color: '#DC2626' });
  statuses = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus("Sababli yo'q", 'absent_excused'),
    absent_unexcused: await makeStatus("Sababsiz yo'q", 'absent_unexcused'),
  };

  const sc = (
    st: Doc,
    cls: Doc,
    teacher: Doc,
    date: string,
    value: number,
    bt: Doc,
    comment: string | null = null,
  ) =>
    Score.create({
      schoolId: school.id,
      studentId: st._id,
      classId: cls._id,
      teacherId: teacher._id,
      academicYearId: year._id,
      behaviorTypeId: bt._id,
      value,
      comment,
      date,
    });
  await sc(s1, c5, t1u, '2026-10-01', 90, pos, 'T1 izoh');
  await sc(s1, c5, t1u, '2026-10-02', 80, pos);
  await sc(s1, c5, t1u, '2026-10-03', 70, neg);
  await sc(s1, c5, t3u, '2026-10-04', 60, pos, 'T3 maxfiy izoh');
  for (const d of ['01', '02', '03']) await sc(s2, c5, t1u, `2026-10-${d}`, 100, pos);
  for (const d of ['01', '02']) await sc(s3, c5, t1u, `2026-10-${d}`, 50, neg);
  for (const d of ['01', '02', '03']) await sc(s4, c6, t2u, `2026-10-${d}`, 60, pos);

  const at = (st: Doc, cls: Doc, teacher: Doc, date: string, category: AttendanceCategory) =>
    AttendanceRecord.create({
      schoolId: school.id,
      studentId: st._id,
      classId: cls._id,
      academicYearId: year._id,
      date,
      lessonNo: 0,
      statusId: statuses[category]._id,
      category,
      markedBy: teacher._id,
      updatedBy: teacher._id,
    });
  await at(s1, c5, t1u, '2026-10-12', 'present');
  await at(s1, c5, t1u, '2026-10-13', 'late');
  await at(s1, c5, t1u, '2026-10-14', 'absent_unexcused');
  await at(s2, c5, t1u, '2026-10-12', 'present');
  await at(s2, c5, t1u, '2026-10-13', 'present');
  await at(s4, c6, t2u, '2026-10-13', 'absent_excused');

  [root, admin, rep, noview, t1, t2, tNoRep] = await Promise.all(
    ['root', 'admin', 'rep', 'noview', 'teacher1', 'teacher2', 'tnorep'].map(
      async (u) => (await login(u)).token,
    ),
  );
});

const get = (t: string, path: string, h: Record<string, string> = {}) =>
  request(app).get(`/api/v1/reports${path}`).set(bearer(t)).set(h);
const H = (id: string): Record<string, string> => ({ 'X-School-Id': id });
const setAtt = (values: object) =>
  request(app)
    .put('/api/v1/settings/attendance')
    .set(bearer(root))
    .send({ scope: 'school', schoolId: school.id, values });

describe('Sinf hisoboti', () => {
  it('shakl va formulalar: avgScore, davomat foizi, rank/ratingScore (reyting dvigateli), topBehavior, xulq taqsimoti', async () => {
    const res = await get(admin, `/class?classId=${c5.id}&${Q}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.meta).toMatchObject({
      period: { from: '2026-10-01', to: '2026-10-14' },
      school: { id: school.id, name: 'Maktab a' },
      scope: 'class',
    });
    expect(new Date(d.meta.generatedAt).toString()).not.toBe('Invalid Date');
    expect(d.class).toEqual({
      id: c5.id,
      name: '5-A',
      grade: 5,
      homeroomTeacher: { id: t1u.id, fullName: 'Test teacher1' },
    });
    expect(d.summary).toEqual({
      students: 3,
      ratedStudents: 2, // s1 (4 kun), s2 (3 kun); s3 — 2 kun, eligible emas
      avgScore: 77.78, // 700 / 9 ta kunlik ball birligi
      daysScored: 4,
      scoresCount: 9,
      subjectAvg: null,
      gradesCount: 0,
      attendanceRate: 80, // (s1: 2/3, s2: 2/2) -> 4/5
      penaltyTotal: 0,
    });
    const by = (id: string) => d.students.find((s: { studentId: string }) => s.studentId === id);
    expect(by(s1.id)).toEqual({
      studentId: s1.id,
      fullName: 'Aliyev Ali',
      studentCode: 'A-1',
      classRank: 2,
      rank: 2,
      ratingScore: 75,
      avgScore: 75,
      minScore: 60,
      maxScore: 90,
      daysCount: 4,
      scoresCount: 4,
      subjectAvg: null,
      gradesCount: 0,
      attendance: {
        present: 1,
        late: 1,
        absentExcused: 0,
        absentUnexcused: 1,
        total: 3,
        rate: 66.67,
      },
      penalty: 0,
      topBehavior: { name: 'Namunali xulq', count: 3 },
    });
    expect(by(s2.id)).toMatchObject({
      classRank: 1,
      rank: 1,
      ratingScore: 100,
      avgScore: 100,
      attendance: { total: 2, rate: 100 },
    });
    expect(by(s3.id)).toMatchObject({
      classRank: null,
      rank: null,
      ratingScore: null,
      avgScore: 50,
      daysCount: 2,
      scoresCount: 2,
      topBehavior: { name: 'Darsga kechikish', count: 2 },
    });
    expect(by(s3.id).attendance).toEqual({
      present: 0,
      late: 0,
      absentExcused: 0,
      absentUnexcused: 0,
      total: 0,
      rate: null,
    });
    expect(d.students.map((s: { fullName: string }) => s.fullName)).toEqual([
      'Aliyev Ali',
      'Bekov Bek',
      'Valiyev Vali',
    ]);
    expect(d.behaviorDistribution).toEqual([
      {
        behaviorTypeId: pos.id,
        name: 'Namunali xulq',
        kind: 'positive',
        color: '#16A34A',
        count: 6,
      },
      {
        behaviorTypeId: neg.id,
        name: 'Darsga kechikish',
        kind: 'negative',
        color: '#DC2626',
        count: 3,
      },
    ]);
  });

  it('rank reyting dvigatelining jonli hisobi bilan mos, davomat jarimasi hisobga olinadi', async () => {
    const live = (
      await request(app)
        .get(`/api/v1/ratings/students?${Q}&includeIneligible=true`)
        .set(bearer(admin))
    ).body.data.items;
    const report = (await get(admin, `/class?classId=${c5.id}&${Q}`)).body.data.students;
    for (const r of report) {
      const l = live.find((x: { studentId: string }) => x.studentId === r.studentId);
      expect(r.rank).toBe(l.eligible ? l.rank : null);
      expect(r.ratingScore).toBe(l.eligible ? l.score : null);
    }

    await setAtt({
      ratingImpact: {
        enabled: true,
        penaltyLate: 2,
        penaltyAbsentExcused: 0,
        penaltyAbsentUnexcused: 20,
      },
    });
    const d = (await get(admin, `/class?classId=${c5.id}&${Q}`)).body.data;
    // s1: 75 - (1*2 + 1*20) = 53 -> s4 (60, boshqa sinf) dan ham pastda, sinf ichida 2-o'rin saqlanadi
    const s1row = d.students.find((s: { studentId: string }) => s.studentId === s1.id);
    expect(s1row).toMatchObject({ ratingScore: 53, penalty: 22, avgScore: 75 });
    expect(s1row.rank).toBe(3); // s2 100, s4 60, s1 53 (butun maktab bo'yicha)
    expect(d.summary.penaltyTotal).toBe(22);
  });

  it("bo'sh davr: 0 qator va null qiymatlar xatosiz", async () => {
    const d = (await get(admin, `/class?classId=${c5.id}&from=2026-09-01&to=2026-09-10`)).body.data;
    expect(d.summary).toEqual({
      students: 3,
      ratedStudents: 0,
      avgScore: null,
      daysScored: 0,
      scoresCount: 0,
      subjectAvg: null,
      gradesCount: 0,
      attendanceRate: null,
      penaltyTotal: 0,
    });
    expect(
      d.students.every(
        (s: { avgScore: number | null; rank: number | null }) =>
          s.avgScore === null && s.rank === null,
      ),
    ).toBe(true);
    expect(d.behaviorDistribution).toEqual([]);

    const emptyClass = await makeClass(school.id, year.id, '9-A');
    const e = (await get(admin, `/class?classId=${emptyClass.id}&${Q}`)).body.data;
    expect(e.students).toEqual([]);
    expect(e.summary.students).toBe(0);
  });
});

describe("O'quvchi hisoboti", () => {
  it("shakl: ball, dinamika, xulq, davomat, baholar; admin hammasini, o'qituvchi esa boshqa izohlarsiz ko'radi", async () => {
    const res = await get(admin, `/student/${s1.id}?${Q}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.meta.scope).toBe('student');
    expect(d.student).toEqual({
      id: s1.id,
      fullName: 'Aliyev Ali',
      studentCode: 'A-1',
      birthDate: '2013-03-15',
      gender: 'male',
      class: { id: c5.id, name: '5-A' },
      status: 'active',
      parentPhone: '+998901112233',
    });
    expect(d.score).toEqual({
      avgScore: 75,
      minScore: 60,
      maxScore: 90,
      daysCount: 4,
      scoresCount: 4,
      rank: 2,
      classRank: 2,
      ratingScore: 75,
      ratedStudentsInClass: 2,
    });
    expect(d.trend).toEqual([
      { date: '2026-10-01', dayScore: 90 },
      { date: '2026-10-02', dayScore: 80 },
      { date: '2026-10-03', dayScore: 70 },
      { date: '2026-10-04', dayScore: 60 },
    ]);
    expect(d.attendance).toMatchObject({
      total: 3,
      present: 1,
      late: 1,
      absentExcused: 0,
      absentUnexcused: 1,
      rate: 66.67,
      penalty: 0,
    });
    expect(d.attendance.days).toEqual([
      { date: '2026-10-12', category: 'present', status: 'present' },
      { date: '2026-10-13', category: 'late', status: 'late' },
      { date: '2026-10-14', category: 'absent_unexcused', status: 'absent_unexcused' },
    ]);
    expect(
      d.behaviorDistribution.map((b: { name: string; count: number }) => [b.name, b.count]),
    ).toEqual([
      ['Namunali xulq', 3],
      ['Darsga kechikish', 1],
    ]);
    expect(d.entries.map((e: { date: string }) => e.date)).toEqual([
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ]); // sana desc
    expect(d.entries[0]).toMatchObject({
      value: 60,
      behaviorType: { name: 'Namunali xulq', kind: 'positive', color: '#16A34A' },
      comment: 'T3 maxfiy izoh',
      teacher: { id: t3u.id },
    });

    // O'qituvchi (teacher1): o'z izohi ko'rinadi, boshqa o'qituvchi (teacher3) izohi null; parentPhone yo'q
    const asT = (await get(t1, `/student/${s1.id}?${Q}`)).body.data;
    expect(asT.entries.find((e: { date: string }) => e.date === '2026-10-01').comment).toBe(
      'T1 izoh',
    );
    expect(asT.entries.find((e: { date: string }) => e.date === '2026-10-04').comment).toBeNull();
    expect(JSON.stringify(asT)).not.toContain('maxfiy');
    expect(asT.student).not.toHaveProperty('parentPhone');
  });

  it('davomat kunlari: bir qism dars yo`qlik -> status partial; hamma dars yo`qlik -> absent', async () => {
    const lesson = (date: string, category: AttendanceCategory, lessonNo: number) =>
      AttendanceRecord.create({
        schoolId: school.id,
        studentId: s3._id,
        classId: c5._id,
        academicYearId: year._id,
        date,
        lessonNo,
        statusId: statuses[category]._id,
        category,
        markedBy: t1u._id,
        updatedBy: t1u._id,
      });
    await lesson('2026-10-08', 'absent_excused', 1);
    await lesson('2026-10-08', 'present', 2);
    await lesson('2026-10-09', 'absent_excused', 1);
    await lesson('2026-10-09', 'absent_unexcused', 2);
    const d = (await get(admin, `/student/${s3.id}?${Q}`)).body.data;
    expect(d.attendance.days).toEqual([
      { date: '2026-10-08', category: 'absent_excused', status: 'partial' },
      { date: '2026-10-09', category: 'absent_unexcused', status: 'absent_unexcused' },
    ]);
    // birlik bo'yicha foiz o'zgarmaydi
    expect(d.attendance).toMatchObject({ total: 4, present: 1, rate: 25 });
  });

  it("o'qituvchi faqat o'z sinfi o'quvchisi; tenant izolyatsiya; noto'g'ri id — 404", async () => {
    expect((await get(t1, `/student/${s4.id}?${Q}`)).status).toBe(404);
    expect((await get(t2, `/student/${s1.id}?${Q}`)).status).toBe(404);
    expect((await get(t2, `/student/${s4.id}?${Q}`)).status).toBe(200);
    expect((await get(admin, `/student/bad-id?${Q}`)).status).toBe(404);

    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    const os = await makeStudent(other.id, oc.id, 'Chet Maktab');
    expect((await get(admin, `/student/${os.id}?${Q}`)).status).toBe(404);
    expect((await get(root, `/student/${os.id}?${Q}`, H(school.id))).status).toBe(404);
    expect((await get(root, `/student/${os.id}?${Q}`, H(other.id))).status).toBe(200);
  });

  it("bo'sh davr: kunlik ballar/davomat yo'q — null va bo'sh massivlar", async () => {
    const d = (await get(admin, `/student/${s1.id}?from=2026-09-01&to=2026-09-10`)).body.data;
    expect(d.score).toEqual({
      avgScore: null,
      minScore: null,
      maxScore: null,
      daysCount: 0,
      scoresCount: 0,
      rank: null,
      classRank: null,
      ratingScore: null,
      ratedStudentsInClass: 0,
    });
    expect(d.trend).toEqual([]);
    expect(d.entries).toEqual([]);
    expect(d.attendance).toMatchObject({ total: 0, rate: null, days: [] });
  });
});

describe("O'qituvchilar, maktab, xulq va maktablar hisobotlari", () => {
  it("teachers: faollik ko'rsatkichlari va qamrov", async () => {
    const d = (await get(admin, `/teachers?${Q}`)).body.data;
    expect(d.meta.scope).toBe('teachers');
    const by = (id: string) => d.teachers.find((t: { teacherId: string }) => t.teacherId === id);
    expect(by(t1u.id)).toMatchObject({
      fullName: 'Test teacher1',
      username: 'teacher1',
      isActive: true,
      classes: [{ id: c5.id, name: '5-A' }],
      scoresCount: 8,
      daysActive: 3,
      studentsScored: 3,
      attendanceUnits: 5,
      attendanceDays: 3,
    });
    // 1-14 oktyabr, dushanba-shanba: 12 ish kuni x 1 sinf; baho qo'yilgan sinf-kunlar: 3
    expect(by(t1u.id).coverage).toEqual({ expectedClassDays: 12, scoredClassDays: 3, rate: 25 });
    expect(by(t1u.id).lastActivityAt).toBeTruthy();
    expect(by(t3u.id)).toMatchObject({
      scoresCount: 1,
      daysActive: 1,
      studentsScored: 1,
      attendanceUnits: 0,
      // baho yakshanbaga (04.10) qo'yilgan: scoresCount/daysActive ga kiradi, qamrovga kirmaydi
      coverage: { expectedClassDays: 12, scoredClassDays: 0, rate: 0 },
    });
    expect(by(t2u.id)).toMatchObject({
      scoresCount: 3,
      attendanceUnits: 1,
      classes: [{ name: '6-A' }],
    });
    const idle = d.teachers.find((t: { username: string }) => t.username === 'tnorep');
    expect(idle).toMatchObject({
      scoresCount: 0,
      daysActive: 0,
      lastActivityAt: null,
      classes: [],
      coverage: { expectedClassDays: 0, scoredClassDays: 0, rate: null },
    });

    const filtered = (await get(admin, `/teachers?${Q}&classId=${c5.id}`)).body.data.teachers
      .map((t: { username: string }) => t.username)
      .sort();
    expect(filtered).toEqual(['teacher1', 'teacher3']);
    expect((await get(admin, `/teachers?${Q}&classId=64b64b64b64b64b64b64b64b`)).status).toBe(404);
  });

  it("school: jami ko'rsatkichlar, sinflar jadvali, xulq va kunlik dinamika", async () => {
    const d = (await get(admin, `/school?${Q}`)).body.data;
    expect(d.meta.scope).toBe('school');
    expect(d.totals).toMatchObject({
      students: 4,
      classes: 2,
      teachers: 4,
      scoresCount: 12,
      attendanceRate: 66.67, // 4 / 6 birlik
      penaltyTotal: 0,
    });
    expect(d.totals.avgScore).toBe(73.33); // (700 + 180) / 12 kunlik ball birligi
    const c5row = d.classes.find((c: { classId: string }) => c.classId === c5.id);
    expect(c5row).toMatchObject({
      className: '5-A',
      grade: 5,
      studentsCount: 3,
      ratedStudents: 2,
      avgScore: 77.78,
      ratingScore: 87.5,
      rank: 1,
      attendanceRate: 80,
      scoresCount: 9,
    });
    expect(d.classes.find((c: { classId: string }) => c.classId === c6.id)).toMatchObject({
      className: '6-A',
      studentsCount: 1,
      ratedStudents: 1,
      avgScore: 60,
      ratingScore: 60,
      rank: 2,
      attendanceRate: 0,
      scoresCount: 3,
    });
    expect(d.behaviorDistribution.reduce((s: number, b: { count: number }) => s + b.count, 0)).toBe(
      12,
    );
    expect(d.dailyTrend[0]).toEqual({
      date: '2026-10-01',
      avgScore: 75,
      attendanceRate: null,
      scoresCount: 4,
    });
    expect(d.dailyTrend.find((t: { date: string }) => t.date === '2026-10-13')).toMatchObject({
      avgScore: null,
      attendanceRate: 66.67,
      scoresCount: 0,
    });
    expect(d.dailyTrend.map((t: { date: string }) => t.date)).toEqual(
      [...d.dailyTrend.map((t: { date: string }) => t.date)].sort(),
    );
  });

  it("behavior: turlar, kind, sinflar bo'yicha va top o'quvchilar", async () => {
    const d = (await get(admin, `/behavior?${Q}`)).body.data;
    expect(d.byType).toEqual([
      {
        behaviorTypeId: pos.id,
        name: 'Namunali xulq',
        kind: 'positive',
        color: '#16A34A',
        count: 9,
        studentsCount: 3,
      },
      {
        behaviorTypeId: neg.id,
        name: 'Darsga kechikish',
        kind: 'negative',
        color: '#DC2626',
        count: 3,
        studentsCount: 2,
      },
    ]);
    expect(d.byKind).toEqual({ positive: 9, negative: 3, neutral: 0 });
    expect(d.byClass).toEqual([
      { classId: c5.id, className: '5-A', positive: 6, negative: 3, neutral: 0, total: 9 },
      { classId: c6.id, className: '6-A', positive: 3, negative: 0, neutral: 0, total: 3 },
    ]);
    // Teng sonlarda ism bo'yicha tartiblanadi: Aliyev (3), Cholpon (3), Valiyev (3)
    expect(
      d.topStudents.positive.map((s: { fullName: string; count: number }) => [s.fullName, s.count]),
    ).toEqual([
      ['Aliyev Ali', 3],
      ['Cholpon Chol', 3],
      ['Valiyev Vali', 3],
    ]);
    expect(d.topStudents.negative[0]).toMatchObject({ studentId: s3.id, count: 2 });
    expect(d.topStudents.positive.length).toBeLessThanOrEqual(10);

    const one = (await get(admin, `/behavior?${Q}&classId=${c6.id}`)).body.data;
    expect(one.byKind).toEqual({ positive: 3, negative: 0, neutral: 0 });
    expect(one.byClass).toHaveLength(1);
  });

  it('schools: faqat superadmin, X-School-Id shart emas; maktablar solishtiruvi', async () => {
    const res = await get(root, `/schools?${Q}`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta).toMatchObject({ scope: 'schools', school: null });
    const a = res.body.data.schools.find((s: { slug: string }) => s.slug === 'a');
    expect(a).toEqual({
      schoolId: school.id,
      name: 'Maktab a',
      slug: 'a',
      enabled: false,
      students: 4,
      classes: 2,
      teachers: 4,
      scoresCount: 12,
      avgScore: 73.33,
      ratingScore: 78.33, // eligible: 100, 75, 60
      attendanceRate: 66.67,
      activeTeachers: 3,
    });
    const b = res.body.data.schools.find((s: { slug: string }) => s.slug === 'b');
    expect(b).toMatchObject({
      students: 0,
      classes: 0,
      scoresCount: 0,
      avgScore: null,
      ratingScore: null,
      attendanceRate: null,
      activeTeachers: 0,
    });
    for (const t of [admin, rep, t1]) expect((await get(t, `/schools?${Q}`)).status).toBe(403);
  });
});

describe('Ruxsatlar, tenant va validatsiya', () => {
  it("o'qituvchi: sinf/o'quvchi hisobotlari faqat o'z sinfi; teachers/school/behavior/schools — 403", async () => {
    expect((await get(t1, `/class?classId=${c5.id}&${Q}`)).status).toBe(200);
    expect((await get(t1, `/class?classId=${c6.id}&${Q}`)).status).toBe(404);
    expect((await get(t2, `/class?classId=${c5.id}&${Q}`)).status).toBe(404);
    for (const p of ['/teachers', '/school', '/behavior', '/schools']) {
      expect((await get(t1, `${p}?${Q}`)).status, p).toBe(403);
      expect((await get(t1, `${p}/export?${Q}`)).status, `${p}/export`).toBe(403);
    }
    expect((await get(tNoRep, `/class?classId=${c5.id}&${Q}`)).status).toBe(403); // reports.view yo'q
    expect((await request(app).get(`/api/v1/reports/school?${Q}`)).status).toBe(401);
  });

  it("school_admin reports.view siz 403; superadmin X-School-Id talab qiladi; boshqa maktab sinfi/o'quvchisi 404", async () => {
    expect((await get(noview, `/school?${Q}`)).status).toBe(403);
    expect((await get(rep, `/school?${Q}`)).status).toBe(200);
    expect((await get(root, `/school?${Q}`)).status).toBe(400);
    expect((await get(root, `/school?${Q}`, H(school.id))).body.data.meta.school.id).toBe(
      school.id,
    );

    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    await makeUser({
      username: 'oadmin',
      role: 'school_admin',
      schoolId: other.id,
      permissions: ['reports.view'],
    });
    const ot = (await login('oadmin')).token;
    expect((await get(admin, `/class?classId=${oc.id}&${Q}`)).status).toBe(404);
    expect((await get(admin, `/teachers?${Q}&classId=${oc.id}`)).status).toBe(404);
    expect((await get(admin, `/behavior?${Q}&classId=${oc.id}`)).status).toBe(404);
    expect((await get(ot, `/class?classId=${c5.id}&${Q}`)).status).toBe(404);
    expect((await get(ot, `/school?${Q}`)).body.data.totals.students).toBe(0);
    expect((await get(admin, `/class?classId=bad&${Q}`)).status).toBe(400);
    expect((await get(admin, `/class?${Q}`)).status).toBe(400); // classId majburiy
  });

  it("davr validatsiyasi: majburiy, from>to, >366 kun, kelajak, noto'g'ri format", async () => {
    const bad = async (q: string, path = 'to') => {
      const r = await get(admin, `/school?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    };
    await bad('', 'from');
    await bad('from=2026-10-01', 'to');
    await bad('from=2026-10-10&to=2026-10-01', 'from');
    await bad('from=2025-01-01&to=2026-10-14');
    await bad('from=2026-10-01&to=2026-10-15'); // kelajak (bugun 14-oktyabr)
    await bad('from=01.10.2026&to=14.10.2026', 'from');
    expect((await get(admin, '/school?from=2025-10-14&to=2026-10-14')).status).toBe(200); // aynan 365+1 kun
    expect((await get(admin, '/school?from=2025-10-13&to=2026-10-14')).status).toBe(200); // 366 oraliq
    expect((await get(admin, '/school?from=2025-10-12&to=2026-10-14')).status).toBe(400);
    expect((await get(admin, '/school?from=2026-10-14&to=2026-10-14')).status).toBe(200); // bir kunlik
  });

  it('qator cheklovi: REPORTS_MAX_ROWS dan oshsa 400 "Davrni qisqartiring"', async () => {
    const original = env.REPORTS_MAX_ROWS;
    try {
      env.REPORTS_MAX_ROWS = 2;
      const r = await get(admin, `/class?classId=${c5.id}&${Q}`);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/Davrni qisqartiring/);
      expect((await get(admin, `/class/export?classId=${c5.id}&${Q}&format=pdf`)).status).toBe(400);
      expect((await get(admin, `/teachers?${Q}`)).status).toBe(400);
      env.REPORTS_MAX_ROWS = 5000;
      expect((await get(admin, `/class?classId=${c5.id}&${Q}`)).status).toBe(200);
    } finally {
      env.REPORTS_MAX_ROWS = original;
    }
    expect(await AuditLog.countDocuments({ action: 'reports.export' })).toBe(0);
  });
});
