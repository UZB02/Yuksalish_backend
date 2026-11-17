import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AcademicYear } from '../../../models/AcademicYear';
import { ClassSubject } from '../../../models/ClassSubject';
import { AppError, type ErrorDetail } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import {
  ExamTemplate,
  SCORING_MODES,
  TIMING_MODES,
  type ExamTemplateDoc,
} from '../../../models/ExamTemplate';
import { ExamTopic } from '../../../models/ExamTopic';
import { Question, QUESTION_TYPES } from '../../../models/Question';
import { Subject } from '../../../models/Subject';
import { User } from '../../../models/User';
import { isId, uniq } from '../../../utils/helpers';
import { cleanText } from '../../../utils/text';
import { auditService } from '../../audit/audit.service';
import { EXAMS_KEY, type ExamsSettings } from '../../settings/exams.settings';
import { settingsService } from '../../settings/settings.service';
import { effectivePermissions } from '../../users/user.dto';
import { resolveExamScope, type ExamScope } from '../exams.scope';
import { visibilityFilter } from '../exams.visibility';
import {
  MAX_BLOCKS,
  effectiveItems,
  normalizeBlocks,
  scoringModeOf,
  timingModeOf,
  type NBlock,
} from '../blocks/blocks.core';

type Actor = Ctx['actor'];

export const MAX_POOL = 500;
export const MAX_SECTIONS = 20;

// ---------- Sxemalar ----------
const manualItem = z
  .object({
    kind: z.literal('manual'),
    questionIds: z.array(objectIdSchema).min(1, 'Kamida bitta savol tanlang').max(MAX_POOL),
  })
  .strict();
const ruleItem = z
  .object({
    kind: z.literal('rule'),
    topicId: objectIdSchema,
    count: z.number().int().min(1, 'Kamida 1 ta').max(200, '200 tadan oshmasligi kerak'),
    difficulty: z.number().int().min(1).max(3).nullish(),
    type: z.enum(QUESTION_TYPES).nullish(),
  })
  .strict();
export const item = z.discriminatedUnion('kind', [manualItem, ruleItem]);
// eslint-disable-next-line no-control-regex
const NOCTRL = /^[^\u0000-\u001F\u007F]*$/;
const title = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} bo'sh bo'lmasligi kerak`)
    .max(150, `${label} 150 belgidan oshmasligi kerak`)
    .regex(NOCTRL, `${label}da boshqaruv belgilari bo'lmasligi kerak`);
/** Blok kiritish shakli (tuzuvchi). `blockId` mavjud blokni tahrirlashda beriladi (savollar saqlanib qoladi) */
export const blockInput = z
  .object({
    blockId: z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .optional(),
    subjectId: objectIdSchema,
    title: z
      .string()
      .trim()
      .max(150, 'Blok nomi 150 belgidan oshmasligi kerak')
      .regex(NOCTRL, "Blok nomida boshqaruv belgilari bo'lmasligi kerak")
      .optional(),
    targetCount: z.number().int().min(0).max(MAX_POOL).default(0),
    coefficient: z.number().min(0.01, 'Koeffitsiyent 0 dan katta').max(1000).default(1),
    durationMin: z.number().int().min(1, 'Kamida 1 daqiqa').max(600).nullish(),
    contributorIds: z.array(objectIdSchema).max(20).default([]),
    items: z.array(item).max(50).default([]),
  })
  .strict();
export const blocksSchema = z
  .array(blockInput)
  .min(1, 'Kamida bitta blok kerak')
  .max(MAX_BLOCKS, `${MAX_BLOCKS} tadan ko'p blok bo'lmasin`);
export type BlocksInput = z.infer<typeof blocksSchema>;

export const sectionsSchema = z
  .array(
    z
      .object({
        title: title('Bo‘lim nomi'),
        items: z.array(item).min(1, "Bo'limda kamida bitta element bo'lishi kerak").max(50),
      })
      .strict(),
  )
  .min(1, "Kamida bitta bo'lim kerak")
  .max(MAX_SECTIONS);
