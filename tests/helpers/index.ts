import crypto from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { createApp } from '../../src/app';
import type { Role } from '../../src/constants/roles';
import { AcademicYear } from '../../src/models/AcademicYear';
import { BehaviorType } from '../../src/models/BehaviorType';
import { Score } from '../../src/models/Score';
import { ClassSubject } from '../../src/models/ClassSubject';
import { Subject } from '../../src/models/Subject';
import { SubjectGrade } from '../../src/models/SubjectGrade';
import { Setting } from '../../src/models/Setting';
import { Rating, RatingDailyRank, RatingState } from '../../src/models/Rating';
import { publicCache } from '../../src/modules/public/public.cache';
import { clock } from '../../src/utils/clock';
import { AttendanceRecord } from '../../src/models/AttendanceRecord';
import { AttendanceStatus } from '../../src/models/AttendanceStatus';
import { AuditLog } from '../../src/models/AuditLog';
import { ClassModel } from '../../src/models/Class';
import { ImportSession } from '../../src/models/ImportSession';
import { Student } from '../../src/models/Student';
import { nameKeyOf } from '../../src/utils/text';
import { RefreshToken } from '../../src/models/RefreshToken';
import { School } from '../../src/models/School';
import { User } from '../../src/models/User';
import { hashPassword } from '../../src/utils/password';

export const app = createApp();
export const PASSWORD = 'Passw0rd1';

const ALL_MODELS: { init(): Promise<unknown>; deleteMany(f: object): PromiseLike<unknown> }[] = [
  User,
  School,
  RefreshToken,
  AuditLog,
  AcademicYear,
  ClassModel,
  Student,
  ImportSession,
  BehaviorType,
  Setting,
  Score,
  Rating,
  RatingState,
  RatingDailyRank,
  AttendanceRecord,
  AttendanceStatus,
  Subject,
  ClassSubject,
  SubjectGrade,
];

/** Har bir test fayli uchun alohida baza; har testdan oldin tozalanadi */
export function useTestDb() {
  beforeAll(async () => {
    const dbName = `test_${crypto.randomBytes(6).toString('hex')}`;
    await mongoose.connect(inject('mongoUri'), { dbName });
    await Promise.all(ALL_MODELS.map((m) => m.init()));
  });
  beforeEach(async () => {
    clock.reset();
    publicCache.clear();
    await Promise.all(ALL_MODELS.map((m) => m.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

export const makeSchool = (slug: string, extra: Record<string, unknown> = {}) =>
  School.create({ name: `Maktab ${slug}`, slug, ...extra });

export async function makeUser(opts: {
  username: string;
  role: Role;
  schoolId?: string | null;
  permissions?: string[];
  password?: string;
  isActive?: boolean;
}) {
  return User.create({
    username: opts.username,
    fullName: `Test ${opts.username}`,
    role: opts.role,
    schoolId: opts.schoolId ?? null,
    permissions: opts.permissions ?? [],
    isActive: opts.isActive ?? true,
    passwordHash: await hashPassword(opts.password ?? PASSWORD),
  });
}

export async function login(username: string, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ username, password });
  return {
    res,
    token: res.body?.data?.accessToken as string,
    cookies: (res.headers['set-cookie'] ?? []) as unknown as string[],
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** "refreshToken=xxx; Path=..." qatoridan faqat name=value qismini oladi */
export const cookieValue = (cookies: string[]) =>
  cookies.find((c) => c.startsWith('refreshToken='))?.split(';')[0] ?? '';

export const makeYear = (schoolId: string, name = '2026-2027', isActive = true) =>
  AcademicYear.create({
    schoolId,
    name,
    isActive,
    startDate: new Date('2026-09-01'),
    endDate: new Date('2027-06-01'),
  });

export const makeClass = (
  schoolId: string,
  academicYearId: string,
  name: string,
  teacherIds: string[] = [],
  extra: Record<string, unknown> = {},
) =>
  ClassModel.create({
    schoolId,
    academicYearId,
    name,
    grade: Number.parseInt(name, 10) || 1,
    teacherIds,
    ...extra,
  });

export const makeStudent = (
  schoolId: string,
  classId: string,
  fullName: string,
  extra: Record<string, unknown> = {},
) =>
  Student.create({
    schoolId,
    classId,
    fullName,
    nameKey: nameKeyOf(fullName),
    classHistory: [{ classId, from: new Date(), to: null }],
    ...extra,
  });

export const makeBehaviorType = (
  name: string,
  kind: 'positive' | 'negative' | 'neutral' = 'positive',
  extra: Record<string, unknown> = {},
) =>
  BehaviorType.create({
    schoolId: null,
    name,
    nameKey: nameKeyOf(name),
    kind,
    color: '#16A34A',
    order: 1,
    ...extra,
  });

export { Score };

export const makeSubject = (
  name: string,
  schoolId: string | null = null,
  extra: Record<string, unknown> = {},
) => Subject.create({ schoolId, name, nameKey: nameKeyOf(name), order: 1, ...extra });

export const assignSubject = (
  schoolId: string,
  cls: {
    id: string;
    academicYearId: mongoose.Types.ObjectId;
    updateOne: (u: object) => PromiseLike<unknown>;
  },
  subjectId: string,
  teacherId: string,
) =>
  Promise.all([
    ClassSubject.create({
      schoolId,
      classId: cls.id,
      subjectId,
      teacherId,
      academicYearId: cls.academicYearId,
    }),
    cls.updateOne({ $addToSet: { teacherIds: teacherId } }),
  ]);

export { SubjectGrade };

export const ADMIN_PERMS = [
  'classes.manage',
  'students.view',
  'students.manage',
  'teachers.manage',
  'dashboard.view',
];

export const makeStatus = (
  name: string,
  category: 'present' | 'late' | 'absent_excused' | 'absent_unexcused' = 'present',
  extra: Record<string, unknown> = {},
) =>
  AttendanceStatus.create({
    schoolId: null,
    name,
    nameKey: nameKeyOf(name),
    shortName: name.slice(0, 2),
    color: '#16A34A',
    category,
    ...extra,
  });

export { AttendanceRecord };
