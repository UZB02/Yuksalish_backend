import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import { ExamSession, type ExamSessionDoc } from '../../../models/ExamSession';
import { ExamTopic } from '../../../models/ExamTopic';
import { Question } from '../../../models/Question';
import { Subject } from '../../../models/Subject';
import { User } from '../../../models/User';
import { clock } from '../../../utils/clock';
import { isId, uniq } from '../../../utils/helpers';
import { cleanText, nameKeyOf } from '../../../utils/text';
import { auditService } from '../../audit/audit.service';
import { resolveExamScope } from '../exams.scope';
import { visibilityFilter } from '../exams.visibility';
import { importService, type CommitBody } from '../import/import.service';
import { questionsService } from '../questions.service';
import { topicsService } from '../topics.service';
import { findSession, isCreator } from '../sessions/sessions.service';
import {
  blockQuestionCount,
  effectiveItems,
  normalizeBlocks,
  type NBlock,
} from './blocks.core';
import { MAX_POOL } from '../sessions/templates.service';

type Actor = Ctx['actor'];
const oid = (s: string) => new Types.ObjectId(s);

export const addQuestionsBody = z
  .object({ questionIds: z.array(objectIdSchema).min(1).max(100) })
  .strict();
export const readyBody = z.object({ ready: z.boolean() }).strict();

const notFoundBlock = () => AppError.notFound('Blok topilmadi');

export type LockReason = 'status' | 'ready' | 'deadline' | null;

/** Biriktirilgan o'qituvchi uchun blok qulfi: faqat qoralama, tayyor emas va muddat o'tmagan bo'lsa ochiq */
export function lockOf(
  s: Pick<ExamSessionDoc, 'status' | 'contribDeadline'>,
  b: Pick<NBlock, 'status'>,
  now: Date = clock.now(),
): LockReason {
  if (s.status !== 'draft') return 'status';
  if (b.status === 'ready') return 'ready';
  if (s.contribDeadline && now.getTime() > s.contribDeadline.getTime()) return 'deadline';
  return null;
}

const LOCK_MSG: Record<Exclude<LockReason, null>, string> = {
  status: 'Imtihon qoralama holatidan chiqqan: blok faqat o‘qish uchun',
  ready: 'Blok tuzuvchi tomonidan "tayyor" deb belgilangan: faqat o‘qish uchun',
  deadline: 'Savol topshirish muddati tugagan: blok faqat o‘qish uchun',
};

async function loadSession(schoolId: string, id: string): Promise<ExamSessionDoc> {
  const s = isId(id)
    ? await ExamSession.findOne({ _id: id, schoolId, isDeleted: { $ne: true } })
    : null;
  if (!s) throw notFoundBlock();
  return s;
}

/**
 * Biriktirilgan o'qituvchi kirishi: faqat O'Z bloki. Boshqa blok, eski (blokisiz) imtihon, boshqa maktab yoki
 * biriktirilmagan foydalanuvchi: 404 (mavjudligi oshkor qilinmaydi).
 */
async function contribAccess(ctx: Ctx, schoolId: string, sessionId: string, blockId: string) {
  const s = await loadSession(schoolId, sessionId);
  const b = normalizeBlocks(s).find((x) => x.blockId === blockId && !x.legacy);
  if (!b || !b.contributors.includes(ctx.actor.id)) throw notFoundBlock();
  return { s, b };
}

function assertUnlocked(s: ExamSessionDoc, b: NBlock) {
  const r = lockOf(s, b);
  if (r) throw AppError.forbidden(LOCK_MSG[r]);
}

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
    entity: 'exam_session',
    entityId: id,
    before,
    after,
    ip: ctx.ip,
  });

const previewOf = (blocks: { type: string; text?: string; tex?: string }[]): string => {
  const t = blocks.find((x) => x.type === 'text' && x.text)?.text;
  if (t) return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  const f = blocks[0];
  return f?.type === 'math' ? (f.tex ?? '').slice(0, 200) : '';
};