export type SectionsInput = z.infer<typeof sectionsSchema>;

export const templateBody = z
  .object({
    title: title('Shablon nomi'),
    subjectId: objectIdSchema.nullish(),
    sections: sectionsSchema.optional(),
    blocks: blocksSchema.optional(),
    scoringMode: z.enum(SCORING_MODES).optional(),
    timingMode: z.enum(TIMING_MODES).optional(),
    shuffleQuestions: z.boolean().default(true),
    shuffleOptions: z.boolean().default(true),
  })
  .strict()
  .refine((b) => !(b.sections && b.blocks), {
    message: "Bo'limlar yoki bloklardan faqat bittasini bering",
    path: ['blocks'],
  });
export const templatePatchBody = z
  .object({
    title: title('Shablon nomi'),
    subjectId: objectIdSchema.nullish(),
    sections: sectionsSchema,
    blocks: blocksSchema,
    scoringMode: z.enum(SCORING_MODES),
    timingMode: z.enum(TIMING_MODES),
    shuffleQuestions: z.boolean(),
    shuffleOptions: z.boolean(),
  })
  .partial()
  .strict();
export const previewBody = z
  .object({ sections: sectionsSchema.optional(), blocks: blocksSchema.optional() })
  .strict()
  .refine((b) => !!b.sections !== !!b.blocks, {
    message: "Bo'limlar yoki bloklardan aynan bittasini bering",
    path: ['blocks'],
  });

// ---------- Yordamchilar ----------
export async function examSettings(schoolId: string): Promise<ExamsSettings> {
  return settingsService.getEffective<ExamsSettings>(EXAMS_KEY, schoolId);
}

/** Foydalanuvchi hujjatidan Actor (savol ko'rinishi/doira hisoblash uchun: tasdiqlovchi emas, YARATUVCHI nomidan) */
export async function actorOfUser(userId: string): Promise<Actor | null> {
  const u = isId(userId) ? await User.findById(userId) : null;
  if (!u || !u.isActive) return null;
  return {
    id: u.id,
    role: u.role,
    schoolId: u.schoolId ? String(u.schoolId) : null,
    fullName: u.fullName,
    username: u.username,
    permissions: effectivePermissions(u.role, u.permissions),
  };
}

export const isAdministration = (scope: ExamScope) => scope.all;

export interface ItemInfo {
  kind: 'manual' | 'rule';
  /** manual: tanlangan va ko'rinadigan FAOL savollar; rule: mos keladigan FAOL savollar */
  available: number;
  /** manual: tanlangan soni; rule: talab qilingan soni */
  requested: number;
  ok: boolean;
  topicName?: string | null;
  /** Qoida: mavzu id (faollashtirish havolasi uchun) */
  topicId?: string;
  /** Mos keluvchi, lekin hali QORALAMA holatidagi (foydalanuvchiga ko'rinadigan) savollar soni */
  draft?: number;
}
export interface SectionsInfo {
  sections: { title: string; items: ItemInfo[] }[];
  errors: string[];
  poolIds: string[];
  /** Har ishtirokchi oladigan savollar soni (qo'lda + qoida bo'yicha) */
  questionsPerParticipant: number;
  /** Qoida elementlari uchun mos savollar: item -> id lar */
  rulePools: Map<string, string[]>;
}

const oid = (s: string) => new Types.ObjectId(s);

/**
 * Bo'limlarni tekshiradi (yaratuvchi doirasida): qo'lda savollar ko'rinadigan va FAOL bo'lishi,
 * qoidalar uchun mavzu ruxsat etilgan va yetarli FAOL savol bo'lishi shart. Xatoni TASHLAMAYDI: hisobot beradi.
 */
