import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { purgeStaleTimetableVersions } from '../src/modules/timetable/timetable.purge';
import { resolveLessons } from '../src/modules/timetable/timetable.resolver';
import { clock } from '../src/utils/clock';
import {
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

useTestDb();

const DAY = 86_400_000;
const now = () => clock.now();
const ago = (days: number) => new Date(now().getTime() - days * DAY);

let school: { id: string };
let cls: Awaited<ReturnType<typeof makeClass>>;
let seq = 0;

async function mk(
  schoolId: string,
  classId: string,
  status: 'draft' | 'active' | 'superseded' | 'replaced',
  o: {
    replacedAt?: Date;
    updatedAt?: Date;
    validFrom?: string;
    validTo?: string | null;
    basedOn?: Types.ObjectId;
    replacedBy?: Types.ObjectId;
  } = {},
) {
  seq++;
  const activated = status !== 'draft';
  const doc = await TimetableVersion.create({
    schoolId,
    academicYearId: new Types.ObjectId(),
    classId,
    status,
    validFrom: o.validFrom ?? `2025-0${(seq % 9) + 1}-01`,
    validTo: o.validTo ?? null,
    activatedAt: activated ? ago(200) : null,
    replacedAt: o.replacedAt ?? null,
    replacedBy: o.replacedBy ?? null,
    basedOnVersionId: o.basedOn ?? null,
  });
  if (o.updatedAt) {
    await TimetableVersion.collection.updateOne(
      { _id: doc._id },
      { $set: { updatedAt: o.updatedAt } },
    );
  }
  return String(doc._id);
}
const exists = async (id: string) => !!(await TimetableVersion.exists({ _id: id }));

beforeEach(async () => {
  school = await makeSchool('purge');
  const year = await makeYear(school.id);
  cls = await makeClass(school.id, year.id, '5-A');
});

describe('purgeStaleTimetableVersions', () => {
  it("30 kundan eski replaced va qoralamani o'chiradi, qolganini saqlaydi", async () => {
    const c = String(cls.id);
    const oldReplaced = await mk(school.id, c, 'replaced', { replacedAt: ago(31) });
    const newReplaced = await mk(school.id, c, 'replaced', { replacedAt: ago(29) });
    const oldDraft = await mk(school.id, c, 'draft', { updatedAt: ago(31) });
    const newDraft = await mk(school.id, c, 'draft', { updatedAt: ago(5) });
    const oldSuperseded = await mk(school.id, c, 'superseded', {
      validTo: '2020-01-31',
      validFrom: '2020-01-01',
    });
    const oldActive = await mk(school.id, c, 'active', { validFrom: '2020-02-01' });
    await TimetableVersion.collection.updateMany(
      { _id: { $in: [oldSuperseded, oldActive].map((i) => new Types.ObjectId(i)) } },
      { $set: { updatedAt: ago(900), activatedAt: ago(900) } },
    );

    const r = await purgeStaleTimetableVersions();
    expect(r).toMatchObject({ deleted: 2, replaced: 1, drafts: 1 });
    expect(await exists(oldReplaced)).toBe(false);
    expect(await exists(oldDraft)).toBe(false);
    for (const id of [newReplaced, newDraft, oldSuperseded, oldActive])
      expect(await exists(id)).toBe(true);

    const again = await purgeStaleTimetableVersions();
    expect(again.deleted).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'timetable.version_purged' })).toBe(1);
  });

  it("audit yozuvi maktab bo'yicha, tenantlar izolyatsiyasi", async () => {
    const s2 = await makeSchool('purge2');
    const y2 = await makeYear(s2.id);
    const c2 = await makeClass(s2.id, y2.id, '6-A');
    await mk(school.id, String(cls.id), 'draft', { updatedAt: ago(40) });
    await mk(s2.id, String(c2.id), 'replaced', { replacedAt: ago(40) });
    await mk(s2.id, String(c2.id), 'draft', { updatedAt: ago(1) });
    const r = await purgeStaleTimetableVersions();
    expect(r.deleted).toBe(2);
    expect(r.bySchool).toEqual({ [school.id]: 1, [s2.id]: 1 });
    const logs = await AuditLog.find({ action: 'timetable.version_purged' }).lean();
    expect(logs.map((l) => String(l.schoolId)).sort()).toEqual([school.id, s2.id].sort());
    expect(logs.every((l) => l.userId === null)).toBe(true);
    expect(await TimetableVersion.countDocuments({ schoolId: s2.id })).toBe(1);
  });

  it('havolalarni tozalaydi (basedOnVersionId)', async () => {
    const c = String(cls.id);
    const old = await mk(school.id, c, 'replaced', { replacedAt: ago(60) });
    const child = await mk(school.id, c, 'draft', {
      updatedAt: ago(1),
      basedOn: new Types.ObjectId(old),
    });
    await purgeStaleTimetableVersions();
    expect(await exists(old)).toBe(false);
    expect((await TimetableVersion.findById(child).lean())?.basedOnVersionId).toBeNull();
  });
});

describe("o'tgan davr purgedan keyin", () => {
  it("superseded davr bo'yicha jadval hal qilinadi, ro'yxatda purgeAt bor", async () => {
    await makeUser({
      username: 'padmin',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['timetable.manage', 'timetable.view'],
    });
    const token = (await login('padmin')).token;
    const t = await makeUser({ username: 'pt1', role: 'teacher', schoolId: school.id });
    const subj = await makeSubject('Matematika');
    const c = String(cls.id);
    const old = await mk(school.id, c, 'superseded', {
      validFrom: '2020-01-01',
      validTo: '2020-01-31',
    });
    await TimetableVersion.updateOne(
      { _id: old },
      {
        $set: {
          entries: [
            {
              weekday: 1,
              lessonNo: 1,
              subjectId: subj.id,
              teacherId: t.id,
              groupKey: null,
              room: null,
            },
          ],
        },
      },
    );
    await mk(school.id, c, 'replaced', { replacedAt: ago(45) });
    const draft = await mk(school.id, c, 'draft', { updatedAt: ago(10) });
    await purgeStaleTimetableVersions();

    const lessons = await resolveLessons(school.id, c, '2020-01-06'); // dushanba
    expect(lessons.map((l) => l.lessonNo)).toEqual([1]);

    const res = await request(app)
      .get(`/api/v1/timetable/classes/${c}/versions`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    const vs = res.body.data.versions as { id: string; purgeAt: string | null }[];
    expect(vs.map((v) => v.id).sort()).toEqual([old, draft].sort());
    expect(vs.find((v) => v.id === draft)?.purgeAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(vs.find((v) => v.id === old)?.purgeAt).toBeNull();
  });
});
