import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ClassModel } from '../src/models/Class';
import { LessonOverride } from '../src/models/LessonOverride';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { User } from '../src/models/User';
import { teacherLessons, resolveLessons } from '../src/modules/timetable/timetable.resolver';
import { clock } from '../src/utils/clock';
import {
  app,
  assignSubject,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

type Doc = { id: string };
const API = '/api/v1/timetable';
// 2026-11-04 = chorshanba (weekday 3), 2026-11-05 = payshanba, 2026-11-08 = yakshanba
const WED = '2026-11-04';
const THU = '2026-11-05';
const SUN = '2026-11-08';

let school: Doc, other: Doc;
let c1: Awaited<ReturnType<typeof makeClass>>;
let c2: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, phys: Doc, eng: Doc;
let t1: Doc, t2: Doc, t3: Doc, tOther: Doc;
let admin: string, viewer: string, nobody: string, teacher1: string, adminOther: string;

const e = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  groupKey: null,
  room: null,
});
const g = (t: string, path: string) => request(app).get(`${API}${path}`).set(bearer(t));
const post = (t: string, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(bearer(t)).send(body);
const del = (t: string, path: string) => request(app).delete(`${API}${path}`).set(bearer(t));
const make = (body: object, t = admin) => post(t, '/overrides', body);

async function version(classId: string, entries: object[]) {
  await TimetableVersion.create({
    schoolId: school.id,
    academicYearId: (await ClassModel.findById(classId))!.academicYearId,
    classId,
    status: 'active',
    validFrom: '2026-09-01',
    activatedAt: new Date(),
    entries,
  });
}

beforeEach(async () => {
  clock.set(() => new Date('2026-11-04T07:00:00Z'));
  school = await makeSchool('ov');
  other = await makeSchool('ov2');
  const year = await makeYear(school.id);
  const yearO = await makeYear(other.id);
  t1 = await makeUser({ username: 'ov_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'ov_t2', role: 'teacher', schoolId: school.id });
  t3 = await makeUser({ username: 'ov_t3', role: 'teacher', schoolId: school.id });
  tOther = await makeUser({ username: 'ov_to', role: 'teacher', schoolId: other.id });
  await makeUser({ username: 'ov_off', role: 'teacher', schoolId: school.id, isActive: false });
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  eng = await makeSubject('Ingliz tili');
  c1 = await makeClass(school.id, year.id, '5-A', [t1.id]);
  c2 = await makeClass(school.id, year.id, '6-A', [t2.id]);
  await makeClass(other.id, yearO.id, '5-A');
  await assignSubject(school.id, c1, math.id, t1.id);
  await assignSubject(school.id, c2, phys.id, t2.id);
  // 5-A: chor 1 = mat/t1, chor 2 = fizika/t2 ; 6-A: chor 1 = fizika/t2... t2 band 1-darsda ham
  await version(c1.id, [e(3, 1, math.id, t1.id), e(3, 2, phys.id, t2.id)]);
  await version(c2.id, [e(3, 1, phys.id, t2.id), e(3, 3, math.id, t1.id)]);
  for (const [u, perms] of [
    ['ov_admin', ['timetable.view', 'timetable.substitute']],
    ['ov_view', ['timetable.view']],
    ['ov_none', []],
  ] as const) {
    await makeUser({
      username: u,
      role: 'school_admin',
      schoolId: school.id,
      permissions: [...perms],
    });
  }
  await makeUser({
    username: 'ov_admin_o',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['timetable.view', 'timetable.substitute'],
  });
  admin = (await login('ov_admin')).token;
  viewer = (await login('ov_view')).token;
  nobody = (await login('ov_none')).token;
  adminOther = (await login('ov_admin_o')).token;
  teacher1 = (await login('ov_t1')).token;
});

describe('override yaratish: tekshiruvlar', () => {
  it("substitute: o'qituvchi shart, asl o'qituvchidan farq qiladi, fan o'zgarmaydi", async () => {
    const base = { classId: c1.id, date: WED, lessonNo: 1, type: 'substitute' };
    expect((await make(base)).status).toBe(400);
    expect((await make({ ...base, teacherId: t1.id })).status).toBe(400);
    const r = await make({ ...base, teacherId: t3.id, subjectId: eng.id, reason: 'Kasal' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      classId: c1.id,
      class: { name: '5-A' },
      date: WED,
      lessonNo: 1,
      type: 'substitute',
      subject: null,
      teacher: { id: t3.id },
      originalSubject: { id: math.id, name: 'Matematika' },
      originalTeacher: { id: t1.id },
      reason: 'Kasal',
      moveGroupId: null,
      createdBy: { fullName: 'Test ov_admin' },
    });
    // fan saqlanmaydi (o'rinbosarda fan o'zgarmaydi)
    expect((await LessonOverride.findById(r.body.data.id))?.subjectId).toBeNull();
  });

  it("replace: fan va o'qituvchi shart, fan farq qilishi kerak", async () => {
    const base = { classId: c1.id, date: WED, lessonNo: 1, type: 'replace' };
    expect((await make({ ...base, teacherId: t3.id })).status).toBe(400);
    expect((await make({ ...base, subjectId: eng.id })).status).toBe(400);
    expect((await make({ ...base, subjectId: math.id, teacherId: t3.id })).status).toBe(400);
    const r = await make({ ...base, subjectId: eng.id, teacherId: t3.id });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      subject: { id: eng.id },
      teacher: { id: t3.id },
      originalSubject: { id: math.id },
      originalTeacher: { id: t1.id },
    });
  });

  it("cancel va jadvalsiz slot: 409; extra faqat bo'sh slotga", async () => {
    expect((await make({ classId: c1.id, date: WED, lessonNo: 5, type: 'cancel' })).status).toBe(
      409,
    );
    expect(
      (await make({ classId: c1.id, date: WED, lessonNo: 5, type: 'substitute', teacherId: t3.id }))
        .status,
    ).toBe(409);
    const extraBusy = { classId: c1.id, date: WED, lessonNo: 1, type: 'extra' };
    expect((await make({ ...extraBusy, subjectId: eng.id, teacherId: t3.id })).status).toBe(409);
    const ex = { classId: c1.id, date: WED, lessonNo: 5, type: 'extra' };
    expect((await make({ ...ex, teacherId: t3.id })).status).toBe(400);
    expect((await make({ ...ex, subjectId: eng.id })).status).toBe(400);
    const r = await make({ ...ex, subjectId: eng.id, teacherId: t3.id, room: '12' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      type: 'extra',
      subject: { id: eng.id },
      teacher: { id: t3.id },
      originalSubject: null,
      originalTeacher: null,
      room: '12',
    });
    const c = await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'cancel' });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({
      type: 'cancel',
      subject: null,
      teacher: null,
      originalTeacher: { id: t1.id },
    });
  });

  it('bir slotga bitta override (409), ish kuni emas, noto`g`ri o`qituvchi/fan', async () => {
    const b = { classId: c1.id, date: WED, lessonNo: 1, type: 'cancel' };
    expect((await make(b)).status).toBe(201);
    expect((await make(b)).status).toBe(409);
    expect((await make({ ...b, type: 'substitute', teacherId: t3.id })).status).toBe(409);
    expect((await make({ ...b, date: SUN, lessonNo: 2 })).status).toBe(400);
    const sub = { classId: c1.id, date: WED, lessonNo: 2, type: 'substitute' };
    expect((await make({ ...sub, teacherId: tOther.id })).status).toBe(400); // boshqa maktab
    expect((await make({ ...sub, teacherId: '0'.repeat(24) })).status).toBe(400);
    const inactive = await User.findOne({ username: 'ov_off' });
    expect((await make({ ...sub, teacherId: inactive?.id })).status).toBe(400);
    const rep = { classId: c1.id, date: WED, lessonNo: 2, type: 'replace', teacherId: t3.id };
    expect((await make({ ...rep, subjectId: '1'.repeat(24) })).status).toBe(400);
    expect((await make({ ...b, classId: '0'.repeat(24), lessonNo: 2 })).status).toBe(404);
    expect((await make({ ...b, lessonNo: 99 })).status).toBe(400);
  });

  it("arxivlangan sinf: 409; o'tgan sana ruxsat", async () => {
    const past = await make({ classId: c1.id, date: '2026-10-28', lessonNo: 1, type: 'cancel' });
    expect(past.status).toBe(201); // 2026-10-28 = chorshanba
    await c2.updateOne({ isArchived: true });
    expect((await make({ classId: c2.id, date: WED, lessonNo: 1, type: 'cancel' })).status).toBe(
      409,
    );
  });

  it("o'qituvchi to`qnashuvi: boshqa sinfda shu soatda darsi bor -> 409", async () => {
    // t2 6-A da chor 1-darsda fizika o'tadi; 5-A 1-darsga t2 ni o'rinbosar qilib bo'lmaydi
    const r = await make({
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'substitute',
      teacherId: t2.id,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('6-A');
    // 6-A 1-dars bekor qilinsa t2 bo'shaydi
    expect((await make({ classId: c2.id, date: WED, lessonNo: 1, type: 'cancel' })).status).toBe(
      201,
    );
    expect(
      (
        await make({
          classId: c1.id,
          date: WED,
          lessonNo: 1,
          type: 'substitute',
          teacherId: t2.id,
        })
      ).status,
    ).toBe(201);
    // endi t2 5-A 1-darsda band: 3-o'qituvchini qo'yib, so'ng t2 ni extra qilib bo'lmaydi
    const clash = await make({
      classId: c2.id,
      date: WED,
      lessonNo: 1,
      type: 'cancel',
    });
    expect(clash.status).toBe(409); // allaqachon override bor
  });
});

describe("resolver: override natijasi va o'qituvchi ko'rinishlari", () => {
  it('substitute / replace / cancel / extra resolver chiqishida', async () => {
    await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'substitute', teacherId: t3.id });
    await make({
      classId: c1.id,
      date: WED,
      lessonNo: 2,
      type: 'replace',
      subjectId: eng.id,
      teacherId: t3.id,
    });
    await make({ classId: c2.id, date: WED, lessonNo: 3, type: 'cancel' });
    await make({
      classId: c2.id,
      date: WED,
      lessonNo: 5,
      type: 'extra',
      subjectId: eng.id,
      teacherId: t3.id,
    });
    const l1 = await resolveLessons(school.id, c1.id, WED);
    expect(l1.map((l) => [l.lessonNo, l.source, l.overrideType, l.teacherId, l.cancelled])).toEqual(
      [
        [1, 'override', 'substitute', t3.id, false],
        [2, 'override', 'replace', t3.id, false],
      ],
    );
    expect(l1[0]).toMatchObject({ originalTeacherId: t1.id, subjectId: math.id });
    expect(l1[1]).toMatchObject({
      originalTeacherId: t2.id,
      originalSubjectId: phys.id,
      subjectId: eng.id,
    });
    expect(l1[0]?.overrideId).toBeTruthy();
    const l2 = await resolveLessons(school.id, c2.id, WED);
    expect(l2.map((l) => [l.lessonNo, l.source, l.overrideType, l.cancelled])).toEqual([
      [1, 'timetable', undefined, false],
      [3, 'override', 'cancel', true],
      [5, 'override', 'extra', false],
    ]);
    expect(l2[2]).toMatchObject({ teacherId: t3.id, subjectId: eng.id, versionId: null });
    // boshqa kun o'zgarmaydi
    expect(
      (await resolveLessons(school.id, c1.id, '2026-11-11')).every((l) => l.source === 'timetable'),
    ).toBe(true);
    // o'qituvchilar ko'rinishi: t3 o'zi o'tmaydigan sinflarda ham darsga ega; t1 o'z darsini yo'qotdi
    const t3Lessons = await teacherLessons(school.id, t3.id, WED);
    expect(t3Lessons.map((l) => `${l.classId === c1.id ? 'c1' : 'c2'}#${l.lessonNo}`)).toEqual([
      'c1#1',
      'c1#2',
      'c2#5',
    ]);
    const t1Lessons = await teacherLessons(school.id, t1.id, WED);
    expect(t1Lessons.map((l) => [l.lessonNo, l.cancelled])).toEqual([[3, true]]);
  });

  it('me/today: o`rinbosar o`z jadvali bo`lmasa ham darsni ko`radi', async () => {
    await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'substitute', teacherId: t3.id });
    const t3tok = (await login('ov_t3')).token;
    const r = await g(t3tok, '/me/today');
    expect(r.status).toBe(200);
    expect(r.body.data.hasTimetable).toBe(true);
    expect(r.body.data.lessons).toHaveLength(1);
    expect(r.body.data.lessons[0]).toMatchObject({
      lessonNo: 1,
      substitute: true,
      overrideType: 'substitute',
      source: 'override',
    });
    const t1Today = await g(teacher1, '/me/today');
    expect(t1Today.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([3]);
  });

  it('lessons endpoint override`larni ko`rsatadi', async () => {
    await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'cancel' });
    const r = await g(teacher1, `/lessons?classId=${c1.id}&date=${WED}`);
    expect(r.status).toBe(200);
    expect(r.body.data.lessons[0]).toMatchObject({
      lessonNo: 1,
      cancelled: true,
      overrideType: 'cancel',
      source: 'override',
    });
  });
});

