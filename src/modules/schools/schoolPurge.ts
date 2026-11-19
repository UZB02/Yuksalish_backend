import { Types, type Model } from 'mongoose';
import { AcademicYear } from '../../models/AcademicYear';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { AttendanceStatus } from '../../models/AttendanceStatus';
import { AuditLog } from '../../models/AuditLog';
import { BehaviorType } from '../../models/BehaviorType';
import { BrandingAsset } from '../../models/BrandingAsset';
import { ClassModel } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { ExamAsset } from '../../models/ExamAsset';
import { ExamAttempt } from '../../models/ExamAttempt';
import { ExamEntryCode } from '../../models/ExamEntryCode';
import { ExamCandidate } from '../../models/ExamCandidate';
import { ExamImportSession } from '../../models/ExamImportSession';
import { ExamSession } from '../../models/ExamSession';
import { ExamTemplate } from '../../models/ExamTemplate';
import { ExamTopic } from '../../models/ExamTopic';
import { ImportSession } from '../../models/ImportSession';
import { LessonOverride } from '../../models/LessonOverride';
import { PasswordResetCode } from '../../models/PasswordResetCode';
import { Photo } from '../../models/Photo';
import { Question } from '../../models/Question';
import { Rating, RatingDailyRank, RatingState } from '../../models/Rating';
import { RatingResult } from '../../models/RatingResult';
import { RefreshToken } from '../../models/RefreshToken';
import { Score } from '../../models/Score';
import { Setting } from '../../models/Setting';
import { Student } from '../../models/Student';
import { Subject } from '../../models/Subject';
import { SubjectGrade } from '../../models/SubjectGrade';
import { TelegramLinkToken } from '../../models/TelegramLinkToken';
import { TelegramOutbox } from '../../models/TelegramOutbox';
import { TimetableVersion } from '../../models/TimetableVersion';
import { User } from '../../models/User';

/**
 * MAKTABNI BUTUNLAY O'CHIRISH: o'chiriladigan kolleksiyalar ro'yxati (yagona manba).
 *
 * Qoidalar:
 *  - Har bir yozuv `scope` bo'yicha qat'iy filtrga ega: 'school' = filtr `schoolId` ni o'z ichiga oladi,
 *    'users' = filtr faqat shu maktab foydalanuvchilarining aniq `userId` ro'yxati ($in) bilan cheklanadi.
 *    Bo'sh/umumiy filtr hech qachon bajarilmaydi (`assertSafeFilter`).
 *  - Global yozuvlar (schoolId=null: fan, xulq turi, davomat holati, global sozlama, platforma brendi,
 *    Telegram bot konfiguratsiyasi) filtrga TUSHMAYDI, chunki filtr aniq schoolId'ga teng.
 *  - Tartib muhim: farzand yozuvlar -> foydalanuvchiga bog'liq yozuvlar -> foydalanuvchilar. `School`
 *    hujjati bu ro'yxatda EMAS: u eng OXIRIDA (`schools.delete.ts`) o'chiriladi.
 *  - Yangi model (schoolId yoki userId yo'li bilan) qo'shilsa, `tests/school-purge.test.ts`
 *    (registry completeness) shu ro'yxatga qo'shilmaguncha YIQILADI.
 */