export async function inspectSections(
  actor: Actor,
  schoolId: string,
  scope: ExamScope,
  sections: SectionsInput,
  /** Blok: elementlar shu fanga tegishli bo'lishi shart */
  opts: { subjectId?: string | null } = {},
): Promise<SectionsInfo> {
  const vis = visibilityFilter(actor, schoolId, scope);
  const base: Record<string, unknown>[] = [...vis, { status: 'active' }];
  if (opts.subjectId) base.push({ subjectId: oid(opts.subjectId) });
  const errors: string[] = [];
  const poolIds = new Set<string>();
  const rulePools = new Map<string, string[]>();
  let perParticipant = 0;
  const out: SectionsInfo['sections'] = [];

  for (const [si, sec] of sections.entries()) {
    const items: ItemInfo[] = [];
    for (const [ii, it] of sec.items.entries()) {
      const where = `${si + 1}-bo'lim, ${ii + 1}-element`;
      if (it.kind === 'manual') {
        const ids = uniq(it.questionIds);
        const found = await Question.find({ $and: [...base, { _id: { $in: ids.map(oid) } }] })
          .select('_id')
          .lean();
        const ok = found.length === ids.length;
        const draft = ok
          ? 0
          : await Question.countDocuments({
              $and: [...vis, { status: 'draft' }, { _id: { $in: ids.map(oid) } }],
            });
        if (!ok) {
          errors.push(
            `${where}: ${ids.length - found.length} ta savol topilmadi, faol emas yoki sizga ko'rinmaydi` +
              (draft ? ` (${draft} tasi qoralamada)` : ''),
          );
        }
        for (const f of found) poolIds.add(String(f._id));
        perParticipant += found.length;
        items.push({ kind: 'manual', available: found.length, requested: ids.length, ok, draft });
        continue;
      }
      // qoida
      const topic = await ExamTopic.findOne({
        _id: it.topicId,
        schoolId,
        isDeleted: { $ne: true },
      }).lean();
      if (
        !topic ||
        (!scope.all && !scope.subjectIds.includes(String(topic.subjectId))) ||
        (opts.subjectId && String(topic.subjectId) !== opts.subjectId)
      ) {
        errors.push(
          `${where}: mavzu topilmadi${opts.subjectId ? ', blok faniga mos emas' : ''} yoki bu fan sizga biriktirilmagan`,
        );
        items.push({
          kind: 'rule',
          available: 0,
          requested: it.count,
          ok: false,
          topicName: null,
          draft: 0,
        });
        continue;
      }
      const filter: Record<string, unknown>[] = [...base, { topicId: oid(it.topicId) }];
      if (it.difficulty) filter.push({ difficulty: it.difficulty });
      if (it.type) filter.push({ type: it.type });
      const ids = (await Question.find({ $and: filter }).select('_id').lean()).map((q) =>
        String(q._id),
      );
      const ok = ids.length >= it.count;
      const draft = ok
        ? 0
        : await Question.countDocuments({
            $and: filter.map((f) => ('status' in f ? { status: 'draft' } : f)),
          });
      if (!ok) {
        errors.push(
          `${where}: "${topic.name}" mavzusida mos FAOL savol yetarli emas (kerak ${it.count}, bor ${ids.length})` +
            (draft ? `. Qoralamada ${draft} ta savol bor: mavzuni ochib faollashtiring` : ''),
        );
      }
      for (const id of ids) poolIds.add(id);
      rulePools.set(`${si}.${ii}`, ids);
      perParticipant += it.count;
      items.push({
        kind: 'rule',
        available: ids.length,
        requested: it.count,
        ok,
        topicName: topic.name,
        topicId: String(topic._id),
        draft,
      });
    }
    out.push({ title: sec.title, items });
  }
  if (poolIds.size > MAX_POOL) {
    errors.push(`Savollar to'plami ${MAX_POOL} tadan oshmasligi kerak (hozir ${poolIds.size})`);
  }
  return {
    sections: out,
    errors,
    poolIds: [...poolIds],
    questionsPerParticipant: perParticipant,
    rulePools,
  };
}

