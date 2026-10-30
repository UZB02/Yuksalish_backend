import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimetableVersion } from '../src/models/TimetableVersion';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { readXlsx } from './helpers/xlsx';

// Resolver (P4 almashtirishlari hali yo'q) 3-darsni bekor qilingan deb qaytaradi
vi.mock('../src/modules/timetable/timetable.resolver', async (orig) => {
  const mod = await orig<typeof import('../src/modules/timetable/timetable.resolver')>();
  return {
    ...mod,
    subjectLessonsInRange: async (...args: Parameters<typeof mod.subjectLessonsInRange>) =>
      (await mod.subjectLessonsInRange(...args)).map((l) =>
        l.lessonNo === 3 ? { ...l, cancelled: true, overrideType: 'cancel' as const } : l,
      ),
  };
});

useTestDb();

describe('Jurnal: bekor qilingan dars ustuni', () => {
  let ctx: { classId: string; subjectId: string; token: string };
  beforeEach(async () => {
    const school = await makeSchool('jc');
    const year = await makeYear(school.id);
    const teacher = await makeUser({ username: 'tc', role: 'teacher', schoolId: school.id });
    await makeUser({
      username: 'jcadm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: [...ADMIN_PERMS, 'grades.create'],
    });
    const eng = await makeSubject('Ingliz tili');
    const cls = await makeClass(school.id, year.id, '8-B');
    const e = (lessonNo: number) => ({
      weekday: 3,
      lessonNo,
      subjectId: eng.id,
      teacherId: teacher.id,
      groupKey: null,
      room: null,
    });
    await TimetableVersion.create({
      schoolId: school.id,
      academicYearId: year.id,
      classId: cls.id,
      status: 'active',
      validFrom: '2026-10-01',
      activatedAt: new Date(),
      entries: [e(1), e(3)],
    });
    ctx = { classId: cls.id, subjectId: eng.id, token: (await login('jcadm')).token };
  });

  it('cancelled bayrog`i ustunga o`tadi; xlsx va pdf ishlaydi', async () => {
    const q = `classId=${ctx.classId}&subjectId=${ctx.subjectId}&from=2026-10-12&to=2026-10-17`;
    const r = await request(app).get(`/api/v1/journal/subject?${q}`).set(bearer(ctx.token));
    expect(
      r.body.data.columns.map((c: { key: string; cancelled: boolean }) => [c.key, c.cancelled]),
    ).toEqual([
      ['2026-10-14#1', false],
      ['2026-10-14#3', true],
    ]);
    const bin = (p: string) =>
      request(app)
        .get(`/api/v1/journal/subject/${p}?${q}`)
        .set(bearer(ctx.token))
        .buffer(true)
        .parse((res, cb) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => cb(null, Buffer.concat(parts)));
        });
    const x = await bin('export.xlsx');
    expect(x.status).toBe(200);
    expect((await readXlsx(x.body as Buffer)).some((row) => row.includes('3-d'))).toBe(true);
    expect((await bin('export.pdf')).status).toBe(200);
  });
});