describe('ko`chirish (move)', () => {
  const mv = (body: object, t = admin) => post(t, '/overrides/move', body);

  it('cancel + extra juftligi, bir moveGroupId; bittasini o`chirsa ikkalasi o`chadi', async () => {
    const r = await mv({
      classId: c1.id,
      from: { date: WED, lessonNo: 1 },
      to: { date: THU, lessonNo: 4 },
      reason: "Ko'chirildi",
    });
    expect(r.status).toBe(201);
    const [a, b] = r.body.data.items;
    expect(a).toMatchObject({ type: 'cancel', date: WED, lessonNo: 1 });
    expect(b).toMatchObject({
      type: 'extra',
      date: THU,
      lessonNo: 4,
      subject: { id: math.id },
      teacher: { id: t1.id },
    });
    expect(a.moveGroupId).toBeTruthy();
    expect(a.moveGroupId).toBe(b.moveGroupId);
    const thu = await resolveLessons(school.id, c1.id, THU);
    expect(thu.map((l) => [l.lessonNo, l.overrideType])).toEqual([[4, 'extra']]);

    expect((await del(admin, `/overrides/${b.id}`)).status).toBe(204);
    expect(await LessonOverride.countDocuments({})).toBe(0);
    expect(
      await AuditLog.countDocuments({ action: 'timetable.override_deleted', schoolId: school.id }),
    ).toBe(2);
    expect(
      await AuditLog.countDocuments({ action: 'timetable.override_created', schoolId: school.id }),
    ).toBe(2);
    expect((await del(admin, `/overrides/${b.id}`)).status).toBe(404);
  });

  it("maqsad band/ish kuni emas/bir xil joy/jadvalsiz manba; muvaffaqiyatsiz bo'lsa hech narsa qolmaydi", async () => {
    const from = { date: WED, lessonNo: 1 };
    expect((await mv({ classId: c1.id, from, to: from })).status).toBe(400);
    expect((await mv({ classId: c1.id, from, to: { date: WED, lessonNo: 2 } })).status).toBe(409);
    expect((await mv({ classId: c1.id, from, to: { date: SUN, lessonNo: 2 } })).status).toBe(400);
    expect(
      (
        await mv({
          classId: c1.id,
          from: { date: WED, lessonNo: 7 },
          to: { date: THU, lessonNo: 1 },
        })
      ).status,
    ).toBe(409);
    // t3 emas, t2: 6-A 1-dars (WED) — maqsad WED 1 band bo'lgani uchun 409 (jadval darsi bor)
    expect(
      (
        await mv({
          classId: c1.id,
          from: { date: WED, lessonNo: 2 },
          to: { date: WED, lessonNo: 3 },
          teacherId: t1.id,
        })
      ).status,
    ).toBe(409); // t1 6-A da 3-darsda band
    expect(await LessonOverride.countDocuments({})).toBe(0);
    // maqsad slotda allaqachon override bo'lsa: birinchi yozuv qaytarib olinadi
    await LessonOverride.create({
      schoolId: school.id,
      classId: c1.id,
      date: THU,
      lessonNo: 4,
      type: 'extra',
      subjectId: eng.id,
      teacherId: t3.id,
    });
    expect((await mv({ classId: c1.id, from, to: { date: THU, lessonNo: 4 } })).status).toBe(409);
    expect(await LessonOverride.countDocuments({})).toBe(1);
  });
});

