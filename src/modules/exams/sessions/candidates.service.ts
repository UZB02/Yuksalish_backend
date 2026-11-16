import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import { buildMeta, paginationQuery, skipOf } from '../../../core/pagination';
import { ExamCandidate } from '../../../models/ExamCandidate';
import type { ExamCandidateDoc } from '../../../models/ExamCandidate';
import { ExamSession } from '../../../models/ExamSession';
import { isId } from '../../../utils/helpers';
import { cleanText } from '../../../utils/text';
import { auditService } from '../../audit/audit.service';
import { resolveExamScope } from '../exams.scope';
import { examSettings } from './templates.service';
import { commonEnd } from './timing';

const DAY = 86_400_000;
// eslint-disable-next-line no-control-regex
const NOCTRL = /^[^\u0000-\u001F\u007F]*$/;
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, "Telefon raqami noto'g'ri");

const fields = {
  fullName: z.string().trim().min(2, 'F.I.Sh. kiritilishi kerak').max(100).regex(NOCTRL),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD ko‘rinishida bo‘lishi kerak')
    .nullish(),
  targetGrade: z.number().int().min(1).max(11).nullish(),
  parentPhone: phoneSchema.nullish(),
  notes: z.string().trim().max(1000).regex(NOCTRL).default(''),
};
export const candidateBody = z.object(fields).strict();
export const candidatePatchBody = z.object(fields).partial().strict();
export const candidateListQuery = z.object({
  ...paginationQuery,
  q: z.string().trim().max(100).optional(),
});
export type CandidateListQuery = z.output<typeof candidateListQuery>;

export const maskPhone = (p: string | null | undefined): string | null => {
  if (!p) return null;
  const d = p.replace(/\D/g, '');
  return d.length < 5
    ? '***'
    : `${p.trim().startsWith('+') ? '+' : ''}${d.slice(0, 3)}*****${d.slice(-2)}`;
};

const dto = (c: ExamCandidateDoc, full: boolean) => ({
  id: c.id as string,
  fullName: c.fullName,
  targetGrade: c.targetGrade,
  /** Ro'yxatda tug'ilgan sana yashiriladi (faqat bor-yo'qligi), batafsilda to'liq */
  birthDate: full ? c.birthDate : null,
  hasBirthDate: !!c.birthDate,
  parentPhone: full ? c.parentPhone : maskPhone(c.parentPhone),
  notes: c.notes,
  piiPurged: !!c.piiPurgedAt,
  createdAt: c.createdAt,
});

async function admin(ctx: Ctx, schoolId: string) {
  const scope = await resolveExamScope(ctx.actor, schoolId);
  if (!scope.all) throw AppError.forbidden("Nomzodlar bilan faqat ma'muriyat ishlaydi");
}
const log = (
  ctx: Ctx,
  schoolId: string,
  action: string,
  id: string,
  before: unknown,
  after: unknown,
) =>
  auditService.log({
    userId: ctx.actor.id,
    schoolId,
    action,
    entity: 'exam_candidate',
    entityId: id,
    before,
    after,
    ip: ctx.ip,
  });
// Audit: telefon/tug'ilgan sana yozilmaydi
const sum = (c: ExamCandidateDoc) => ({ fullName: c.fullName, targetGrade: c.targetGrade });

async function find(schoolId: string, id: string) {
  const c = isId(id) ? await ExamCandidate.findOne({ _id: id, schoolId }) : null;
  if (!c) throw AppError.notFound('Nomzod topilmadi');
  return c;
}

const dateOf = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