/** Blok savollari ro'yxati: javob kalitisiz (preview), kim qo'shgani va olib tashlash huquqi bilan */
async function questionList(schoolId: string, b: NBlock, canRemoveOf: (addedBy: string | null) => boolean) {
  const owner = new Map<string, string | null>(); // qid -> contributor id | null (tuzuvchi)
  for (const it of b.items) {
    if (it.kind === 'manual') for (const q of it.questionIds ?? []) owner.set(String(q), null);
  }
  for (const c of b.contribQuestions) owner.set(c.questionId, c.addedBy);
  const ids = [...owner.keys()];
  const docs = ids.length
    ? await Question.find({ _id: { $in: ids.map(oid) }, schoolId, isDeleted: { $ne: true } }).select(
        '-answer',
      )
    : [];
  const users = await User.find({
    _id: { $in: uniq([...[...owner.values()].filter(Boolean), ...docs.map((d) => String(d.authorId))] as string[]) },
  })
    .select('fullName')
    .lean();
  const names = new Map(users.map((u) => [String(u._id), u.fullName]));
  const byId = new Map(docs.map((d) => [d.id as string, d]));
  const topics = await ExamTopic.find({
    _id: {
      $in: b.items.filter((i) => i.kind === 'rule').map((i) => String(i.topicId)),
    },
  })
    .select('name')
    .lean();
  const tn = new Map(topics.map((t) => [String(t._id), t.name]));
  return {
    questions: ids
      .map((id) => {
        const d = byId.get(id);
        const addedBy = owner.get(id) ?? null;
        return {
          id,
          missing: !d,
          type: d?.type ?? null,
          difficulty: d?.difficulty ?? null,
          points: d?.points ?? null,
          status: d?.status ?? null,
          preview: d ? previewOf(d.content as never) : '',
          hasMath: !!d?.content.some((x) => x.type === 'math'),
          hasImage: !!d?.content.some((x) => x.type === 'image'),
          authorName: d ? (names.get(String(d.authorId)) ?? null) : null,
          source: addedBy ? ('contributor' as const) : ('composer' as const),
          addedByName: addedBy ? (names.get(addedBy) ?? null) : null,
          canRemove: canRemoveOf(addedBy),
        };
      })
      .sort((x, y) => Number(x.missing) - Number(y.missing)),
    rules: b.items
      .filter((i) => i.kind === 'rule')
      .map((i) => ({
        topicId: String(i.topicId),
        topicName: tn.get(String(i.topicId)) ?? null,
        count: i.count ?? 0,
        difficulty: i.difficulty ?? null,
        type: i.type ?? null,
      })),
  };
}

/** "Imtihon: ‹nomi›" mavzusi (fan ichida); yo'q bo'lsa yaratiladi (poyga: dublikat bo'lsa topiladi) */
async function ensureExamTopic(ctx: Ctx, schoolId: string, subjectId: string, examTitle: string) {
  const name = cleanText(`Imtihon: ${examTitle}`).slice(0, 150);
  const find = () =>
    ExamTopic.findOne({
      schoolId,
      subjectId,
      nameKey: nameKeyOf(name),
      isDeleted: { $ne: true },
    });
  const have = await find();
  if (have) return have;
  try {
    await topicsService.create(ctx, schoolId, subjectId, { name });
  } catch (e) {
    const t = await find();
    if (t) return t;
    throw e;
  }
  const t = await find();
  if (!t) throw AppError.unavailable('Mavzuni yaratib bo‘lmadi');
  return t;
}

