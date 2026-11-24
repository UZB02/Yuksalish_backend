import crypto from 'crypto';
import { Types } from 'mongoose';
import { env } from '../../../config/env';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { buildMeta, paginationQuery, skipOf } from '../../../core/pagination';
import { objectIdSchema } from '../../../core/validators';
import { AcademicYear } from '../../../models/AcademicYear';
import { ClassModel } from '../../../models/Class';
import { ClassSubject } from '../../../models/ClassSubject';
import { ExamAttempt } from '../../../models/ExamAttempt';
import { ExamCandidate } from '../../../models/ExamCandidate';
import { ExamJoinGuard } from '../../../models/ExamJoinGuard';
import { ExamTopic } from '../../../models/ExamTopic';
import { TelegramOutbox } from '../../../models/TelegramOutbox';
import {
  ExamSession,
  RESULTS_MODES,
  SESSION_STATUSES,
  SESSION_TYPES,
} from '../../../models/ExamSession';
import type {
  ExamSessionDoc,
  ISessionParticipant,
  SessionStatus,
} from '../../../models/ExamSession';
import { ExamTemplate, SCORING_MODES, TIMING_MODES } from '../../../models/ExamTemplate';
import { Question } from '../../../models/Question';
import { School } from '../../../models/School';
import { Student } from '../../../models/Student';
import { Subject } from '../../../models/Subject';
import { User } from '../../../models/User';
import { escapeRegex, isDuplicateKeyError, isId, uniq } from '../../../utils/helpers';
import { notifyBlockAssignments, notifyExamClosed } from '../../telegram/telegram.exams';
import { cleanText } from '../../../utils/text';
import { auditService } from '../../audit/audit.service';
import { resolveExamScope, type ExamScope } from '../exams.scope';
import { persistResultsMeta } from '../results/results.meta';
import {
  MAX_POOL,
  actorOfUser,
  assertBlocksOk,
  assertSectionsOk,
  blocksSchema,
  examSettings,
  inspectBlockOfStored,
  inspectBlocks,
  inspectSections,
  itemsDto,
  sectionsDto,
  sectionsSchema,
  storeBlocks,
  storeSections,
  templateBlocksDto,
  validateBlocksInput,
} from './templates.service';
import {
  blockQuestionCount,
  contribRuleOffset,
  effectiveItems,
  normalizeBlocks,
  scoringModeOf,
  sumBlockDurations,
  timingModeOf,
  type NBlock,
} from '../blocks/blocks.core';
import { fileTestSummary, poolOfFileBlock } from '../filetest/filetest.core';
import { assertFileBlocksReady, expiredFilesOf } from '../filetest/filetest.guard';
import { ExamEntryCode } from '../../../models/ExamEntryCode';
import {
  decryptEntryCode,
  encryptEntryCode,
  formatEntryCode,
  hashEntryCode,
  randomEntryCode,
} from './entryCode';
import {
  decryptPin,
  encryptPin,
  hashPin,
  newParticipantKey,
  newPinSalt,
  pinSecretConfigured,
  uniquePin,
} from './pin';
import {
  commonEnd,
  extendCurrentBlock,
  participantDeadline,
  projectedDeadline,
  reclampCurrentBlock,
  type BlockStateLike,
} from './timing';

type Actor = Ctx['actor'];

export const MAX_PARTICIPANTS = 500;
const MAX_DURATION_MIN = 1440;

// ---------- Sxemalar ----------
// eslint-disable-next-line no-control-regex
const NOCTRL = /^[^\u0000-\u001F\u007F]*$/;
const text = (label: string, max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min, `${label} kiritilishi kerak`)
    .max(max, `${label} ${max} belgidan oshmasligi kerak`)
    .regex(NOCTRL, `${label}da boshqaruv belgilari bo'lmasligi kerak`);
const startSchema = z
  .string()
  .datetime({ offset: true, message: 'Sana ISO ko‘rinishida (vaqt zonasi bilan) bo‘lishi kerak' })
  .transform((v) => new Date(v));

const sessionFields = {
  title: text('Nom', 150),
  type: z.enum(SESSION_TYPES),
  subjectId: objectIdSchema.nullish(),
  classIds: z.array(objectIdSchema).max(60).default([]),
  templateId: objectIdSchema.nullish(),
  sections: sectionsSchema.optional(),
  blocks: blocksSchema.optional(),
  scoringMode: z.enum(SCORING_MODES).optional(),
  timingMode: z.enum(TIMING_MODES).optional(),
  scheduledStart: startSchema,
  /** Savol topshirish muddati (biriktirilgan o'qituvchilar uchun); boshlanishdan keyin bo'lmasin */
  contribDeadline: startSchema.nullish(),
  /** umumiy vaqt rejimida majburiy; blokma-blok rejimda bloklar yig'indisidan hisoblanadi */
  durationMin: z
    .number()
    .int()
    .min(5, 'Kamida 5 daqiqa')
    .max(600, '600 daqiqadan oshmasligi kerak')
    .optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  resultsMode: z.enum(RESULTS_MODES).default('score'),
  passPercent: z.number().int().min(1).max(100).nullish(),
  supervisorIds: z.array(objectIdSchema).max(30).default([]),
  periodId: objectIdSchema.nullish(),
};
export const sessionBody = z.object(sessionFields).strict();
export const sessionPatchBody = z.object(sessionFields).partial().strict();

export const participantsBody = z
  .object({
    classIds: z.array(objectIdSchema).max(60).default([]),
    studentIds: z.array(objectIdSchema).max(MAX_PARTICIPANTS).default([]),
    guests: z
      .array(
        z
          .object({ fullName: text('F.I.Sh.', 100, 2), origin: text('Qayerdan kelgani', 150) })
          .strict(),
      )
      .max(100)
      .default([]),
    candidateIds: z.array(objectIdSchema).max(MAX_PARTICIPANTS).default([]),
  })
  .strict();
export const submitBody = z.object({ confirmShort: z.boolean().optional() }).strict();
export const reopenBody = z.object({ reason: text('Sabab', 500), newEnd: startSchema }).strict();
export const extendBody = z
  .object({
    minutes: z.number().int().min(1, 'Kamida 1 daqiqa').max(180, '180 daqiqadan oshmasligi kerak'),
    reason: text('Sabab', 500, 0).optional(),
  })
  .strict();
export const grantBody = z
  .object({
    fullTime: z.boolean().optional(),
    extraMinutes: z.number().int().min(0).max(240).optional(),
  })
  .strict();
export const deleteBody = z
  .object({
    mode: z.enum(['exam_only', 'with_results']).optional(),
    confirmTitle: z.string().max(300).optional(),
  })
  .strict();
export const reasonBody = z.object({ reason: text('Sabab', 500) }).strict();
export const optionalReasonBody = z.object({ reason: text('Sabab', 500, 0).optional() }).strict();
export const sessionListQuery = z.object({
  ...paginationQuery,
  status: z.enum(SESSION_STATUSES).optional(),
  type: z.enum(SESSION_TYPES).optional(),
});
export type SessionListQuery = z.output<typeof sessionListQuery>;

// ---------- Yordamchilar ----------
const notFound = () => AppError.notFound('Imtihon topilmadi');
const oid = (s: string) => new Types.ObjectId(s);

export const audit = (
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
    entity: 'exam_session',
    entityId: id,
    before,
    after,
    ip: ctx.ip,
  });

/** Audit xulosasi: PIN, savollar yoki ishtirokchi ismlari yozilmaydi (faqat sonlar) */
const summary = (s: ExamSessionDoc) => ({
  title: s.title,
  type: s.type,
  status: s.status,
  scheduledStart: s.scheduledStart,
  durationMin: s.durationMin,
  resultsMode: s.resultsMode,
  blocks: s.blocks?.length ?? 0,
  scoringMode: scoringModeOf(s),
  timingMode: timingModeOf(s),
  participants: s.participants.length,
  supervisors: s.supervisorIds.length,
  classes: s.classIds.length,
});

/** Yangi biriktirilgan o'qituvchilar: blockId -> faqat avval bu blokda bo'lmaganlar */
export function contributorDiff(prev: NBlock[], next: NBlock[]) {
  const had = new Map(prev.map((b) => [b.blockId, new Set(b.contributors)]));
  return next
    .map((b) => ({
      blockId: b.blockId,
      userIds: b.contributors.filter((u) => !had.get(b.blockId)?.has(u)),
    }))
    .filter((x) => x.userIds.length);
}

export const isSupervisor = (s: ExamSessionDoc, actor: Actor) =>
  s.supervisorIds.some((x) => String(x) === actor.id);
export const isCreator = (s: ExamSessionDoc, actor: Actor) => String(s.createdBy) === actor.id;

function assertPinSecret() {
  if (!pinSecretConfigured()) {
    throw AppError.unavailable('EXAM_PIN_SECRET sozlanmagan: PIN yaratib bo‘lmaydi');
  }
}

async function activeYear(schoolId: string) {
  const y = await AcademicYear.findOne({ schoolId, isActive: true });
  if (!y) {
    throw AppError.validation("Faol o'quv yili yo'q", [
      { path: 'academicYear', message: "Avval faol o'quv yilini belgilang" },
    ]);
  }
  return y;
}

/** O'qituvchining faol yildagi (sinf, fan) juftliklari */
async function teacherPairs(schoolId: string, teacherId: string, yearId: Types.ObjectId) {
  const rows = await ClassSubject.find({ schoolId, teacherId, academicYearId: yearId })
    .select('classId subjectId')
    .lean();
  return new Set(rows.map((r) => `${r.classId}:${r.subjectId}`));
}

export async function findSession(
  ctx: Ctx,
  schoolId: string,
  scope: ExamScope,
  id: string,
  /** true: natijalari saqlangan (faqat imtihon o'chirilgan) sessiyani ham topadi: faqat natijalar uchun */
  kept = false,
) {
  const s = isId(id)
    ? await ExamSession.findOne({
        _id: id,
        schoolId,
        ...(kept
          ? { $or: [{ isDeleted: { $ne: true } }, { resultsKept: true }] }
          : { isDeleted: { $ne: true } }),
      })
    : null;
  if (!s) throw notFound();
  // O'qituvchi faqat o'zi yaratgan yoki nazoratchi bo'lgan imtihonni ko'radi
  if (!scope.all && !isCreator(s, ctx.actor) && !isSupervisor(s, ctx.actor)) throw notFound();
  return s;
}

function assertManager(s: ExamSessionDoc, scope: ExamScope, actor: Actor) {
  if (!scope.all && !isCreator(s, actor)) {
    throw AppError.forbidden("Imtihonni faqat yaratuvchisi yoki ma'muriyat o'zgartira oladi");
  }
}

async function validateSupervisors(schoolId: string, ids: string[]) {
  const u = uniq(ids);
  if (!u.length) return [];
  const n = await User.countDocuments({
    _id: { $in: u },
    schoolId,
    role: { $in: ['teacher', 'school_admin'] },
    isActive: true,
  });
  if (n !== u.length) {
    throw AppError.validation('Nazoratchi topilmadi', [
      { path: 'supervisorIds', message: 'Faqat shu maktabning faol xodimlarini tanlash mumkin' },
    ]);
  }
  return u;
}

const phase = (s: ExamSessionDoc, now = new Date()) => {
  if (s.status !== 'scheduled' && s.status !== 'open') return null;
  if (now < s.scheduledStart) return 'upcoming' as const;
  return now < commonEnd(s) ? ('running' as const) : ('ended' as const);
};