export const candidatesService = {
  async list(ctx: Ctx, schoolId: string, q: CandidateListQuery) {
    await admin(ctx, schoolId);
    const filter: Record<string, unknown> = { schoolId };
    if (q.q)
      filter.fullName = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [docs, total] = await Promise.all([
      ExamCandidate.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      ExamCandidate.countDocuments(filter),
    ]);
    return { items: docs.map((d) => dto(d, false)), meta: buildMeta(q.page, q.limit, total) };
  },
  /** Batafsil ko'rinishda telefon to'liq (faqat ma'muriyat) */
  async get(ctx: Ctx, schoolId: string, id: string) {
    await admin(ctx, schoolId);
    return dto(await find(schoolId, id), true);
  },
  async create(ctx: Ctx, schoolId: string, body: z.output<typeof candidateBody>) {
    await admin(ctx, schoolId);
    const c = await ExamCandidate.create({
      schoolId,
      fullName: cleanText(body.fullName),
      birthDate: dateOf(body.birthDate),
      targetGrade: body.targetGrade ?? null,
      parentPhone: body.parentPhone ?? null,
      notes: cleanText(body.notes),
      createdBy: ctx.actor.id,
    });
    await log(ctx, schoolId, 'exam.candidate.create', c.id, null, sum(c));
    return dto(c, true);
  },
  async update(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof candidatePatchBody>) {
    await admin(ctx, schoolId);
    const c = await find(schoolId, id);
    const before = sum(c);
    if (body.fullName !== undefined) c.fullName = cleanText(body.fullName);
    if (body.birthDate !== undefined) c.birthDate = dateOf(body.birthDate);
    if (body.targetGrade !== undefined) c.targetGrade = body.targetGrade ?? null;
    if (body.parentPhone !== undefined) c.parentPhone = body.parentPhone ?? null;
    if (body.notes !== undefined) c.notes = cleanText(body.notes);
    await c.save();
    await log(ctx, schoolId, 'exam.candidate.update', c.id, before, sum(c));
    return dto(c, true);
  },
  async remove(ctx: Ctx, schoolId: string, id: string) {
    await admin(ctx, schoolId);
    const c = await find(schoolId, id);
    const used = await ExamSession.exists({
      schoolId,
      isDeleted: { $ne: true },
      participants: { $elemMatch: { kind: 'candidate', refId: c._id } },
    });
    if (used) throw AppError.conflict('Nomzod imtihonga qo‘shilgan, o‘chirib bo‘lmaydi');
    await c.deleteOne();
    await log(ctx, schoolId, 'exam.candidate.delete', c.id, sum(c), null);
    return { id: c.id as string, deleted: true };
  },
};

const HAS_PII = { $or: [{ parentPhone: { $ne: null } }, { birthDate: { $ne: null } }] };

/**
 * Saqlash muddati tugagan nomzodlarning shaxsiy ma'lumotini (telefon, tug'ilgan sana) tozalaydi; ism va natija
 * qoladi. Muddat: maktab sozlamasi `candidateRetentionDays`; oxirgi imtihoni tugaganidan (imtihoni bo'lmasa
 * yaratilganidan) shuncha kun o'tgan va tugamagan/kutilayotgan imtihoni yo'q nomzodlar. Idempotent.
 */
export async function runExamCandidatePurge(now = new Date()): Promise<number> {
  let purged = 0;
  const schools = await ExamCandidate.distinct('schoolId', { piiPurgedAt: null, ...HAS_PII });
  for (const schoolId of schools) {
    try {
      const days = (await examSettings(String(schoolId))).candidateRetentionDays;
      const cands = await ExamCandidate.find({ schoolId, piiPurgedAt: null, ...HAS_PII });
      if (!cands.length) continue;
      const sessions = await ExamSession.find({
        schoolId,
        isDeleted: { $ne: true },
        'participants.refId': { $in: cands.map((c) => c._id) },
      })
        .select('scheduledStart durationMin status participants.refId participants.kind')
        .lean();
      const last = new Map<string, number>();
      const live = new Set<string>();
      for (const s of sessions) {
        if (s.status === 'cancelled') continue;
        const end = commonEnd(s).getTime();
        const isLive = ['draft', 'pending_approval', 'scheduled', 'open'].includes(s.status);
        for (const p of s.participants) {
          if (p.kind !== 'candidate' || !p.refId) continue;
          const k = String(p.refId);
          if (isLive) live.add(k);
          last.set(k, Math.max(last.get(k) ?? 0, end));
        }
      }
      const ids = cands
        .filter((c) => {
          const k = String(c._id);
          if (live.has(k)) return false;
          const base = last.get(k) ?? c.createdAt.getTime();
          return now.getTime() - base > days * DAY;
        })
        .map((c) => c._id);
      if (!ids.length) continue;
      const r = await ExamCandidate.updateMany(
        { _id: { $in: ids }, schoolId },
        { $set: { parentPhone: null, birthDate: null, piiPurgedAt: now } },
      );
      purged += r.modifiedCount;
      await auditService.log({
        userId: null,
        schoolId: String(schoolId),
        action: 'exam.candidate.pii_purge',
        entity: 'exam_candidate',
        entityId: String(schoolId),
        before: null,
        after: { purged: r.modifiedCount, retentionDays: days },
      });
    } catch (err) {
      logger.error({ err, schoolId: String(schoolId) }, 'Nomzod PII tozalash xatosi');
    }
  }
  return purged;
}