/** Savollarni blokka atomik qo'shadi (qulf shartlari filtrda: muddat/tayyorlik/holat poygasiga chidamli) */
async function pushContrib(
  ctx: Ctx,
  schoolId: string,
  s: ExamSessionDoc,
  b: NBlock,
  ids: string[],
) {
  const now = clock.now();
  const have = new Set(
    normalizeBlocks(s).flatMap((x) =>
      effectiveItems(x).flatMap((it) =>
        it.kind === 'manual' ? (it.questionIds ?? []).map(String) : [],
      ),
    ),
  );
  const fresh = uniq(ids).filter((id) => !have.has(id));
  if (blockQuestionCount(b) + fresh.length > MAX_POOL) {
    throw AppError.validation('Savollar juda ko‘p', [
      { path: 'questionIds', message: `Blokda ${MAX_POOL} tadan ortiq savol bo'lmasin` },
    ]);
  }
  if (!fresh.length) return { added: 0, skipped: ids.length };
  const r = await ExamSession.updateOne(
    {
      _id: s._id,
      schoolId,
      status: 'draft',
      isDeleted: { $ne: true },
      $or: [{ contribDeadline: null }, { contribDeadline: { $gt: now } }],
      blocks: {
        $elemMatch: { blockId: b.blockId, status: { $ne: 'ready' }, contributors: oid(ctx.actor.id) },
      },
    },
    {
      $push: {
        'blocks.$.contribQuestions': {
          $each: fresh.map((id) => ({ questionId: oid(id), addedBy: oid(ctx.actor.id), addedAt: now })),
        },
      },
    },
  );
  if (!r.matchedCount) throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
  await audit(ctx, schoolId, 'exam.block.question_add', String(s._id), null, {
    blockId: b.blockId,
    added: fresh.length,
  });
  return { added: fresh.length, skipped: ids.length - fresh.length };
}

async function blockSummary(schoolId: string, sessionId: string, blockId: string) {
  const s = await loadSession(schoolId, sessionId);
  const b = normalizeBlocks(s).find((x) => x.blockId === blockId)!;
  return { count: blockQuestionCount(b), target: b.targetCount };
}