// ---------- DTO ----------
const participantDto = (p: ISessionParticipant) => ({
  key: p.key,
  kind: p.kind,
  fullName: p.fullName,
  className: p.className,
  grade: p.grade,
  origin: p.origin,
  /** PIN va kirish kodining o'zi hech qachon ro'yxatda chiqmaydi (kod faqat alohida ko'rsatish endpointida) */
  hasPin: !!p.pinHash,
  hasCode: !!p.codeEnc,
  fullTimeGranted: p.fullTimeGranted,
  extraMinutes: p.extraMinutes,
});

async function refs(docs: ExamSessionDoc[]) {
  const blocksOfDocs = docs.map((d) => normalizeBlocks(d));
  const userIds = uniq(
    docs.flatMap((d, i) => [
      String(d.createdBy),
      ...d.supervisorIds.map(String),
      ...blocksOfDocs[i]!.flatMap((b) => [
        ...b.contributors,
        ...b.contribQuestions.map((c) => c.addedBy),
        ...b.contribRules.map((c) => c.addedBy),
      ]),
    ]),
  );
  const classIds = uniq(docs.flatMap((d) => d.classIds.map(String)));
  const subjectIds = uniq([
    ...docs.map((d) => (d.subjectId ? String(d.subjectId) : '')).filter(Boolean),
    ...blocksOfDocs.flatMap((bs) => bs.map((b) => b.subjectId ?? '')).filter(Boolean),
  ]);
  const [users, classes, subjects] = await Promise.all([
    User.find({ _id: { $in: userIds } })
      .select('fullName')
      .lean(),
    ClassModel.find({ _id: { $in: classIds } })
      .select('name')
      .lean(),
    Subject.find({ _id: { $in: subjectIds } })
      .select('name')
      .lean(),
  ]);
  return {
    user: new Map(users.map((u) => [String(u._id), u.fullName])),
    cls: new Map(classes.map((c) => [String(c._id), c.name])),
    subject: new Map(subjects.map((s) => [String(s._id), s.name])),
  };
}

/** Fanlar bo'yicha jamlama: jami, o'qituvchi tugatgan/tasdiqlangan (o'qituvchisiz fan tasdiqlangan hisoblanadi) */
function blocksProgressOf(s: ExamSessionDoc) {
  const blocks = normalizeBlocks(s).filter((b) => !b.legacy);
  const approved = (b: NBlock) =>
    b.contributors.length === 0 || (b.status === 'ready' && b.readyBy === 'composer');
  return {
    total: blocks.length,
    done: blocks.filter((b) => approved(b) || b.status === 'ready').length,
    approved: blocks.filter(approved).length,
  };
}

/** Tuzuvchi uchun blok DTO (eski hujjat: bitta sun'iy blok, legacy: true) */
function blockDto(b: NBlock, r: Awaited<ReturnType<typeof refs>>) {
  return {
    id: b.blockId,
    legacy: b.legacy,
    subjectId: b.subjectId,
    subjectName: b.subjectId ? (r.subject.get(b.subjectId) ?? null) : null,
    title: b.title,
    targetCount: b.targetCount,
    coefficient: b.coefficient,
    durationMin: b.durationMin,
    status: b.status,
    readyBy: b.readyBy,
    remindedAt: b.remindedAt,
    /** Har ishtirokchi shu blokdan oladigan savollar soni (qo'lda + qoidalar; fayl blokida kalitdagi savollar) */
    count: blockQuestionCount(b),
    /** Blok mazmuni: 'bank' yoki 'file' (fayl + kalit, §22); kalit chiqmaydi, faqat xulosa */
    content: b.content,
    fileTest: b.content === 'file' ? fileTestSummary(b.fileTest) : null,
    contributors: b.contributors.map((id) => ({ id, fullName: r.user.get(id) ?? '' })),
    items: itemsDto(b.items),
    contribQuestions: b.contribQuestions.map((c) => ({
      questionId: c.questionId,
      addedBy: c.addedBy,
      addedByName: r.user.get(c.addedBy) ?? null,
      addedAt: c.addedAt,
    })),
    /** Tasodifiy tanlash qoidalari (har o'quvchiga boshqacha), poolIds chiqarilmaydi */
    contribRules: b.contribRules.map((c) => ({
      ruleId: c.ruleId,
      topicIds: c.topicIds,
      allTopics: c.allTopics,
      difficulty: c.difficulty,
      type: c.type,
      count: c.count,
      addedBy: c.addedBy,
      addedByName: r.user.get(c.addedBy) ?? null,
      addedAt: c.addedAt,
    })),
  };
}

function flags(s: ExamSessionDoc, scope: ExamScope, actor: Actor, isSuper: boolean) {
  const manager = scope.all || isCreator(s, actor);
  const editableStatus = ['draft', 'scheduled', 'open'].includes(s.status);
  return {
    canEdit: manager && s.status === 'draft',
    canSubmit: manager && s.status === 'draft',
    canApprove: scope.all && s.status === 'pending_approval',
    canManageParticipants: manager && editableStatus,
    canGrant: (isSuper || isSupervisor(s, actor)) && ['scheduled', 'open'].includes(s.status),
    canOpen:
      (scope.all || isSupervisor(s, actor) || isCreator(s, actor)) && s.status === 'scheduled',
    canClose:
      (scope.all || isSupervisor(s, actor) || isCreator(s, actor)) &&
      ['scheduled', 'open'].includes(s.status),
    canCancel:
      (scope.all || (isCreator(s, actor) && s.status !== 'open')) &&
      ['draft', 'pending_approval', 'scheduled', 'open'].includes(s.status),
    canReopen:
      (scope.all || isSupervisor(s, actor) || isCreator(s, actor)) && s.status === 'closed',
    canExtend: (scope.all || isSupervisor(s, actor) || isCreator(s, actor)) && s.status === 'open',
    /** Jonli kuzatuv (E5): ma'muriyat, yaratuvchi va nazoratchilar; amallar (ogohlantirish/to'xtatish) faqat ochiq imtihonda */
    canMonitor:
      (scope.all || isSupervisor(s, actor) || isCreator(s, actor)) &&
      ['scheduled', 'open'].includes(s.status),
    canIntervene:
      (scope.all || isSupervisor(s, actor) || isCreator(s, actor)) && s.status === 'open',
    canViewResults:
      ['open', 'closed'].includes(s.status) &&
      (isCreator(s, actor) ||
        isSupervisor(s, actor) ||
        isSuper ||
        (scope.all &&
          (actor.permissions.includes('exams.results') ||
            actor.permissions.includes('exams.manage')))),
    canPrint: manager && ['scheduled', 'open', 'closed'].includes(s.status),
    canDelete: manager && s.status !== 'open',
    canCopy: manager,
    canReturnToDraft: manager && ['scheduled', 'pending_approval'].includes(s.status),
  };
}

async function toDto(ctx: Ctx, scope: ExamScope, docs: ExamSessionDoc[], full: boolean) {
  const r = await refs(docs);
  const isSuper = ctx.actor.role === 'superadmin';
  const withAttempts = full
    ? new Set(
        (
          await ExamAttempt.distinct('sessionId', { sessionId: { $in: docs.map((d) => d._id) } })
        ).map(String),
      )
    : new Set<string>();
  return docs.map((s) => ({
    id: s.id as string,
    title: s.title,
    type: s.type,
    status: s.status,
    phase: phase(s),
    subjectId: s.subjectId ? String(s.subjectId) : null,
    subjectName: s.subjectId ? (r.subject.get(String(s.subjectId)) ?? null) : null,
    classes: s.classIds.map((c) => ({ id: String(c), name: r.cls.get(String(c)) ?? '' })),
    scheduledStart: s.scheduledStart,
    durationMin: s.durationMin,
    endsAt: commonEnd(s),
    code: s.code,
    resultsMode: s.resultsMode,
    passPercent: s.passPercent ?? null,
    resultsPublished: !!s.resultsPublished,
    /** Umumiy vaqt tugagan, lekin sessiya hali yopilmagan (davom etayotgan urinishlar bor) */
    timeUp: s.status === 'open' && Date.now() > commonEnd(s).getTime(),
    scoringMode: scoringModeOf(s),
    timingMode: timingModeOf(s),
    contribDeadline: s.contribDeadline ?? null,
    blocksCount: normalizeBlocks(s).length,
    /** Fanlar holati (ro'yxatdagi bosqich belgisi uchun): o'qituvchisi borlar orasida tugatgan va tasdiqlanganlar */
    blocksProgress: blocksProgressOf(s),
    shuffleQuestions: s.shuffleQuestions,
    shuffleOptions: s.shuffleOptions,
    participantsCount: s.participants.length,
    supervisors: s.supervisorIds.map((x) => ({
      id: String(x),
      fullName: r.user.get(String(x)) ?? '',
    })),
    approval: {
      status: s.approval?.status ?? 'none',
      reason: s.approval?.reason ?? '',
      at: s.approval?.at ?? null,
    },
    pool: { frozen: !!s.poolFrozenAt, frozenAt: s.poolFrozenAt },
    createdBy: String(s.createdBy),
    createdByName: r.user.get(String(s.createdBy)) ?? null,
    isMine: isCreator(s, ctx.actor),
    cancelReason: s.cancelReason,
    createdAt: s.createdAt,
    ...flags(s, scope, ctx.actor, isSuper),
    ...(full
      ? {
          templateId: s.templateId ? String(s.templateId) : null,
          period: s.period ?? null,
          sections: sectionsDto(s.sections),
          blocks: normalizeBlocks(s).map((b) => blockDto(b, r)),
          /** Urinish bor (kirgan/boshlagan/topshirgan): qoralamaga qaytarib bo'lmaydi, o'chirishda tanlov kerak */
          hasAttempts: withAttempts.has(s.id as string),
          participants: s.participants.map(participantDto),
        }
      : {}),
  }));
}

// ---------- Savollar nusxasi (snapshot) va kod ----------
/**
 * Savollar to'plamini MUZLATADI: qo'lda tanlangan va qoidalarga mos kelishi mumkin bo'lgan BARCHA faol
 * savollarning to'liq nusxasi (javob kaliti bilan). Keyin bankdagi tahrir/o'chirish sessiyaga ta'sir
 * qilmaydi. Savollar YARATUVCHI nomidan tekshiriladi (tasdiqlovchi ma'muriyat nomidan emas).
 */
