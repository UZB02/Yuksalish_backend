import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { TimetableVersion } from '../src/models/TimetableVersion';
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
let school: Doc;
let c1: Awaited<ReturnType<typeof makeClass>>;
let c2: Awaited<ReturnType<typeof makeClass>>;
let c3: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, eng: Doc;
let t1: Doc, t2: Doc;
let admin: string, root: string;

const e = (
  weekday: number,
  lessonNo: number,
  subjectId: string,
  teacherId: string,
  extra = {},
) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  ...extra,
});
const sa = (r: request.Test) => r.set('X-School-Id', school.id);
const g = (t: string, path: string) => {
  const r = request(app).get(`${API}${path}`).set(bearer(t));
  return t === root ? sa(r) : r;
};
const send = (m: 'post' | 'put' | 'delete', t: string, path: string, body: object = {}) => {
  const r = request(app)[m](`${API}${path}`).set(bearer(t)).send(body);
  return t === root ? sa(r) : r;
};
const slotPath = (id: string, wd: number, ln: number, teacher: string) =>
  `/versions/${id}/entries/${wd}/${ln}/${teacher}/overlap-approval`;

async function draft(token: string, classId: string, entries: object[], validFrom = '2026-11-02') {
  const c = await send('post', token, `/classes/${classId}/versions`, { validFrom });
  expect(c.status).toBe(201);
  const id = c.body.data.version.id as string;
  const r = await send('put', token, `/versions/${id}`, { entries });
  expect(r.status).toBe(200);
  return { id, res: r };
}
const activate = (token: string, id: string, body: object = {}) =>
  send('post', token, `/versions/${id}/activate`, { validFrom: '2026-11-02', ...body });
const codes = (res: request.Response) =>
  (res.body.data.warnings as { code: string }[]).map((w) => w.code);

