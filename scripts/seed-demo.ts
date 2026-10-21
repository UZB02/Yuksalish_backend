import { Types } from 'mongoose';
import { connectDb, disconnectDb, ensureIndexes } from '../src/config/db';
import { logger } from '../src/core/logger';
import { AcademicYear } from '../src/models/AcademicYear';
import { ClassModel } from '../src/models/Class';
import { BehaviorType } from '../src/models/BehaviorType';
import { Rating, RatingDailyRank, RatingState } from '../src/models/Rating';
import { AttendanceRecord } from '../src/models/AttendanceRecord';
import { AttendanceStatus } from '../src/models/AttendanceStatus';
import { ensureDefaultAttendanceStatuses } from '../src/modules/attendance-statuses/attendance-statuses.defaults';
import { isoWeekday } from '../src/utils/dates';
import { AuditLog } from '../src/models/AuditLog';
import { Score } from '../src/models/Score';
import { Setting } from '../src/models/Setting';
import { recalculateAll } from '../src/modules/ratings/ratings.service';
import { ensureDefaultBehaviorTypes } from '../src/modules/behavior-types/behavior-types.defaults';
import { addDaysStr, todayTashkent } from '../src/utils/clock';
import { School } from '../src/models/School';
import { Student } from '../src/models/Student';
import { User } from '../src/models/User';
import { hashPassword } from '../src/utils/password';
import { nameKeyOf } from '../src/utils/text';

// Demo ma'lumot: 1 maktab, o'quv yili, 3 sinf, ~30 o'quvchi, 2 o'qituvchi (qayta ishga tushirsa dublikat qilmaydi)
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo12345';

