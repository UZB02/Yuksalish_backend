import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import { AuditLog } from '../../models/AuditLog';
import { School, type SchoolDoc } from '../../models/School';
import { User } from '../../models/User';
import { isId } from '../../utils/helpers';
import { authService } from '../auth/auth.service';
import { publicCache } from '../public/public.cache';
import { ratingEvents } from '../ratings/ratings.events';
import { clearChatCommands } from '../telegram/telegram.commands';
import { SCHOOL_PURGE_STEPS, SWEEP_KEYS, countStep, purgeStep, type PurgeCtx } from './schoolPurge';

/** Parolni noto'g'ri kiritish chegarasi: foydalanuvchi bo'yicha, oyna ichida */
export const DELETE_MAX_ATTEMPTS = 5;
export const DELETE_ATTEMPT_WINDOW_MS = 15 * 60_000;

const attempts = new Map<string, { count: number; resetAt: number }>();
/** Bir vaqtda bitta maktab uchun bitta o'chirish (bitta instansiya taxmini) */
const inFlight = new Set<string>();

/** Testlar uchun */
export const resetSchoolDeleteState = () => {
  attempts.clear();
  inFlight.clear();
};

function assertNotThrottled(userId: string) {
  const a = attempts.get(userId);
  if (a && a.resetAt > Date.now() && a.count >= DELETE_MAX_ATTEMPTS) {
    const mins = Math.ceil((a.resetAt - Date.now()) / 60_000);
    throw AppError.rateLimited(
      `Parol urinishlari juda ko'p. ${mins} daqiqadan so'ng qayta urinib ko'ring`,
    );
  }
}
function registerAttemptFailure(userId: string) {
  const now = Date.now();
  const a = attempts.get(userId);
  if (!a || a.resetAt <= now)
    attempts.set(userId, { count: 1, resetAt: now + DELETE_ATTEMPT_WINDOW_MS });
  else a.count += 1;
}

async function findSchool(id: string): Promise<SchoolDoc> {
  const school = isId(id) ? await School.findById(id) : null;
  if (!school) throw AppError.notFound('Maktab topilmadi');
  return school;
}

async function buildCtx(school: SchoolDoc): Promise<PurgeCtx> {
  const users = await User.find({ schoolId: school._id, role: { $ne: 'superadmin' } })
    .select('_id')
    .lean();
  return { schoolId: school._id, userIds: users.map((u) => u._id) };
}

export interface DeletePreview {
  school: { id: string; name: string; slug: string; isActive: boolean; deletingAt: Date | null };
  items: { key: string; label: string; count: number }[];
  total: number;
  users: { teachers: number; schoolAdmins: number };
  /** Shu maktabga bog'langan superadminlar (o'chirilmaydi; bo'lmasligi kerak) */
  superadminsSkipped: number;
}

/** O'chiriladigan hujjatlar soni (o'chirishdagi xuddi shu ro'yxat va filtrlar bilan) */
async function computeCounts(ctx: PurgeCtx) {
  const items: DeletePreview['items'] = [];
  for (const step of SCHOOL_PURGE_STEPS) {
    items.push({ key: step.key, label: step.label, count: await countStep(step, ctx) });
  }
  return items;
}

async function preview(id: string): Promise<DeletePreview> {
  const school = await findSchool(id);
  const ctx = await buildCtx(school);
  const [items, teachers, schoolAdmins, superadminsSkipped] = await Promise.all([
    computeCounts(ctx),
    User.countDocuments({ schoolId: school._id, role: 'teacher' }),
    User.countDocuments({ schoolId: school._id, role: 'school_admin' }),
    User.countDocuments({ schoolId: school._id, role: 'superadmin' }),
  ]);
  return {
    school: {
      id: school.id,
      name: school.name,
      slug: school.slug,
      isActive: school.isActive,
      deletingAt: school.deletingAt ?? null,
    },
    items,
    total: items.reduce((s, i) => s + i.count, 0),
    users: { teachers, schoolAdmins },
    superadminsSkipped,
  };
}

/** Superadmin o'z parolini kiritadi; noto'g'ri bo'lsa 400 INVALID_PASSWORD (401 EMAS), urinishlar cheklangan */
async function verifyActorPassword(ctx: Ctx, password: string): Promise<void> {
  assertNotThrottled(ctx.actor.id);
  const actor = await User.findById(ctx.actor.id).select('+passwordHash');
  if (!actor || actor.role !== 'superadmin') throw AppError.forbidden();
  try {
    // Mavjud tekshiruv: bcrypt.compare + login bilan bir xil bloklash hisobi (xato -> failedLoginCount)
    await authService.verifyCurrentPassword(actor, password, ctx.ip);
  } catch (e) {
    if (e instanceof AppError && e.code === 'VALIDATION_ERROR') {
      registerAttemptFailure(actor.id);
      throw AppError.invalidPassword();
    }
    throw e;
  }
  attempts.delete(actor.id);
}

const startAudit = (ctx: Ctx, school: SchoolDoc, action: string, after: Record<string, unknown>) =>
  // Muhim amal: audit yozilmasa o'chirish BOSHLANMAYDI (auditService.log xatoni yutadi, shuning uchun to'g'ridan-to'g'ri)
  AuditLog.create({
    userId: new Types.ObjectId(ctx.actor.id),
    schoolId: null,
    action,
    entity: 'school',
    entityId: school.id,
    before: null,
    after,
    ip: ctx.ip ?? null,
  });

