import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ClassModel } from '../src/models/Class';
import { ClassSubject } from '../src/models/ClassSubject';
import { Setting } from '../src/models/Setting';
import { Subject } from '../src/models/Subject';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { dedupeWarnings } from '../src/modules/timetable/timetable.conflicts';
import { rechain } from '../src/modules/timetable/timetable.chain';
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
// 2026-10-30 = juma; 2026-11-02 = dushanba
const TODAY = '2026-10-30';

let school: Doc, other: Doc;
let c1: Awaited<ReturnType<typeof makeClass>>;
let c2: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, eng: Doc, art: Doc;
let t1: Doc, t2: Doc, t3: Doc, tOther: Doc;
let admin: string, viewer: string, nobody: string, teacher1: string, adminOther: string;

const e = (
  weekday: number,
  lessonNo: number,
  subjectId: string,
  teacherId: string,
  room?: string,
) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  ...(room ? { room } : {}),
});
const g = (t: string, path: string) => request(app).get(`${API}${path}`).set(bearer(t));
const p = (t: string, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(bearer(t)).send(body);
const put = (t: string, path: string, body: object) =>
  request(app).put(`${API}${path}`).set(bearer(t)).send(body);
const del = (t: string, path: string) => request(app).delete(`${API}${path}`).set(bearer(t));

async function draft(classId: string, entries: object[], validFrom = '2026-11-02') {
  const c = await p(admin, `/classes/${classId}/versions`, { validFrom });
  expect(c.status).toBe(201);
  const id = c.body.data.version.id as string;
  const r = await put(admin, `/versions/${id}`, { entries });
  expect(r.status).toBe(200);
  return { id, res: r };
}

beforeEach(async () => {
  clock.set(() => new Date('2026-10-30T07:00:00Z'));
  school = await makeSchool('tt1');
  other = await makeSchool('tt2');
  const year = await makeYear(school.id);
  const yearO = await makeYear(other.id);
  t1 = await makeUser({ username: 'tt_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'tt_t2', role: 'teacher', schoolId: school.id });
  t3 = await makeUser({ username: 'tt_t3', role: 'teacher', schoolId: school.id });
  tOther = await makeUser({ username: 'tt_to', role: 'teacher', schoolId: other.id });
  c1 = await makeClass(school.id, year.id, '5-A', [t1.id]);
  c2 = await makeClass(school.id, year.id, '5-B', []);
  await makeClass(other.id, yearO.id, '5-A');
  math = await makeSubject('Matematika');
  eng = await makeSubject('Ingliz tili');
  art = await makeSubject('Rasm');
  await makeUser({
    username: 'tt_admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.manage', 'timetable.view'],
  });
  await makeUser({
    username: 'tt_view',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.view'],
  });
  await makeUser({ username: 'tt_none', role: 'school_admin', schoolId: school.id });
  await makeUser({
    username: 'tt_adminO',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['timetable.manage', 'timetable.view'],
  });
  admin = (await login('tt_admin')).token;
  viewer = (await login('tt_view')).token;
  nobody = (await login('tt_none')).token;
  adminOther = (await login('tt_adminO')).token;
  teacher1 = (await login('tt_t1')).token;
});

describe('ruxsatlar va tenant', () => {
  it("manage yo'q bo'lsa yozib bo'lmaydi; view faqat o'qiydi", async () => {
    expect((await p(viewer, `/classes/${c1.id}/versions`, {})).status).toBe(403);
    expect((await p(nobody, `/classes/${c1.id}/versions`, {})).status).toBe(403);
    expect((await g(viewer, '/classes')).status).toBe(200);
    expect((await g(nobody, '/classes')).status).toBe(403);
    expect((await g(nobody, `/classes/${c1.id}/versions`)).status).toBe(403);
    expect((await p(teacher1, `/classes/${c1.id}/versions`, {})).status).toBe(403);
  });

  it("o'qituvchi faqat o'z sinfi jadvalini ko'radi, qoralamalarni ko'rmaydi", async () => {
    const d = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    const r = await g(teacher1, `/classes/${c1.id}/versions`);
    expect(r.status).toBe(200);
    expect(r.body.data.versions).toHaveLength(0);
    expect((await g(teacher1, `/versions/${d.id}`)).status).toBe(404);
    expect((await g(teacher1, `/classes/${c2.id}/versions`)).status).toBe(403);
    expect((await g(teacher1, '/day')).status).toBe(403);
    expect((await g(teacher1, `/teachers/${t2.id}/week`)).status).toBe(403);
    expect((await g(teacher1, `/teachers/${t1.id}/week`)).status).toBe(200);
    expect((await g(teacher1, '/me/week')).status).toBe(200);
    // faollashtirilgach o'qituvchi o'z sinfi versiyasini ko'radi
    expect((await p(admin, `/versions/${d.id}/activate`, { validFrom: '2026-11-02' })).status).toBe(
      200,
    );
    const r2 = await g(teacher1, `/classes/${c1.id}/versions`);
    expect(r2.body.data.versions).toHaveLength(1);
    expect((await g(teacher1, `/versions/${d.id}`)).status).toBe(200);
  });

  it("boshqa maktab ma'lumotiga kirib bo'lmaydi", async () => {
    const d = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    expect((await g(adminOther, `/versions/${d.id}`)).status).toBe(404);
    expect((await g(adminOther, `/classes/${c1.id}/versions`)).status).toBe(404);
    expect((await put(adminOther, `/versions/${d.id}`, { entries: [] })).status).toBe(404);
    expect((await del(adminOther, `/versions/${d.id}`)).status).toBe(404);
    expect((await p(adminOther, `/versions/${d.id}/activate`, { validFrom: TODAY })).status).toBe(
      404,
    );
    expect((await g(adminOther, `/teachers/${t1.id}/week`)).status).toBe(404);
    const o = await g(adminOther, '/classes');
    expect(o.body.data.classes).toHaveLength(1);
  });
});

describe('CRUD va tekshiruvlar', () => {
  it("bo'sh qoralama yaratadi (validFrom sukut: ertaga), audit yoziladi", async () => {
    const r = await p(admin, `/classes/${c1.id}/versions`);
    expect(r.status).toBe(201);
    expect(r.body.data.version.status).toBe('draft');
    expect(r.body.data.version.validFrom).toBe('2026-10-31');
    expect(r.body.data.version.entries).toEqual([]);
    expect(await AuditLog.countDocuments({ action: 'timetable.version_create' })).toBe(1);
  });

  it("PUT: saqlaydi, tartiblaydi, sinf teacherIds ga o'qituvchini qo'shadi", async () => {
    const d = await draft(c2.id, [e(2, 1, eng.id, t2.id, '12'), e(1, 3, math.id, t3.id)]);
    const v = d.res.body.data.version;
    expect(v.entries.map((x: { weekday: number }) => x.weekday)).toEqual([1, 2]);
    expect(v.entries[1].room).toBe('12');
    expect(v.entries[0].subject.name).toBe('Matematika');
    const cls = await ClassModel.findById(c2.id);
    expect(cls?.teacherIds.map(String).sort()).toEqual([t2.id, t3.id].sort());
    expect(await AuditLog.countDocuments({ action: 'timetable.version_update' })).toBe(1);
  });

  it("chegaralar: kun/dars sozlamadan tashqarida, takror, noma'lum fan/o'qituvchi, yil chegarasi", async () => {
    const c = await p(admin, `/classes/${c1.id}/versions`, { validFrom: '2026-11-02' });
    const id = c.body.data.version.id as string;
    const bad = async (entries: object[], body: object = {}) =>
      (await put(admin, `/versions/${id}`, { entries, ...body })).status;
    expect(await bad([e(7, 1, math.id, t1.id)])).toBe(400); // yakshanba ish kuni emas
    expect(await bad([e(1, 7, math.id, t1.id)])).toBe(200); // lessonsPerDay=6 dan keyin ham mumkin
    expect(await bad([e(1, 12, math.id, t1.id)])).toBe(200);
    expect(await bad([e(1, 13, math.id, t1.id)])).toBe(400);
    expect(await bad([e(0, 1, math.id, t1.id)])).toBe(400);
    // bir o'qituvchi bir katakda ikki marta bo'lmaydi (turli o'qituvchilar bir katakda mumkin)
    expect(await bad([e(1, 1, math.id, t1.id), e(1, 1, eng.id, t1.id)])).toBe(400);
    expect(await bad([e(1, 1, math.id, tOther.id)])).toBe(400);
    expect(await bad([e(1, 1, '0'.repeat(24), t1.id)])).toBe(400);
    expect(await bad([{ ...e(1, 1, math.id, t1.id), groupKey: 'g1' }])).toBe(400);
    expect(await bad([], { validFrom: '2025-01-01' })).toBe(400);
    expect(await bad([], { validFrom: '2028-01-01' })).toBe(400);
    expect(await bad([e(1, 1, math.id, t1.id)], { validFrom: '2026-12-01' })).toBe(200);
  });

  it('nusxa: faol versiyadan va boshqa sinfdan', async () => {
    const d = await draft(c1.id, [e(1, 1, math.id, t1.id), e(2, 2, eng.id, t2.id)]);
    await p(admin, `/versions/${d.id}/activate`, { validFrom: '2026-11-02' });
    const a = await p(admin, `/classes/${c1.id}/versions`, {
      validFrom: '2026-12-01',
      copyFrom: 'active',
    });
    expect(a.body.data.version.entries).toHaveLength(2);
    expect(a.body.data.version.basedOnVersionId).toBe(d.id);
    const b = await p(admin, `/classes/${c2.id}/versions`, { copyFrom: { classId: c1.id } });
    expect(b.body.data.version.entries).toHaveLength(2);
    const none = await p(admin, `/classes/${c2.id}/versions`, { copyFrom: 'active' });
    expect(none.status).toBe(404);
    const byId = await p(admin, `/classes/${c2.id}/versions`, { copyFrom: d.id });
    expect(byId.body.data.version.entries).toHaveLength(2);
  });

  it("arxivdagi sinf jadvali faqat o'qish uchun", async () => {
    const d = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await ClassModel.updateOne({ _id: c1.id }, { isArchived: true });
    expect((await p(admin, `/classes/${c1.id}/versions`, {})).status).toBe(409);
    expect((await put(admin, `/versions/${d.id}`, { entries: [] })).status).toBe(409);
    expect((await g(admin, `/classes/${c1.id}/versions`)).status).toBe(200);
  });
});

describe("faollashtirish, rechain va o'chirish", () => {
  it("birinchi faollashtirish: active; keyingisi oldingisini bo'ladi (validTo, superseded)", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    expect((await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' })).status).toBe(
      200,
    );
    const b = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2026-12-01');
    const r = await p(admin, `/versions/${b.id}/activate`, { validFrom: '2026-12-01' });
    expect(r.status).toBe(200);
    const [va, vb] = await Promise.all([
      TimetableVersion.findById(a.id),
      TimetableVersion.findById(b.id),
    ]);
    expect(va?.status).toBe('superseded');
    expect(va?.validTo).toBe('2026-11-30');
    expect(vb?.status).toBe('active');
    expect(vb?.validTo).toBeNull();
    expect(vb?.activatedAt).toBeInstanceOf(Date);
    expect(await AuditLog.countDocuments({ action: 'timetable.version_activate' })).toBe(2);
  });

  it("ketma-ket versiyalar bog'lanadi; kelajak versiyani o'chirish zanjirni tiklaydi; rechain idempotent", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    const b = await draft(c1.id, [e(1, 1, art.id, t3.id)], '2026-12-01');
    await p(admin, `/versions/${b.id}/activate`, { validFrom: '2026-12-01' });
    const c = await draft(c1.id, [e(1, 1, eng.id, t2.id)], '2027-02-01');
    await p(admin, `/versions/${c.id}/activate`, { validFrom: '2027-02-01' });
    const get = async (id: string) => TimetableVersion.findById(id);
    expect((await get(a.id))?.validTo).toBe('2026-11-30');
    expect((await get(b.id))?.validTo).toBe('2027-01-31');
    expect((await get(c.id))?.validTo).toBeNull();

    expect((await del(admin, `/versions/${b.id}`)).status).toBe(200);
    expect((await get(a.id))?.validTo).toBe('2027-01-31');
    expect((await get(a.id))?.status).toBe('superseded');
    expect(await TimetableVersion.exists({ _id: b.id })).toBeNull();

    expect(await rechain(c1.id)).toBe(0);
    expect(await rechain(c1.id)).toBe(0);
    await TimetableVersion.updateOne({ _id: a.id }, { validTo: null, status: 'active' });
    expect(await rechain(c1.id)).toBe(1);
    expect(await rechain(c1.id)).toBe(0);
    expect((await get(a.id))?.validTo).toBe('2027-01-31');
    expect(await AuditLog.countDocuments({ action: 'timetable.version_delete' })).toBe(1);
  });

  it("kuchga kirgan versiyani o'chirib bo'lmaydi; qoralama o'chadi; faol versiya PUT qilinmaydi", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-10-01', confirmPast: true });
    expect((await del(admin, `/versions/${a.id}`)).status).toBe(409);
    expect((await put(admin, `/versions/${a.id}`, { entries: [] })).status).toBe(409);
    const d = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    expect((await del(admin, `/versions/${d.id}`)).status).toBe(200);
  });

  it("o'tmish sanadan faollashtirish confirmPast talab qiladi va auditga yoziladi", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    const no = await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-10-05' });
    expect(no.status).toBe(400);
    expect(no.body.error.details[0].path).toBe('confirmPast');
    const yes = await p(admin, `/versions/${a.id}/activate`, {
      validFrom: '2026-10-05',
      confirmPast: true,
    });
    expect(yes.status).toBe(200);
    const log = await AuditLog.findOne({ action: 'timetable.version_activate' });
    expect((log?.after as { pastActivation: boolean }).pastActivation).toBe(true);
  });

  it("faollashtirish: yil chegarasi, bo'sh jadval, qoralama bo'lmagan, takror sana", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    expect((await p(admin, `/versions/${a.id}/activate`, { validFrom: '2028-01-01' })).status).toBe(
      400,
    );
    const empty = await p(admin, `/classes/${c1.id}/versions`, {});
    expect(
      (await p(admin, `/versions/${empty.body.data.version.id}/activate`, { validFrom: TODAY }))
        .status,
    ).toBe(400);
    expect((await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' })).status).toBe(
      200,
    );
    expect((await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-09' })).status).toBe(
      409,
    );
    const b = await draft(c1.id, [e(1, 1, eng.id, t1.id)]);
    expect((await p(admin, `/versions/${b.id}/activate`, { validFrom: '2026-11-02' })).status).toBe(
      409,
    );
  });
});

