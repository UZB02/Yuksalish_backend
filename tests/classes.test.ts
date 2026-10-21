import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClassModel } from '../src/models/Class';
import { User } from '../src/models/User';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let t1: Awaited<ReturnType<typeof makeUser>>;
let t2: Awaited<ReturnType<typeof makeUser>>;
let token: string;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'adm2',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'nope',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['dashboard.view'],
  });
  t1 = await makeUser({ username: 'teacher1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'teacher2', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  token = (await login('adm')).token;
});

describe('Sinflar', () => {
  it("yaratish: default faol yil, DTO shakli, rahbar teacherIds ga qo'shiladi", async () => {
    const res = await request(app)
      .post('/api/v1/classes')
      .set(bearer(token))
      .send({ name: '7-A', grade: 7, section: 'A', homeroomTeacherId: t1.id, teacherIds: [t2.id] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: '7-A',
      grade: 7,
      section: 'A',
      academicYearId: year.id,
      homeroomTeacherId: t1.id,
      homeroomTeacher: { id: t1.id, fullName: t1.fullName },
      studentsCount: 0,
      isArchived: false,
    });
    expect(res.body.data.teacherIds.sort()).toEqual([t1.id, t2.id].sort());
    expect(res.body.data.teachers).toHaveLength(2);
  });

  it('nom faol yil + maktab ichida unique (7A / 7-a ham bir xil), boshqa maktabda mumkin', async () => {
    const post = (t: string, name: string) =>
      request(app).post('/api/v1/classes').set(bearer(t)).send({ name, grade: 7 });
    expect((await post(token, '7-A')).status).toBe(201);
    expect((await post(token, '7-A')).status).toBe(409);
    expect((await post(token, '7a')).status).toBe(409);
    expect((await post(token, '7-B')).status).toBe(201);

    const t2token = (await login('adm2')).token;
    await makeYear(other.id);
    expect((await post(t2token, '7-A')).status).toBe(201);
  });

  it("faol yil bo'lmasa 400; grade 1..11; noto'g'ri o'qituvchi 400", async () => {
    const post = (b: object) => request(app).post('/api/v1/classes').set(bearer(token)).send(b);
    expect((await post({ name: '12-A', grade: 12 })).status).toBe(400);
    const stranger = await makeUser({ username: 'tx', role: 'teacher', schoolId: other.id });
    expect((await post({ name: '5-A', grade: 5, teacherIds: [stranger.id] })).status).toBe(400);
    const inactive = await makeUser({
      username: 'ti',
      role: 'teacher',
      schoolId: school.id,
      isActive: false,
    });
    expect((await post({ name: '5-A', grade: 5, teacherIds: [inactive.id] })).status).toBe(400);

    await year.deleteOne();
    const noYear = await post({ name: '5-B', grade: 5 });
    expect(noYear.status).toBe(400);
    expect(noYear.body.error.details[0].path).toBe('academicYearId');
  });

  it("ro'yxat: default faol yil va arxivlanmagan, filtrlar, studentsCount", async () => {
    const a = await makeClass(school.id, year.id, '5-A');
    const b = await makeClass(school.id, year.id, '7-B', [], { isArchived: true });
    const oldYear = await makeYear(school.id, '2025-2026', false);
    await makeClass(school.id, oldYear.id, '4-A');
    await makeStudent(school.id, a.id, 'Ali Valiyev');
    await makeStudent(school.id, a.id, 'Vali Aliyev');
    await makeStudent(school.id, a.id, 'Chetga Chiqqan', { isDeleted: true });

    const def = await request(app).get('/api/v1/classes').set(bearer(token));
    expect(def.body.data.map((c: { name: string }) => c.name)).toEqual(['5-A']);
    expect(def.body.data[0].studentsCount).toBe(2);
    expect(def.body.meta).toMatchObject({ total: 1 });

    const archived = await request(app).get('/api/v1/classes?isArchived=true').set(bearer(token));
    expect(archived.body.data.map((c: { id: string }) => c.id)).toEqual([b.id]);
    const old = await request(app)
      .get(`/api/v1/classes?academicYearId=${oldYear.id}`)
      .set(bearer(token));
    expect(old.body.data.map((c: { name: string }) => c.name)).toEqual(['4-A']);
    expect(
      (await request(app).get('/api/v1/classes?grade=5').set(bearer(token))).body.data,
    ).toHaveLength(1);
    expect(
      (await request(app).get('/api/v1/classes?search=zzz').set(bearer(token))).body.data,
    ).toHaveLength(0);
  });

  it("o'qituvchi faqat o'ziga biriktirilgan sinflarni ko'radi (ruxsatsiz ham); boshqasi 404", async () => {
    const mine = await makeClass(school.id, year.id, '5-A', [t1.id]);
    const theirs = await makeClass(school.id, year.id, '6-A', [t2.id]);
    const tt = (await login('teacher1')).token;

    const list = await request(app).get('/api/v1/classes').set(bearer(tt));
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    expect((await request(app).get(`/api/v1/classes/${mine.id}`).set(bearer(tt))).status).toBe(200);
    expect((await request(app).get(`/api/v1/classes/${theirs.id}`).set(bearer(tt))).status).toBe(
      404,
    );
    expect(
      (await request(app).post('/api/v1/classes').set(bearer(tt)).send({ name: '1-A', grade: 1 }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).patch(`/api/v1/classes/${mine.id}`).set(bearer(tt)).send({ name: 'x' }))
        .status,
    ).toBe(403);
  });

  it("ruxsat: classes.manage/students.view/scores.create yo'q admin 403", async () => {
    const tn = (await login('nope')).token;
    expect((await request(app).get('/api/v1/classes').set(bearer(tn))).status).toBe(403);
    expect(
      (await request(app).post('/api/v1/classes').set(bearer(tn)).send({ name: '1-A', grade: 1 }))
        .status,
    ).toBe(403);
    await makeUser({
      username: 'sv',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['students.view'],
    });
    const sv = (await login('sv')).token;
    expect((await request(app).get('/api/v1/classes').set(bearer(sv))).status).toBe(200);
    expect(
      (await request(app).post('/api/v1/classes').set(bearer(sv)).send({ name: '1-A', grade: 1 }))
        .status,
    ).toBe(403);
  });

  it('tenant: boshqa maktab sinfi 404 (barcha amallar)', async () => {
    const oy = await makeYear(other.id);
    const foreign = await makeClass(other.id, oy.id, '5-A');
    for (const [method, path, payload] of [
      ['get', `/api/v1/classes/${foreign.id}`, undefined],
      ['patch', `/api/v1/classes/${foreign.id}`, { name: 'x' }],
      ['post', `/api/v1/classes/${foreign.id}/archive`, undefined],
      [
        'put',
        `/api/v1/classes/${foreign.id}/teachers`,
        { teacherIds: [], homeroomTeacherId: null },
      ],
    ] as const) {
      const r = await request(app)[method](path).set(bearer(token)).send(payload);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // Bir maktab admini boshqa maktab o'qituvchisini sinfga qo'sha olmaydi
    const own = await makeClass(school.id, year.id, '6-A');
    const stranger = await makeUser({ username: 'tx', role: 'teacher', schoolId: other.id });
    const r = await request(app)
      .put(`/api/v1/classes/${own.id}/teachers`)
      .set(bearer(token))
      .send({ teacherIds: [stranger.id], homeroomTeacherId: null });
    expect(r.status).toBe(400);
  });

  it("PATCH, arxivlash/qaytarish (o'quvchilar saqlanadi)", async () => {
    const c = await makeClass(school.id, year.id, '5-A');
    await makeStudent(school.id, c.id, 'Ali Valiyev');
    const patched = await request(app)
      .patch(`/api/v1/classes/${c.id}`)
      .set(bearer(token))
      .send({ name: '5-B', section: null });
    expect(patched.body.data).toMatchObject({ name: '5-B', section: null });

    const arch = await request(app).post(`/api/v1/classes/${c.id}/archive`).set(bearer(token));
    expect(arch.body.data).toMatchObject({ isArchived: true, studentsCount: 1 });
    expect((await request(app).get('/api/v1/classes').set(bearer(token))).body.data).toHaveLength(
      0,
    );
    const un = await request(app).post(`/api/v1/classes/${c.id}/unarchive`).set(bearer(token));
    expect(un.body.data.isArchived).toBe(false);
  });

  it("PUT /classes/:id/teachers: rahbar teacherIds ichida bo'lishi shart", async () => {
    const c = await makeClass(school.id, year.id, '5-A');
    const put = (b: object) =>
      request(app).put(`/api/v1/classes/${c.id}/teachers`).set(bearer(token)).send(b);
    const bad = await put({ teacherIds: [t1.id], homeroomTeacherId: t2.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('homeroomTeacherId');

    const ok = await put({ teacherIds: [t1.id, t2.id], homeroomTeacherId: t2.id });
    expect(ok.status).toBe(200);
    expect(ok.body.data.homeroomTeacher.id).toBe(t2.id);
    const cleared = await put({ teacherIds: [], homeroomTeacherId: null });
    expect(cleared.body.data.teachers).toEqual([]);
  });
});

describe("O'qituvchi sinflari (PUT /teachers/:id/classes)", () => {
  it("to'liq almashtiradi, Class.teacherIds yangilanadi, DTO da classes bor", async () => {
    const a = await makeClass(school.id, year.id, '5-A', [t1.id], { homeroomTeacherId: t1.id });
    const b = await makeClass(school.id, year.id, '6-A');
    const c = await makeClass(school.id, year.id, '7-A');

    const res = await request(app)
      .put(`/api/v1/teachers/${t1.id}/classes`)
      .set(bearer(token))
      .send({ classIds: [b.id, c.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.classes.map((x: { name: string }) => x.name)).toEqual(['6-A', '7-A']);

    const fresh = await ClassModel.findById(a.id);
    expect(fresh!.teacherIds).toHaveLength(0);
    expect(fresh!.homeroomTeacherId).toBeNull();
    expect((await ClassModel.findById(b.id))!.teacherIds.map(String)).toEqual([t1.id]);

    const get = await request(app).get(`/api/v1/teachers/${t1.id}`).set(bearer(token));
    expect(get.body.data.classes).toHaveLength(2);
    const list = await request(app).get('/api/v1/teachers').set(bearer(token));
    expect(list.body.data.find((t: { id: string }) => t.id === t2.id).classes).toEqual([]);

    await request(app)
      .put(`/api/v1/teachers/${t1.id}/classes`)
      .set(bearer(token))
      .send({ classIds: [] });
    expect(
      (await request(app).get(`/api/v1/teachers/${t1.id}`).set(bearer(token))).body.data.classes,
    ).toEqual([]);
  });

  it("boshqa maktab/eski yil/arxiv sinfi 400; boshqa maktab o'qituvchisi 404; ruxsat kerak", async () => {
    const oy = await makeYear(other.id);
    const foreign = await makeClass(other.id, oy.id, '5-A');
    const oldYear = await makeYear(school.id, '2025-2026', false);
    const old = await makeClass(school.id, oldYear.id, '4-A');
    const arch = await makeClass(school.id, year.id, '8-A', [], { isArchived: true });
    for (const id of [foreign.id, old.id, arch.id]) {
      const r = await request(app)
        .put(`/api/v1/teachers/${t1.id}/classes`)
        .set(bearer(token))
        .send({ classIds: [id] });
      expect(r.status).toBe(400);
    }
    const tx = await makeUser({ username: 'tx', role: 'teacher', schoolId: other.id });
    expect(
      (
        await request(app)
          .put(`/api/v1/teachers/${tx.id}/classes`)
          .set(bearer(token))
          .send({ classIds: [] })
      ).status,
    ).toBe(404);
    const tn = (await login('nope')).token;
    expect(
      (
        await request(app)
          .put(`/api/v1/teachers/${t1.id}/classes`)
          .set(bearer(tn))
          .send({ classIds: [] })
      ).status,
    ).toBe(403);
  });
});

describe('Kichik tuzatish: null bilan tozalash', () => {
  it("maktab (address/phone/logoUrl) va o'qituvchi (phone) PATCH null qabul qiladi", async () => {
    const root = (await login('root')).token;
    const s = await request(app).post('/api/v1/schools').set(bearer(root)).send({
      name: 'Maktab X',
      slug: 'x-maktab',
      address: 'Toshkent',
      phone: '+998901234567',
      logoUrl: 'https://e.com/l.png',
    });
    const cleared = await request(app)
      .patch(`/api/v1/schools/${s.body.data.id}`)
      .set(bearer(root))
      .send({ address: null, phone: null, logoUrl: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ address: null, phone: null, logoUrl: null });

    const t = await request(app)
      .patch(`/api/v1/teachers/${t1.id}`)
      .set(bearer(token))
      .send({ phone: '+998901112233' });
    expect(t.body.data.phone).toBe('+998901112233');
    const tc = await request(app)
      .patch(`/api/v1/teachers/${t1.id}`)
      .set(bearer(token))
      .send({ phone: null });
    expect(tc.status).toBe(200);
    expect(tc.body.data.phone).toBeNull();
  });
});

describe('Dashboard', () => {
  it("maktab, o'qituvchi (o'z sinflari) va global hisob", async () => {
    const a = await makeClass(school.id, year.id, '5-A', [t1.id]);
    const b = await makeClass(school.id, year.id, '6-A', [t2.id]);
    await makeStudent(school.id, a.id, 'Ali Valiyev');
    await makeStudent(school.id, a.id, 'Vali Aliyev');
    await makeStudent(school.id, b.id, 'Hasan Husanov');
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    await makeStudent(other.id, oc.id, 'Boshqa Maktab');

    const adm = await request(app).get('/api/v1/dashboard/summary').set(bearer(token));
    expect(adm.body.data).toMatchObject({
      students: 3,
      classes: 2,
      teachers: 2,
      scoresToday: 0,
      unscoredClassesToday: 2,
    });

    const root = (await login('root')).token;
    const school1 = await request(app)
      .get('/api/v1/dashboard/summary')
      .set(bearer(root))
      .set('X-School-Id', school.id);
    expect(school1.body.data).toMatchObject({ students: 3, classes: 2 });
    expect(school1.body.data.schools).toBeUndefined();
    const global = await request(app).get('/api/v1/dashboard/summary').set(bearer(root));
    expect(global.body.data).toMatchObject({ students: 4, classes: 3, teachers: 2, schools: 2 });

    const tt = (await login('teacher1')).token;
    const own = await request(app).get('/api/v1/dashboard/summary').set(bearer(tt));
    expect(own.status).toBe(403); // dashboard.view berilmagan
    await User.updateOne({ _id: t1._id }, { permissions: ['dashboard.view'] });
    const scoped = await request(app).get('/api/v1/dashboard/summary').set(bearer(tt));
    expect(scoped.body.data).toMatchObject({ students: 2, classes: 1, teachers: 1 });

    expect(
      (
        await request(app)
          .get('/api/v1/dashboard/summary')
          .set(bearer((await login('nope')).token))
      ).status,
    ).toBe(200);
  });
});