export function assertSectionsOk(info: SectionsInfo) {
  if (info.errors.length) {
    const details: ErrorDetail[] = info.errors.map((m) => ({ path: 'sections', message: m }));
    throw AppError.validation("Savollar tanlovi noto'g'ri", details);
  }
}

export type ItemsInput = z.infer<typeof item>[];

/** Elementlarni saqlanadigan shaklga (ObjectId lar) o'giradi */
export const storeItems = (items: ItemsInput) =>
  items.map((i) =>
    i.kind === 'manual'
      ? { kind: 'manual', questionIds: uniq(i.questionIds).map(oid) }
      : {
          kind: 'rule',
          topicId: oid(i.topicId),
          count: i.count,
          difficulty: i.difficulty ?? null,
          type: i.type ?? null,
        },
  );

/** Shablon/sessiyaga saqlanadigan shakl (ObjectId lar) */
export const storeSections = (sections: SectionsInput) =>
  sections.map((s) => ({ title: cleanText(s.title), items: storeItems(s.items) }));

/** Saqlangan elementlarni API shakliga (satr id lar) qaytaradi; poolIds chiqarilmaydi */
export const itemsDto = (stored: unknown): ItemsInput =>
  ((stored as Record<string, unknown>[]) ?? []).map((i) =>
    i.kind === 'manual'
      ? { kind: 'manual' as const, questionIds: (i.questionIds as unknown[]).map(String) }
      : {
          kind: 'rule' as const,
          topicId: String(i.topicId),
          count: Number(i.count),
          difficulty: (i.difficulty as number | null) ?? null,
          type: (i.type as (typeof QUESTION_TYPES)[number] | null) ?? null,
        },
  );

/** Saqlangan bo'limlarni API shakliga (satr id lar) qaytaradi; poolIds chiqarilmaydi */
export const sectionsDto = (stored: unknown): SectionsInput =>
  ((stored as { title: string; items: Record<string, unknown>[] }[]) ?? []).map((s) => ({
    title: s.title,
    items: itemsDto(s.items),
  }));

// ---------- Bloklar ----------
export const newBlockId = () => new Types.ObjectId().toHexString();

export interface BlockInfo {
  title: string;
  items: ItemInfo[];
  /** Har ishtirokchi shu blokdan oladigan savollar soni (qo'lda + qoidalar) */
  count: number;
  target: number;
  ok: boolean;
}
export interface BlocksInspect {
  blocks: BlockInfo[];
  errors: string[];
  poolIds: string[];
  questionsPerParticipant: number;
  /** Qoida elementlari: "<blokIndeks>.<elementIndeks>" -> mos savol id lari */
  rulePools: Map<string, string[]>;
}

/** Inspect uchun blok: saqlangan (NBlock) yoki kiritilgan shakldan */
export interface InspectBlock {
  title: string;
  subjectId: string | null;
  items: ItemsInput;
}
export const inspectBlockOfStored = (b: NBlock): InspectBlock => ({
  title: b.title,
  subjectId: b.subjectId,
  items: itemsDto(effectiveItems(b)),
});

/**
 * Bloklarni tekshiradi (yaratuvchi doirasida): har blok elementlari shu blok fanidagi FAOL savollar bo'lishi,
 * bir savol ikki blokda qo'lda tanlanmagan bo'lishi shart. Xatoni TASHLAMAYDI: hisobot beradi.
 * subjectId yo'q (eski, blokisiz) bo'lsa fan cheklovi qo'llanmaydi.
 */
