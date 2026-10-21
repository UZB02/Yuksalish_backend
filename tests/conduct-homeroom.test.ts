import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClassModel } from '../src/models/Class';
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

type Doc = { id: string };
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let s1: Doc, s2: Doc, s6: Doc;
let pos: Doc;
let home: string, plain: string, admin: string, root: string, homeOfC6: string;
let schoolId: string;

beforeEach(async () => {
  const school = await makeSchool('a');
  schoolId = school.id;
  const year = await makeYear(school.id);
  const t1 = await makeUser({ username: 'home', role: 'teacher', schoolId });
  const t2 = await makeUser({ username: 'plain', role: 'teacher', schoolId });
  const t3 = await makeUser({ username: 'home6', role: 'teacher', schoolId });
  await makeUser({
    username: 'admin',
    role: 'school_admin',
    schoolId,
    permissions: [...ADMIN_PERMS, 'scores.create', 'scores.edit'],
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  // 5-A: sinf rahbari t1, t2 oddiy fan o'qituvchisi. 6-A: rahbar t3, t2 ham o'qitadi
  c5 = await makeClass(schoolId, year.id, '5-A', [t1.id, t2.id], { homeroomTeacherId: t1.id });
  c6 = await makeClass(schoolId, year.id, '6-A', [t2.id, t3.id], { homeroomTeacherId: t3.id });
  s1 = await makeStudent(schoolId, c5.id, 'Aliyev Ali');
  s2 = await makeStudent(schoolId, c5.id, 'Valiyev Vali');
  s6 = await makeStudent(schoolId, c6.id, 'Cholpon Chol');
  pos = await makeBehaviorType('Namunali xulq', 'positive');
  [home, plain, admin, root, homeOfC6] = await Promise.all(
    ['home', 'plain', 'admin', 'root', 'home6'].map(async (u) => (await login(u)).token),
  );
});

const post = (t: string, studentId: string, h: Record<string, string> = {}) =>
  request(app)
    .post('/api/v1/scores')
    .set(bearer(t))
    .set(h)
    .send({ studentId, value: 80, behaviorTypeId: pos.id });
const bulk = (t: string, classId: string, studentId: string) =>
  request(app)
    .post('/api/v1/scores/bulk')
    .set(bearer(t))
    .send({ classId, items: [{ studentId, value: 70, behaviorTypeId: pos.id }] });

describe('Xulq bahosi: o`qituvchilardan faqat sinf rahbari', () => {
  it('sinf rahbari baho qo`yadi; sinfga biriktirilgan lekin rahbar bo`lmagan o`qituvchi 403', async () => {
    expect((await post(home, s1.id)).status).toBe(201);
    const denied = await post(plain, s2.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(denied.body.error.message).toMatch(/sinf rahbari/);
    // boshqa sinf rahbari o'zga sinf o'quvchisiga qo'ya olmaydi (sinfga biriktirilmagan -> 404)
    expect((await post(homeOfC6, s1.id)).status).toBe(404);
    // t2 6-A da ham rahbar emas
    expect((await post(plain, s6.id)).status).toBe(403);
    expect((await post(homeOfC6, s6.id)).status).toBe(201);
    expect(await Score.countDocuments({})).toBe(2);
  });

  it('bulk: faqat rahbar; rahbar bo`lmagan o`qituvchiga 403 va hech narsa yozilmaydi', async () => {
    expect((await bulk(plain, c5.id, s1.id)).status).toBe(403);
    expect(await Score.countDocuments({})).toBe(0);
    const ok = await bulk(home, c5.id, s1.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.created).toBe(1);
  });

  it('sinf rahbari bo`lmagan sinf uchun scoring-sheet 403; today-progress faqat rahbar sinflari', async () => {
    const sheet = (t: string, id: string) =>
      request(app).get(`/api/v1/classes/${id}/scoring-sheet`).set(bearer(t));
    expect((await sheet(home, c5.id)).status).toBe(200);
    expect((await sheet(plain, c5.id)).status).toBe(403);
    expect((await sheet(plain, c6.id)).status).toBe(403);

    const progress = (t: string) =>
      request(app).get('/api/v1/scores/today-progress').set(bearer(t));
    const names = (r: request.Response) =>
      r.body.data.map((c: { className: string }) => c.className).sort();
    expect(names(await progress(home))).toEqual(['5-A']);
    expect(names(await progress(homeOfC6))).toEqual(['6-A']);
    expect(names(await progress(plain))).toEqual([]);
    expect(names(await progress(admin))).toEqual(['5-A', '6-A']);
  });

  it('admin (permission) va superadmin cheklanmaydi', async () => {
    expect((await post(admin, s1.id)).status).toBe(201);
    expect((await post(admin, s6.id)).status).toBe(201);
    expect((await post(root, s2.id, { 'X-School-Id': schoolId })).status).toBe(201);
    expect((await bulk(admin, c6.id, s6.id)).status).toBe(200);
  });

  it('o`z mavjud bahosini tahrirlash/o`chirish rahbarlik olib tashlangandan keyin ham oyna ichida mumkin', async () => {
    const created = await post(home, s1.id);
    expect(created.status).toBe(201);
    await ClassModel.updateOne({ _id: c5.id }, { homeroomTeacherId: null });
    const patch = await request(app)
      .patch(`/api/v1/scores/${created.body.data.id}`)
      .set(bearer(home))
      .send({ value: 90 });
    expect(patch.status).toBe(200);
    expect(patch.body.data.value).toBe(90);
    // yangi baho esa mumkin emas
    expect((await post(home, s2.id)).status).toBe(403);
    const del = await request(app)
      .delete(`/api/v1/scores/${created.body.data.id}`)
      .set(bearer(home));
    expect(del.status).toBe(200);
  });

  it('sinf rahbarsiz bo`lsa o`qituvchilardan hech kim baho qo`ya olmaydi, admin esa qo`yadi', async () => {
    await ClassModel.updateOne({ _id: c5.id }, { homeroomTeacherId: null });
    expect((await post(home, s1.id)).status).toBe(403);
    expect((await post(plain, s1.id)).status).toBe(403);
    expect((await post(admin, s1.id)).status).toBe(201);
  });
});