describe("to'qnashuvlar", () => {
  it("o'qituvchi ikki sinfda bir vaqtda: ogohlantirish, faollashtirish bloklanadi, force+izoh bilan o'tadi", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    const b = await draft(c2.id, [e(1, 1, math.id, t1.id), e(1, 2, math.id, t1.id)]);
    const w = b.res.body.data.warnings as { code: string; weekday: number; lessonNo: number }[];
    const dbl = w.filter((x) => x.code === 'teacher_double_booked');
    expect(dbl).toHaveLength(1);
    expect(dbl[0]).toMatchObject({ weekday: 1, lessonNo: 1 });

    const blocked = await p(admin, `/versions/${b.id}/activate`, { validFrom: '2026-11-02' });
    expect(blocked.status).toBe(409);
    const noNote = await p(admin, `/versions/${b.id}/activate`, {
      validFrom: '2026-11-02',
      force: true,
    });
    expect(noNote.status).toBe(400);
    expect((await TimetableVersion.findById(b.id))?.status).toBe('draft');
    const forced = await p(admin, `/versions/${b.id}/activate`, {
      validFrom: '2026-11-02',
      force: true,
      note: 'Vaqtincha',
    });
    expect(forced.status).toBe(200);
    expect((await TimetableVersion.findById(b.id))?.forced).toBe(true);
    const log = await AuditLog.findOne({
      action: 'timetable.version_activate',
      entityId: b.id,
    });
    expect(log?.after).toMatchObject({ forced: true, note: 'Vaqtincha', conflicts: 1 });
  });

  it("validlik kesishmasa to'qnashuv yo'q (boshqa sinf versiyasi keyinroq boshlanadi)", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-11-02');
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    // c1 ning keyingi versiyasi 2026-12-01 dan: eskisi 11-30 gacha
    const a2 = await draft(c1.id, [e(1, 2, math.id, t1.id)], '2026-12-01');
    await p(admin, `/versions/${a2.id}/activate`, { validFrom: '2026-12-01' });
    // c2: 1-dars faqat 12-01 dan boshlanadi -> c1 ning yangi versiyasida 1-dars yo'q
    const b = await draft(c2.id, [e(1, 1, math.id, t1.id)], '2026-12-01');
    expect(
      (b.res.body.data.warnings as { code: string }[]).some(
        (x) => x.code === 'teacher_double_booked',
      ),
    ).toBe(false);
    // lekin 11-02 dan bo'lsa to'qnashadi
    const b2 = await draft(c2.id, [e(1, 1, math.id, t1.id)], '2026-11-02');
    expect(
      (b2.res.body.data.warnings as { code: string }[]).some(
        (x) => x.code === 'teacher_double_booked',
      ),
    ).toBe(true);
  });

  it("bitta boshqa sinfning bir nechta versiyasi to'qnashsa ham bitta ogohlantirish (versions bilan)", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-11-02');
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    const a2 = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-12-01');
    await p(admin, `/versions/${a2.id}/activate`, { validFrom: '2026-12-01' });
    const b = await draft(c2.id, [e(1, 1, math.id, t1.id)], '2026-11-02');
    const dbl = (
      b.res.body.data.warnings as {
        code: string;
        other: { classId: string; versions: unknown[] };
      }[]
    ).filter((x) => x.code === 'teacher_double_booked');
    expect(dbl).toHaveLength(1);
    expect(dbl[0]?.other.classId).toBe(c1.id);
    expect(dbl[0]?.other.versions).toHaveLength(2);
    const full = await g(admin, `/versions/${b.id}`);
    expect(
      full.body.data.warnings.filter((x: { code: string }) => x.code === 'teacher_double_booked'),
    ).toHaveLength(1);
  });

  it('dedupeWarnings aynan bir xil elementlarni olib tashlaydi', () => {
    const w = {
      code: 'teacher_double_booked' as const,
      severity: 'error' as const,
      weekday: 1,
      lessonNo: 1,
      subjectId: 's',
      teacherId: 't',
      message: 'x',
      other: {
        classId: 'c',
        className: 'C',
        versionId: 'v',
        validFrom: 'a',
        validTo: null,
        versions: [],
      },
    };
    expect(
      dedupeWarnings([w, { ...w }, { ...w, other: { ...w.other, classId: 'd' } }]),
    ).toHaveLength(2);
  });

  it("band o'qituvchilar: boshqa sinfdagi faol versiya, tenant va ruxsat", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id), e(2, 3, math.id, t2.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    const b = await draft(c2.id, [e(1, 2, math.id, t3.id)]);
    const q = (t: string, qs: string) => g(t, `/versions/${b.id}/busy-teachers?${qs}`);
    const r = await q(admin, 'weekday=1&lessonNo=1');
    expect(r.status).toBe(200);
    expect(r.body.data.items).toEqual([{ teacherId: t1.id, classId: c1.id, className: '5-A' }]);
    expect((await q(admin, 'weekday=1&lessonNo=5')).body.data.items).toEqual([]);
    expect((await q(admin, 'weekday=2&lessonNo=3')).body.data.items[0].teacherId).toBe(t2.id);
    // o'z sinfi hisobga olinmaydi
    const own = await g(admin, `/versions/${a.id}/busy-teachers?weekday=1&lessonNo=1`);
    expect(own.body.data.items).toEqual([]);
    expect((await q(viewer, 'weekday=1&lessonNo=1')).status).toBe(403);
    expect((await q(adminOther, 'weekday=1&lessonNo=1')).status).toBe(404);
    expect((await q(admin, 'weekday=9&lessonNo=1')).status).toBe(400);
  });

  it("biriktirilmagan, nofaol fan/o'qituvchi va sozlama o'zgargach outOfRange", async () => {
    await assignSubject(school.id, c1 as never, math.id, t1.id);
    const d = await draft(c1.id, [
      e(1, 1, math.id, t1.id), // mos
      e(1, 2, math.id, t2.id), // boshqa o'qituvchi
      e(1, 3, eng.id, t1.id), // biriktirilmagan
    ]);
    const codes = (d.res.body.data.warnings as { code: string; lessonNo: number }[]).map(
      (x) => `${x.code}:${x.lessonNo}`,
    );
    expect(codes).toContain('teacher_not_assigned:2');
    expect(codes).toContain('teacher_not_assigned:3');
    expect(codes).not.toContain('teacher_not_assigned:1');

    await makeUser({
      username: 'tt_off',
      role: 'teacher',
      schoolId: school.id,
      isActive: false,
    }).then(async (off) => {
      const x = await put(admin, `/versions/${d.id}`, {
        entries: [e(1, 1, math.id, off.id)],
      });
      expect(x.status).toBe(200);
      expect(
        (x.body.data.warnings as { code: string }[]).some((w) => w.code === 'teacher_inactive'),
      ).toBe(true);
    });
    await Subject.updateOne({ _id: math.id }, { isActive: false });
    const r = await g(admin, `/versions/${d.id}`);
    expect(
      (r.body.data.warnings as { code: string }[]).some((w) => w.code === 'subject_inactive'),
    ).toBe(true);

    // lessonsPerDay kichik bo'lsa ham dars 8 outOfRange emas
    await put(admin, `/versions/${d.id}`, { entries: [e(6, 8, eng.id, t1.id)] });
    await Setting.create({
      scope: 'school',
      schoolId: school.id,
      key: 'attendance',
      value: { lessonsPerDay: 4 },
    });
    const ok8 = await g(admin, `/versions/${d.id}`);
    expect(ok8.body.data.version.entries[0].outOfRange).toBe(false);
    expect(
      (ok8.body.data.warnings as { code: string }[]).some((w) => w.code === 'out_of_range'),
    ).toBe(false);

    // ish kunlari o'zgarsa: yozuv saqlanadi, outOfRange belgilanadi (faqat dam olish kuni)
    await Setting.updateOne(
      { schoolId: school.id, key: 'attendance' },
      { value: { lessonsPerDay: 4, workingWeekdays: [1, 2, 3, 4, 5] } },
    );
    const out = await g(admin, `/versions/${d.id}`);
    expect(out.body.data.version.entries[0].outOfRange).toBe(true);
    expect(
      (out.body.data.warnings as { code: string }[]).some((w) => w.code === 'out_of_range'),
    ).toBe(true);
    // mavjud (o'zgarmagan) outOfRange yozuvni saqlash mumkin, yangisini qo'shib bo'lmaydi
    const keep = await put(admin, `/versions/${d.id}`, { entries: [e(6, 8, eng.id, t1.id)] });
    expect(keep.status).toBe(200);
    const addNew = await put(admin, `/versions/${d.id}`, {
      entries: [e(6, 8, eng.id, t1.id), e(6, 9, eng.id, t1.id)],
    });
    expect(addNew.status).toBe(400);
  });
});