export async function inspectBlocks(
  actor: Actor,
  schoolId: string,
  scope: ExamScope,
  blocks: InspectBlock[],
): Promise<BlocksInspect> {
  const errors: string[] = [];
  const poolIds = new Set<string>();
  const rulePools = new Map<string, string[]>();
  const out: BlockInfo[] = [];
  const manualOwner = new Map<string, number>();
  let perParticipant = 0;
  for (const [bi, b] of blocks.entries()) {
    const label = `${bi + 1}-blok${b.title ? ` (${b.title})` : ''}`;
    const info = await inspectSections(
      actor,
      schoolId,
      scope,
      [{ title: b.title || label, items: b.items }],
      { subjectId: b.subjectId },
    );
    for (const e of info.errors) errors.push(`${label}: ${e.replace(/^1-bo'lim, /, '')}`);
    for (const [k, ids] of info.rulePools) rulePools.set(`${bi}.${k.split('.')[1]}`, ids);
    for (const id of info.poolIds) poolIds.add(id);
    for (const it of b.items) {
      if (it.kind !== 'manual') continue;
      for (const q of it.questionIds) {
        const prev = manualOwner.get(q);
        if (prev !== undefined && prev !== bi) {
          errors.push(`${label}: bir savol ikki blokda tanlangan (${prev + 1}-blok bilan takror)`);
        }
        manualOwner.set(q, bi);
      }
    }
    perParticipant += info.questionsPerParticipant;
    out.push({
      title: b.title,
      items: info.sections[0]?.items ?? [],
      count: info.questionsPerParticipant,
      target: 0,
      ok: info.errors.length === 0,
    });
  }
  if (poolIds.size > MAX_POOL) {
    errors.push(`Savollar to'plami ${MAX_POOL} tadan oshmasligi kerak (hozir ${poolIds.size})`);
  }
  return {
    blocks: out,
    errors: [...new Set(errors)],
    poolIds: [...poolIds],
    questionsPerParticipant: perParticipant,
    rulePools,
  };
}

export function assertBlocksOk(info: BlocksInspect) {
  if (info.errors.length) {
    const details: ErrorDetail[] = info.errors.map((m) => ({ path: 'blocks', message: m }));
    throw AppError.validation("Savollar tanlovi noto'g'ri", details);
  }
}

/**
 * Bloklar kiritishini tekshiradi: fanlar (o'qituvchi uchun faqat o'z fanlari), biriktirilgan xodimlar
 * (faqat ma'muriyat biriktiradi; faol o'qituvchi/maktab admini), per_block da davomiyliklar.
 * Qaytaradi: fan nomlari (blok nomi bo'sh bo'lsa fan nomi qo'yiladi).
 */
