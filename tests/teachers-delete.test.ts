import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AttendanceRecord } from '../src/models/AttendanceRecord';
import { AuditLog } from '../src/models/AuditLog';
import { ClassModel } from '../src/models/Class';
import { ClassSubject } from '../src/models/ClassSubject';
import { LessonOverride } from '../src/models/LessonOverride';
import { Photo } from '../src/models/Photo';
import { RefreshToken } from '../src/models/RefreshToken';
import { Score } from '../src/models/Score';
import { SubjectGrade } from '../src/models/SubjectGrade';
import { TelegramLinkToken } from '../src/models/TelegramLinkToken';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { User } from '../src/models/User';
import { teacherDeletion } from '../src/modules/teachers/teachers.delete';
import {
  ADMIN_PERMS,
  app,
  assignSubject,
  bearer,
  login,
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

const API = '/api/v1/teachers';
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let teacher: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let adm: string;
let root: string;
let cls: Awaited<ReturnType<typeof makeClass>>;
let student: Awaited<ReturnType<typeof makeStudent>>;
let subject: Awaited<ReturnType<typeof makeSubject>>;

const usage = (t = adm, id = teacher.id as string) =>
  request(app).get(`${API}/${id}/usage`).set(bearer(t));
const del = (t = adm, id = teacher.id as string) =>
  request(app).delete(`${API}/${id}`).set(bearer(t));

beforeEach(async () => {
  school = await makeSchool('s1');
  other = await makeSchool('s2');
  year = await makeYear(school.id);
  admin = await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({ username: 'root', role: 'superadmin' });
  teacher = await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
  cls = await makeClass(school.id, year.id, '5-A', [teacher.id], { homeroomTeacherId: teacher._id });
  student = await makeStudent(school.id, cls.id, 'Aliyev Ali');
  subject = await makeSubject('Matematika');
  adm = (await login('adm')).token;
  root = (await login('root')).token;
});

const EMPTY = {
  scores: 0,
  subjectGrades: 0,
  attendance: 0,
  timetableEntries: 0,
  lessonOverrides: 0,
  auditActions: 0,
};

describe('GET /teachers/:id/usage', () => {
  it('tarixsiz oqituvchi ochiriladigan, hamma hisob 0', async () => {
    const res = await usage();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deletable: true, counts: EMPTY });
  });

  it('Score (soft-delete ham) hisoblanadi', async () => {
    const bt = await makeBehaviorType('Faol');
    const base = {
      schoolId: school.id,
      studentId: student.id,
      classId: cls.id,
      teacherId: teacher.id,
      academicYearId: year.id,
      behaviorTypeId: bt.id,
      value: 5,
      date: '2026-10-05',
    };
    await Score.create(base);
    await Score.create({ ...base, isDeleted: true });
    const res = await usage();
    expect(res.body.data.deletable).toBe(false);
    expect(res.body.data.counts).toEqual({ ...EMPTY, scores: 2 });
  });

  it('SubjectGrade hisoblanadi', async () => {
    await SubjectGrade.create({
      schoolId: school.id,
      studentId: student.id,
      classId: cls.id,
      subjectId: subject.id,
      teacherId: teacher.id,
      academicYearId: year.id,
      value: 5,
      date: '2026-10-05',
    });
    const res = await usage();
    expect(res.body.data.counts).toEqual({ ...EMPTY, subjectGrades: 1 });
    expect(res.body.data.deletable).toBe(false);
  });

  it('Davomat: teacherId, markedBy yoki updatedBy boyicha', async () => {
    const t2 = await makeUser({ username: 'tch2', role: 'teacher', schoolId: school.id });
    const common = {
      schoolId: school.id,
      classId: cls.id,
      academicYearId: year.id,
      studentId: student.id,
      statusId: new Types.ObjectId(),
      category: 'present' as const,
    };
    await AttendanceRecord.create({
      ...common,
      date: '2026-10-05',
      teacherId: teacher.id,
      markedBy: t2.id,
      updatedBy: t2.id,
    });
    await AttendanceRecord.create({
      ...common,
      date: '2026-10-06',
      markedBy: teacher.id,
      updatedBy: t2.id,
    });
    await AttendanceRecord.create({
      ...common,
      date: '2026-10-07',
      markedBy: t2.id,
      updatedBy: teacher.id,
    });
    const res = await usage();
    expect(res.body.data.counts).toEqual({ ...EMPTY, attendance: 3 });
  });

  it('Dars jadvali yozuvlari: har qanday status (draft ham) hisoblanadi', async () => {
    const entry = (n: number, t: string | Types.ObjectId = teacher.id) => ({
      weekday: 1,
      lessonNo: n,
      subjectId: subject.id,
      teacherId: t,
    });
    await TimetableVersion.create({
      schoolId: school.id,
      academicYearId: year.id,
      classId: cls.id,
      status: 'draft',
      validFrom: '2026-09-01',
      entries: [entry(1), entry(2), entry(3, new Types.ObjectId())],
    });
    const res = await usage();
    expect(res.body.data.counts).toEqual({ ...EMPTY, timetableEntries: 2 });
    expect(res.body.data.deletable).toBe(false);
  });

  it('Dars ozgarishi: teacherId, targetTeacherId va createdBy', async () => {
    const base = { schoolId: school.id, classId: cls.id, type: 'substitute' as const };
    await LessonOverride.create({ ...base, date: '2026-10-05', lessonNo: 1, teacherId: teacher.id });
    await LessonOverride.create({
      ...base,
      date: '2026-10-05',
      lessonNo: 2,
      targetTeacherId: teacher.id,
    });
    await LessonOverride.create({ ...base, date: '2026-10-05', lessonNo: 3, createdBy: teacher.id });
    const res = await usage();
    expect(res.body.data.counts).toEqual({ ...EMPTY, lessonOverrides: 3 });
  });

  it('Audit: faqat oqituvchi OZI bajargan amallar; admin uni yaratgani sanalmaydi', async () => {
    await AuditLog.create({
      userId: admin._id,
      action: 'teacher.create',
      entity: 'user',
      entityId: teacher.id,
    });
    expect((await usage()).body.data).toEqual({ deletable: true, counts: EMPTY });
    await AuditLog.create({ userId: teacher._id, action: 'auth.login', entity: 'user' });
    const res = await usage();
    expect(res.body.data.counts).toEqual({ ...EMPTY, auditActions: 1 });
    expect(res.body.data.deletable).toBe(false);
  });
});