export interface DeleteInput {
  confirmName: string;
  password: string;
  acknowledge: true;
}

export interface DeleteResult {
  deleted: true;
  school: { id: string; name: string };
  counts: Record<string, number>;
  total: number;
  resumed: boolean;
  superadminsRepaired: number;
}

async function remove(ctx: Ctx, id: string, input: DeleteInput): Promise<DeleteResult> {
  const school = await findSchool(id);

  if (school.isActive) throw AppError.conflict('Avval maktabni nofaol qiling');
  if (input.confirmName.trim() !== school.name.trim()) {
    throw AppError.validation('Maktab nomi mos kelmadi', [
      { path: 'confirmName', message: 'Maktab nomini aynan kiriting' },
    ]);
  }
  await verifyActorPassword(ctx, input.password);

  const sid = school.id as string;
  if (inFlight.has(sid)) throw AppError.conflict("Bu maktabni o'chirish allaqachon davom etmoqda");
  inFlight.add(sid);
  try {
    return await run(ctx, school);
  } finally {
    inFlight.delete(sid);
  }
}

async function run(ctx: Ctx, school: SchoolDoc): Promise<DeleteResult> {
  const sid = school.id as string;
  const resumed = !!school.deletingAt;

  // 1) Belgi: maktab "yo'q" hisoblanadi (reaktivatsiya taqiqlanadi, reyting hisoblari o'tkazib yuboriladi)
  if (!resumed) {
    school.deletingAt = new Date();
    await School.updateOne(
      { _id: school._id, deletingAt: null },
      { $set: { deletingAt: school.deletingAt } },
    );
  }
  ratingEvents.cancel(sid);
  publicCache.clear();

  const pctx = await buildCtx(school);
  const before = await computeCounts(pctx);
  const beforeCounts = Object.fromEntries(before.map((i) => [i.key, i.count]));

  // 2) Audit: BOSHLANDI (global yozuv, schoolId=null: maktab audit yozuvlari o'chirilganda saqlanadi)
  await startAudit(ctx, school, 'school.delete.start', {
    name: school.name,
    slug: school.slug,
    resumed,
    counts: beforeCounts,
  });
  logger.warn(
    { schoolId: sid, name: school.name, by: ctx.actor.id, resumed, counts: beforeCounts },
    "Maktabni butunlay o'chirish BOSHLANDI",
  );

  try {
    // 3) Maktabga bog'langan superadmin (bo'lmasligi kerak): o'chirilmaydi, lekin ma'lumotnomadagi
    //    ko'rsatkichi bo'sh qoldirilmaydi (aks holda maktab o'chgach u tizimga kira olmay qolardi)
    const repaired = await User.updateMany(
      { schoolId: school._id, role: 'superadmin' },
      { $set: { schoolId: null } },
    );

    // 4) Telegram: rahbariyat hisobot doirasi shu maktab bo'lsa bekor
    await User.updateMany(
      { role: 'superadmin', 'telegram.reportScope': sid },
      { $set: { 'telegram.reportScope': null } },
    );

    // 5) Telegram menyusini tozalash (hech qachon tashlamaydi)
    if (pctx.userIds.length) {
      const linked = await User.find({ _id: { $in: pctx.userIds } }).select('+telegram.chatId');
      for (const u of linked) {
        const chatId = u.telegram?.chatId ?? null;
        if (chatId !== null) await clearChatCommands(chatId);
      }
    }

    // 6) Kolleksiyalar (farzandlar -> foydalanuvchiga bog'liqlar -> foydalanuvchilar)
    const counts: Record<string, number> = {};
    for (const step of SCHOOL_PURGE_STEPS) {
      counts[step.key] = await purgeStep(step, pctx);
    }

    // 7) School hujjati ENG OXIRIDA
    await School.deleteOne({ _id: school._id });

    // 8) Parallel hisob/xabar qoldirgan izlarni oxirgi marta tozalash + kesh/rejalashtirish
    for (const key of SWEEP_KEYS) {
      const step = SCHOOL_PURGE_STEPS.find((s) => s.key === key);
      if (step) counts[key] = (counts[key] ?? 0) + (await purgeStep(step, pctx));
    }
    publicCache.clear();
    ratingEvents.schoolRemoved(sid); // kutayotgan hisob bekor, umumiy (maktablar) reyting qayta hisoblanadi

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await startAudit(ctx, school, 'school.delete', {
      name: school.name,
      slug: school.slug,
      resumed,
      counts,
      total,
      superadminsRepaired: repaired.modifiedCount,
    });
    logger.warn(
      { schoolId: sid, name: school.name, by: ctx.actor.id, counts, total },
      "Maktab butunlay o'chirildi",
    );

    return {
      deleted: true,
      school: { id: sid, name: school.name },
      counts,
      total,
      resumed,
      superadminsRepaired: repaired.modifiedCount,
    };
  } catch (err) {
    logger.error(
      { err, schoolId: sid },
      "Maktabni o'chirish yarim yo'lda to'xtadi (qayta urinish mumkin)",
    );
    await auditFailure(ctx, school, err);
    throw err;
  }
}

async function auditFailure(ctx: Ctx, school: SchoolDoc, err: unknown) {
  try {
    await startAudit(ctx, school, 'school.delete.failed', {
      name: school.name,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (e) {
    logger.error({ err: e }, 'school.delete.failed audit yozilmadi');
  }
}

export const schoolDeletion = { preview, remove };