describe('tuzatish', () => {
  it("faol versiyani joyida tuzatadi, auditga before/after yoziladi; o'tgan versiya tuzatilmaydi; qoralama emas", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-10-05', confirmPast: true });
    const r = await p(admin, `/versions/${a.id}/correct`, {
      entries: [e(1, 1, eng.id, t2.id), e(2, 1, math.id, t1.id)],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.version.entries).toHaveLength(2);
    expect((await TimetableVersion.findById(a.id))?.entries).toHaveLength(2);
    const log = await AuditLog.findOne({ action: 'timetable.version_correct' });
    expect((log?.before as { entries: unknown[] }).entries).toHaveLength(1);
    expect((log?.after as { entries: unknown[] }).entries).toHaveLength(2);

    // endi boshqa versiya 10-20 dan: a to'liq o'tgan (validTo < bugun)
    const b = await draft(c1.id, [e(1, 1, math.id, t1.id)], '2026-10-20');
    await p(admin, `/versions/${b.id}/activate`, { validFrom: '2026-10-20', confirmPast: true });
    expect((await p(admin, `/versions/${a.id}/correct`, { entries: [] })).status).toBe(409);
    const dr = await draft(c2.id, []);
    expect((await p(admin, `/versions/${dr.id}/correct`, { entries: [] })).status).toBe(409);
    expect((await p(viewer, `/versions/${b.id}/correct`, { entries: [] })).status).toBe(403);
  });

  it("tuzatishda to'qnashuv force talab qiladi", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    const b = await draft(c2.id, [e(2, 1, math.id, t2.id)]);
    await p(admin, `/versions/${b.id}/activate`, { validFrom: '2026-11-02' });
    const body = { entries: [e(1, 1, math.id, t1.id)] };
    expect((await p(admin, `/versions/${b.id}/correct`, body)).status).toBe(409);
    expect(
      (await p(admin, `/versions/${b.id}/correct`, { ...body, force: true, note: 'x' })).status,
    ).toBe(200);
  });
});

