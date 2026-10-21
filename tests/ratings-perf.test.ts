import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Rating } from '../src/models/Rating';
import { Score } from '../src/models/Score';
import { Student } from '../src/models/Student';
import { recalculateSchool } from '../src/modules/ratings/ratings.service';
import { clock } from '../src/utils/clock';
import {
  app,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';

useTestDb();

describe("Reyting hisoblash tezligi (3000 o'quvchi x 30 kun)", () => {
  it('90 000 ta baho bilan bitta maktabni qayta hisoblash', async () => {
    clock.set(() => new Date('2026-10-31T07:00:00Z'));
    const school = await makeSchool('perf');
    const year = await makeYear(school.id);
    const teacher = await makeUser({ username: 'ptch', role: 'teacher', schoolId: school.id });
    const bt = await makeBehaviorType('Perf tur');

    const classIds: Types.ObjectId[] = [];
    for (let i = 0; i < 100; i++)
      classIds.push((await makeClass(school.id, year.id, `${(i % 11) + 1}-${i}`))._id);
    const studentDocs = Array.from({ length: 3000 }, (_, i) => ({
      schoolId: school._id,
      classId: classIds[i % 100],
      fullName: `Talaba ${String(i).padStart(4, '0')}`,
      nameKey: `talaba ${i}`,
      classHistory: [],
    }));
    const students = await Student.insertMany(studentDocs);

    const scoreDocs: Record<string, unknown>[] = [];
    for (const [i, s] of students.entries()) {
      for (let d = 1; d <= 30; d++) {
        scoreDocs.push({
          schoolId: school._id,
          studentId: s._id,
          classId: s.classId,
          teacherId: teacher._id,
          academicYearId: year._id,
          behaviorTypeId: bt._id,
          value: 50 + ((i * 7 + d * 3) % 51),
          comment: null,
          date: `2026-10-${String(d).padStart(2, '0')}`,
          isDeleted: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
    for (let i = 0; i < scoreDocs.length; i += 10_000)
      await Score.collection.insertMany(scoreDocs.slice(i, i + 10_000));
    expect(await Score.countDocuments({ schoolId: school._id })).toBe(90_000);

    const t0 = performance.now();
    await recalculateSchool(school.id);
    const ms = Math.round(performance.now() - t0);
    console.log(`[PERF] 3000 o'quvchi x 30 kun (90 000 baho): recalculateSchool = ${ms} ms`);
    expect(ms).toBeLessThan(15_000);
    expect(await Rating.countDocuments({ schoolId: school._id, scope: 'student' })).toBe(3000);
    expect(await Rating.countDocuments({ schoolId: school._id, scope: 'class' })).toBe(100);

    const admin = await makeUser({
      username: 'padm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['reports.view'],
    });
    const token = (await login(admin.get('username'))).token;
    const t1 = performance.now();
    const res = await request(app)
      .get('/api/v1/ratings/students?limit=50&page=10')
      .set(bearer(token));
    const readMs = Math.round(performance.now() - t1);
    console.log(`[PERF] GET /ratings/students (snapshot, 10-sahifa): ${readMs} ms`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(50);
    expect(res.body.meta.total).toBe(3000);
    expect(res.body.data.items[0].rank).toBe(451);
  }, 120_000);
});
