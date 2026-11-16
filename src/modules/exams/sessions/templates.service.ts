import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError, type ErrorDetail } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import { ExamTemplate, type ExamTemplateDoc } from '../../../models/ExamTemplate';
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
const item = z.discriminatedUnion('kind', [manualItem, ruleItem]);
// eslint-disable-next-line no-control-regex
const NOCTRL = /^[^\u0000-\u001F\u007F]*$/;
const title = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} bo'sh bo'lmasligi kerak`)
    .max(150, `${label} 150 belgidan oshmasligi kerak`)
    .regex(NOCTRL, `${label}da boshqaruv belgilari bo'lmasligi kerak`);
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
    sections: sectionsSchema,
    shuffleQuestions: z.boolean().default(true),
    shuffleOptions: z.boolean().default(true),
  })
  .strict();
export const templatePatchBody = templateBody.partial().strict();
export const previewBody = z.object({ sections: sectionsSchema }).strict();

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
): Promise<SectionsInfo> {
  const vis = visibilityFilter(actor, schoolId, scope);
  const base = [...vis, { status: 'active' }];
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
      if (!topic || (!scope.all && !scope.subjectIds.includes(String(topic.subjectId)))) {
        errors.push(`${where}: mavzu topilmadi yoki bu fan sizga biriktirilmagan`);
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

/** Shablon/sessiyaga saqlanadigan shakl (ObjectId lar) */
export const storeSections = (sections: SectionsInput) =>
  sections.map((s) => ({
    title: cleanText(s.title),
    items: s.items.map((i) =>
      i.kind === 'manual'
        ? { kind: 'manual', questionIds: uniq(i.questionIds).map(oid) }
        : {
            kind: 'rule',
            topicId: oid(i.topicId),
            count: i.count,
            difficulty: i.difficulty ?? null,
            type: i.type ?? null,
          },
    ),
  }));

/** Saqlangan bo'limlarni API shakliga (satr id lar) qaytaradi; poolIds chiqarilmaydi */
export const sectionsDto = (stored: unknown): SectionsInput =>
  ((stored as { title: string; items: Record<string, unknown>[] }[]) ?? []).map((s) => ({
    title: s.title,
    items: s.items.map((i) =>
      i.kind === 'manual'
        ? { kind: 'manual' as const, questionIds: (i.questionIds as unknown[]).map(String) }
        : {
            kind: 'rule' as const,
            topicId: String(i.topicId),
            count: Number(i.count),
            difficulty: (i.difficulty as number | null) ?? null,
            type: (i.type as (typeof QUESTION_TYPES)[number] | null) ?? null,
          },
    ),
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
    const info = await inspectSections(ctx.actor, schoolId, scope, body.sections);
    return {
      sections: info.sections,
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
    assertSectionsOk(await inspectSections(ctx.actor, schoolId, scope, body.sections));
    const doc = await ExamTemplate.create({
      schoolId,
      title: cleanText(body.title),
      subjectId,
      sections: storeSections(body.sections) as never,
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
    if (body.sections) {
      assertSectionsOk(await inspectSections(ctx.actor, schoolId, scope, body.sections));
      t.sections = storeSections(body.sections) as never;
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