describe('biriktirishlarni sinxronlash va ommaviy faollashtirish', () => {
  it("syncAssignments yetishmayotgan ClassSubject ni qo'shadi, mavjudiga tegmaydi, teacherIds invarianti", async () => {
    await assignSubject(school.id, c2 as never, math.id, t3.id);
    const d = await draft(c2.id, [
      e(1, 1, math.id, t2.id), // mavjud biriktirish t3 — tegilmaydi
      e(1, 2, eng.id, t2.id),
      e(2, 2, eng.id, t2.id),
    ]);
    const r = await p(admin, `/versions/${d.id}/activate`, {
      validFrom: '2026-11-02',
      syncAssignments: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.syncedAssignments).toEqual([{ subjectId: eng.id, teacherId: t2.id }]);
    const cs = await ClassSubject.find({ classId: c2.id });
    expect(cs).toHaveLength(2);
    expect(String(cs.find((x) => String(x.subjectId) === math.id)?.teacherId)).toBe(t3.id);
    expect(String(cs.find((x) => String(x.subjectId) === eng.id)?.teacherId)).toBe(t2.id);
    const cls = await ClassModel.findById(c2.id);
    expect(cls?.teacherIds.map(String)).toContain(t2.id);
    expect(cls?.teacherIds.map(String)).toContain(t3.id);
  });

  it("syncAssignments bo'lmasa ClassSubject o'zgarmaydi", async () => {
    const d = await draft(c2.id, [e(1, 2, eng.id, t2.id)]);
    await p(admin, `/versions/${d.id}/activate`, { validFrom: '2026-11-02' });
    expect(await ClassSubject.countDocuments({ classId: c2.id })).toBe(0);
  });

  it("ommaviy: hammasi bir sanadan; o'zaro to'qnashuv hech birini faollashtirmaydi", async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    const b = await draft(c2.id, [e(1, 1, math.id, t1.id)]);
    const bad = await p(admin, '/activate-bulk', {
      versionIds: [a.id, b.id],
      validFrom: '2026-11-02',
    });
    expect(bad.status).toBe(409);
    expect(await TimetableVersion.countDocuments({ status: 'draft' })).toBe(2);
    const pv = await p(admin, '/activate-bulk/preview', {
      versionIds: [a.id, b.id],
      validFrom: '2026-11-02',
    });
    expect(pv.status).toBe(200);
    expect(
      pv.body.data.warnings.filter((w: { code: string }) => w.code === 'teacher_double_booked'),
    ).toHaveLength(2);
    expect(await TimetableVersion.countDocuments({ status: 'draft' })).toBe(2);
    await put(admin, `/versions/${b.id}`, { entries: [e(1, 1, math.id, t2.id)] });
    const ok = await p(admin, '/activate-bulk', {
      versionIds: [a.id, b.id],
      validFrom: '2026-11-02',
      syncAssignments: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.activated).toHaveLength(2);
    expect(await TimetableVersion.countDocuments({ status: 'active' })).toBe(2);
    expect(await ClassSubject.countDocuments({})).toBe(2);
    const dup = await p(admin, '/activate-bulk', { versionIds: [a.id, a.id], validFrom: TODAY });
    expect(dup.status).toBe(409); // a endi qoralama emas
    expect(
      (await p(viewer, '/activate-bulk', { versionIds: [a.id], validFrom: TODAY })).status,
    ).toBe(403);
  });
});

describe("ko'rinishlar", () => {
  it('overview: sinflar holati va ogohlantirishlar soni', async () => {
    const a = await draft(c1.id, [e(1, 1, math.id, t1.id)]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-10-05', confirmPast: true });
    await draft(c2.id, [e(1, 1, math.id, t1.id)], '2026-10-05');
    const r = await g(admin, '/classes');
    const rows = r.body.data.classes as {
      name: string;
      current: { id: string } | null;
      draft: { id: string } | null;
      errorsCount: number;
      warningsCount: number;
    }[];
    const r1 = rows.find((x) => x.name === '5-A');
    const r2 = rows.find((x) => x.name === '5-B');
    expect(r1?.current?.id).toBe(a.id);
    expect(r1?.draft).toBeNull();
    expect(r2?.current).toBeNull();
    expect(r2?.draft).not.toBeNull();
    expect(r2?.errorsCount).toBe(1);
    expect(r2?.warningsCount).toBeGreaterThanOrEqual(1);
    // qoralamani view foydalanuvchi ko'rmaydi
    const rv = (await g(viewer, '/classes')).body.data.classes as {
      name: string;
      draft: unknown;
    }[];
    expect(rv.find((x) => x.name === '5-B')?.draft).toBeNull();
  });

  it("o'qituvchi haftasi va kun ko'rinishi", async () => {
    const a = await draft(c1.id, [
      e(1, 1, math.id, t1.id),
      e(1, 2, eng.id, t2.id),
      e(2, 3, math.id, t1.id),
    ]);
    await p(admin, `/versions/${a.id}/activate`, { validFrom: '2026-11-02' });
    const w = await g(admin, `/teachers/${t1.id}/week?date=2026-11-04`);
    expect(w.status).toBe(200);
    expect(w.body.data.from).toBe('2026-11-02');
    expect(w.body.data.to).toBe('2026-11-08');
    expect(w.body.data.weeklyCount).toBe(2);
    expect(w.body.data.days).toHaveLength(6);
    expect(w.body.data.days[0].lessons[0]).toMatchObject({
      lessonNo: 1,
      source: 'timetable',
      cancelled: false,
      class: { name: '5-A' },
      subject: { name: 'Matematika' },
    });
    // versiya boshlanishidan oldingi hafta bo'sh
    const prev = await g(admin, `/teachers/${t1.id}/week?date=2026-10-28`);
    expect(prev.body.data.weeklyCount).toBe(0);
    // /me/week
    const me = await g(teacher1, '/me/week?date=2026-11-04');
    expect(me.body.data.weeklyCount).toBe(2);
    expect((await g(admin, `/teachers/${'1'.repeat(24)}/week`)).status).toBe(404);

    const day = await g(viewer, '/day?date=2026-11-02');
    expect(day.body.data.working).toBe(true);
    const row = day.body.data.classes.find((c: { name: string }) => c.name === '5-A');
    expect(row.lessons).toHaveLength(2);
    const sun = await g(viewer, '/day?date=2026-11-01');
    expect(sun.body.data.working).toBe(false);
    expect(sun.body.data.classes.every((c: { lessons: unknown[] }) => c.lessons.length === 0)).toBe(
      true,
    );
    const lessons = await g(teacher1, `/lessons?classId=${c1.id}&date=2026-11-02`);
    expect(lessons.body.data.lessons).toHaveLength(2);
    expect((await g(teacher1, `/lessons?classId=${c2.id}&date=2026-11-02`)).status).toBe(403);
  });
});

describe('options', () => {
  it("faol fan/o'qituvchilar, sinf biriktirishlari va fan -> o'qituvchilar", async () => {
    await assignSubject(school.id, c1 as never, math.id, t1.id);
    await assignSubject(school.id, c2 as never, math.id, t2.id);
    await Subject.updateOne({ _id: art.id }, { isActive: false });
    const r = await g(viewer, `/options?classId=${c1.id}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.subjects.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(['Matematika', 'Ingliz tili']),
    );
    expect(d.subjects.some((s: { name: string }) => s.name === 'Rasm')).toBe(false);
    expect(d.teachers).toHaveLength(3);
    expect(d.classAssignments).toEqual([{ subjectId: math.id, teacherId: t1.id }]);
    expect(d.subjectTeachers[math.id].sort()).toEqual([t1.id, t2.id].sort());
    expect((await g(nobody, '/options')).status).toBe(403);
    expect((await g(teacher1, '/options')).status).toBe(403);
  });
});