async function freezePool(schoolId: string, s: ExamSessionDoc) {
  const creator = await actorOfUser(String(s.createdBy));
  if (!creator) throw AppError.conflict('Imtihon yaratuvchisi faol emas, tasdiqlab bo‘lmaydi');
  const scope = await resolveExamScope(creator, schoolId);
  const nblocks = normalizeBlocks(s);
  const blockMode = !nblocks[0]!.legacy;
  const sections = sectionsDto(s.sections);
  let poolIds: string[];
  let rulePools: Map<string, string[]>;
  if (blockMode) {
    // Blokli imtihon: har blok o'z fanidagi savollar bilan tekshiriladi (biriktirilgan o'qituvchilar savollari ham)
    const binfo = await inspectBlocks(creator, schoolId, scope, nblocks.map(inspectBlockOfStored));
    assertBlocksOk(binfo);
    poolIds = binfo.poolIds;
    rulePools = binfo.rulePools;
  } else {
    const info = await inspectSections(creator, schoolId, scope, sections);
    assertSectionsOk(info);
    poolIds = info.poolIds;
    rulePools = info.rulePools;
  }
  const docs = await Question.find({ _id: { $in: poolIds.map(oid) }, schoolId });
  if (docs.length > MAX_POOL) throw AppError.validation('Savollar to‘plami juda katta');
  // Fayl + kalit bloklari (§22): to'liq tekshiruv, kalit sun'iy savollarga aylanadi
  await assertFileBlocksReady(schoolId, s);
  const filePool = nblocks.flatMap((b) =>
    b.content === 'file' && b.fileTest ? poolOfFileBlock(b.blockId, b.subjectId, b.fileTest) : [],
  );
  const pool = [
    ...docs.map((q) => ({
      questionId: q._id,
      version: q.version ?? 1,
      topicId: q.topicId,
      subjectId: q.subjectId,
      type: q.type,
      difficulty: q.difficulty,
      points: q.points,
      content: q.content.map((b) => ({ ...(b as unknown as object) })),
      options: q.options.map((o) => ({
        id: o.id,
        content: o.content.map((b) => ({ ...(b as unknown as object) })),
      })),
      answer: {
        ...((q.answer as unknown as { toObject?: () => object })?.toObject?.() ?? q.answer),
      },
    })),
    ...filePool,
  ] as unknown[];
  if (JSON.stringify(pool).length > 12_000_000) {
    throw AppError.validation('Savollar to‘plami hajmi juda katta (rasmlar/matn ko‘p)');
  }
  // Qoida elementlariga mos savollar id si (E4 da har ishtirokchi shu to'plamdan tanlaydi)
  const frozenSections = storeSections(sections).map((sec, si) => ({
    ...sec,
    items: sec.items.map((it, ii) =>
      it.kind === 'rule' ? { ...it, poolIds: (rulePools.get(`${si}.${ii}`) ?? []).map(oid) } : it,
    ),
  }));
  // Bloklar: har blokning (tuzuvchi) elementlari + qoida poolIds; o'qituvchi savollari o'z ro'yxatida qoladi
  const frozenBlocks = blockMode
    ? (s.blocks as unknown as Record<string, unknown>[]).map((b, bi) => {
        const nb = nblocks[bi]!;
        const offset = contribRuleOffset(nb);
        return {
          ...(typeof (b as { toObject?: () => object }).toObject === 'function'
            ? (b as unknown as { toObject: () => object }).toObject()
            : b),
          items: ((b.items as Record<string, unknown>[]) ?? []).map((it, ii) =>
            it.kind === 'rule'
              ? { ...it, poolIds: (rulePools.get(`${bi}.${ii}`) ?? []).map(oid) }
              : it,
          ),
          // Tasodifiy tanlash qoidalari (E8): effectiveItems ichida items(+1 qo'lda) dan keyin turadi
          contribRules: nb.contribRules.map((r, ri) => ({
            ruleId: r.ruleId,
            topicIds: r.topicIds.map(oid),
            allTopics: r.allTopics,
            difficulty: r.difficulty,
            type: r.type,
            count: r.count,
            addedBy: oid(r.addedBy),
            addedAt: r.addedAt,
            poolIds: (rulePools.get(`${bi}.${offset + ri}`) ?? []).map(oid),
          })),
        };
      })
    : null;
  return { pool, frozenSections, frozenBlocks };
}

/** draft/pending_approval -> scheduled: snapshot + noyob kod (to'qnashuvda qayta tanlanadi) */
async function schedule(schoolId: string, s: ExamSessionDoc, ctx: Ctx, via: 'submit' | 'approve') {
  const { pool, frozenSections, frozenBlocks } = await freezePool(schoolId, s);
  const from: SessionStatus[] = ['draft', 'pending_approval'];
  for (let i = 0; i < 25; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      const r = await ExamSession.updateOne(
        { _id: s._id, status: { $in: from } },
        {
          $set: {
            status: 'scheduled',
            code,
            codeActive: true,
            questionPool: pool,
            sections: frozenSections as never,
            ...(frozenBlocks ? { blocks: frozenBlocks as never } : {}),
            poolFrozenAt: new Date(),
            approval: {
              status: via === 'approve' ? 'approved' : (s.approval?.status ?? 'none'),
              by: via === 'approve' ? oid(ctx.actor.id) : (s.approval?.by ?? null),
              at: via === 'approve' ? new Date() : (s.approval?.at ?? null),
              reason: '',
            },
          },
        },
      );
      if (!r.matchedCount) throw AppError.conflict('Imtihon holati o‘zgargan, sahifani yangilang');
      return code;
    } catch (e) {
      if (isDuplicateKeyError(e)) continue; // kod band: yangisini tanlaymiz
      throw e;
    }
  }
  throw AppError.unavailable('Imtihon kodini tanlab bo‘lmadi, qayta urinib ko‘ring');
}

/**
 * Savollar sonini tekshiradi (rejalashtirishdan oldin): bo'sh blok (0 savol) har doim xato; maqsaddan kam bo'lsa
 * `confirmShort` bilan tuzuvchi tasdiqlashi shart (409). Faqat blokli imtihon uchun.
 */
/**
 * Fan bo'yicha tasdiq: o'qituvchisi bor har fan ma'muriyat (tuzuvchi) tomonidan tasdiqlangan bo'lishi shart (409,
 * path=approval, aylanib o'tib bo'lmaydi). O'qituvchisiz fan (tuzuvchi o'zi to'ldiradi) va eski blokisiz imtihon
 * tasdiqni talab qilmaydi.
 */
function assertBlocksApproved(s: ExamSessionDoc) {
  const blocks = normalizeBlocks(s);
  if (blocks[0]!.legacy) return;
  const missing = blocks.filter(
    (b) => b.contributors.length > 0 && !(b.status === 'ready' && b.readyBy === 'composer'),
  );
  if (missing.length) {
    throw AppError.conflict(
      'Tasdiqlanmagan fanlar bor',
      missing.map((b) => ({
        path: 'approval',
        message: `${b.title || 'Fan'}: ma'muriyat tasdiqlamagan`,
      })),
    );
  }
}

function assertBlockTargets(s: ExamSessionDoc, confirmShort: boolean) {
  const blocks = normalizeBlocks(s);
  if (blocks[0]!.legacy) return;
  const empty = blocks.filter((b) => blockQuestionCount(b) === 0);
  if (empty.length) {
    throw AppError.validation(
      'Bo‘sh blok bor',
      empty.map((b) => ({ path: 'blocks', message: `${b.title || 'Blok'}: savol yo'q` })),
    );
  }
  const short = blocks.filter((b) => blockQuestionCount(b) < b.targetCount);
  if (short.length && !confirmShort) {
    throw AppError.conflict(
      'Ba‘zi fanlarda savollar maqsaddan kam',
      short.map((b) => ({
        path: 'blocks',
        message: `${b.title || 'Blok'}: ${blockQuestionCount(b)}/${b.targetCount}`,
      })),
    );
  }
}

/**
 * Davom etayotgan urinishlar deadline i ni sessiya hozirgi davomiyligidan qayta hisoblaydi (hamma uchun +N / yangi tugash).
 * participantDeadline: to'liq vaqtli = boshlagan vaqti + davomiylik (+extra); aks holda umumiy tugash (+extra).
 * per_block: qattiq (hard) deadline shu formuladan; `extendMinutes` bo'lsa JORIY blokka shuncha qo'shiladi (har o'quvchi
 * aynan N daqiqa ko'p oladi), joriy blok deadline qayta cheklanadi va urinish deadline i = min(hard, joriy + qolgan bloklar).
 */
export async function recomputeDeadlines(s: ExamSessionDoc, extendMinutes = 0): Promise<void> {
  const perBlock = timingModeOf(s) === 'per_block';
  const attempts = await ExamAttempt.find({ sessionId: s._id, status: 'in_progress' }).select(
    'participantKey startedAt blockState blockIndex',
  );
  const ops = [];
  for (const a of attempts) {
    const p = s.participants.find((x) => x.key === a.participantKey);
    if (!p || !a.startedAt) continue;
    const hard = participantDeadline(s, p, a.startedAt);
    if (perBlock && a.blockState?.length) {
      const idx = a.blockIndex ?? 0;
      const st = (
        extendMinutes
          ? extendCurrentBlock(a.blockState as BlockStateLike[], idx, extendMinutes, hard)
          : reclampCurrentBlock(a.blockState as BlockStateLike[], idx, hard)
      ) as never;
      ops.push({
        updateOne: {
          filter: { _id: a._id, status: 'in_progress', blockIndex: idx },
          update: {
            $set: {
              hardDeadline: hard,
              blockState: st,
              deadline: projectedDeadline(st as BlockStateLike[], idx, hard),
            },
          },
        },
      });
      continue;
    }
    ops.push({
      updateOne: {
        filter: { _id: a._id, status: 'in_progress' },
        update: { $set: { deadline: hard } },
      },
    });
  }
  if (ops.length) await ExamAttempt.bulkWrite(ops as never);
}

// ---------- Shaxsiy kirish kodlari ----------
const CODE_KEEP_MS = 60 * 86_400_000;
/** Kod yozuvi TTL: imtihon tugashidan 60 kun keyin (tozalash uchun; faollik kirishda sessiya holatidan tekshiriladi) */
const entryExpiry = (s: ExamSessionDoc) =>
  new Date(Math.max(Date.now(), commonEnd(s).getTime()) + CODE_KEEP_MS);

/**
 * Ishtirokchiga yangi shaxsiy kod beradi: global noyob qidiruv yozuvi (HMAC xesh) yaratiladi, ochiq kod faqat
 * qaytariladi (shifrlangan nusxa ishtirokchiga yoziladi). Takror (11000) bo'lsa qayta tanlanadi.
 */