const MALE = [
  'Ali',
  'Vali',
  'Hasan',
  'Husan',
  'Bobur',
  'Javohir',
  'Sardor',
  'Aziz',
  'Otabek',
  'Jasur',
  'Dilshod',
  'Sherzod',
];
const FEMALE = [
  'Dilnoza',
  'Madina',
  'Zilola',
  'Malika',
  'Nilufar',
  'Sevara',
  'Gulnora',
  'Lola',
  'Shahnoza',
  'Kamola',
  'Nodira',
  'Feruza',
];
const SURNAMES = [
  'Karimov',
  'Aliyev',
  'Valiyev',
  'Rahimov',
  'Tursunov',
  'Yusupov',
  'Abdullayev',
  'Ergashev',
  'Sodiqov',
  'Ismoilov',
];

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Oxirgi 14 kun uchun deterministik baholar (~70% o'quvchilar har kuni) */
async function seedScores(schoolId: string, yearId: string) {
  await Score.init();
  await BehaviorType.init();
  await ensureDefaultBehaviorTypes();
  const types = await BehaviorType.find({ schoolId: null });
  const byName = (n: string) => types.find((t) => t.name === n)?._id ?? null;
  const classes = await ClassModel.find({ schoolId });
  const rand = rng(20261014);
  const today = todayTashkent();
  const docs = [];
  for (const cls of classes) {
    const teacherId = cls.teacherIds[0];
    if (!teacherId) continue;
    const students = await Student.find({ schoolId, classId: cls._id, isDeleted: false });
    for (const st of students) {
      const base = 62 + Math.floor(rand() * 34); // o'quvchining o'rtacha darajasi
      for (let i = 13; i >= 0; i--) {
        if (rand() > 0.7) continue;
        const value = Math.max(40, Math.min(100, base + Math.round((rand() - 0.5) * 20)));
        const typeId =
          value >= 85
            ? byName('Namunali xulq')
            : value >= 70
              ? byName('Oddiy kun')
              : byName(rand() > 0.5 ? 'Darsga kechikish' : 'Dars paytida bezovtalik');
        docs.push({
          schoolId,
          studentId: st._id,
          classId: cls._id,
          teacherId,
          academicYearId: yearId,
          behaviorTypeId: typeId,
          value,
          comment: value < 60 ? 'Suhbat otkazildi' : null,
          date: addDaysStr(today, -i),
        });
      }
    }
  }
  await Score.insertMany(docs);
  logger.info(`Demo baholar: ${docs.length} ta (oxirgi 14 kun)`);
}

async function seedFirstSchool() {
  const existing = await School.findOne({ slug: 'demo-maktab' });
  if (existing) {
    const year = await AcademicYear.findOne({ schoolId: existing._id, isActive: true });
    if (year && !(await Score.exists({ schoolId: existing._id })))
      await seedScores(existing.id, year.id);
    else logger.info("Demo maktab allaqachon mavjud — o'tkazib yuborildi");
    return;
  }
  const school = await School.create({
    name: 'Demo maktab',
    slug: 'demo-maktab',
    address: 'Toshkent sh.',
    phone: '+998901234567',
  });
  const year = await AcademicYear.create({
    schoolId: school._id,
    name: '2026-2027',
    startDate: new Date('2026-09-01'),
    endDate: new Date('2027-05-31'),
    isActive: true,
    periods: [
      { name: '1-chorak', startDate: new Date('2026-09-01'), endDate: new Date('2026-10-31') },
      { name: '2-chorak', startDate: new Date('2026-11-03'), endDate: new Date('2026-12-30') },
      { name: '3-chorak', startDate: new Date('2027-01-10'), endDate: new Date('2027-03-20') },
      { name: '4-chorak', startDate: new Date('2027-03-29'), endDate: new Date('2027-05-31') },
    ],
  });

  const passwordHash = await hashPassword(PASSWORD);
  const teachers = await User.create([
    {
      schoolId: school._id,
      role: 'teacher',
      fullName: 'Rustamov Anvar',
      username: 'demo.teacher1',
      passwordHash,
      permissions: [
        'students.view',
        'dashboard.view',
        'reports.view',
        'reports.export',
        'attendance.view',
      ],
    },
    {
      schoolId: school._id,
      role: 'teacher',
      fullName: 'Saidova Gulbahor',
      username: 'demo.teacher2',
      passwordHash,
      permissions: ['students.view'],
    },
  ]);
  await User.create({
    schoolId: school._id,
    role: 'school_admin',
    fullName: 'Demo Administrator',
    username: 'demo.admin',
    passwordHash,
    permissions: [
      'dashboard.view',
      'classes.manage',
      'students.view',
      'students.manage',
      'teachers.manage',
      'reports.view',
      'reports.export',
      'audit.view',
      'attendance.view',
      'attendance.settings',
    ],
  });

  const classDefs = [
    { name: '5-A', grade: 5, section: 'A', teacher: teachers[0] },
    { name: '6-B', grade: 6, section: 'B', teacher: teachers[1] },
    { name: '7-A', grade: 7, section: 'A', teacher: teachers[0] },
  ];
  let n = 0;
  for (const def of classDefs) {
    const cls = await ClassModel.create({
      schoolId: school._id,
      academicYearId: year._id,
      name: def.name,
      grade: def.grade,
      section: def.section,
      homeroomTeacherId: def.teacher._id,
      teacherIds: [def.teacher._id],
    });
    const students = Array.from({ length: 10 }, (_, i) => {
      const male = i % 2 === 0;
      const first = (male ? MALE : FEMALE)[(n + i) % 12];
      const fullName = `${SURNAMES[(n * 3 + i) % SURNAMES.length]} ${first}`;
      n++;
      return {
        schoolId: school._id,
        classId: cls._id,
        fullName,
        nameKey: nameKeyOf(fullName),
        studentCode: `D-${1000 + n}`,
        gender: male ? 'male' : 'female',
        birthDate: new Date(Date.UTC(2026 - 6 - def.grade - 5, i % 12, 1 + i)),
        parentPhone: `+99890${String(1000000 + n * 137).slice(0, 7)}`,
        classHistory: [{ classId: cls._id, from: new Date(), to: null }],
      };
    });
    await Student.insertMany(students);
  }

  await seedScores(school.id, year.id);
  logger.info(`Demo tayyor. Maktab: demo-maktab (id: ${school.id}), o'quvchilar: ${n}`);
  logger.info(
    `Loginlar (parol: ${PASSWORD}): demo.admin (maktab admini), demo.teacher1, demo.teacher2 (o'qituvchilar)`,
  );
}

async function seedSecondSchool() {
  if (await School.exists({ slug: 'demo-maktab-2' })) {
    logger.info("Ikkinchi demo maktab allaqachon mavjud — o'tkazib yuborildi");
    return;
  }
  const school = await School.create({
    name: 'Demo maktab 2',
    slug: 'demo-maktab-2',
    address: 'Samarqand sh.',
  });
  const year = await AcademicYear.create({
    schoolId: school._id,
    name: '2026-2027',
    startDate: new Date('2026-09-01'),
    endDate: new Date('2027-05-31'),
    isActive: true,
    periods: [
      { name: '1-chorak', startDate: new Date('2026-09-01'), endDate: new Date('2026-10-31') },
    ],
  });
  const passwordHash = await hashPassword(PASSWORD);
  const teacher = await User.create({
    schoolId: school._id,
    role: 'teacher',
    fullName: 'Karimova Nodira',
    username: 'demo2.teacher1',
    passwordHash,
    permissions: ['students.view'],
  });
  await User.create({
    schoolId: school._id,
    role: 'school_admin',
    fullName: 'Demo 2 Administrator',
    username: 'demo2.admin',
    passwordHash,
    permissions: [
      'dashboard.view',
      'classes.manage',
      'students.view',
      'students.manage',
      'teachers.manage',
      'reports.view',
      'reports.export',
    ],
  });
  let n = 0;
  for (const def of [
    { name: '5-B', grade: 5 },
    { name: '6-A', grade: 6 },
  ]) {
    const cls = await ClassModel.create({
      schoolId: school._id,
      academicYearId: year._id,
      name: def.name,
      grade: def.grade,
      homeroomTeacherId: teacher._id,
      teacherIds: [teacher._id],
    });
    const students = Array.from({ length: 10 }, (_, i) => {
      const male = i % 2 === 1;
      const fullName = `${SURNAMES[(n * 7 + i) % SURNAMES.length]} ${(male ? MALE : FEMALE)[(n + i * 5) % 12]}`;
      n++;
      return {
        schoolId: school._id,
        classId: cls._id,
        fullName,
        nameKey: nameKeyOf(fullName),
        studentCode: `E-${2000 + n}`,
        gender: male ? 'male' : 'female',
        classHistory: [{ classId: cls._id, from: new Date(), to: null }],
      };
    });
    await Student.insertMany(students);
  }
  await seedScores(school.id, year.id);
  logger.info(`Ikkinchi demo maktab tayyor: demo-maktab-2, o'quvchilar: ${n}`);
  logger.info(`Loginlar (parol: ${PASSWORD}): demo2.admin, demo2.teacher1`);
}

/** Ochiq reyting: ikkala demo maktab yoqiladi va umumiy reyting platformada yoqiladi (mavjud sozlamaga tegmaydi) */
/**
 * Oxirgi 14 kun ish kunlari uchun deterministik davomat (bugun olinmagan qoldiriladi).
 * demo-maktab — kunlik rejim; demo-maktab-2 — dars rejimi (4 dars), oxirgi bir necha kun.
 * ~92% keldi, ~4% kechikdi, ~2% sababli, ~2% sababsiz.
 */
async function seedAttendance() {
  await AttendanceRecord.init();
  await AttendanceStatus.init();
  await ensureDefaultAttendanceStatuses();
  const statuses = await AttendanceStatus.find({ schoolId: null });
  const idOf = (cat: string) => statuses.find((s) => s.category === cat)?._id;
  const rand = rng(20261017);
  const today = todayTashkent();

  const second = await School.findOne({ slug: 'demo-maktab-2' });
  if (second) {
    await Setting.updateOne(
      { scope: 'school', schoolId: second._id, key: 'attendance' },
      { $setOnInsert: { value: { mode: 'lesson', lessonsPerDay: 4 } } },
      { upsert: true },
    );
  }

  for (const slug of ['demo-maktab', 'demo-maktab-2']) {
    const school = await School.findOne({ slug });
    if (!school || (await AttendanceRecord.exists({ schoolId: school._id }))) continue;
    const year = await AcademicYear.findOne({ schoolId: school._id, isActive: true });
    if (!year) continue;
    const lesson = slug === 'demo-maktab-2';
    const days: string[] = [];
    for (let i = 13; i >= 1; i--) {
      const d = addDaysStr(today, -i);
      if (isoWeekday(d) <= 6) days.push(d);
    }
    const useDays = lesson ? days.slice(-5) : days;
    const units = lesson ? [1, 2, 3, 4] : [0];

    const docs = [];
    for (const cls of await ClassModel.find({ schoolId: school._id })) {
      const teacherId = cls.teacherIds[0];
      if (!teacherId) continue;
      const students = await Student.find({
        schoolId: school._id,
        classId: cls._id,
        isDeleted: false,
      });
      for (const date of useDays) {
        for (const lessonNo of units) {
          for (const st of students) {
            const r = rand();
            const category =
              r < 0.92
                ? 'present'
                : r < 0.96
                  ? 'late'
                  : r < 0.98
                    ? 'absent_excused'
                    : 'absent_unexcused';
            docs.push({
              schoolId: school._id,
              studentId: st._id,
              classId: cls._id,
              academicYearId: year._id,
              date,
              lessonNo,
              statusId: idOf(category),
              category,
              minutesLate: category === 'late' ? 5 + Math.floor(rand() * 16) : null,
              note: category === 'absent_excused' ? 'Kasallik' : null,
              markedBy: teacherId,
              updatedBy: teacherId,
            });
          }
        }
      }
    }
    for (let i = 0; i < docs.length; i += 5000)
      await AttendanceRecord.insertMany(docs.slice(i, i + 5000));
    logger.info(
      `Demo davomat (${slug}, ${lesson ? 'dars' : 'kunlik'} rejim): ${docs.length} ta yozuv`,
    );
  }
}

/** Audit log namunalari (login, settings.update, scores.bulk, ...). Idempotent: ip='seed-demo' belgisi bo'yicha. */
async function seedAudit() {
  await AuditLog.init();
  if (await AuditLog.exists({ ip: 'seed-demo' })) return;
  const school = await School.findOne({ slug: 'demo-maktab' });
  const admin = await User.findOne({ username: 'demo.admin' });
  const teacher = await User.findOne({ username: 'demo.teacher1' });
  if (!school || !admin || !teacher) return;
  const day = (n: number, h: number) =>
    new Date(`${addDaysStr(todayTashkent(), -n)}T${String(h).padStart(2, '0')}:00:00+05:00`);
  const e = (
    userId: unknown,
    action: string,
    entity: string,
    at: Date,
    extra: Record<string, unknown> = {},
  ) => ({
    userId,
    schoolId: school._id,
    action,
    entity,
    entityId: null,
    before: null,
    after: null,
    ip: 'seed-demo',
    createdAt: at,
    ...extra,
  });
  await AuditLog.collection.insertMany([
    e(admin._id, 'auth.login', 'user', day(3, 8), { entityId: String(admin._id) }),
    e(teacher._id, 'auth.login', 'user', day(3, 8)),
    e(admin._id, 'settings.update', 'settings', day(2, 9), {
      entityId: 'scoring',
      before: { scope: 'school', values: null },
      after: { scope: 'school', values: { editWindowHours: 48 } },
    }),
    e(teacher._id, 'scores.bulk', 'score', day(2, 11), {
      after: { created: 10, updated: 0, failed: 0, items: 10 },
    }),
    e(teacher._id, 'attendance.bulk', 'attendance', day(1, 8), {
      after: { created: 10, updated: 0, failed: 0, items: 10 },
    }),
    e(admin._id, 'reports.export', 'report', day(1, 15), {
      entityId: 'class',
      after: { type: 'class', format: 'pdf', rowCount: 12 },
    }),
    e(admin._id, 'teacher.permissions', 'user', day(0, 9), {
      before: { permissions: [] },
      after: { permissions: ['reports.view'] },
    }),
  ]);
  logger.info('Demo audit yozuvlari: 7 ta');
}

async function enablePublicAndRatings() {
  await Setting.init();
  const put = (
    scope: 'global' | 'school',
    schoolId: Types.ObjectId | null,
    key: string,
    value: object,
  ) => Setting.updateOne({ scope, schoolId, key }, { $setOnInsert: { value } }, { upsert: true });
  for (const slug of ['demo-maktab', 'demo-maktab-2']) {
    const sc = await School.findOne({ slug });
    if (sc)
      await put('school', sc._id, 'public', {
        enabled: true,
        showScope: 'global',
        includeInGlobal: true,
      });
  }
  await put('global', null, 'public', { globalRatingEnabled: true });
  await put('global', null, 'rating', { minScoresCount: 2 });
  await Rating.init();
  await RatingState.init();
  await RatingDailyRank.init();
  await recalculateAll();
  logger.info(
    'Ochiq reyting yoqildi: /api/v1/public/demo-maktab/config va /api/v1/public/global/rating',
  );
}

async function main() {
  await connectDb(undefined, { autoIndex: false, maxPoolSize: 1 });
  await ensureIndexes();
  await Promise.all([
    School.init(),
    User.init(),
    AcademicYear.init(),
    ClassModel.init(),
    Student.init(),
  ]);
  await seedFirstSchool();
  await seedSecondSchool();
  await seedAttendance();
  await seedAudit();
  await enablePublicAndRatings();
}

main()
  .catch((err) => {
    logger.error({ err }, 'Demo seed bajarilmadi');
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