describe('/day, /overrides, /free-teachers', () => {
  it('/teacher-day: tekis ro`yxat, override maydonlari va teacherId filtri', async () => {
    await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'substitute', teacherId: t3.id });
    await make({ classId: c2.id, date: WED, lessonNo: 3, type: 'cancel' });
    const r = await g(admin, `/teacher-day?date=${WED}`);
    expect(r.status).toBe(200);
    expect(r.body.data.isWorkday).toBe(true);
    expect(
      r.body.data.lessons.map(
        (l: { class: { name: string }; lessonNo: number }) => `${l.class.name}#${l.lessonNo}`,
      ),
    ).toEqual(['5-A#1', '5-A#2', '6-A#1', '6-A#3']);
    const sub = r.body.data.lessons[0];
    expect(sub).toMatchObject({
      classId: c1.id,
      subject: { name: 'Matematika' },
      teacher: { id: t3.id },
      originalTeacher: { id: t1.id },
      source: 'override',
      overrideType: 'substitute',
      cancelled: false,
    });
    expect(sub.overrideId).toBeTruthy();
    expect(r.body.data.lessons[3]).toMatchObject({
      cancelled: true,
      overrideType: 'cancel',
      originalTeacher: null,
    });
    // t1: 5-A#1 (asl o'qituvchi) + 6-A#3 (bekor, hali t1 nomida)
    const f1 = await g(admin, `/teacher-day?date=${WED}&teacherId=${t1.id}`);
    expect(f1.body.data.lessons.map((l: { lessonNo: number }) => l.lessonNo)).toEqual([1, 3]);
    // t3: faqat o'rinbosar bo'lgan dars
    const f3 = await g(admin, `/teacher-day?date=${WED}&teacherId=${t3.id}`);
    expect(f3.body.data.lessons).toHaveLength(1);
    // eski /day javobi o'zgarmagan
    const old = await g(admin, `/day?date=${WED}`);
    expect(old.body.data.classes).toHaveLength(2);
    expect(old.body.data.lessons).toBeUndefined();
    expect((await g(admin, `/teacher-day?date=${SUN}`)).body.data).toMatchObject({
      isWorkday: false,
      lessons: [],
    });
  });

  it('GET /overrides?date: ro`yxat, view yetarli, ruxsatsiz 403', async () => {
    await make({ classId: c2.id, date: WED, lessonNo: 3, type: 'cancel' });
    await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'substitute', teacherId: t3.id });
    await make({
      classId: c1.id,
      date: THU,
      lessonNo: 5,
      type: 'extra',
      subjectId: eng.id,
      teacherId: t3.id,
    });
    const r = await g(viewer, `/overrides?date=${WED}`);
    expect(r.status).toBe(200);
    expect(
      r.body.data.items.map(
        (i: { class: { name: string }; lessonNo: number }) => `${i.class.name}#${i.lessonNo}`,
      ),
    ).toEqual(['5-A#1', '6-A#3']);
    expect(r.body.data.items[1].originalTeacher.id).toBe(t1.id);
    expect((await g(nobody, `/overrides?date=${WED}`)).status).toBe(403);
    expect((await g(admin, '/overrides')).status).toBe(400);
  });

  it('free-teachers: bo`shlar, fan o`qituvchilari, yuklama va nom bo`yicha tartib', async () => {
    const r = await g(admin, `/free-teachers?date=${WED}&lessonNo=1&subjectId=${math.id}`);
    expect(r.status).toBe(200);
    // t2 1-darsda band; t1 (mat o'qituvchisi) 1-darsda band; t3 bo'sh, hech narsa o'tmaydi
    expect(
      r.body.data.items.map(
        (i: { id: string; free: boolean; teachesSubject: boolean; lessonsThatDay: number }) => [
          i.id,
          i.free,
          i.teachesSubject,
          i.lessonsThatDay,
        ],
      ),
    ).toEqual([
      [t3.id, true, false, 0],
      [t1.id, false, true, 2],
      [t2.id, false, false, 2],
    ]);
    // bekor qilingan dars o'qituvchini band qilmaydi va yuklamaga kirmaydi
    await make({ classId: c2.id, date: WED, lessonNo: 1, type: 'cancel' });
    const r2 = await g(admin, `/free-teachers?date=${WED}&lessonNo=1&subjectId=${math.id}`);
    expect(r2.body.data.items.map((i: { id: string }) => i.id)).toEqual([t3.id, t2.id, t1.id]);
    expect(r2.body.data.items[1]).toMatchObject({ id: t2.id, free: true, lessonsThatDay: 1 });
    // faqat substitute huquqi bilan
    expect((await g(viewer, `/free-teachers?date=${WED}&lessonNo=1`)).status).toBe(403);
  });
});