export async function validateBlocksInput(
  schoolId: string,
  scope: ExamScope,
  blocks: BlocksInput,
  timing: 'common' | 'per_block',
): Promise<Map<string, string>> {
  const ids = uniq(blocks.map((b) => b.subjectId));
  const subs = await Subject.find({
    _id: { $in: ids },
    isActive: true,
    $or: [{ schoolId: null }, { schoolId }],
  })
    .select('name')
    .lean();
  if (subs.length !== ids.length) {
    throw AppError.validation('Fan topilmadi', [{ path: 'blocks', message: 'Fan topilmadi' }]);
  }
  if (!scope.all) {
    for (const id of ids) {
      if (!scope.subjectIds.includes(id)) throw AppError.forbidden('Bu fan sizga biriktirilmagan');
    }
  }
  const cids = uniq(blocks.flatMap((b) => b.contributorIds));
  if (cids.length) {
    if (!scope.all) {
      throw AppError.forbidden("Bloklarga o'qituvchi biriktirishni faqat ma'muriyat bajaradi");
    }
    const users = await User.find({
      _id: { $in: cids },
      schoolId,
      role: { $in: ['teacher', 'school_admin'] },
      isActive: true,
    })
      .select('role')
      .lean();
    if (users.length !== cids.length) {
      throw AppError.validation("O'qituvchi topilmadi", [
        {
          path: 'blocks',
          message: "Faqat shu maktabning faol o'qituvchilarini biriktirish mumkin",
        },
      ]);
    }
    // O'qituvchi blok fanini o'qitishi shart (savollar banki doirasi shunga bog'liq); maktab admini istalgan fanga
    const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
    const teacherIds = users.filter((u) => u.role === 'teacher').map((u) => String(u._id));
    const taught = new Set<string>();
    if (teacherIds.length && year) {
      const rows = await ClassSubject.find({
        schoolId,
        teacherId: { $in: teacherIds },
        academicYearId: year._id,
      })
        .select('teacherId subjectId')
        .lean();
      for (const r of rows) taught.add(`${r.teacherId}:${r.subjectId}`);
    }
    for (const [i, b] of blocks.entries()) {
      for (const uid of b.contributorIds) {
        if (teacherIds.includes(uid) && !taught.has(`${uid}:${b.subjectId}`)) {
          throw AppError.validation("O'qituvchi bu fanni o'qitmaydi", [
            {
              path: `blocks.${i}.contributorIds`,
              message: "Blokka faqat shu fanni o'qitadigan o'qituvchi biriktiriladi",
            },
          ]);
        }
      }
    }
  }
  if (timing === 'per_block') {
    for (const [i, b] of blocks.entries()) {
      if (!b.durationMin) {
        throw AppError.validation('Blok davomiyligi kerak', [
          {
            path: `blocks.${i}.durationMin`,
            message: 'Blokma-blok vaqtda har blokka davomiylik kiriting',
          },
        ]);
      }
    }
    const total = blocks.reduce((n, b) => n + (b.durationMin ?? 0), 0);
    if (total < 5 || total > 1440) {
      throw AppError.validation('Umumiy davomiylik noto‘g‘ri', [
        {
          path: 'blocks',
          message: "Bloklar davomiyligi yig'indisi 5 daqiqadan 24 soatgacha bo'lsin",
        },
      ]);
    }
  }
  return new Map(subs.map((s) => [String(s._id), s.name]));
}

/**
 * Kiritishdan saqlanadigan bloklar. Mavjud blokni (blockId bo'yicha) tahrirlashda biriktirilgan o'qituvchilar
 * qo'shgan savollar va tayyorlik holati saqlanadi; fani o'zgargan blokda o'qituvchi savollari tashlanadi.
 */
export function storeBlocks(
  input: BlocksInput,
  existing: NBlock[],
  subjectNames: Map<string, string>,
  timing: 'common' | 'per_block',
) {
  return input.map((b) => {
    const prev = b.blockId ? existing.find((e) => e.blockId === b.blockId) : undefined;
    const sameSubject = !!prev && prev.subjectId === b.subjectId;
    return {
      blockId: prev?.blockId ?? newBlockId(),
      subjectId: oid(b.subjectId),
      title: cleanText(b.title || subjectNames.get(b.subjectId) || ''),
      targetCount: b.targetCount,
      coefficient: b.coefficient,
      durationMin: timing === 'per_block' ? (b.durationMin ?? null) : null,
      contributors: uniq(b.contributorIds).map(oid),
      items: storeItems(b.items),
      contribQuestions: sameSubject
        ? prev!.contribQuestions.map((c) => ({
            questionId: oid(c.questionId),
            addedBy: oid(c.addedBy),
            addedAt: c.addedAt,
          }))
        : [],
      status: sameSubject ? prev!.status : ('open' as const),
    };
  });
}

/** Shablon uchun blok DTO: o'qituvchilar va ularning savollari shablonga o'tmaydi */
export const templateBlocksDto = (t: { blocks?: unknown[] }) =>
  normalizeBlocks({ blocks: t.blocks, sections: [] })
    .filter((b) => !b.legacy)
    .map((b) => ({
      blockId: b.blockId,
      subjectId: b.subjectId as string,
      title: b.title,
      targetCount: b.targetCount,
      coefficient: b.coefficient,
      durationMin: b.durationMin,
      contributorIds: [] as string[],
      items: itemsDto(b.items),
    }));

// ---------- Shablonlar ----------
const notFound = () => AppError.notFound('Shablon topilmadi');

