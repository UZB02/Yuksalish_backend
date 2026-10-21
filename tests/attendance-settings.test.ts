import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AttendanceStatus } from '../src/models/AttendanceStatus';
import { AuditLog } from '../src/models/AuditLog';
import { ensureDefaultAttendanceStatuses } from '../src/modules/attendance-statuses/attendance-statuses.defaults';
import {
  AttendanceRecord,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

let a: Awaited<ReturnType<typeof makeSchool>>;
let b: Awaited<ReturnType<typeof makeSchool>>;
let root: string, setAdmin: string, plainAdmin: string, otherAdmin: string, teacher: string;

beforeEach(async () => {
  a = await makeSchool('a');
  b = await makeSchool('b');
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({
    username: 'setadm',
    role: 'school_admin',
    schoolId: a.id,
    permissions: ['attendance.settings', 'attendance.view'],
  });
  await makeUser({
    username: 'plain',
    role: 'school_admin',
    schoolId: a.id,
    permissions: ['attendance.take'],
  });
  await makeUser({
    username: 'otheradm',
    role: 'school_admin',
    schoolId: b.id,
    permissions: ['attendance.settings'],
  });
  await makeUser({ username: 'tch', role: 'teacher', schoolId: a.id });
  [root, setAdmin, plainAdmin, otherAdmin, teacher] = await Promise.all(
    ['root', 'setadm', 'plain', 'otheradm', 'tch'].map(async (u) => (await login(u)).token),
  );
});

const post = (t: string, body: object) =>
  request(app).post('/api/v1/attendance-statuses').set(bearer(t)).send(body);
const body = (extra: Record<string, unknown> = {}) => ({
  name: 'Yangi holat',
  shortName: 'Y1',
  color: '#aabbcc',
  category: 'late',
  ...extra,
});

describe('Davomat holatlari', () => {
  it("standart holatlar idempotent yaratiladi va hamma maktab rollari ko'radi", async () => {
    expect(await ensureDefaultAttendanceStatuses()).toBe(4);
    expect(await ensureDefaultAttendanceStatuses()).toBe(0);
    const res = await request(app).get('/api/v1/attendance-statuses').set(bearer(teacher));
    expect(res.status).toBe(200);
    expect(
      res.body.data.map(
        (s: { name: string; shortName: string; category: string; isDefault: boolean }) => [
          s.name,
          s.shortName,
          s.category,
          s.isDefault,
        ],
      ),
    ).toEqual([
      ['Keldi', 'K', 'present', true],
      ['Kechikdi', 'Ke', 'late', false],
      ["Sababli yo'q", 'S', 'absent_excused', false],
      ["Sababsiz yo'q", 'Y', 'absent_unexcused', false],
    ]);
    expect(res.body.data[0]).toMatchObject({ schoolId: null, isActive: true, color: '#16A34A' });
  });

  it("faqat superadmin yaratadi/o'zgartiradi; o'chirish yo'q", async () => {
    for (const t of [setAdmin, plainAdmin, teacher])
      expect((await post(t, body())).status).toBe(403);
    expect((await request(app).post('/api/v1/attendance-statuses').send(body())).status).toBe(401);
    const created = await post(root, body({ order: 7 }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Yangi holat',
      color: '#AABBCC',
      category: 'late',
      order: 7,
      isDefault: false,
      schoolId: null,
    });
    const id = created.body.data.id;
    for (const t of [setAdmin, teacher]) {
      expect(
        (
          await request(app)
            .patch(`/api/v1/attendance-statuses/${id}`)
            .set(bearer(t))
            .send({ name: 'x' })
        ).status,
      ).toBe(403);
      expect(
        (await request(app).post(`/api/v1/attendance-statuses/${id}/deactivate`).set(bearer(t)))
          .status,
      ).toBe(403);
    }
    expect(
      (await request(app).delete(`/api/v1/attendance-statuses/${id}`).set(bearer(root))).status,
    ).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'attendance_status.create' })).toBe(1);
  });

  it('validatsiya: qisqa belgi, rang, kategoriya; nom unique (normalizatsiya)', async () => {
    expect((await post(root, body({ shortName: 'ABCD' }))).status).toBe(400);
    expect((await post(root, body({ shortName: '' }))).status).toBe(400);
    expect((await post(root, body({ color: 'red' }))).status).toBe(400);
    expect((await post(root, body({ category: 'sick' }))).status).toBe(400);
    expect((await post(root, body())).status).toBe(201);
    expect((await post(root, body({ name: ' yangi   HOLAT ' }))).status).toBe(409);
  });

  it("standart holat: scope ichida bitta, present va faol bo'lishi shart", async () => {
    const k = (
      await post(
        root,
        body({ name: 'Keldi', shortName: 'K', category: 'present', isDefault: true }),
      )
    ).body.data;
    expect(k.isDefault).toBe(true);
    expect(
      (await post(root, body({ name: 'Kech', category: 'late', isDefault: true }))).status,
    ).toBe(400);

    const second = await post(
      root,
      body({ name: 'Hozir', shortName: 'H', category: 'present', isDefault: true }),
    );
    expect(second.status).toBe(201);
    const list = (await request(app).get('/api/v1/attendance-statuses').set(bearer(root))).body
      .data;
    expect(
      list.filter((s: { isDefault: boolean }) => s.isDefault).map((s: { name: string }) => s.name),
    ).toEqual(['Hozir']);

    // PATCH orqali almashtirish
    const patched = await request(app)
      .patch(`/api/v1/attendance-statuses/${k.id}`)
      .set(bearer(root))
      .send({ isDefault: true });
    expect(patched.body.data.isDefault).toBe(true);
    expect((await AttendanceStatus.findById(second.body.data.id))!.isDefault).toBe(false);

    // Standart holat faolsizlantirilmaydi, kategoriyasi present dan o'zgartirilmaydi
    expect(
      (await request(app).post(`/api/v1/attendance-statuses/${k.id}/deactivate`).set(bearer(root)))
        .status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance-statuses/${k.id}`)
          .set(bearer(root))
          .send({ category: 'late' })
      ).status,
    ).toBe(400);

    // Maktab doirasida alohida standart
    const sch = await post(
      root,
      body({
        schoolId: a.id,
        name: 'Maktab keldi',
        shortName: 'MK',
        category: 'present',
        isDefault: true,
      }),
    );
    expect(sch.status).toBe(201);
    expect((await AttendanceStatus.findById(k.id))!.isDefault).toBe(true); // global saqlanadi
  });

  it("yozuvlari bor holat kategoriyasi o'zgarmaydi (409); yozuv bo'lmasa o'zgaradi", async () => {
    const st = await makeStatus('Sinov', 'late');
    const free = await request(app)
      .patch(`/api/v1/attendance-statuses/${st.id}`)
      .set(bearer(root))
      .send({ category: 'absent_excused' });
    expect(free.status).toBe(200);
    expect(free.body.data.category).toBe('absent_excused');

    const year = await makeYear(a.id);
    const cls = await makeClass(a.id, year.id, '5-A');
    const stu = await makeStudent(a.id, cls.id, 'Ali Valiyev');
    const teacherUser = await makeUser({ username: 'tx', role: 'teacher', schoolId: a.id });
    await AttendanceRecord.create({
      schoolId: a.id,
      studentId: stu._id,
      classId: cls._id,
      academicYearId: year._id,
      date: '2026-10-14',
      lessonNo: 0,
      statusId: st._id,
      category: 'absent_excused',
      markedBy: teacherUser._id,
      updatedBy: teacherUser._id,
    });
    const blocked = await request(app)
      .patch(`/api/v1/attendance-statuses/${st.id}`)
      .set(bearer(root))
      .send({ category: 'present' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONFLICT');
    // Boshqa maydonlar o'zgaraveradi, o'sha kategoriyani qayta yuborish mumkin
    expect(
      (
        await request(app)
          .patch(`/api/v1/attendance-statuses/${st.id}`)
          .set(bearer(root))
          .send({ name: 'Yangi nom', category: 'absent_excused' })
      ).status,
    ).toBe(200);
  });

  it("global + maktab holatlari qo'shiladi; nom to'qnashuvi 409; faolsizlantirish", async () => {
    await makeStatus('Global bir', 'present', { order: 1 });
    const own = await post(
      root,
      body({ schoolId: a.id, name: 'Maktab A holati', category: 'late', order: 2 }),
    );
    expect(own.status).toBe(201);
    await post(root, body({ schoolId: b.id, name: 'Maktab B holati', order: 3 }));

    const names = async (t: string, q = '', h: Record<string, string> = {}) =>
      (
        await request(app).get(`/api/v1/attendance-statuses${q}`).set(bearer(t)).set(h)
      ).body.data.map((s: { name: string }) => s.name);
    expect(await names(teacher)).toEqual(['Global bir', 'Maktab A holati']);
    expect(await names(otherAdmin)).toEqual(['Global bir', 'Maktab B holati']);
    expect(await names(teacher, '?scope=school')).toEqual(['Maktab A holati']);
    expect(await names(teacher, '?scope=global')).toEqual(['Global bir']);
    expect(await names(root)).toHaveLength(3);
    expect(await names(root, '', { 'X-School-Id': a.id })).toEqual([
      'Global bir',
      'Maktab A holati',
    ]);

    // Nom to'qnashuvi: maktab-global, global-maktab, maktab-maktab
    expect((await post(root, body({ schoolId: a.id, name: 'global BIR' }))).status).toBe(409);
    expect((await post(root, body({ name: 'Maktab A holati' }))).status).toBe(409);
    expect((await post(root, body({ schoolId: a.id, name: 'maktab a holati' }))).status).toBe(409);
    expect((await post(root, body({ schoolId: b.id, name: 'Boshqa B' }))).status).toBe(201);

    const id = own.body.data.id;
    expect(
      (await request(app).post(`/api/v1/attendance-statuses/${id}/deactivate`).set(bearer(root)))
        .body.data.isActive,
    ).toBe(false);
    expect(await names(teacher, '?isActive=true')).toEqual(['Global bir']);
    expect(
      (await request(app).post(`/api/v1/attendance-statuses/${id}/activate`).set(bearer(root))).body
        .data.isActive,
    ).toBe(true);
    expect(
      (await post(root, body({ schoolId: '64b64b64b64b64b64b64b64b', name: 'Yoq maktab' }))).status,
    ).toBe(400);
  });
});

describe('Davomat sozlamalari va ruxsat siyosati', () => {
  const get = (t: string, h: Record<string, string> = {}) =>
    request(app).get('/api/v1/settings/attendance').set(bearer(t)).set(h);
  const put = (t: string, b: object) =>
    request(app).put('/api/v1/settings/attendance').set(bearer(t)).send(b);

  it("standart qiymatlar; global/override faqat huquqi borlarga ko'rinadi", async () => {
    const asTeacher = await get(teacher);
    expect(asTeacher.status).toBe(200);
    expect(asTeacher.body.data.effective).toEqual({
      mode: 'daily',
      lessonsPerDay: 6,
      workingWeekdays: [1, 2, 3, 4, 5, 6],
      editWindowHours: 24,
      backdateDays: 3,
      noteRequiredCategories: [],
      ratingImpact: {
        enabled: false,
        penaltyLate: 0,
        penaltyAbsentExcused: 0,
        penaltyAbsentUnexcused: 0,
      },
    });
    expect(asTeacher.body.data.global).toBeNull();
    expect(asTeacher.body.data.override).toBeNull();
    const plain = await get(plainAdmin);
    expect(plain.body.data.global).toBeNull();
    expect(plain.body.data.effective.mode).toBe('daily');

    await put(root, {
      scope: 'school',
      schoolId: a.id,
      values: { mode: 'lesson', lessonsPerDay: 4 },
    });
    const withPerm = (await get(setAdmin)).body.data;
    expect(withPerm.global.mode).toBe('daily');
    expect(withPerm.override).toEqual({ mode: 'lesson', lessonsPerDay: 4 });
    expect(withPerm.effective).toMatchObject({ mode: 'lesson', lessonsPerDay: 4 });
    expect((await get(teacher)).body.data.effective.mode).toBe('lesson'); // effective hamma uchun
    expect((await get(root, { 'X-School-Id': a.id })).body.data.override).toEqual({
      mode: 'lesson',
      lessonsPerDay: 4,
    });
    expect((await get(root, { 'X-School-Id': b.id })).body.data.effective.mode).toBe('daily');
  });

  it("PUT ruxsat siyosati: school_admin (attendance.settings) faqat o'z maktabi, scope=school", async () => {
    const ok = await put(setAdmin, { scope: 'school', values: { backdateDays: 5 } }); // schoolId tokendan
    expect(ok.status).toBe(200);
    expect(ok.body.data.override).toEqual({ backdateDays: 5 });
    expect(
      (
        await put(setAdmin, {
          scope: 'school',
          schoolId: a.id,
          values: { backdateDays: 5, editWindowHours: 48 },
        })
      ).status,
    ).toBe(200);
    expect((await get(plainAdmin)).body.data.effective).toMatchObject({
      backdateDays: 5,
      editWindowHours: 48,
    });

    expect(
      (await put(setAdmin, { scope: 'school', schoolId: b.id, values: { backdateDays: 1 } }))
        .status,
    ).toBe(403);
    expect((await put(setAdmin, { scope: 'global', values: { backdateDays: 1 } })).status).toBe(
      403,
    );
    expect((await put(plainAdmin, { scope: 'school', values: { backdateDays: 1 } })).status).toBe(
      403,
    );
    expect((await put(teacher, { scope: 'school', values: { backdateDays: 1 } })).status).toBe(403);
    expect(
      (await put(otherAdmin, { scope: 'school', schoolId: a.id, values: { backdateDays: 1 } }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).put('/api/v1/settings/attendance').send({ scope: 'school', values: {} }))
        .status,
    ).toBe(401);
    // Boshqa maktabga ta'sir qilmagan
    expect((await get(otherAdmin)).body.data.effective.backdateDays).toBe(3);

    // Override ni olib tashlash
    const removed = await put(setAdmin, { scope: 'school', values: null });
    expect(removed.body.data.override).toBeNull();
    expect((await get(plainAdmin)).body.data.effective.backdateDays).toBe(3);

    // Superadmin: global va school
    expect((await put(root, { scope: 'global', values: { lessonsPerDay: 8 } })).status).toBe(200);
    expect(
      (await put(root, { scope: 'school', schoolId: b.id, values: { lessonsPerDay: 3 } })).status,
    ).toBe(200);
    expect((await get(plainAdmin)).body.data.effective.lessonsPerDay).toBe(8);
    expect((await get(otherAdmin)).body.data.effective.lessonsPerDay).toBe(3);
    expect(
      await AuditLog.countDocuments({ action: 'settings.update', entityId: 'attendance' }),
    ).toBe(5);
  });

  it('scoring / rating / public hamon faqat superadmin (attendance.settings yetmaydi)', async () => {
    for (const key of ['scoring', 'rating', 'public']) {
      const r = await request(app)
        .put(`/api/v1/settings/${key}`)
        .set(bearer(setAdmin))
        .send({ scope: 'school', schoolId: a.id, values: {} });
      expect(r.status, key).toBe(403);
      const t = await request(app)
        .put(`/api/v1/settings/${key}`)
        .set(bearer(teacher))
        .send({ scope: 'school', schoolId: a.id, values: {} });
      expect(t.status, key).toBe(403);
      expect(
        (
          await request(app)
            .put(`/api/v1/settings/${key}`)
            .set(bearer(root))
            .send({ scope: 'school', schoolId: a.id, values: {} })
        ).status,
        key,
      ).toBe(200);
      // Eski ko'rinish saqlanadi: global hammaga ko'rinadi
      expect(
        (await request(app).get(`/api/v1/settings/${key}`).set(bearer(teacher))).body.data.global,
      ).toBeTruthy();
    }
  });

  it('validatsiya va normalizatsiya', async () => {
    const bad = async (values: object) => {
      const r = await put(root, { scope: 'global', values });
      expect(r.status, JSON.stringify(values)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    };
    await bad({ mode: 'weekly' });
    await bad({ lessonsPerDay: 0 });
    await bad({ lessonsPerDay: 13 });
    await bad({ lessonsPerDay: 2.5 });
    await bad({ workingWeekdays: [] });
    await bad({ workingWeekdays: [0] });
    await bad({ workingWeekdays: [8] });
    await bad({ workingWeekdays: [1, 1] });
    await bad({ editWindowHours: 721 });
    await bad({ editWindowHours: -1 });
    await bad({ backdateDays: 31 });
    await bad({ noteRequiredCategories: ['sick'] });
    await bad({ noteRequiredCategories: ['late', 'late'] });
    await bad({ ratingImpact: { penaltyLate: -1 } });
    await bad({ ratingImpact: { penaltyAbsentUnexcused: 100.5 } });
    await bad({ ratingImpact: { enabled: 'yes' } });

    const ok = await put(root, {
      scope: 'global',
      values: {
        workingWeekdays: [3, 1, 2],
        noteRequiredCategories: ['absent_excused'],
        ratingImpact: { enabled: true, penaltyLate: 1.234 },
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.global).toMatchObject({
      workingWeekdays: [1, 2, 3],
      noteRequiredCategories: ['absent_excused'],
      ratingImpact: {
        enabled: true,
        penaltyLate: 1.23,
        penaltyAbsentExcused: 0,
        penaltyAbsentUnexcused: 0,
      },
    });
    // ratingImpact ichma-ich qisman emas: maktab override i to'liq almashtiradi
    await put(root, {
      scope: 'school',
      schoolId: a.id,
      values: { ratingImpact: { enabled: false } },
    });
    expect((await get(teacher)).body.data.effective.ratingImpact).toEqual({
      enabled: false,
      penaltyLate: 0,
      penaltyAbsentExcused: 0,
      penaltyAbsentUnexcused: 0,
    });
    expect((await get(otherAdmin)).body.data.effective.ratingImpact).toMatchObject({
      enabled: true,
      penaltyLate: 1.23,
    });
    // global null — standartga qaytish
    expect((await put(root, { scope: 'global', values: null })).body.data.global.mode).toBe(
      'daily',
    );
  });
});

describe("Davomat ruxsatlari: ko'tarilmaslik qoidasi", () => {
  it("admin o'zida yo'q davomat ruxsatini bera olmaydi; attendance.settings o'qituvchiga berilmaydi; teacher da take doim bor", async () => {
    await makeUser({
      username: 'mgr',
      role: 'school_admin',
      schoolId: a.id,
      permissions: ['teachers.manage', 'attendance.view'],
    });
    const mgr = (await login('mgr')).token;
    const create = (permissions: string[], username: string) =>
      request(app)
        .post('/api/v1/teachers')
        .set(bearer(mgr))
        .send({ fullName: 'Yangi Ustoz', username, password: 'Passw0rd1', permissions });

    expect((await create(['attendance.edit'], 'ustoz1')).status).toBe(403);
    expect((await create(['attendance.settings'], 'ustoz2')).status).toBe(400); // o'qituvchi katalogida yo'q
    const ok = await create(['attendance.view'], 'ustoz3');
    expect(ok.status).toBe(201);
    expect(ok.body.data.permissions).toEqual(
      expect.arrayContaining(['scores.create', 'attendance.take', 'attendance.view']),
    );
    // attendance.take o'qituvchida doim samarali (ko'tarilish tekshiruvidan ozod)
    expect((await create(['attendance.take'], 'ustoz4')).status).toBe(201);

    const meta = await request(app).get('/api/v1/meta/permissions').set(bearer(mgr));
    const att = meta.body.data.filter((p: { key: string }) => p.key.startsWith('attendance.'));
    expect(
      att.map((p: { key: string; group: string; roles: string[] }) => [p.key, p.group, p.roles]),
    ).toEqual([
      ['attendance.take', 'Davomat', ['school_admin', 'teacher']],
      ['attendance.edit', 'Davomat', ['school_admin', 'teacher']],
      ['attendance.view', 'Davomat', ['school_admin', 'teacher']],
      ['attendance.settings', 'Davomat', ['school_admin']],
    ]);
  });
});