async function issueEntryCode(s: ExamSessionDoc, participantKey: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomEntryCode();
    try {
      await ExamEntryCode.create({
        codeHash: hashEntryCode(code),
        schoolId: s.schoolId,
        sessionId: s._id,
        participantKey,
        expiresAt: entryExpiry(s),
      });
      return encryptEntryCode(code, s.id as string);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  throw AppError.unavailable('Kirish kodi yaratib bo‘lmadi, qayta urinib ko‘ring');
}
const dropEntryCodes = (sessionId: Types.ObjectId, participantKey?: string) =>
  ExamEntryCode.deleteMany({
    sessionId,
    ...(participantKey ? { participantKey } : {}),
  });

// ---------- Ishtirokchilar ----------
async function makeParticipants(
  s: ExamSessionDoc,
  specs: Omit<
    ISessionParticipant,
    'key' | 'pinHash' | 'pinEnc' | 'fullTimeGranted' | 'extraMinutes' | 'allowReentry' | 'addedAt'
  >[],
) {
  const taken = new Set(s.participants.map((p) => p.pinHash));
  const out: ISessionParticipant[] = [];
  for (const sp of specs) {
    const { pin, hash } = uniquePin(s.pinSalt, taken);
    const key = newParticipantKey();
    out.push({
      ...sp,
      key,
      pinHash: hash,
      pinEnc: encryptPin(pin, s.id as string),
      codeEnc: await issueEntryCode(s, key),
      fullTimeGranted: false,
      extraMinutes: 0,
      allowReentry: false,
      addedAt: new Date(),
    });
  }
  return out;
}

// ---------- Servis ----------
export const sessionsService = {
  async meta(ctx: Ctx, schoolId: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await examSettings(schoolId);
    const staff = await User.find({
      schoolId,
      role: { $in: ['teacher', 'school_admin'] },
      isActive: true,
    })
      .sort({ fullName: 1 })
      .select('fullName role')
      .limit(500)
      .lean();
    // Blokka biriktirish uchun: har o'qituvchi faol yilda o'qitadigan fanlar (maktab admini istalgan fanga)
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
    const taught = new Map<string, Set<string>>();
    if (year && scope.all) {
      const rows = await ClassSubject.find({ schoolId, academicYearId: year._id })
        .select('teacherId subjectId')
        .lean();
      for (const r of rows) {
        const k = String(r.teacherId);
        taught.set(k, (taught.get(k) ?? new Set()).add(String(r.subjectId)));
      }
    }
    return {
      pinSecretConfigured: pinSecretConfigured(),
      isAdministration: scope.all,
      contributors: scope.all
        ? staff.map((u) => ({
            id: String(u._id),
            fullName: u.fullName,
            role: u.role,
            /** teacher: o'qitadigan fanlari; school_admin: null = istalgan fan */
            subjectIds: u.role === 'teacher' ? [...(taught.get(String(u._id)) ?? [])] : null,
          }))
        : [],
      teachersCanCreateQuizzes: s.teachersCanCreateQuizzes,
      teacherQuizNeedsApproval: s.teacherQuizNeedsApproval,
      // O'qituvchi faqat nazorat ishi yarata oladi
      allowedTypes: scope.all ? [...SESSION_TYPES] : s.teachersCanCreateQuizzes ? ['quiz'] : [],
      supervisors: staff.map((u) => ({ id: String(u._id), fullName: u.fullName, role: u.role })),
    };
  },

  /**
   * Fan uchun o'qituvchi taklifi: faol o'quv yilida SHU sinflarda shu fanni o'qitadigan faol o'qituvchilar
   * (ClassSubject). Faqat ma'muriyat. Hech kim topilmasa bo'sh ro'yxat (admin qo'lda tanlaydi).
   */
  async suggestTeachers(ctx: Ctx, schoolId: string, subjectId: string, classIds: string[]) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    if (!scope.all) throw AppError.forbidden("O'qituvchi taklifi faqat ma'muriyat uchun");
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
    if (!year || !classIds.length) return { teacherIds: [] as string[] };
    const ids = await ClassSubject.distinct('teacherId', {
      schoolId,
      subjectId,
      classId: { $in: classIds },
      academicYearId: year._id,
    });
    const users = await User.find({
      _id: { $in: ids },
      schoolId,
      role: 'teacher',
      isActive: true,
    })
      .select('_id')
      .lean();
    return { teacherIds: users.map((u) => String(u._id)) };
  },

  /** Sessiya yaratish uchun sinflar: o'qituvchi uchun faqat o'zi o'qitadigan (sinf, fan) juftliklari */
  async classOptions(ctx: Ctx, schoolId: string, subjectId?: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const year = await AcademicYear.findOne({ schoolId, isActive: true });
    if (!year) return [];
    const filter: Record<string, unknown> = {
      schoolId,
      academicYearId: year._id,
      isArchived: { $ne: true },
    };
    if (!scope.all) {
      const rows = await ClassSubject.find({
        schoolId,
        teacherId: ctx.actor.id,
        academicYearId: year._id,
        ...(subjectId ? { subjectId } : {}),
      })
        .select('classId')
        .lean();
      filter._id = { $in: rows.map((r) => r.classId) };
    }
    const classes = await ClassModel.find(filter)
      .sort({ grade: 1, name: 1 })
      .select('name grade')
      .lean();
    const counts = await Student.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          schoolId: oid(schoolId),
          classId: { $in: classes.map((c) => c._id) },
          status: 'active',
          isDeleted: { $ne: true },
        },
      },
      { $group: { _id: '$classId', n: { $sum: 1 } } },
    ]);
    const m = new Map(counts.map((c) => [String(c._id), c.n]));
    return classes.map((c) => ({
      id: String(c._id),
      name: c.name,
      grade: c.grade,
      studentsCount: m.get(String(c._id)) ?? 0,
    }));
  },

  /** Sinf o'quvchilari (ishtirokchi qo'shishda tanlash uchun) */
  async classStudents(ctx: Ctx, schoolId: string, classId: string, sessionId?: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const cls = isId(classId) ? await ClassModel.findOne({ _id: classId, schoolId }) : null;
    if (!cls) throw AppError.notFound('Sinf topilmadi');
    if (!scope.all) {
      const year = await activeYear(schoolId);
      const pairs = await teacherPairs(schoolId, ctx.actor.id, year._id);
      if (![...pairs].some((p) => p.startsWith(`${classId}:`)))
        throw AppError.notFound('Sinf topilmadi');
    }
    void sessionId;
    const students = await Student.find({
      schoolId,
      classId,
      status: 'active',
      isDeleted: { $ne: true },
    })
      .sort({ fullName: 1 })
      .select('fullName')
      .lean();
    return students.map((s) => ({ id: String(s._id), fullName: s.fullName }));
  },

  async list(ctx: Ctx, schoolId: string, q: SessionListQuery) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const filter: Record<string, unknown> = { schoolId, isDeleted: { $ne: true } };
    if (q.status) filter.status = q.status;
    if (q.type) filter.type = q.type;
    if (!scope.all) filter.$or = [{ createdBy: ctx.actor.id }, { supervisorIds: ctx.actor.id }];
    const [docs, total] = await Promise.all([
      ExamSession.find(filter)
        .sort({ scheduledStart: -1, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      ExamSession.countDocuments(filter),
    ]);
    return { items: await toDto(ctx, scope, docs, false), meta: buildMeta(q.page, q.limit, total) };
  },

  async get(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    return (await toDto(ctx, scope, [s], true))[0]!;
  },

  /**
   * Yaratish. O'qituvchi: faqat 'quiz', faqat o'zi o'qitadigan (sinf, fan) uchun va faqat o'ziga ko'rinadigan
   * savollardan; `teachersCanCreateQuizzes` o'chiq bo'lsa 403. Ma'muriyat: barcha turlar.
   */
  async create(ctx: Ctx, schoolId: string, body: z.output<typeof sessionBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const year = await activeYear(schoolId);
    const settings = await examSettings(schoolId);
    if (body.blocks && body.sections) {
      throw AppError.validation('Bloklar va bo‘limlarni birga berib bo‘lmaydi', [
        { path: 'blocks', message: "Bo'limlar yoki bloklardan faqat bittasini bering" },
      ]);
    }
    if (!scope.all && body.blocks && body.blocks.length !== 1) {
      throw AppError.forbidden("Nazorat ishi o'z faningizdan bitta blokdan iborat bo'ladi");
    }
    // Bitta blokli imtihon: sessiya fani = blok fani (o'qituvchi nazorat ishi shu shaklda)
    if (!body.subjectId && body.blocks?.length === 1) {
      body = { ...body, subjectId: body.blocks[0]!.subjectId };
    }

    if (!scope.all) {
      if (!settings.teachersCanCreateQuizzes) {
        throw AppError.forbidden("O'qituvchilar nazorat ishi yarata olmaydi (sozlama o'chiq)");
      }
      if (body.type !== 'quiz') {
        throw AppError.forbidden("O'qituvchi faqat nazorat ishi (quiz) yarata oladi");
      }
      if (!body.subjectId) {
        throw AppError.validation('Fan majburiy', [
          { path: 'subjectId', message: 'Fanni tanlang' },
        ]);
      }
      if (!scope.subjectIds.includes(body.subjectId)) {
        throw AppError.forbidden('Bu fan sizga biriktirilmagan');
      }
      if (!body.classIds.length) {
        throw AppError.validation('Sinf majburiy', [
          { path: 'classIds', message: 'Sinfni tanlang' },
        ]);
      }
      const pairs = await teacherPairs(schoolId, ctx.actor.id, year._id);
      for (const c of body.classIds) {
        if (!pairs.has(`${c}:${body.subjectId}`)) {
          throw AppError.forbidden("Bu sinfda shu fanni siz o'qitmaysiz");
        }
      }
    }
    if (!scope.all && body.blocks) {
      if (body.blocks.length !== 1 || body.blocks[0]!.subjectId !== body.subjectId) {
        throw AppError.forbidden("Nazorat ishi o'z faningizdan bitta blokdan iborat bo'ladi");
      }
    }
    if (body.subjectId) {
      const ok = await Subject.exists({
        _id: body.subjectId,
        $or: [{ schoolId: null }, { schoolId }],
      });
      if (!ok) throw AppError.notFound('Fan topilmadi');
    }
    const classIds = uniq(body.classIds);
    if (classIds.length) {
      const n = await ClassModel.countDocuments({
        _id: { $in: classIds },
        schoolId,
        academicYearId: year._id,
        isArchived: { $ne: true },
      });
      if (n !== classIds.length) {
        throw AppError.validation('Sinf topilmadi', [
          { path: 'classIds', message: "Faqat faol o'quv yilidagi sinflarni tanlash mumkin" },
        ]);
      }
    }

    let sections = body.sections;
    let blocksIn = body.blocks;
    let scoringIn = body.scoringMode;
    let timingIn = body.timingMode;
    let shuffleQ = body.shuffleQuestions;
    let shuffleO = body.shuffleOptions;
    let templateId: string | null = null;
    if (body.templateId) {
      const t = await ExamTemplate.findOne({
        _id: body.templateId,
        schoolId,
        isDeleted: { $ne: true },
      });
      if (!t || (!scope.all && String(t.createdBy) !== ctx.actor.id)) {
        throw AppError.notFound('Shablon topilmadi');
      }
      templateId = t.id as string;
      if (!sections && !blocksIn) {
        if (t.blocks?.length) {
          blocksIn = templateBlocksDto(t).map((b) => ({ ...b, blockId: undefined }));
        } else {
          sections = sectionsDto(t.sections);
        }
      }
      scoringIn = scoringIn ?? scoringModeOf(t);
      timingIn = timingIn ?? timingModeOf(t);
      shuffleQ = shuffleQ ?? t.shuffleQuestions;
      shuffleO = shuffleO ?? t.shuffleOptions;
    }
    if (!sections && !blocksIn) {
      throw AppError.validation("Savollar tanlovi yo'q", [
        { path: 'sections', message: "Shablon, bo'limlar yoki bloklarni bering" },
      ]);
    }
    const timing = blocksIn ? (timingIn ?? 'common') : 'common';
    const scoring = blocksIn ? (scoringIn ?? 'points') : 'points';
    if (!blocksIn && (timingIn === 'per_block' || scoringIn === 'coefficient')) {
      throw AppError.validation('Rejim faqat bloklar bilan', [
        { path: 'blocks', message: 'Koeffitsiyent va blokma-blok vaqt uchun bloklar kerak' },
      ]);
    }
    let storedBlocks: ReturnType<typeof storeBlocks> = [];
    let durationMin = body.durationMin;
    if (blocksIn) {
      const names = await validateBlocksInput(schoolId, scope, blocksIn, timing);
      assertBlocksOk(
        await inspectBlocks(
          ctx.actor,
          schoolId,
          scope,
          blocksIn.map((b) => ({ title: b.title ?? '', subjectId: b.subjectId, items: b.items })),
        ),
      );
      storedBlocks = storeBlocks(blocksIn, [], names, timing);
      if (timing === 'per_block')
        durationMin = sumBlockDurations(normalizeBlocks({ blocks: storedBlocks }));
    } else {
      assertSectionsOk(await inspectSections(ctx.actor, schoolId, scope, sections!));
    }
    if (!durationMin) {
      throw AppError.validation('Davomiylik kerak', [
        { path: 'durationMin', message: 'Davomiylikni kiriting' },
      ]);
    }
    if (body.contribDeadline && body.contribDeadline.getTime() > body.scheduledStart.getTime()) {
      throw AppError.validation('Muddat noto‘g‘ri', [
        {
          path: 'contribDeadline',
          message: 'Savol topshirish muddati imtihon boshlanishidan oldin bo‘lsin',
        },
      ]);
    }

    let period: unknown = null;
    if (body.periodId) {
      const p = year.periods.find((x) => String(x._id) === body.periodId);
      if (!p) {
        throw AppError.validation('Davr topilmadi', [
          { path: 'periodId', message: 'Davr topilmadi' },
        ]);
      }
      period = { periodId: p._id, name: p.name, startDate: p.startDate, endDate: p.endDate };
    }
    const supervisors = await validateSupervisors(schoolId, [
      ...body.supervisorIds,
      ...(ctx.actor.role === 'superadmin' ? [] : [ctx.actor.id]),
    ]);

    const doc = await ExamSession.create({
      schoolId,
      templateId,
      title: cleanText(body.title),
      type: body.type,
      subjectId: body.subjectId ?? null,
      classIds,
      academicYearId: year._id,
      period: period as never,
      scheduledStart: body.scheduledStart,
      durationMin,
      sections: (blocksIn ? [] : storeSections(sections!)) as never,
      blocks: storedBlocks as never,
      scoringMode: scoring,
      timingMode: timing,
      contribDeadline: body.contribDeadline ?? null,
      shuffleQuestions: shuffleQ ?? true,
      shuffleOptions: shuffleO ?? true,
      resultsMode: body.resultsMode,
      passPercent: body.passPercent ?? null,
      supervisorIds: supervisors,
      pinSalt: newPinSalt(),
      createdBy: ctx.actor.id,
    });
    await audit(ctx, schoolId, 'exam.session.create', doc.id, null, summary(doc));
    void notifyBlockAssignments(doc.id as string, contributorDiff([], normalizeBlocks(doc)));
    return (await toDto(ctx, scope, [doc], true))[0]!;
  },

  /** Faqat qoralamani tahrirlash (rad etilgan imtihon ham qoralamaga qaytadi) */
  async update(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof sessionPatchBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (s.status !== 'draft') throw AppError.conflict('Faqat qoralamani tahrirlash mumkin');
    const before = summary(s);
    const year = await activeYear(schoolId);

    if (body.type !== undefined) {
      if (!scope.all && body.type !== 'quiz') {
        throw AppError.forbidden("O'qituvchi faqat nazorat ishi (quiz) yarata oladi");
      }
      s.type = body.type;
    }
    if (body.subjectId !== undefined) {
      if (body.subjectId && !scope.all && !scope.subjectIds.includes(body.subjectId)) {
        throw AppError.forbidden('Bu fan sizga biriktirilmagan');
      }
      s.subjectId = (body.subjectId ?? null) as never;
    }
    if (body.classIds !== undefined) {
      const ids = uniq(body.classIds);
      const n = await ClassModel.countDocuments({
        _id: { $in: ids },
        schoolId,
        academicYearId: year._id,
      });
      if (n !== ids.length) {
        throw AppError.validation('Sinf topilmadi', [
          { path: 'classIds', message: 'Sinf topilmadi' },
        ]);
      }
      s.classIds = ids.map(oid) as never;
    }
    if (!scope.all) {
      const pairs = await teacherPairs(schoolId, ctx.actor.id, year._id);
      for (const c of s.classIds) {
        if (!s.subjectId || !pairs.has(`${c}:${s.subjectId}`)) {
          throw AppError.forbidden("Bu sinfda shu fanni siz o'qitmaysiz");
        }
      }
    }
    if (body.title !== undefined) s.title = cleanText(body.title);
    if (body.scheduledStart !== undefined) s.scheduledStart = body.scheduledStart;
    const prevBlocks = normalizeBlocks(s);
    const prevDeadline = s.contribDeadline;
    const hadBlocks = !prevBlocks[0]!.legacy;
    if (body.sections !== undefined && (hadBlocks || body.blocks)) {
      throw AppError.validation('Bloklar va bo‘limlarni birga berib bo‘lmaydi', [
        { path: 'sections', message: 'Blokli imtihonda bloklarni tahrirlang' },
      ]);
    }
    if (body.scoringMode !== undefined || body.timingMode !== undefined) {
      if (!hadBlocks && !body.blocks) {
        throw AppError.validation('Rejim faqat bloklar bilan', [
          { path: 'blocks', message: 'Koeffitsiyent va blokma-blok vaqt uchun bloklar kerak' },
        ]);
      }
      if (body.scoringMode !== undefined) s.scoringMode = body.scoringMode;
      if (body.timingMode !== undefined) s.timingMode = body.timingMode;
    }
    if (body.contribDeadline !== undefined)
      s.contribDeadline = (body.contribDeadline ?? null) as never;
    if (s.contribDeadline && s.contribDeadline.getTime() > s.scheduledStart.getTime()) {
      throw AppError.validation('Muddat noto‘g‘ri', [
        {
          path: 'contribDeadline',
          message: 'Savol topshirish muddati imtihon boshlanishidan oldin bo‘lsin',
        },
      ]);
    }
    if (body.blocks !== undefined) {
      if (
        !scope.all &&
        (body.blocks.length !== 1 || body.blocks[0]!.subjectId !== String(s.subjectId))
      ) {
        throw AppError.forbidden("Nazorat ishi o'z faningizdan bitta blokdan iborat bo'ladi");
      }
      const timing = timingModeOf(s);
      const names = await validateBlocksInput(schoolId, scope, body.blocks, timing);
      assertBlocksOk(
        await inspectBlocks(
          ctx.actor,
          schoolId,
          scope,
          body.blocks.map((b) => ({
            title: b.title ?? '',
            subjectId: b.subjectId,
            items: b.items,
          })),
        ),
      );
      s.blocks = storeBlocks(
        body.blocks.map((b) => ({ ...b, blockId: b.blockId === 'main' ? undefined : b.blockId })),
        prevBlocks.filter((b) => !b.legacy),
        names,
        timing,
      ) as never;
      s.sections = [] as never;
      s.templateId = null;
    } else if (body.timingMode !== undefined && hadBlocks && timingModeOf(s) === 'per_block') {
      if (normalizeBlocks(s).some((b) => !b.durationMin)) {
        throw AppError.validation('Blok davomiyligi kerak', [
          { path: 'blocks', message: 'Blokma-blok vaqtda har blokka davomiylik kiriting' },
        ]);
      }
    }
    if (timingModeOf(s) === 'per_block' && !s.blocks?.length) {
      throw AppError.validation('Blokma-blok vaqt uchun bloklar kerak', [
        { path: 'timingMode', message: 'Bloklar yo‘q' },
      ]);
    }
    if (timingModeOf(s) === 'per_block') {
      s.durationMin = sumBlockDurations(normalizeBlocks(s));
    } else if (body.durationMin !== undefined) {
      s.durationMin = body.durationMin;
    }
    if (body.shuffleQuestions !== undefined) s.shuffleQuestions = body.shuffleQuestions;
    if (body.shuffleOptions !== undefined) s.shuffleOptions = body.shuffleOptions;
    if (body.resultsMode !== undefined) s.resultsMode = body.resultsMode;
    if (body.passPercent !== undefined) s.passPercent = body.passPercent ?? null;
    if (body.supervisorIds !== undefined) {
      s.supervisorIds = (
        await validateSupervisors(schoolId, [
          ...body.supervisorIds,
          ...(isSupervisor(s, { id: String(s.createdBy) } as Actor) ? [String(s.createdBy)] : []),
        ])
      ).map(oid) as never;
    }
    if (body.sections !== undefined) {
      assertSectionsOk(await inspectSections(ctx.actor, schoolId, scope, body.sections));
      s.sections = storeSections(body.sections) as never;
      s.templateId = null;
    }
    let diff = body.blocks ? contributorDiff(prevBlocks, normalizeBlocks(s)) : [];
    // Nusxadan keyin: contribDeadline birinchi marta qo'yilganda barcha biriktirilganlarga xabar (dedupe qayta yubormaydi)
    if (!prevDeadline && s.contribDeadline) {
      diff = normalizeBlocks(s)
        .filter((b) => !b.legacy && b.contributors.length)
        .map((b) => ({ blockId: b.blockId, userIds: b.contributors }));
    }
    if (body.periodId !== undefined) {
      const p = body.periodId ? year.periods.find((x) => String(x._id) === body.periodId) : null;
      if (body.periodId && !p) {
        throw AppError.validation('Davr topilmadi', [
          { path: 'periodId', message: 'Davr topilmadi' },
        ]);
      }
      s.period = (
        p ? { periodId: p._id, name: p.name, startDate: p.startDate, endDate: p.endDate } : null
      ) as never;
    }
    await s.save();
    await audit(ctx, schoolId, 'exam.session.update', s.id, before, summary(s));
    void notifyBlockAssignments(s.id as string, diff);
    return (await toDto(ctx, scope, [s], true))[0]!;
  },

  /**
   * O'chirish. Ochiq (open) imtihonni o'chirib bo'lmaydi. Urinishlari yo'q imtihon: oddiy yumshoq o'chirish.
   * Urinishlari bor imtihon: `mode` majburiy:
   *  - exam_only: imtihon yashirinadi, natijalar "Natijalar" bo'limida qoladi (yopilgan imtihon uchun);
   *  - with_results: `confirmTitle` imtihon nomiga AYNAN teng bo'lishi shart; urinishlar, Telegram dedupe yozuvlari,
   *    kirish hisoblagichlari va sessiyaning o'zi BUTUNLAY o'chadi (qaytarib bo'lmaydi). Jurnal, baholar, reyting
   *    va boshqa modullarga TEGILMAYDI (imtihon natijalari ularga hech qachon ko'chirilmagan). Audit qoladi (faqat xulosa).
   */
  async remove(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof deleteBody> = {}) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (s.status === 'open') {
      throw AppError.conflict('Davom etayotgan (ochiq) imtihonni o‘chirib bo‘lmaydi: avval yoping');
    }
    const attempts = await ExamAttempt.countDocuments({ sessionId: s._id, schoolId });
    if (!attempts) {
      const before = summary(s);
      s.isDeleted = true;
      s.codeActive = false;
      await s.save();
      await dropEntryCodes(s._id);
      await audit(ctx, schoolId, 'exam.session.delete', s.id, before, { attempts: 0 });
      return { id: s.id as string, deleted: true, mode: 'none' as const };
    }
    if (!body.mode) {
      throw AppError.validation('O‘chirish usulini tanlang', [
        { path: 'mode', message: 'Faqat imtihon yoki natijalari bilan birga' },
      ]);
    }
    if (body.mode === 'exam_only') {
      if (s.status === 'closed') await persistResultsMeta(s.id);
      const before = summary(s);
      s.isDeleted = true;
      s.codeActive = false;
      s.resultsKept = s.status === 'closed';
      await s.save();
      await dropEntryCodes(s._id);
      await audit(ctx, schoolId, 'exam.session.delete', s.id, before, {
        mode: 'exam_only',
        attempts,
        resultsKept: s.resultsKept,
      });
      return { id: s.id as string, deleted: true, mode: 'exam_only' as const };
    }
    if (body.confirmTitle !== s.title) {
      throw AppError.validation('Imtihon nomi mos kelmadi', [
        { path: 'confirmTitle', message: 'Tasdiqlash uchun imtihon nomini aynan yozing' },
      ]);
    }
    const before = summary(s);
    const sessionId = s._id;
    const code = s.code;
    // Audit AVVAL (xulosa): o'chirish yarim yo'lda to'xtasa ham izi qoladi
    await audit(ctx, schoolId, 'exam.session.purge', s.id, before, {
      mode: 'with_results',
      attempts,
    });
    await ExamAttempt.deleteMany({ sessionId, schoolId });
    await dropEntryCodes(sessionId);
    await TelegramOutbox.deleteMany({ dedupeKey: new RegExp(`^exam:${String(sessionId)}:`) });
    if (code) {
      await ExamJoinGuard.deleteMany({ key: new RegExp(`^(dev|ip):${escapeRegex(code)}:`) });
    }
    await ExamSession.deleteOne({ _id: sessionId, schoolId });
    return { id: String(sessionId), deleted: true, mode: 'with_results' as const };
  },

  /**
   * "Nusxa olib yangi imtihon": yangi QORALAMA. Ko'chadi: nom (+ " (nusxa)"), bloklar (savollar, qoidalar, o'qituvchilar
   * qo'shgan savollar ham blok elementi sifatida), rejimlar, davomiylik, sozlamalar, sinflar, nazoratchilar.
   * Ko'chmaydi: ishtirokchilar, PIN, urinishlar, natijalar, sanalar (boshlanish ertangi 09:00 qo'yiladi),
   * contribDeadline, tasdiq holati, muzlatilgan savollar. Bankdan o'chirilgan/arxivlangan savollar tashlanadi va
   * `warnings` da qaytadi. Biriktirilgan o'qituvchilarga Telegram xabari NUSXA uchun yuborilmaydi: tuzuvchi yangi
   * contribDeadline qo'yib saqlaganda yuboriladi (update()).
   */
  async copy(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    const year = await activeYear(schoolId);
    const nblocks = normalizeBlocks(s);
    const legacy = nblocks[0]!.legacy;
    const warnings: string[] = [];

    const qids = new Set<string>();
    const topicIds = new Set<string>();
    const collect = (items: { kind: string; questionIds?: unknown[]; topicId?: unknown }[]) => {
      for (const it of items) {
        if (it.kind === 'manual') for (const q of it.questionIds ?? []) qids.add(String(q));
        else if (it.topicId) topicIds.add(String(it.topicId));
      }
    };
    if (legacy) for (const sec of s.sections) collect(sec.items as never);
    else for (const b of nblocks) collect(effectiveItems(b) as never);
    const [okQ, okT] = await Promise.all([
      Question.find({
        _id: { $in: [...qids].map(oid) },
        schoolId,
        isDeleted: { $ne: true },
        status: { $ne: 'archived' },
      })
        .select('_id')
        .lean(),
      ExamTopic.find({ _id: { $in: [...topicIds].map(oid) }, schoolId, isDeleted: { $ne: true } })
        .select('_id')
        .lean(),
    ]);
    const liveQ = new Set(okQ.map((x) => String(x._id)));
    const liveT = new Set(okT.map((x) => String(x._id)));
    let droppedQ = 0;
    let droppedRules = 0;
    const clean = (
      items: {
        kind: string;
        questionIds?: unknown[];
        topicId?: unknown;
        topicIds?: unknown[];
        allTopics?: boolean;
      }[],
    ) => {
      const seen = new Set<string>();
      const out: Record<string, unknown>[] = [];
      for (const it of items as Record<string, unknown>[]) {
        if (it.kind === 'manual') {
          const keep: string[] = [];
          for (const q of (it.questionIds as unknown[]) ?? []) {
            const k = String(q);
            if (!liveQ.has(k)) droppedQ++;
            else if (!seen.has(k)) {
              seen.add(k);
              keep.push(k);
            }
          }
          if (keep.length) out.push({ kind: 'manual', questionIds: keep.map(oid) });
        } else if (
          it.allTopics === true ||
          [...((it.topicIds as unknown[]) ?? []), ...(it.topicId ? [it.topicId] : [])]
            .map(String)
            .some((t) => liveT.has(t))
        ) {
          const keepTopics = [
            ...((it.topicIds as unknown[]) ?? []),
            ...(it.topicId ? [it.topicId] : []),
          ]
            .map(String)
            .filter((t) => liveT.has(t));
          out.push({
            kind: 'rule',
            topicId: keepTopics[0] ? oid(keepTopics[0]) : null,
            ...(it.allTopics === true ? { allTopics: true } : {}),
            ...(keepTopics.length > 1 || (it.topicIds as unknown[] | undefined)?.length
              ? { topicIds: [...new Set(keepTopics)].map(oid) }
              : {}),
            count: it.count,
            difficulty: it.difficulty ?? null,
            type: it.type ?? null,
          });
        } else {
          droppedRules++;
        }
      }
      return out;
    };
    const sections = legacy
      ? s.sections.map((sec) => ({ title: sec.title, items: clean(sec.items as never) }))
      : [];
    const blocks = legacy
      ? []
      : nblocks.map((b) => ({
          blockId: new Types.ObjectId().toHexString(),
          subjectId: oid(b.subjectId as string),
          title: b.title,
          targetCount: b.targetCount,
          coefficient: b.coefficient,
          durationMin: b.durationMin,
          contributors: b.contributors.map(oid),
          items: clean(effectiveItems(b) as never),
          contribQuestions: [],
          contribRules: [],
          status: 'open' as const,
          // Nusxa (§23): rejim, yetkazish usuli va KALIT ko'chadi; test fayllari ko'chmaydi (ekranda: "faylni qayta yuklang").
          // Savollar banki mazmuni yuqoridagi odatiy qoidalar bilan ko'chadi (fayl rejimida ham yashirin holda)
          content: b.content,
          bankTarget: b.bankTarget,
          fileTest: b.fileTest
            ? {
                delivery: b.fileTest.delivery,
                variants: b.fileTest.variants.map((v) => ({ ...v, files: [] })),
              }
            : null,
        }));
    if (droppedQ) {
      warnings.push(`${droppedQ} ta savol bankdan o'chirilgan yoki arxivlangan: nusxaga tushmadi`);
    }
    if (droppedRules) {
      warnings.push(`${droppedRules} ta qoida mavzusi o'chirilgan: nusxaga tushmadi`);
    }

    const classIds = s.classIds.length
      ? (
          await ClassModel.find({
            _id: { $in: s.classIds },
            schoolId,
            academicYearId: year._id,
            isArchived: { $ne: true },
          })
            .select('_id')
            .lean()
        ).map((c) => String(c._id))
      : [];
    if (classIds.length !== s.classIds.length) {
      warnings.push("Ba'zi sinflar joriy o'quv yilida yo'q: nusxaga tushmadi");
    }
    const sup = await User.find({
      _id: {
        $in: [
          ...s.supervisorIds.map(String),
          ...(ctx.actor.role === 'superadmin' ? [] : [ctx.actor.id]),
        ],
      },
      schoolId,
      role: { $in: ['teacher', 'school_admin'] },
      isActive: true,
    })
      .select('_id')
      .lean();
    const now = new Date();
    // Ertangi 09:00 (Toshkent, +05:00 = 04:00 UTC): foydalanuvchi ustada o'zgartiradi
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 4, 0, 0),
    );
    const doc = await ExamSession.create({
      schoolId,
      templateId: null,
      title: cleanText(`${s.title} (nusxa)`).slice(0, 150),
      type: s.type,
      subjectId: s.subjectId ?? null,
      classIds: classIds.map(oid),
      academicYearId: year._id,
      period: null,
      scheduledStart: start,
      durationMin: s.durationMin,
      sections: sections as never,
      blocks: blocks as never,
      scoringMode: scoringModeOf(s),
      timingMode: timingModeOf(s),
      contribDeadline: null,
      shuffleQuestions: s.shuffleQuestions,
      shuffleOptions: s.shuffleOptions,
      resultsMode: s.resultsMode,
      passPercent: s.passPercent ?? null,
      supervisorIds: sup.map((u) => u._id),
      pinSalt: newPinSalt(),
      createdBy: ctx.actor.id,
    });
    await audit(ctx, schoolId, 'exam.session.copy', doc.id, { from: s.id }, summary(doc));
    return { session: (await toDto(ctx, scope, [doc], true))[0]!, warnings };
  },

  /**
   * "Tahrirlash uchun qaytarish": scheduled/pending_approval va HECH KIM boshlamagan (urinish yo'q) imtihon qoralamaga
   * qaytadi. Poyga xavfsizligi: (1) shartli yangilash holatni draft + codeActive=false qiladi (yangi kirishlar
   * to'xtaydi), (2) shundan keyin urinishlar QAYTA tekshiriladi; bor bo'lsa holat qaytariladi (409). Tekshiruvdan
   * keyin kelgan "joined" urinish start() da rad etiladi (imtihon scheduled emas). Muzlatilgan savollar tozalanadi,
   * tasdiq tiklanadi, ishtirokchilar saqlanadi, barcha PIN va pinSalt qayta yaratiladi (eski PIN va PIN varaqasi
   * darhol yaroqsiz), scheduleVersion +1 (Telegram eslatma dedupe kaliti yangilanadi).
   */
  async returnToDraft(ctx: Ctx, schoolId: string, id: string) {
    assertPinSecret();
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    const prev = s.status;
    if (prev !== 'scheduled' && prev !== 'pending_approval') {
      throw AppError.conflict(
        'Faqat rejalashtirilgan yoki tasdiq kutayotgan imtihonni qaytarish mumkin',
      );
    }
    const prevActive = s.codeActive;
    const r = await ExamSession.updateOne(
      { _id: s._id, schoolId, status: prev, isDeleted: { $ne: true } },
      { $set: { status: 'draft', codeActive: false } },
    );
    if (!r.matchedCount) throw AppError.conflict('Imtihon holati o‘zgargan, sahifani yangilang');
    if (await ExamAttempt.exists({ sessionId: s._id, schoolId })) {
      await ExamSession.updateOne(
        { _id: s._id, status: 'draft' },
        { $set: { status: prev, codeActive: prevActive } },
      );
      throw AppError.conflict('Imtihonga allaqachon kirilgan: qoralamaga qaytarib bo‘lmaydi');
    }
    const fresh = (await ExamSession.findById(s._id))!;
    fresh.questionPool = [] as never;
    fresh.poolFrozenAt = null;
    fresh.code = null;
    fresh.approval = { status: 'none', by: null, at: null, reason: '' } as never;
    fresh.scheduleVersion = (fresh.scheduleVersion ?? 0) + 1;
    fresh.pinSalt = newPinSalt();
    const taken = new Set<string>();
    for (const p of fresh.participants) {
      const { pin, hash } = uniquePin(fresh.pinSalt, taken);
      taken.add(hash);
      p.pinHash = hash;
      p.pinEnc = encryptPin(pin, fresh.id as string);
      p.allowReentry = false;
    }
    // Shaxsiy kodlar ham qayta yaratiladi (eski kartochkalar yaroqsiz)
    await dropEntryCodes(fresh._id);
    for (const p of fresh.participants) p.codeEnc = await issueEntryCode(fresh, p.key);
    await fresh.save();
    await audit(
      ctx,
      schoolId,
      'exam.session.return_draft',
      fresh.id,
      { status: prev },
      {
        status: 'draft',
        participants: fresh.participants.length,
        scheduleVersion: fresh.scheduleVersion,
      },
    );
    return (await toDto(ctx, scope, [fresh], true))[0]!;
  },

  // ----- Ishtirokchilar -----
  async addParticipants(
    ctx: Ctx,
    schoolId: string,
    id: string,
    body: z.output<typeof participantsBody>,
  ) {
    assertPinSecret();
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (!['draft', 'scheduled', 'open'].includes(s.status)) {
      throw AppError.conflict('Bu holatda ishtirokchi qo‘shib bo‘lmaydi');
    }
    if (!scope.all && (body.guests.length || body.candidateIds.length)) {
      throw AppError.forbidden("Mehmon va nomzodlarni faqat ma'muriyat qo'shadi");
    }
    if (body.candidateIds.length && s.type !== 'admission') {
      throw AppError.validation('Nomzod faqat kirish imtihoniga qo‘shiladi', [
        { path: 'candidateIds', message: 'Imtihon turi: kirish imtihoni emas' },
      ]);
    }
    const year = await activeYear(schoolId);
    const allowedClass = async (classId: string) => {
      if (scope.all) return true;
      return s.classIds.some((c) => String(c) === classId);
    };

    const have = new Set(s.participants.map((p) => `${p.kind}:${p.refId ?? p.key}`));
    const specs: Parameters<typeof makeParticipants>[1] = [];
    let skipped = 0;
    const add = (sp: (typeof specs)[number]) => {
      const k = `${sp.kind}:${sp.refId ?? sp.fullName}`;
      if (sp.refId && have.has(k)) {
        skipped++;
        return;
      }
      if (sp.refId) have.add(k);
      specs.push(sp);
    };

    // Sinflar -> faqat FAOL o'quvchilar (o'chirilmagan, status active), joriy yil sinflari
    const classIds = uniq(body.classIds);
    for (const c of classIds) {
      if (!(await allowedClass(c)))
        throw AppError.forbidden('Bu sinf imtihon sinflari orasida emas');
    }
    const classes = classIds.length
      ? await ClassModel.find({ _id: { $in: classIds }, schoolId, academicYearId: year._id })
      : [];
    if (classes.length !== classIds.length) throw AppError.notFound('Sinf topilmadi');
    const clsMap = new Map(classes.map((c) => [String(c._id), c]));
    if (classIds.length) {
      const studs = await Student.find({
        schoolId,
        classId: { $in: classIds },
        status: 'active',
        isDeleted: { $ne: true },
      }).sort({ fullName: 1 });
      for (const st of studs) {
        const c = clsMap.get(String(st.classId))!;
        add({
          kind: 'student',
          refId: st._id,
          fullName: st.fullName,
          className: c.name,
          grade: c.grade,
          origin: null,
        });
      }
    }
    const studentIds = uniq(body.studentIds);
    if (studentIds.length) {
      const studs = await Student.find({
        _id: { $in: studentIds },
        schoolId,
        status: 'active',
        isDeleted: { $ne: true },
      });
      if (studs.length !== studentIds.length)
        throw AppError.notFound("O'quvchi topilmadi yoki faol emas");
      for (const st of studs) {
        if (!(await allowedClass(String(st.classId)))) {
          throw AppError.forbidden("Bu o'quvchi imtihon sinflari orasida emas");
        }
        const c = await ClassModel.findById(st.classId).select('name grade').lean();
        add({
          kind: 'student',
          refId: st._id,
          fullName: st.fullName,
          className: c?.name ?? null,
          grade: c?.grade ?? null,
          origin: null,
        });
      }
    }
    for (const g of body.guests) {
      add({
        kind: 'guest',
        refId: null,
        fullName: cleanText(g.fullName),
        className: null,
        grade: null,
        origin: cleanText(g.origin),
      });
    }
    const candIds = uniq(body.candidateIds);
    if (candIds.length) {
      const cands = await ExamCandidate.find({ _id: { $in: candIds }, schoolId });
      if (cands.length !== candIds.length) throw AppError.notFound('Nomzod topilmadi');
      for (const c of cands) {
        add({
          kind: 'candidate',
          refId: c._id,
          fullName: c.fullName,
          className: c.targetGrade ? `${c.targetGrade}-sinfga` : null,
          grade: c.targetGrade ?? null,
          origin: null,
        });
      }
    }
    if (s.participants.length + specs.length > MAX_PARTICIPANTS) {
      throw AppError.validation(`Ishtirokchilar ${MAX_PARTICIPANTS} tadan oshmasligi kerak`, [
        { path: 'participants', message: `Maksimum ${MAX_PARTICIPANTS} ta` },
      ]);
    }
    const created = await makeParticipants(s, specs);
    s.participants.push(...(created as never[]));
    await s.save();
    await audit(ctx, schoolId, 'exam.session.participants_add', s.id, null, {
      added: created.length,
      skipped,
      total: s.participants.length,
      guests: created.filter((p) => p.kind === 'guest').length,
      candidates: created.filter((p) => p.kind === 'candidate').length,
    });
    return { added: created.length, skipped, total: s.participants.length };
  },

  async removeParticipant(ctx: Ctx, schoolId: string, id: string, key: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (!['draft', 'scheduled', 'open'].includes(s.status)) {
      throw AppError.conflict('Bu holatda ishtirokchini olib tashlab bo‘lmaydi');
    }
    const i = s.participants.findIndex((p) => p.key === key);
    if (i < 0) throw AppError.notFound('Ishtirokchi topilmadi');
    const kind = s.participants[i]!.kind;
    s.participants.splice(i, 1);
    await s.save();
    await dropEntryCodes(s._id, key);
    await audit(
      ctx,
      schoolId,
      'exam.session.participant_remove',
      s.id,
      { kind },
      { total: s.participants.length },
    );
    return { removed: true, total: s.participants.length };
  },

  async regeneratePin(ctx: Ctx, schoolId: string, id: string, key: string) {
    assertPinSecret();
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (!['draft', 'scheduled', 'open'].includes(s.status)) {
      throw AppError.conflict('Bu holatda PIN ni qayta yaratib bo‘lmaydi');
    }
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    const taken = new Set(s.participants.filter((x) => x.key !== key).map((x) => x.pinHash));
    const { pin, hash } = uniquePin(s.pinSalt, taken);
    p.pinHash = hash;
    p.pinEnc = encryptPin(pin, s.id as string);
    // Shaxsiy kod ham yangilanadi (eski ishtirokchida bo'lmasa yaratiladi): eski kod darhol yaroqsiz
    await dropEntryCodes(s._id, key);
    p.codeEnc = await issueEntryCode(s, key);
    await s.save();
    await audit(ctx, schoolId, 'exam.session.pin_regenerate', s.id, null, { kind: p.kind });
    return { regenerated: true };
  },

  /**
   * Shaxsiy kodni ko'rsatish (admin paneldagi "ko'rsatish" tugmasi): kod ro'yxat DTO sida chiqmaydi, faqat shu
   * endpoint orqali, audit bilan. Eski ishtirokchida kod bo'lmasa null (qayta yaratish kerak).
   */
  async participantCode(ctx: Ctx, schoolId: string, id: string, key: string) {
    assertPinSecret();
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    const raw = p.codeEnc ? decryptEntryCode(p.codeEnc, s.id as string) : null;
    await audit(ctx, schoolId, 'exam.session.code_view', s.id, null, { kind: p.kind });
    return { code: raw ? formatEntryCode(raw) : null };
  },

  /**
   * Individual vaqt: faqat superadmin yoki shu imtihon nazoratchisi. `fullTime`: deadline = o'quvchi
   * boshlagan vaqt + davomiylik (kechikkan o'quvchiga to'liq vaqt); `extraMinutes`: qo'shimcha daqiqalar.
   */
  /**
   * Boshqa qurilmadan qayta kirishga bir martalik ruxsat (qurilma almashganda). Nazoratchi, yaratuvchi yoki ma'muriyat.
   */
  async allowReentry(ctx: Ctx, schoolId: string, id: string, key: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    if (!scope.all && !isSupervisor(s, ctx.actor) && !isCreator(s, ctx.actor))
      throw AppError.forbidden();
    if (!['scheduled', 'open'].includes(s.status)) {
      throw AppError.conflict('Faqat rejalashtirilgan yoki ochiq imtihonda ruxsat berish mumkin');
    }
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    p.allowReentry = true;
    await s.save();
    await audit(ctx, schoolId, 'exam.session.allow_reentry', s.id, null, { kind: p.kind });
    return { allowReentry: true };
  },

  /** Ishtirokchilar urinishlari holati (nazoratchi ekrani uchun minimal ma'lumot; javoblar va kalit YO'Q) */
  async attempts(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    const rows = await ExamAttempt.find({ sessionId: s._id, schoolId })
      .select(
        'participantKey status answeredCount order.qid startedAt submittedAt deadline lastSeenAt counters blockIndex terminated',
      )
      .lean();
    const byKey = new Map(rows.map((r) => [r.participantKey, r]));
    const items = s.participants.map((p) => {
      const a = byKey.get(p.key);
      const c = (a?.counters ?? {}) as Record<string, number>;
      const warnings = (c.blur ?? 0) + (c.fullscreenExit ?? 0) + (c.visibilityHidden ?? 0);
      return {
        key: p.key,
        status: a?.status ?? 'not_started',
        answered: a?.answeredCount ?? 0,
        total: a?.order?.length ?? 0,
        blockIndex: a?.blockIndex ?? 0,
        startedAt: a?.startedAt ?? null,
        submittedAt: a?.submittedAt ?? null,
        deadline: a?.deadline ?? null,
        lastSeenAt: a?.lastSeenAt ?? null,
        warnings,
        reconnects: c.reconnect ?? 0,
        allowReentry: p.allowReentry === true,
        terminated: a?.terminated ? { reason: a.terminated.reason } : null,
      };
    });
    const jf = (s.joinFailures ?? { count: 0, lastAt: null, alertAt: null }) as {
      count: number;
      lastAt: Date | null;
      alertAt: Date | null;
    };
    return {
      items,
      joinAlert: {
        failures: jf.count ?? 0,
        lastAt: jf.lastAt ?? null,
        alertAt: jf.alertAt ?? null,
      },
    };
  },

  async grant(
    ctx: Ctx,
    schoolId: string,
    id: string,
    key: string,
    body: z.output<typeof grantBody>,
  ) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    if (ctx.actor.role !== 'superadmin' && !isSupervisor(s, ctx.actor)) {
      throw AppError.forbidden('Vaqt berishni faqat superadmin yoki imtihon nazoratchisi bajaradi');
    }
    if (!['scheduled', 'open'].includes(s.status)) {
      throw AppError.conflict('Faqat rejalashtirilgan yoki ochiq imtihonda vaqt berish mumkin');
    }
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    const before = { fullTimeGranted: p.fullTimeGranted, extraMinutes: p.extraMinutes };
    if (body.fullTime !== undefined) p.fullTimeGranted = body.fullTime;
    if (body.extraMinutes !== undefined) p.extraMinutes = body.extraMinutes;
    await s.save();
    await audit(ctx, schoolId, 'exam.session.grant', s.id, before, {
      fullTimeGranted: p.fullTimeGranted,
      extraMinutes: p.extraMinutes,
    });
    return participantDto(p);
  },

  // ----- Holat o'tishlari -----
  async submit(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof submitBody> = {}) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (s.status !== 'draft') throw AppError.conflict('Faqat qoralamani yuborish mumkin');
    if (!s.participants.length) {
      throw AppError.validation('Ishtirokchilar yo‘q', [
        { path: 'participants', message: 'Kamida bitta ishtirokchi qo‘shing' },
      ]);
    }
    if (commonEnd(s) <= new Date()) {
      throw AppError.validation('Imtihon vaqti o‘tib ketgan', [
        { path: 'scheduledStart', message: 'Boshlanish vaqtini kelajakka qo‘ying' },
      ]);
    }
    const settings = await examSettings(schoolId);
    const needsApproval = !scope.all && settings.teacherQuizNeedsApproval;
    const before = summary(s);
    assertBlocksApproved(s);
    assertBlockTargets(s, body.confirmShort === true);
    if (needsApproval) {
      // Savollar yaroqliligi hozir ham tekshiriladi (nusxa tasdiqdan keyin muzlatiladi)
      const nb = normalizeBlocks(s);
      if (nb[0]!.legacy) {
        assertSectionsOk(
          await inspectSections(ctx.actor, schoolId, scope, sectionsDto(s.sections)),
        );
      } else {
        assertBlocksOk(
          await inspectBlocks(ctx.actor, schoolId, scope, nb.map(inspectBlockOfStored)),
        );
      }
      s.status = 'pending_approval';
      s.approval = { status: 'pending', by: null, at: null, reason: '' } as never;
      await s.save();
    } else {
      await schedule(schoolId, s, ctx, 'submit');
    }
    const fresh = (await ExamSession.findById(s._id))!;
    await audit(ctx, schoolId, 'exam.session.submit', s.id, before, summary(fresh));
    return (await toDto(ctx, scope, [fresh], true))[0]!;
  },

  async approve(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    if (!scope.all) throw AppError.forbidden("Tasdiqlashni faqat ma'muriyat bajaradi");
    const s = await findSession(ctx, schoolId, scope, id);
    if (s.status !== 'pending_approval') throw AppError.conflict('Imtihon tasdiq kutmayapti');
    if (commonEnd(s) <= new Date()) {
      throw AppError.validation('Imtihon vaqti o‘tib ketgan', [
        {
          path: 'scheduledStart',
          message: 'Avval boshlanish vaqtini o‘zgartirish kerak (rad eting)',
        },
      ]);
    }
    const before = summary(s);
    await schedule(schoolId, s, ctx, 'approve');
    const fresh = (await ExamSession.findById(s._id))!;
    await audit(ctx, schoolId, 'exam.session.approve', s.id, before, summary(fresh));
    return (await toDto(ctx, scope, [fresh], true))[0]!;
  },

  async reject(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof reasonBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    if (!scope.all) throw AppError.forbidden("Rad etishni faqat ma'muriyat bajaradi");
    const s = await findSession(ctx, schoolId, scope, id);
    if (s.status !== 'pending_approval') throw AppError.conflict('Imtihon tasdiq kutmayapti');
    const before = summary(s);
    s.status = 'draft';
    s.approval = {
      status: 'rejected',
      by: oid(ctx.actor.id),
      at: new Date(),
      reason: body.reason,
    } as never;
    await s.save();
    await audit(ctx, schoolId, 'exam.session.reject', s.id, before, {
      ...summary(s),
      reasonGiven: true,
    });
    return (await toDto(ctx, scope, [s], true))[0]!;
  },

  /** Muddatidan oldin ochish / qo'lda yopish: superadmin, ma'muriyat, nazoratchi yoki yaratuvchi */
  async open(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    if (!scope.all && !isSupervisor(s, ctx.actor) && !isCreator(s, ctx.actor))
      throw AppError.forbidden();
    if (s.status !== 'scheduled')
      throw AppError.conflict('Faqat rejalashtirilgan imtihonni ochish mumkin');
    const now = new Date();
    const prevStart = s.scheduledStart;
    // Muddatidan oldin "Hozir ochish": boshlanish hozirga suriladi (davomiylik o'zgarmaydi), aks holda o'quvchilar
    // eski boshlanish vaqtigacha kira olmaydi. Rejalashtirilgan imtihonda urinish bo'lmaydi (kirish boshlanishdan oldin yopiq).
    const shifted = now < prevStart;
    if (shifted) s.scheduledStart = now;
    s.status = 'open';
    s.openedAt = now;
    await s.save();
    await audit(
      ctx,
      schoolId,
      'exam.session.open',
      s.id,
      { status: 'scheduled', ...(shifted ? { scheduledStart: prevStart } : {}) },
      { status: 'open', ...(shifted ? { scheduledStart: now } : {}) },
    );
    return (await toDto(ctx, scope, [s], true))[0]!;
  },

  /**
   * Yopilgan imtihonni qayta ochish: majburiy sabab va YANGI umumiy tugash vaqti (kelajakda). Topshirganlar qayta
   * topshira olmaydi; boshlanmagan va jarayondagilar yangi tugashgacha kira oladi. Eski kod boshqa faol imtihonda
   * band bo'lsa yangi kod beriladi. Bekor qilingan imtihon ochilmaydi.
   */
  async reopen(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof reopenBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    if (!scope.all && !isSupervisor(s, ctx.actor) && !isCreator(s, ctx.actor))
      throw AppError.forbidden();
    if (s.status === 'cancelled')
      throw AppError.conflict('Bekor qilingan imtihonni qayta ochib bo‘lmaydi');
    if (s.status !== 'closed')
      throw AppError.conflict('Faqat yopilgan imtihonni qayta ochish mumkin');
    // Test fayli muddati tugagan bo'lsa (yopilgandan 14 kun keyin o'chadi): avval faylni qayta yuklash kerak (kalit saqlanadi)
    if ((await expiredFilesOf(s)).length) {
      throw AppError.conflict(
        'Test fayli muddati tugagan: imtihonni qayta ochishdan oldin faylni qayta yuklang (blok sahifasida, kalit o‘zgarmaydi)',
      );
    }
    const now = new Date();
    if (body.newEnd.getTime() <= now.getTime()) {
      throw AppError.validation('Yangi tugash vaqti kelajakda bo‘lishi kerak', [
        { path: 'newEnd', message: 'Kelajakdagi vaqtni tanlang' },
      ]);
    }
    const durationMin = Math.ceil((body.newEnd.getTime() - s.scheduledStart.getTime()) / 60_000);
    if (durationMin < 5 || durationMin > MAX_DURATION_MIN) {
      throw AppError.validation('Davomiylik noto‘g‘ri', [
        {
          path: 'newEnd',
          message: `Boshlanishdan 5 daqiqa..${MAX_DURATION_MIN / 60} soat oralig'ida bo'lishi kerak`,
        },
      ]);
    }
    const oldCode = s.code;
    let code = oldCode as string;
    let opened = false;
    for (let i = 0; i < 25 && !opened; i++) {
      try {
        const r = await ExamSession.updateOne(
          { _id: s._id, status: 'closed' },
          {
            $set: {
              status: 'open',
              openedAt: now,
              closedAt: null,
              durationMin,
              code,
              codeActive: true,
            },
          },
        );
        if (!r.matchedCount)
          throw AppError.conflict('Imtihon holati o‘zgargan, sahifani yangilang');
        opened = true;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        code = String(crypto.randomInt(100000, 1000000)); // eski kod band: yangisi
      }
    }
    if (!opened) throw AppError.unavailable('Imtihon kodini tanlab bo‘lmadi, qayta urinib ko‘ring');
    const fresh = (await ExamSession.findById(s._id))!;
    await recomputeDeadlines(fresh);
    await audit(
      ctx,
      schoolId,
      'exam.session.reopen',
      s.id,
      { status: 'closed' },
      {
        status: 'open',
        reason: body.reason,
        newEnd: body.newEnd,
        codeChanged: code !== oldCode,
      },
    );
    return { ...(await toDto(ctx, scope, [fresh], true))[0]!, codeChanged: code !== oldCode };
  },

  /** Ochiq imtihonda hammaga +N daqiqa: umumiy tugash va davom etayotgan urinishlar deadline i (to'liq vaqtlilar ham) */
  async extend(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof extendBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    if (!scope.all && !isSupervisor(s, ctx.actor) && !isCreator(s, ctx.actor))
      throw AppError.forbidden();
    if (s.status !== 'open') throw AppError.conflict('Faqat ochiq imtihonga vaqt qo‘shiladi');
    if (s.durationMin + body.minutes > MAX_DURATION_MIN) {
      throw AppError.validation('Davomiylik juda uzun', [
        {
          path: 'minutes',
          message: `Umumiy davomiylik ${MAX_DURATION_MIN / 60} soatdan oshmasligi kerak`,
        },
      ]);
    }
    const before = s.durationMin;
    const r = await ExamSession.findOneAndUpdate(
      { _id: s._id, status: 'open' },
      { $inc: { durationMin: body.minutes } },
      { returnDocument: 'after' },
    );
    if (!r) throw AppError.conflict('Imtihon holati o‘zgargan, sahifani yangilang');
    await recomputeDeadlines(r, body.minutes);
    await audit(
      ctx,
      schoolId,
      'exam.session.extend',
      s.id,
      { durationMin: before },
      {
        durationMin: r.durationMin,
        minutes: body.minutes,
        reason: body.reason ?? '',
      },
    );
    return (await toDto(ctx, scope, [r], true))[0]!;
  },

  async close(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    if (!scope.all && !isSupervisor(s, ctx.actor) && !isCreator(s, ctx.actor))
      throw AppError.forbidden();
    if (!['scheduled', 'open'].includes(s.status))
      throw AppError.conflict('Imtihon yopiq yoki hali boshlanmagan');
    const prev = s.status;
    s.status = 'closed';
    s.codeActive = false; // kod boshqa imtihon uchun bo'shaydi
    s.closedAt = new Date();
    await s.save();
    await persistResultsMeta(s.id);
    await audit(ctx, schoolId, 'exam.session.close', s.id, { status: prev }, { status: 'closed' });
    void notifyExamClosed(s.id as string);
    return (await toDto(ctx, scope, [s], true))[0]!;
  },

  async cancel(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof optionalReasonBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (!scope.all && s.status === 'open')
      throw AppError.forbidden("Ochiq imtihonni faqat ma'muriyat bekor qiladi");
    if (!['draft', 'pending_approval', 'scheduled', 'open'].includes(s.status)) {
      throw AppError.conflict('Bu holatda bekor qilib bo‘lmaydi');
    }
    const prev = s.status;
    s.status = 'cancelled';
    s.codeActive = false;
    s.cancelReason = body.reason ?? '';
    await s.save();
    await audit(
      ctx,
      schoolId,
      'exam.session.cancel',
      s.id,
      { status: prev },
      { status: 'cancelled', reasonGiven: !!body.reason },
    );
    return (await toDto(ctx, scope, [s], true))[0]!;
  },

  /** PIN varaqasi uchun ma'lumot (PIN lar shu yerda ochiladi, faqat PDF uchun) */
  async printData(ctx: Ctx, schoolId: string, id: string, className?: string) {
    assertPinSecret();
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertManager(s, scope, ctx.actor);
    if (!['scheduled', 'open', 'closed'].includes(s.status) || !s.code) {
      throw AppError.conflict('Avval imtihonni rejalashtiring (kod berilgach chop etiladi)');
    }
    const school = await School.findById(schoolId).select('name').lean();
    const list = s.participants
      .filter((p) => !className || (p.className ?? '') === className)
      .map((p) => ({
        fullName: p.fullName,
        className: p.className ?? p.origin ?? '',
        kind: p.kind,
        pin: decryptPin(p.pinEnc, s.id as string),
        code: p.codeEnc ? formatEntryCode(decryptEntryCode(p.codeEnc, s.id as string) ?? '') : null,
      }));
    await audit(ctx, schoolId, 'exam.session.pin_sheet', s.id, null, {
      count: list.length,
      filtered: !!className,
    });
    return {
      schoolName: school?.name ?? '',
      title: s.title,
      code: s.code as string,
      examUrl: env.EXAM_PUBLIC_URL ?? null,
      start: s.scheduledStart,
      durationMin: s.durationMin,
      list,
    };
  },
};

export { hashPin };