describe('DELETE /teachers/:id', () => {
  it('tarixsiz oqituvchi ochadi va bogliq malumotlar tozalanadi', async () => {
    const fake = new FakeTelegram();
    fake.install();
    await request(app).put('/api/v1/telegram/config').set(bearer(root)).send({ token: VALID_TOKEN });
    await new Promise((r) => setTimeout(r, 30));
    fake.commandCalls = [];

    const keep = await makeUser({ username: 'tch2', role: 'teacher', schoolId: school.id });
    await ClassModel.updateOne({ _id: cls._id }, { $push: { teacherIds: keep._id } });
    await assignSubject(school.id, cls, subject.id, teacher.id);
    await assignSubject(school.id, cls, subject.id, keep.id);
    await RefreshToken.create({
      userId: teacher._id,
      tokenHash: 'h1',
      expiresAt: new Date(Date.now() + 1e6),
    });
    await TelegramLinkToken.create({
      userId: teacher._id,
      tokenHash: 'x',
      expiresAt: new Date(Date.now() + 1e6),
    });
    await TelegramOutbox.create({ userId: teacher._id, chatId: 77, text: 'salom', kind: 'test' });
    await User.updateOne(
      { _id: teacher._id },
      { $set: { 'telegram.chatId': 77, 'telegram.linkedAt': new Date() } },
    );
    await Photo.create({
      schoolId: school.id,
      ownerType: 'user',
      ownerId: teacher.id,
      data: Buffer.from('x'),
      contentType: 'image/webp',
      width: 1,
      height: 1,
      size: 1,
      hash: 'h',
    });

    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });

    expect(await User.findById(teacher._id)).toBeNull();
    const c = await ClassModel.findById(cls._id);
    expect(c!.homeroomTeacherId).toBeNull();
    expect(c!.teacherIds.map(String)).toEqual([keep.id]);
    expect(await ClassSubject.countDocuments({ teacherId: teacher._id })).toBe(0);
    expect(await ClassSubject.countDocuments({ teacherId: keep._id })).toBe(1);
    expect(await RefreshToken.countDocuments({ userId: teacher._id })).toBe(0);
    expect(await TelegramLinkToken.countDocuments({ userId: teacher._id })).toBe(0);
    expect(await TelegramOutbox.countDocuments({ userId: teacher._id })).toBe(0);
    expect(await Photo.countDocuments({ ownerId: teacher._id })).toBe(0);
    expect(fake.commandCalls).toContainEqual({ op: 'delete', chatId: 77 });

    const audit = await AuditLog.findOne({ action: 'teacher.delete' });
    expect(audit).toBeTruthy();
    expect(audit!.userId!.toString()).toBe(admin.id);
    expect(audit!.entityId).toBe(teacher.id);
    expect(audit!.before).toMatchObject({ fullName: teacher.fullName, username: 'tch' });
    expect(JSON.stringify(audit!.before)).not.toMatch(/passwordHash/i);
  });

  it('Telegram menyusini ochirish xato bersa ham ochiradi', async () => {
    const fake = new FakeTelegram();
    fake.install();
    await request(app).put('/api/v1/telegram/config').set(bearer(root)).send({ token: VALID_TOKEN });
    await new Promise((r) => setTimeout(r, 30));
    fake.failCommands = true;
    await User.updateOne({ _id: teacher._id }, { $set: { 'telegram.chatId': 78 } });
    expect((await del()).status).toBe(200);
    expect(await User.findById(teacher._id)).toBeNull();
  });

  it('tarixi bor bolsa 409 va hisoblar details da; hech narsa ochmaydi', async () => {
    await AuditLog.create({ userId: teacher._id, action: 'auth.login', entity: 'user' });
    const res = await del();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe(
      "O'qituvchining tarixi bor (baholar, davomat yoki dars jadvali). Uni faqat nofaol qilish mumkin.",
    );
    expect(res.body.error.details).toContainEqual({ path: 'auditActions', message: '1' });
    expect(await User.findById(teacher._id)).not.toBeNull();
    expect((await ClassModel.findById(cls._id))!.teacherIds).toHaveLength(1);
    expect(await AuditLog.countDocuments({ action: 'teacher.delete' })).toBe(0);
  });

  it('superadmin X-School-Id bilan ochira oladi', async () => {
    const res = await request(app)
      .delete(`${API}/${teacher.id}`)
      .set(bearer(root))
      .set('X-School-Id', school.id);
    expect(res.status).toBe(200);
  });

  it('boshqa maktab oqituvchisi 404 (usage va delete)', async () => {
    const foreign = await makeUser({ username: 'f1', role: 'teacher', schoolId: other.id });
    expect((await usage(adm, foreign.id)).status).toBe(404);
    expect((await del(adm, foreign.id)).status).toBe(404);
    expect(await User.findById(foreign._id)).not.toBeNull();
  });

  it('teachers.manage ruxsatisiz admin va oqituvchi 403', async () => {
    await makeUser({
      username: 'noperm',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ['dashboard.view'],
    });
    const t = (await login('noperm')).token;
    expect((await del(t)).status).toBe(403);
    expect((await usage(t)).status).toBe(403);
    const tt = (await login('tch')).token;
    expect((await del(tt)).status).toBe(403);
    expect(await User.findById(teacher._id)).not.toBeNull();
  });

  it('autentifikatsiyasiz 401; notogri id 404', async () => {
    expect((await request(app).delete(`${API}/${teacher.id}`)).status).toBe(401);
    expect((await del(adm, 'abc')).status).toBe(404);
  });

  it('ozini ochira olmaydi (actor id mos kelsa 403)', async () => {
    await expect(
      teacherDeletion.remove(
        {
          actor: {
            id: teacher.id,
            role: 'school_admin',
            permissions: [],
            schoolId: school.id,
          } as never,
        },
        school.id,
        teacher.id,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await User.findById(teacher._id)).not.toBeNull();
  });
});

describe('GET /teachers?isActive=', () => {
  it('isActive filtri ishlaydi, berilmasa hammasi', async () => {
    await makeUser({ username: 'off', role: 'teacher', schoolId: school.id, isActive: false });
    const q = (s: string) => request(app).get(`${API}${s}`).set(bearer(adm));
    expect((await q('')).body.data).toHaveLength(2);
    expect((await q('?isActive=true')).body.data).toHaveLength(1);
    const off = (await q('?isActive=false')).body.data;
    expect(off).toHaveLength(1);
    expect(off[0].username).toBe('off');
  });
});

afterAll(uninstallTelegram);