beforeEach(async () => {
  clock.set(() => new Date('2026-10-30T07:00:00Z'));
  school = await makeSchool('ov1');
  const year = await makeYear(school.id);
  t1 = await makeUser({ username: 'ov_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'ov_t2', role: 'teacher', schoolId: school.id });
  c1 = await makeClass(school.id, year.id, '5-A', [t1.id]);
  c2 = await makeClass(school.id, year.id, '5-B', []);
  c3 = await makeClass(school.id, year.id, '5-V', []);
  math = await makeSubject('Matematika');
  eng = await makeSubject('Ingliz tili');
  for (const c of [c1, c2, c3]) await assignSubject(school.id, c as never, math.id, t1.id);
  await makeUser({
    username: 'ov_admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.manage', 'timetable.view'],
  });
  await makeUser({ username: 'ov_root', role: 'superadmin' });
  admin = (await login('ov_admin')).token;
  root = (await login('ov_root')).token;
});

describe("bir vaqtda o'tish ruxsati", () => {
  it("ruxsatsiz to'qnashuv xato; superadmin saqlashda ruxsat bersa info bo'ladi va force kerak emas", async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id)]);
    expect((await activate(root, a.id)).status).toBe(200);
    const b = await draft(admin, c2.id, [e(1, 9, math.id, t1.id)]);
    expect(codes(b.res)).toContain('teacher_double_booked');
    expect((await activate(admin, b.id)).status).toBe(409);

    // superadmin shu yozuvni ruxsat bilan saqlaydi
    const r = await send('put', root, `/versions/${b.id}`, {
      entries: [e(1, 9, math.id, t1.id, { overlapApproved: true })],
    });
    expect(r.status).toBe(200);
    expect(codes(r)).not.toContain('teacher_double_booked');
    const info = (r.body.data.warnings as { code: string; severity: string; approval: any }[]).find(
      (w) => w.code === 'teacher_overlap_approved',
    );
    expect(info).toMatchObject({ severity: 'info' });
    expect(info?.approval).toMatchObject({ side: 'self', approvedByName: 'Test ov_root' });
    expect(r.body.data.version.entries[0].overlapApproval.approvedBy.fullName).toBe('Test ov_root');

    // force'siz faollashadi, forced=false, info xato sifatida sanalmaydi
    const act = await activate(admin, b.id);
    expect(act.status).toBe(200);
    expect((await TimetableVersion.findById(b.id))?.forced).toBe(false);
    const ov = await g(admin, '/classes');
    expect(
      ov.body.data.classes.find((c: { classId: string }) => c.classId === c2.id),
    ).toMatchObject({
      warningsCount: 0,
      errorsCount: 0,
    });
    const log = await AuditLog.findOne({ action: 'timetable.overlap_approve', entityId: b.id });
    expect(log?.after).toMatchObject({ weekday: 1, lessonNo: 9, teacherId: t1.id });
  });

  it("ruxsat ikki tomondan biriga berilsa ham juftlikni qoplaydi (boshqa tomon xato ko'rmaydi)", async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id, { overlapApproved: true })]);
    expect((await activate(root, a.id)).status).toBe(200);
    // c2 ruxsatsiz, lekin juftlik c1 dagi ruxsat bilan qoplangan
    const b = await draft(admin, c2.id, [e(1, 9, math.id, t1.id)]);
    expect(codes(b.res)).not.toContain('teacher_double_booked');
    const info = (b.res.body.data.warnings as { code: string; approval: any }[]).find(
      (w) => w.code === 'teacher_overlap_approved',
    );
    expect(info?.approval.side).toBe('other');
    expect((await activate(admin, b.id)).status).toBe(200);
    // uchinchi sinf: c3 - c1 qoplangan, lekin c3 - c2 ruxsatsiz juftlik -> xato
    const c = await draft(admin, c3.id, [e(1, 9, math.id, t1.id)]);
    const dbl = (c.res.body.data.warnings as { code: string; other: { classId: string } }[]).filter(
      (w) => w.code === 'teacher_double_booked',
    );
    expect(dbl.map((w) => w.other.classId)).toEqual([c2.id]);
    // busy-teachers: ruxsat belgisi
    const busy = await g(admin, `/versions/${c.id}/busy-teachers?weekday=1&lessonNo=9`);
    expect(busy.body.data.items).toEqual(
      expect.arrayContaining([
        { teacherId: t1.id, classId: c1.id, className: '5-A', approved: true },
        { teacherId: t1.id, classId: c2.id, className: '5-B', approved: false },
      ]),
    );
  });

  it("o'qituvchi, fan, kun yoki dars o'zgarsa ruxsat tushadi; o'zgarmasa saqlanadi", async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id, { overlapApproved: true })]);
    // admin (superadmin emas) xuddi shu yozuvni qayta saqlaydi (room o'zgardi) -> ruxsat saqlanadi
    const keep = await send('put', admin, `/versions/${a.id}`, {
      entries: [e(1, 9, math.id, t1.id, { room: '12' })],
    });
    expect(keep.body.data.version.entries[0].overlapApproval).not.toBeNull();
    for (const changed of [
      e(1, 9, eng.id, t1.id), // fan
      e(1, 9, math.id, t2.id), // o'qituvchi
      e(2, 9, math.id, t1.id), // kun
      e(1, 8, math.id, t1.id), // dars
    ]) {
      await send('put', root, `/versions/${a.id}`, {
        entries: [e(1, 9, math.id, t1.id, { overlapApproved: true })],
      });
      const r = await send('put', root, `/versions/${a.id}`, { entries: [changed] });
      expect(r.status).toBe(200);
      expect(r.body.data.version.entries[0].overlapApproval).toBeNull();
    }
    expect((await TimetableVersion.findById(a.id))?.entries[0]?.overlapApproval).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'timetable.overlap_revoke' })).toBeGreaterThan(
      0,
    );
  });

  it("superadmin emas ruxsat bera olmaydi (saqlashda e'tiborga olinmaydi), olib tashlay ham olmaydi", async () => {
    const a = await draft(admin, c1.id, [e(1, 9, math.id, t1.id, { overlapApproved: true })]);
    expect(a.res.body.data.version.entries[0].overlapApproval).toBeNull();
    const b = await draft(root, c2.id, [e(2, 9, math.id, t1.id, { overlapApproved: true })]);
    // admin false yuborsa ham ruxsat olinmaydi
    const r = await send('put', admin, `/versions/${b.id}`, {
      entries: [e(2, 9, math.id, t1.id, { overlapApproved: false })],
    });
    expect(r.body.data.version.entries[0].overlapApproval).not.toBeNull();
    // tuzatish (correct) ham xuddi shunday
    expect((await activate(root, b.id)).status).toBe(200);
    const cr = await send('post', admin, `/versions/${b.id}/correct`, {
      entries: [e(2, 9, math.id, t1.id, { overlapApproved: false })],
    });
    expect(cr.status).toBe(200);
    expect(cr.body.data.version.entries[0].overlapApproval).not.toBeNull();
    // maxsus endpoint: school_admin 403
    expect((await send('post', admin, slotPath(b.id, 2, 9, t1.id))).status).toBe(403);
    expect((await send('delete', admin, slotPath(b.id, 2, 9, t1.id))).status).toBe(403);
  });

  it("nusxa (yangi qoralama) ruxsatlarni ko'chiradi", async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id, { overlapApproved: true })]);
    expect((await activate(root, a.id)).status).toBe(200);
    const c = await send('post', admin, `/classes/${c1.id}/versions`, {
      validFrom: '2026-11-09',
      copyFrom: 'active',
    });
    expect(c.status).toBe(201);
    expect(c.body.data.version.entries[0].overlapApproval.approvedBy.id).toBeTruthy();
    // boshqa sinfdan nusxa
    const d = await send('post', admin, `/classes/${c2.id}/versions`, {
      validFrom: '2026-11-09',
      copyFrom: { classId: c1.id },
    });
    expect(d.body.data.version.entries[0].overlapApproval).not.toBeNull();
  });

  it('maxsus endpoint faol versiyada: berish, idempotent, olib tashlash, audit, xatolar', async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id)]);
    expect((await activate(root, a.id)).status).toBe(200);
    const b = await draft(admin, c2.id, [e(1, 9, math.id, t1.id)]);
    expect((await activate(admin, b.id)).status).toBe(409);
    expect((await activate(admin, b.id, { force: true, note: 'vaqtincha' })).status).toBe(200);

    // faol b versiyaga ruxsat (jadval o'zgarmaydi)
    const before = await TimetableVersion.findById(b.id);
    const ok = await send('post', root, slotPath(b.id, 1, 9, t1.id));
    expect(ok.status).toBe(200);
    expect(ok.body.data.version.entries[0].overlapApproval).not.toBeNull();
    expect(codes({ body: { data: ok.body.data } } as request.Response)).toEqual([
      'teacher_overlap_approved',
    ]);
    const after = await TimetableVersion.findById(b.id);
    expect(after?.status).toBe('active');
    expect(after?.validFrom).toBe(before?.validFrom);
    expect(after?.entries).toHaveLength(1);
    // idempotent: ikkinchi chaqiruv yangi audit yozmaydi
    await send('post', root, slotPath(b.id, 1, 9, t1.id));
    expect(await AuditLog.countDocuments({ action: 'timetable.overlap_approve' })).toBe(1);

    const rev = await send('delete', root, slotPath(b.id, 1, 9, t1.id));
    expect(rev.status).toBe(200);
    expect(rev.body.data.version.entries[0].overlapApproval).toBeNull();
    expect(codes({ body: { data: rev.body.data } } as request.Response)).toEqual([
      'teacher_double_booked',
    ]);
    expect(await AuditLog.countDocuments({ action: 'timetable.overlap_revoke' })).toBe(1);

    // yo'q dars -> 404; noto'g'ri parametr -> 400; superadminga X-School-Id kerak
    expect((await send('post', root, slotPath(b.id, 3, 9, t1.id))).status).toBe(404);
    expect((await send('post', root, slotPath(b.id, 99, 9, t1.id))).status).toBe(400);
    const noHeader = await request(app)
      .post(`${API}${slotPath(b.id, 1, 9, t1.id)}`)
      .set(bearer(root));
    expect(noHeader.status).toBe(400);
  });

  it('ommaviy ruxsat: faqat haqiqatan band yozuvlarga, idempotent, audit, rol va holat tekshiruvlari', async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id), e(2, 9, math.id, t1.id)]);
    expect((await activate(root, a.id)).status).toBe(200);
    const b = await draft(admin, c2.id, [
      e(1, 9, math.id, t1.id),
      e(2, 9, math.id, t1.id),
      e(3, 1, math.id, t1.id), // band emas
    ]);
    const path = `/versions/${b.id}/overlap-approvals`;
    const slots = [
      { weekday: 1, lessonNo: 9, teacherId: t1.id },
      { weekday: 2, lessonNo: 9, teacherId: t1.id },
      { weekday: 3, lessonNo: 1, teacherId: t1.id },
      { weekday: 5, lessonNo: 5, teacherId: t1.id }, // mavjud emas
    ];
    expect((await send('post', admin, path, { entries: slots })).status).toBe(403);
    expect((await send('post', root, path, { entries: [] })).status).toBe(400);

    const r = await send('post', root, path, { entries: slots });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ approved: 2, skipped: 2 });
    const approved = r.body.data.version.entries.map(
      (x: { overlapApproval: unknown }) => !!x.overlapApproval,
    );
    expect(approved).toEqual([true, true, false]);
    expect(codes(r)).not.toContain('teacher_double_booked');
    expect(
      await AuditLog.countDocuments({ action: 'timetable.overlap_approve', entityId: b.id }),
    ).toBe(2);

    // idempotent
    const again = await send('post', root, path, { entries: slots });
    expect(again.body.data).toMatchObject({ approved: 0, skipped: 4 });
    expect(
      await AuditLog.countDocuments({ action: 'timetable.overlap_approve', entityId: b.id }),
    ).toBe(2);
    expect((await activate(admin, b.id)).status).toBe(200);

    // faol versiyada ham ishlaydi
    expect((await send('post', root, path, { entries: slots })).status).toBe(200);
  });

  it("almashtirilgan versiyaga ruxsat berib bo'lmaydi", async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id)], '2026-11-09');
    expect((await activate(root, a.id, { validFrom: '2026-11-09' })).status).toBe(200);
    const b = await draft(root, c1.id, [e(1, 9, math.id, t1.id)], '2026-11-02');
    expect((await activate(root, b.id, { validFrom: '2026-11-02' })).status).toBe(200);
    // b (11-02) dan keyin boshlangan a almashtirilgan
    expect((await TimetableVersion.findById(a.id))?.status).toBe('replaced');
    expect((await send('post', root, slotPath(a.id, 1, 9, t1.id))).status).toBe(409);
  });

  it('ommaviy faollashtirish: ruxsat berilgan juftlik force talab qilmaydi', async () => {
    const a = await draft(root, c1.id, [e(1, 9, math.id, t1.id, { overlapApproved: true })]);
    const b = await draft(admin, c2.id, [e(1, 9, math.id, t1.id)]);
    const bulk = await send('post', admin, '/activate-bulk', {
      versionIds: [a.id, b.id],
      validFrom: '2026-11-02',
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.activated.map((x: { warningsCount: number }) => x.warningsCount)).toEqual(
      [0, 0],
    );
  });
});
