import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { Setting } from '../src/models/Setting';
import { rechain } from '../src/modules/timetable/timetable.chain';
import {
  applyOverrides,
  lessonsFromSlices,
  resolveLesson,
  resolveLessons,
  subjectLessonsInRange,
  teacherLessons,
  teacherLessonsInRange,
  type VersionSlice,
} from '../src/modules/timetable/timetable.resolver';
import { makeClass, makeSchool, makeSubject, makeUser, makeYear, useTestDb } from './helpers';

useTestDb();

type Doc = { id: string };
let school: Doc, other: Doc;
let c1: Doc, c2: Doc;
let math: Doc, eng: Doc;
let t1: Doc, t2: Doc;

const entry = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  groupKey: null,
  room: null,
});

async function version(
  classId: string,
  validFrom: string,
  entries: ReturnType<typeof entry>[],
  schoolId = school.id,
  status: 'draft' | 'active' = 'active',
) {
  return TimetableVersion.create({
    schoolId,
    academicYearId: new Types.ObjectId(),
    classId,
    status,
    validFrom,
    entries,
    activatedAt: status === 'draft' ? null : new Date(),
  });
}

beforeEach(async () => {
  school = await makeSchool('rs1');
  other = await makeSchool('rs2');
  const year = await makeYear(school.id);
  c1 = await makeClass(school.id, year.id, '6-A');
  c2 = await makeClass(school.id, year.id, '6-B');
  math = await makeSubject('Matematika');
  eng = await makeSubject('Ingliz tili');
  t1 = await makeUser({ username: 'rs_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'rs_t2', role: 'teacher', schoolId: school.id });
});

// 2026-11-02 = dushanba, 11-03 seshanba, 11-08 yakshanba

describe('resolver', () => {
  it("sana bo'yicha versiyani tanlaydi (chegara kunlari ham)", async () => {
    await version(c1.id, '2026-09-01', [entry(1, 1, math.id, t1.id)]);
    await version(c1.id, '2026-11-09', [entry(1, 1, eng.id, t2.id), entry(1, 2, math.id, t1.id)]);
    await rechain(c1.id);

    const before = await resolveLessons(school.id, c1.id, '2026-11-02');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      classId: c1.id,
      date: '2026-11-02',
      weekday: 1,
      lessonNo: 1,
      subjectId: math.id,
      teacherId: t1.id,
      source: 'timetable',
      cancelled: false,
      groupKey: null,
    });
    expect(before[0].versionId).toBeTruthy();

    const after = await resolveLessons(school.id, c1.id, '2026-11-09');
    expect(after.map((l) => l.subjectId)).toEqual([eng.id, math.id]);
    const eve = await resolveLessons(school.id, c1.id, '2026-11-08'); // validTo + 1 emas, yakshanba
    expect(eve).toEqual([]);
    expect(await resolveLessons(school.id, c1.id, '2026-08-31')).toEqual([]);
    // versiya chegarasida: 11-09 yangi, o'tgan hafta eski
    expect((await resolveLessons(school.id, c1.id, '2026-11-02'))[0].subjectId).toBe(math.id);
  });

  it("resolveLesson: dars raqami va guruh bo'yicha", async () => {
    await version(c1.id, '2026-09-01', [entry(2, 3, math.id, t1.id)]);
    const l = await resolveLesson(school.id, c1.id, '2026-11-03', 3);
    expect(l?.teacherId).toBe(t1.id);
    expect(await resolveLesson(school.id, c1.id, '2026-11-03', 2)).toBeNull();
    expect(await resolveLesson(school.id, c1.id, '2026-11-03', 3, 'g1')).toBeNull();
  });

  it("ish kuni emas -> bo'sh; qoralama hisobga olinmaydi; boshqa maktab versiyasi chiqmaydi", async () => {
    await version(c1.id, '2026-09-01', [entry(7, 1, math.id, t1.id), entry(1, 1, math.id, t1.id)]);
    expect(await resolveLessons(school.id, c1.id, '2026-11-08')).toEqual([]); // yakshanba
    await version(c2.id, '2026-09-01', [entry(1, 1, math.id, t1.id)], school.id, 'draft');
    expect(await resolveLessons(school.id, c2.id, '2026-11-02')).toEqual([]);
    expect(await resolveLessons(other.id, c1.id, '2026-11-02')).toEqual([]);
  });

  it('outOfRange yozuvlar chiqarib tashlanadi (lessonsPerDay va workingWeekdays)', async () => {
    await version(c1.id, '2026-09-01', [
      entry(1, 1, math.id, t1.id),
      entry(1, 5, math.id, t1.id),
      entry(3, 1, eng.id, t1.id),
    ]);
    await Setting.create({
      scope: 'school',
      schoolId: school.id,
      key: 'attendance',
      value: { lessonsPerDay: 3, workingWeekdays: [1, 2] },
    });
    const mon = await resolveLessons(school.id, c1.id, '2026-11-02');
    expect(mon.map((l) => l.lessonNo)).toEqual([1]); // 5-dars chiqarildi
    expect(await resolveLessons(school.id, c1.id, '2026-11-04')).toEqual([]); // chorshanba ish kuni emas
  });

  it("o'qituvchi darslari: kun va davr, versiya chegarasidan o'tib", async () => {
    await version(c1.id, '2026-09-01', [entry(1, 1, math.id, t1.id), entry(1, 2, eng.id, t2.id)]);
    await version(c2.id, '2026-09-01', [entry(1, 3, math.id, t1.id)]);
    await version(c1.id, '2026-11-09', [entry(1, 2, eng.id, t1.id)]);
    await rechain(c1.id);
    const day = await teacherLessons(school.id, t1.id, '2026-11-02');
    expect(day.map((l) => `${l.classId}:${l.lessonNo}`)).toEqual([`${c1.id}:1`, `${c2.id}:3`]);
    const range = await teacherLessonsInRange(school.id, t1.id, '2026-11-02', '2026-11-10');
    expect(range.map((l) => `${l.date}:${l.lessonNo}`)).toEqual([
      '2026-11-02:1',
      '2026-11-02:3',
      '2026-11-09:2',
      '2026-11-09:3',
    ]);
    expect(await teacherLessons(other.id, t1.id, '2026-11-02')).toEqual([]);
  });

  it("subjectLessonsInRange: bitta so'rov, barcha versiyalar bo'yicha", async () => {
    await version(c1.id, '2026-09-01', [entry(1, 1, math.id, t1.id), entry(2, 1, eng.id, t2.id)]);
    await version(c1.id, '2026-11-09', [entry(1, 2, math.id, t1.id)]);
    await rechain(c1.id);
    const list = await subjectLessonsInRange(school.id, c1.id, math.id, '2026-11-01', '2026-11-15');
    expect(list.map((l) => `${l.date}#${l.lessonNo}`)).toEqual(['2026-11-02#1', '2026-11-09#2']);
    expect(list.every((l) => l.subjectId === math.id)).toBe(true);
  });
});

describe('sof funksiyalar va override ilgagi', () => {
  it("lessonsFromSlices va applyOverrides (bo'sh ro'yxat — o'zgarishsiz)", () => {
    const slices: VersionSlice[] = [
      {
        id: 'v1',
        classId: 'c',
        validFrom: '2026-09-01',
        validTo: null,
        entries: [
          { weekday: 1, lessonNo: 1, subjectId: 's', teacherId: 't', groupKey: null, room: '5' },
        ],
      },
    ];
    const lessons = lessonsFromSlices(
      slices,
      { workingWeekdays: [1], lessonsPerDay: 2 },
      ['c'],
      ['2026-11-02', '2026-11-09'],
    );
    expect(lessons).toHaveLength(2);
    expect(lessons[0].room).toBe('5');
    expect(applyOverrides(lessons, [])).toBe(lessons);
  });
});