describe('ruxsat, tenant, audit', () => {
  it("faqat substitute huquqi: options, classes, teacher-day o'qiladi", async () => {
    await makeUser({
      username: 'ov_subonly',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['timetable.substitute'],
    });
    const tok = (await login('ov_subonly')).token;
    const opt = await g(tok, `/options?classId=${c1.id}`);
    expect(opt.status).toBe(200);
    expect(opt.body.data.teachers.length).toBeGreaterThanOrEqual(3);
    expect(opt.body.data.classAssignments).toEqual([{ subjectId: math.id, teacherId: t1.id }]);
    const cl = await g(tok, '/classes');
    expect(cl.status).toBe(200);
    expect(cl.body.data.classes).toHaveLength(2);
    expect((await g(tok, `/teacher-day?date=${WED}`)).status).toBe(200);
    // yozish ruxsati bor, lekin versiyalarni ko'rish yo'q
    expect((await g(tok, `/classes/${c1.id}/versions`)).status).toBe(403);
    expect((await g(nobody, '/options')).status).toBe(403);
    expect((await g(nobody, '/classes')).status).toBe(403);
    expect((await g(nobody, `/teacher-day?date=${WED}`)).status).toBe(403);
  });

  it("substitute huquqi yo'q -> 403 (yozish); o'qituvchi 403", async () => {
    const b = { classId: c1.id, date: WED, lessonNo: 1, type: 'cancel' };
    expect((await make(b, viewer)).status).toBe(403);
    expect((await make(b, nobody)).status).toBe(403);
    expect((await make(b, teacher1)).status).toBe(403);
    expect((await post(viewer, '/overrides/move', {})).status).toBe(403);
    expect((await del(viewer, `/overrides/${'0'.repeat(24)}`)).status).toBe(403);
    expect(await LessonOverride.countDocuments({})).toBe(0);
  });

  it('tenant: boshqa maktab sinfi/o`qituvchisi/override`i ko`rinmaydi', async () => {
    const mine = await make({ classId: c1.id, date: WED, lessonNo: 1, type: 'cancel' });
    expect(mine.status).toBe(201);
    expect(
      (await make({ classId: c1.id, date: WED, lessonNo: 2, type: 'cancel' }, adminOther)).status,
    ).toBe(404);
    expect((await del(adminOther, `/overrides/${mine.body.data.id}`)).status).toBe(404);
    expect((await g(adminOther, `/overrides?date=${WED}`)).body.data.items).toEqual([]);
    expect((await g(adminOther, `/teacher-day?date=${WED}`)).body.data.lessons).toEqual([]);
    const ft = await g(adminOther, `/free-teachers?date=${WED}&lessonNo=1`);
    expect(ft.body.data.items.map((i: { id: string }) => i.id)).toEqual([tOther.id]);
    expect(await LessonOverride.countDocuments({})).toBe(1);
  });

  it('audit: timetable.override_created / timetable.override_deleted', async () => {
    const r = await make({
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'substitute',
      teacherId: t3.id,
      reason: 'Kasal',
    });
    const created = await AuditLog.findOne({ action: 'timetable.override_created' });
    expect(created?.entityId).toBe(r.body.data.id);
    expect(created?.after).toMatchObject({ type: 'substitute', teacherId: t3.id, reason: 'Kasal' });
    expect((await del(admin, `/overrides/${r.body.data.id}`)).status).toBe(204);
    const removed = await AuditLog.findOne({ action: 'timetable.override_deleted' });
    expect(removed?.before).toMatchObject({ type: 'substitute', classId: c1.id });
    expect(await LessonOverride.countDocuments({})).toBe(0);
  });
});