const audit = (
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
    entity: 'exam_template',
    entityId: id,
    before,
    after,
    ip: ctx.ip,
  });

const summary = (t: ExamTemplateDoc) => ({
  sections: t.sections.length,
  blocks: t.blocks?.length ?? 0,
  scoringMode: scoringModeOf(t),
  timingMode: timingModeOf(t),
  items: t.sections.reduce((n, s) => n + s.items.length, 0),
  shuffleQuestions: t.shuffleQuestions,
  shuffleOptions: t.shuffleOptions,
});

async function assertCanUseTemplates(ctx: Ctx, schoolId: string, scope: ExamScope) {
  if (scope.all) return;
  const s = await examSettings(schoolId);
  if (!s.teachersCanCreateQuizzes) {
    throw AppError.forbidden("O'qituvchilar nazorat ishi yarata olmaydi (sozlama o'chiq)");
  }
}

async function subjectCheck(schoolId: string, scope: ExamScope, subjectId?: string | null) {
  if (!subjectId) return null;
  if (!scope.all && !scope.subjectIds.includes(subjectId)) {
    throw AppError.forbidden('Bu fan sizga biriktirilmagan');
  }
  const ok = await Subject.exists({ _id: subjectId, $or: [{ schoolId: null }, { schoolId }] });
  if (!ok) throw AppError.notFound('Fan topilmadi');
  return subjectId;
}