export const blocksService = {
  /** Menga biriktirilgan bloklar ro'yxati (boshqa bloklar va imtihon sozlamalari chiqmaydi) */
  async myBlocks(ctx: Ctx, schoolId: string) {
    const sessions = await ExamSession.find({
      schoolId,
      isDeleted: { $ne: true },
      status: { $in: ['draft', 'pending_approval', 'scheduled', 'open'] },
      'blocks.contributors': oid(ctx.actor.id),
    })
      .select('title status blocks contribDeadline')
      .sort({ createdAt: -1 })
      .limit(100);
    const subjectIds = uniq(
      sessions.flatMap((s) =>
        normalizeBlocks(s)
          .filter((b) => b.contributors.includes(ctx.actor.id))
          .map((b) => b.subjectId ?? ''),
      ).filter(Boolean),
    );
    const subs = await Subject.find({ _id: { $in: subjectIds } })
      .select('name')
      .lean();
    const sn = new Map(subs.map((x) => [String(x._id), x.name]));
    const now = clock.now();
    return sessions.flatMap((s) =>
      normalizeBlocks(s)
        .filter((b) => !b.legacy && b.contributors.includes(ctx.actor.id))
        .map((b) => {
          const lock = lockOf(s, b, now);
          return {
            sessionId: s.id as string,
            blockId: b.blockId,
            examTitle: s.title,
            examStatus: s.status,
            subjectId: b.subjectId,
            subjectName: b.subjectId ? (sn.get(b.subjectId) ?? null) : null,
            title: b.title,
            targetCount: b.targetCount,
            count: blockQuestionCount(b),
            blockStatus: b.status,
            contribDeadline: s.contribDeadline ?? null,
            locked: lock !== null,
            lockReason: lock,
          };
        }),
    );
  },

  /** Blok sahifasi (biriktirilgan o'qituvchi): imtihon nomi, fan, maqsad, muddat va hozirgi savollar */
  async myBlock(ctx: Ctx, schoolId: string, sessionId: string, blockId: string) {
    const { s, b } = await contribAccess(ctx, schoolId, sessionId, blockId);
    const subject = b.subjectId ? await Subject.findById(b.subjectId).select('name').lean() : null;
    const lock = lockOf(s, b);
    const list = await questionList(schoolId, b, (addedBy) => lock === null && addedBy === ctx.actor.id);
    return {
      exam: { id: s.id as string, title: s.title, contribDeadline: s.contribDeadline ?? null },
      block: {
        id: b.blockId,
        subjectId: b.subjectId,
        subjectName: subject?.name ?? null,
        title: b.title,
        targetCount: b.targetCount,
        count: blockQuestionCount(b),
        status: b.status,
        locked: lock !== null,
        lockReason: lock,
      },
      ...list,
    };
  },

  /** Bankdan tanlab qo'shish: faqat shu blok fanidagi, o'ziga ko'rinadigan FAOL savollar */
  async addFromBank(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof addQuestionsBody>,
  ) {
    const { s, b } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b);
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const ids = uniq(body.questionIds);
    const found = await Question.find({
      $and: [
        ...visibilityFilter(ctx.actor, schoolId, scope),
        { _id: { $in: ids.map(oid) } },
        { subjectId: oid(b.subjectId!) },
        { status: 'active' },
      ],
    })
      .select('_id')
      .lean();
    if (found.length !== ids.length) {
      throw AppError.validation('Savol topilmadi', [
        {
          path: 'questionIds',
          message: "Savollar blok fanidagi, sizga ko'rinadigan FAOL savollar bo'lishi kerak",
        },
      ]);
    }
    const r = await pushContrib(ctx, schoolId, s, b, ids);
    return { ...r, ...(await blockSummary(schoolId, sessionId, blockId)) };
  },

  /** Blok ichida yangi savol yozish: bankka ham tushadi (fan -> "Imtihon: ‹nomi›" mavzusi, faol, yopiq) */
  async createInBlock(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    raw: Record<string, unknown>,
  ) {
    const { s, b } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b);
    const topic = await ensureExamTopic(ctx, schoolId, b.subjectId!, s.title);
    const q = await questionsService.create(ctx, schoolId, {
      ...raw,
      topicId: topic.id as string,
      subjectId: undefined,
      status: 'active',
      sharing: { mode: 'private', userIds: [] },
    });
    await pushContrib(ctx, schoolId, s, b, [q.id]);
    return { question: q, ...(await blockSummary(schoolId, sessionId, blockId)) };
  },

  /** Word/Excel importi oldindan ko'rish: mavzu avtomatik ("Imtihon: ‹nomi›") */
  async importPreview(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    kind: 'word' | 'excel',
    file: Express.Multer.File | undefined,
  ) {
    const { s, b } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b);
    const topic = await ensureExamTopic(ctx, schoolId, b.subjectId!, s.title);
    return importService.preview(ctx, schoolId, kind, file, topic.id as string);
  },

  /** Importni tasdiqlash: savollar FAOL holatda bankka tushadi va blokka qo'shiladi */
  async importCommit(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    importId: string,
    body: CommitBody,
  ) {
    const { s, b } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b);
    const r = (await importService.commit(ctx, schoolId, importId, {
      ...body,
      status: 'active',
    })) as { created: number; ids?: string[] };
    let added = 0;
    if (r.ids?.length) {
      // Qulf import paytida o'zgargan bo'lsa pushContrib rad etadi; savollar bankda qoladi
      added = (await pushContrib(ctx, schoolId, s, b, r.ids)).added;
    }
    return { ...r, addedToBlock: added, ...(await blockSummary(schoolId, sessionId, blockId)) };
  },

  /** O'qituvchi faqat O'Z qo'shgan savolini blokdan olib tashlaydi (bankdan o'chirmaydi) */
  async removeOwn(ctx: Ctx, schoolId: string, sessionId: string, blockId: string, qid: string) {
    const { s, b } = await contribAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b);
    const mine = b.contribQuestions.find((c) => c.questionId === qid && c.addedBy === ctx.actor.id);
    if (!mine) throw AppError.notFound('Savol topilmadi');
    const now = clock.now();
    const r = await ExamSession.updateOne(
      {
        _id: s._id,
        schoolId,
        status: 'draft',
        $or: [{ contribDeadline: null }, { contribDeadline: { $gt: now } }],
        blocks: { $elemMatch: { blockId, status: { $ne: 'ready' }, contributors: oid(ctx.actor.id) } },
      },
      { $pull: { 'blocks.$.contribQuestions': { questionId: oid(qid), addedBy: oid(ctx.actor.id) } } },
    );
    if (!r.matchedCount) throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
    await audit(ctx, schoolId, 'exam.block.question_remove', sessionId, null, { blockId });
    return { removed: true, ...(await blockSummary(schoolId, sessionId, blockId)) };
  },

  // ---------------- Tuzuvchi ----------------
  async composerBlock(ctx: Ctx, schoolId: string, sessionId: string, blockId: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, sessionId);
    if (!scope.all && !isCreator(s, ctx.actor)) throw AppError.forbidden();
    const b = normalizeBlocks(s).find((x) => x.blockId === blockId && !x.legacy);
    if (!b) throw notFoundBlock();
    return questionList(schoolId, b, () => s.status === 'draft');
  },

  /** Tuzuvchi: istalgan blokdan istalgan savolni olib tashlaydi (tuzuvchi elementidan yoki o'qituvchi qo'shganidan) */
  async composerRemove(ctx: Ctx, schoolId: string, sessionId: string, blockId: string, qid: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, sessionId);
    if (!scope.all && !isCreator(s, ctx.actor)) throw AppError.forbidden();
    if (s.status !== 'draft') throw AppError.conflict('Faqat qoralamani tahrirlash mumkin');
    const blocks = s.blocks as unknown as Record<string, unknown>[];
    const raw = blocks.find((x) => x.blockId === blockId);
    if (!raw) throw notFoundBlock();
    const b = normalizeBlocks(s).find((x) => x.blockId === blockId)!;
    let removed = false;
    const items = (b.items as { kind: string; questionIds?: unknown[] }[])
      .map((it) => {
        if (it.kind !== 'manual') return it;
        const left = (it.questionIds ?? []).filter((q) => String(q) !== qid);
        if (left.length !== (it.questionIds ?? []).length) removed = true;
        return { ...it, questionIds: left.map((q) => oid(String(q))) };
      })
      .filter((it) => it.kind !== 'manual' || (it.questionIds?.length ?? 0) > 0);
    const contrib = b.contribQuestions.filter((c) => c.questionId !== qid);
    if (contrib.length !== b.contribQuestions.length) removed = true;
    if (!removed) throw AppError.notFound('Savol bu blokda emas');
    await ExamSession.updateOne(
      { _id: s._id, schoolId, status: 'draft' },
      {
        $set: {
          'blocks.$[b].items': items,
          'blocks.$[b].contribQuestions': contrib.map((c) => ({
            questionId: oid(c.questionId),
            addedBy: oid(c.addedBy),
            addedAt: c.addedAt,
          })),
        },
      },
      { arrayFilters: [{ 'b.blockId': blockId }] },
    );
    await audit(ctx, schoolId, 'exam.block.question_remove', sessionId, null, {
      blockId,
      by: 'composer',
    });
    return { removed: true, ...(await blockSummary(schoolId, sessionId, blockId)) };
  },

  /** Tuzuvchi: blokni "tayyor" deb belgilash / qayta ochish */
  async setReady(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof readyBody>,
  ) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, sessionId);
    if (!scope.all && !isCreator(s, ctx.actor)) throw AppError.forbidden();
    if (s.status !== 'draft') throw AppError.conflict('Faqat qoralamani tahrirlash mumkin');
    const b = normalizeBlocks(s).find((x) => x.blockId === blockId && !x.legacy);
    if (!b) throw notFoundBlock();
    await ExamSession.updateOne(
      { _id: s._id, schoolId, status: 'draft' },
      { $set: { 'blocks.$[b].status': body.ready ? 'ready' : 'open' } },
      { arrayFilters: [{ 'b.blockId': blockId }] },
    );
    await audit(ctx, schoolId, 'exam.block.ready', sessionId, { status: b.status }, {
      blockId,
      status: body.ready ? 'ready' : 'open',
    });
    return { blockId, status: body.ready ? ('ready' as const) : ('open' as const) };
  },
};

export type { Actor };