export interface PurgeCtx {
  schoolId: Types.ObjectId;
  /** Shu maktabning superadmin bo'lmagan foydalanuvchilari (o'chirish boshida aniqlanadi) */
  userIds: Types.ObjectId[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<any>;

export interface PurgeStep {
  key: string;
  /** Preview/hisobot uchun o'zbekcha nom */
  label: string;
  model: AnyModel;
  scope: 'school' | 'users';
  filter: (ctx: PurgeCtx) => Record<string, unknown>;
}

const bySchool = (
  key: string,
  label: string,
  model: AnyModel,
  extra: Record<string, unknown> = {},
): PurgeStep => ({
  key,
  label,
  model,
  scope: 'school',
  filter: (c) => ({ ...extra, schoolId: c.schoolId }),
});

const byUsers = (key: string, label: string, model: AnyModel): PurgeStep => ({
  key,
  label,
  model,
  scope: 'users',
  filter: (c) => ({ userId: { $in: c.userIds } }),
});

/** O'chirish tartibi (yuqoridan pastga) */
export const SCHOOL_PURGE_STEPS: PurgeStep[] = [
  // Imtihon moduli
  bySchool('questions', 'Imtihon savollari', Question),
  bySchool('examTopics', 'Imtihon mavzulari', ExamTopic),
  bySchool('examAssets', 'Imtihon rasmlari', ExamAsset),
  bySchool('examImportSessions', 'Imtihon import sessiyalari', ExamImportSession),
  bySchool('examAttempts', 'Imtihon urinishlari (javoblar, hodisalar)', ExamAttempt),
  bySchool('examEntryCodes', 'Imtihon shaxsiy kirish kodlari', ExamEntryCode),
  bySchool('examSessions', 'Imtihon sessiyalari (PIN, savollar nusxasi)', ExamSession),
  bySchool('examTemplates', 'Imtihon shablonlari', ExamTemplate),
  bySchool('examCandidates', 'Imtihon nomzodlari', ExamCandidate),
  // Baholash va davomat
  bySchool('subjectGrades', 'Fan baholari', SubjectGrade),
  bySchool('scores', 'Xulq baholari', Score),
  bySchool('attendanceRecords', 'Davomat yozuvlari', AttendanceRecord),
  // Dars jadvali va fan kurslari
  bySchool('lessonOverrides', "Bir martalik dars o'zgarishlari", LessonOverride),
  bySchool('timetableVersions', 'Dars jadvali versiyalari', TimetableVersion),
  bySchool('classSubjects', "Sinf-fan-o'qituvchi kurslari", ClassSubject),
  // Reyting
  bySchool('ratingResults', 'Reyting natijalari arxivi', RatingResult),
  bySchool('ratingDailyRanks', "Reyting kunlik o'rinlari", RatingDailyRank),
  bySchool('ratings', 'Reyting snapshotlari', Rating),
  bySchool('ratingStates', 'Reyting holati', RatingState),
  // Fayllar va import
  bySchool('photos', "Rasmlar (o'quvchi/o'qituvchi)", Photo),
  bySchool('importSessions', 'Import sessiyalari', ImportSession),
  // Akademik tuzilma
  bySchool('students', "O'quvchilar", Student),
  bySchool('classes', 'Sinflar', ClassModel),
  bySchool('academicYears', "O'quv yillari", AcademicYear),
  // Maktabga xos ma'lumotnomalar (global, schoolId=null yozuvlarga TEGMAYDI)
  bySchool('subjects', 'Maktab fanlari', Subject),
  bySchool('behaviorTypes', 'Maktab xulq turlari', BehaviorType),
  bySchool('attendanceStatuses', 'Maktab davomat holatlari', AttendanceStatus),
  // Sozlamalar va brend
  bySchool('settings', 'Maktab sozlamalari (override)', Setting, { scope: 'school' }),
  bySchool('brandingAssets', 'Maktab logosi/brendi', BrandingAsset, { ownerType: 'school' }),
  // Audit: maktabning o'z yozuvlari. Global `school.delete*` yozuvlari schoolId=null, shuning uchun saqlanadi
  bySchool('auditLogs', 'Audit yozuvlari', AuditLog),
  // Foydalanuvchiga bog'liq (schoolId yo'q): foydalanuvchilar O'CHIRILMASDAN OLDIN
  byUsers('refreshTokens', 'Sessiyalar (refresh tokenlar)', RefreshToken),
  byUsers('passwordResetCodes', 'Parol tiklash kodlari', PasswordResetCode),
  byUsers('telegramLinkTokens', 'Telegram ulash tokenlari', TelegramLinkToken),
  byUsers('telegramOutbox', 'Telegram xabarlar navbati', TelegramOutbox),
  // Foydalanuvchilar (maktab adminlari va o'qituvchilar). Superadmin HECH QACHON o'chirilmaydi
  bySchool('users', "Foydalanuvchilar (maktab adminlari va o'qituvchilar)", User, {
    role: { $ne: 'superadmin' },
  }),
];

/**
 * Parallel jarayon (reyting hisobi, xabar yuborish) tufayli qayta paydo bo'lishi mumkin bo'lgan yozuvlar:
 * maktab hujjati o'chirilgach oxirida yana bir marta tozalanadi.
 */
export const SWEEP_KEYS = [
  'ratingDailyRanks',
  'ratings',
  'ratingStates',
  'telegramOutbox',
  'refreshTokens',
] as const;

/**
 * Ro'yxatga kirmaydigan modellar (sababi bilan). `School` ro'yxatda emas: u eng oxirida alohida o'chiriladi.
 * TelegramBotConfig: platforma darajasida yagona hujjat, maktabga bog'lanmagan.
 */
export const PURGE_EXEMPT: Record<string, string> = {
  School: "O'chirish ketma-ketligining eng OXIRGI qadami (schools.delete.ts)",
  TelegramBotConfig: "Platforma darajasida yagona hujjat (maktabga bog'lanmagan)",
  ExamJoinGuard:
    "Imtihonga kirishdagi noto'g'ri urinishlar hisoblagichi: maktabga bog'lanmagan (kod/IP kaliti), TTL bilan o'zi o'chadi",
};

/** Filtr aniq shu maktabga (yoki aniq foydalanuvchi id'lariga) bog'langanini tekshiradi. Aks holda XATO */
export function assertSafeFilter(
  step: PurgeStep,
  filter: Record<string, unknown>,
  ctx: PurgeCtx,
): void {
  const fail = (why: string) =>
    new Error(`Xavfsiz bo'lmagan o'chirish filtri (${step.key}): ${why}`);
  if (!filter || Object.keys(filter).length === 0) throw fail("bo'sh filtr");
  if (step.scope === 'school') {
    const sid = filter.schoolId;
    if (!(sid instanceof Types.ObjectId) || !sid.equals(ctx.schoolId)) throw fail("schoolId yo'q");
    return;
  }
  const ids = (filter.userId as { $in?: unknown } | undefined)?.$in;
  if (!Array.isArray(ids) || ids.length === 0) throw fail("userId ro'yxati bo'sh");
  const allowed = new Set(ctx.userIds.map(String));
  if (!ids.every((i) => allowed.has(String(i)))) throw fail('begona userId');
}

function safeFilter(step: PurgeStep, ctx: PurgeCtx): Record<string, unknown> | null {
  // Foydalanuvchisiz 'users' bosqichi hech narsa o'chirmaydi (bo'sh $in ro'yxat bilan so'rov yubormaymiz)
  if (step.scope === 'users' && ctx.userIds.length === 0) return null;
  const filter = step.filter(ctx);
  assertSafeFilter(step, filter, ctx);
  return filter;
}

export async function countStep(step: PurgeStep, ctx: PurgeCtx): Promise<number> {
  const f = safeFilter(step, ctx);
  return f ? step.model.countDocuments(f) : 0;
}

export async function purgeStep(step: PurgeStep, ctx: PurgeCtx): Promise<number> {
  const f = safeFilter(step, ctx);
  if (!f) return 0;
  const res = await step.model.deleteMany(f);
  return res.deletedCount ?? 0;
}