async function toDto(ctx: Ctx, scope: ExamScope, docs: ExamTemplateDoc[]) {
  const users = await User.find({ _id: { $in: uniq(docs.map((d) => String(d.createdBy))) } })
    .select('fullName')
    .lean();
  const names = new Map(users.map((u) => [String(u._id), u.fullName]));
  return docs.map((d) => ({
    id: d.id as string,
    title: d.title,
    subjectId: d.subjectId ? String(d.subjectId) : null,
    sections: sectionsDto(d.sections),
    blocks: templateBlocksDto(d),
    scoringMode: scoringModeOf(d),
    timingMode: timingModeOf(d),
    shuffleQuestions: d.shuffleQuestions,
    shuffleOptions: d.shuffleOptions,
    createdBy: String(d.createdBy),
    createdByName: names.get(String(d.createdBy)) ?? null,
    isMine: String(d.createdBy) === ctx.actor.id,
    canEdit: scope.all || String(d.createdBy) === ctx.actor.id,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));
}

async function findTemplate(ctx: Ctx, schoolId: string, scope: ExamScope, id: string) {
  const t = isId(id)
    ? await ExamTemplate.findOne({ _id: id, schoolId, isDeleted: { $ne: true } })
    : null;
  // O'qituvchi faqat o'z shablonini ko'radi; boshqasiniki 404
  if (!t || (!scope.all && String(t.createdBy) !== ctx.actor.id)) throw notFound();
  return t;
}

export const templatesService = {
  async preview(ctx: Ctx, schoolId: string, body: z.infer<typeof previewBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    await assertCanUseTemplates(ctx, schoolId, scope);
    if (body.blocks) {
      const info = await inspectBlocks(
        ctx.actor,
        schoolId,
        scope,
        body.blocks.map((b) => ({ title: b.title ?? '', subjectId: b.subjectId, items: b.items })),
      );
      return {
        sections: [] as { title: string; items: ItemInfo[] }[],
        blocks: info.blocks.map((b, i) => ({
          ...b,
          target: body.blocks![i]!.targetCount,
          ok: b.ok && b.count >= body.blocks![i]!.targetCount,
        })),
        errors: info.errors,
        poolSize: info.poolIds.length,
        questionsPerParticipant: info.questionsPerParticipant,
        ok: info.errors.length === 0,
      };
    }
    const info = await inspectSections(ctx.actor, schoolId, scope, body.sections!);
    return {
      sections: info.sections,
      blocks: [] as BlockInfo[],
      errors: info.errors,
      poolSize: info.poolIds.length,
      questionsPerParticipant: info.questionsPerParticipant,
      ok: info.errors.length === 0,
    };
  },

  async list(ctx: Ctx, schoolId: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const filter: Record<string, unknown> = { schoolId, isDeleted: { $ne: true } };
    if (!scope.all) filter.createdBy = ctx.actor.id;
    const docs = await ExamTemplate.find(filter).sort({ updatedAt: -1 }).limit(200);
    return toDto(ctx, scope, docs);
  },

  async get(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const t = await findTemplate(ctx, schoolId, scope, id);
    return (await toDto(ctx, scope, [t]))[0]!;
  },

  async create(ctx: Ctx, schoolId: string, body: z.infer<typeof templateBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    await assertCanUseTemplates(ctx, schoolId, scope);
    const subjectId = await subjectCheck(schoolId, scope, body.subjectId);
    if (!body.sections && !body.blocks) {
      throw AppError.validation("Savollar tanlovi yo'q", [
        { path: 'sections', message: "Bo'limlar yoki bloklarni bering" },
      ]);
    }
    const timing = body.timingMode ?? 'common';
    let blocks: ReturnType<typeof storeBlocks> = [];
    if (body.blocks) {
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
      blocks = storeBlocks(
        body.blocks.map((b) => ({ ...b, contributorIds: [], blockId: undefined })),
        [],
        names,
        timing,
      );
    } else {
      assertSectionsOk(await inspectSections(ctx.actor, schoolId, scope, body.sections!));
    }
    const doc = await ExamTemplate.create({
      schoolId,
      title: cleanText(body.title),
      subjectId,
      sections: (body.sections ? storeSections(body.sections) : []) as never,
      blocks: blocks as never,
      scoringMode: body.scoringMode ?? 'points',
      timingMode: timing,
      shuffleQuestions: body.shuffleQuestions,
      shuffleOptions: body.shuffleOptions,
      createdBy: ctx.actor.id,
    });
    await audit(ctx, schoolId, 'exam.template.create', doc.id, null, summary(doc));
    return (await toDto(ctx, scope, [doc]))[0]!;
  },

  async update(ctx: Ctx, schoolId: string, id: string, body: z.infer<typeof templatePatchBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    await assertCanUseTemplates(ctx, schoolId, scope);
    const t = await findTemplate(ctx, schoolId, scope, id);
    const before = summary(t);
    if (body.title !== undefined) t.title = cleanText(body.title);
    if (body.subjectId !== undefined) {
      t.subjectId = (await subjectCheck(schoolId, scope, body.subjectId)) as never;
    }
    if (body.scoringMode !== undefined) t.scoringMode = body.scoringMode;
    if (body.timingMode !== undefined) t.timingMode = body.timingMode;
    if (body.sections) {
      assertSectionsOk(await inspectSections(ctx.actor, schoolId, scope, body.sections));
      t.sections = storeSections(body.sections) as never;
      t.blocks = [] as never;
    }
    if (body.blocks) {
      const timing = timingModeOf(t);
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
      t.blocks = storeBlocks(
        body.blocks.map((b) => ({ ...b, contributorIds: [] })),
        normalizeBlocks({ blocks: t.blocks }),
        names,
        timing,
      ) as never;
      t.sections = [] as never;
    }
    if (body.shuffleQuestions !== undefined) t.shuffleQuestions = body.shuffleQuestions;
    if (body.shuffleOptions !== undefined) t.shuffleOptions = body.shuffleOptions;
    await t.save();
    await audit(ctx, schoolId, 'exam.template.update', t.id, before, summary(t));
    return (await toDto(ctx, scope, [t]))[0]!;
  },

  async remove(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const t = await findTemplate(ctx, schoolId, scope, id);
    t.isDeleted = true;
    t.deletedAt = new Date();
    await t.save();
    await audit(ctx, schoolId, 'exam.template.delete', t.id, summary(t), null);
    return { id: t.id as string, deleted: true };
  },
};
