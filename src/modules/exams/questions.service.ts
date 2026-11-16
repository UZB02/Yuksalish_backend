import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorDetail } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassSubject } from '../../models/ClassSubject';
import { ExamAsset } from '../../models/ExamAsset';
import { ExamTopic } from '../../models/ExamTopic';
import { Question, type QuestionDoc } from '../../models/Question';
import { Subject } from '../../models/Subject';
import { User } from '../../models/User';
import { escapeRegex, isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { resolveExamScope, type ExamScope } from './exams.scope';
import { sharedWithClauses, visibilityFilter, visibleCounts } from './exams.visibility';
import { loadTargetTopic } from './topics.service';
import {
  questionAuditSummary,
  toAnswerDto,
  toBlockDto,
  toQuestionDto,
  toQuestionListDto,
  sharingOf,
  type QuestionRefs,
} from './questions.dto';
import {
  questionInput,
  type BulkStatusBody,
  type ListQuery,
  type QuestionInput,
  type UpdateBody,
} from './questions.schema';

type Actor = Ctx['actor'];

const MAX_BULK = 5000;

const notFound = () => AppError.notFound('Savol topilmadi');

// ---------- Yordamchilar ----------

/** Tahrirlash/o'chirish huquqi: ma'muriyat hammasini, o'qituvchi faqat o'zi yaratganini */
const canEditDoc = (actor: Actor, scope: ExamScope, doc: QuestionDoc): boolean =>
  scope.all || String(doc.authorId) === actor.id;

async function findVisible(
  actor: Actor,
  schoolId: string,
  scope: ExamScope,
  id: string,
): Promise<QuestionDoc> {
  // Boshqa maktab, o'chirilgan yoki doiradan tashqari savol: 404 (mavjudligi oshkor qilinmaydi)
  const doc = isId(id)
    ? await Question.findOne({ $and: [{ _id: id }, ...visibilityFilter(actor, schoolId, scope)] })
    : null;
  if (!doc) throw notFound();
  return doc;
}

async function findEditable(actor: Actor, schoolId: string, scope: ExamScope, id: string) {
  const doc = await findVisible(actor, schoolId, scope, id);
  if (!canEditDoc(actor, scope, doc)) {
    throw AppError.forbidden("Bu savolni faqat muallifi yoki ma'muriyat o'zgartira oladi");
  }
  return doc;
}

async function refsFor(docs: QuestionDoc[]): Promise<{
  subject: (q: QuestionDoc) => string | null;
  topic: (q: QuestionDoc) => string | null;
  author: (q: QuestionDoc) => string | null;
}> {
  const subjectIds = uniq(docs.map((d) => String(d.subjectId)));
  const authorIds = uniq(docs.map((d) => String(d.authorId)));
  const topicIds = uniq(docs.map((d) => String(d.topicId)));
  const [topics, subjects, authors] = await Promise.all([
    ExamTopic.find({ _id: { $in: topicIds } })
      .select('name')
      .lean(),
    Subject.find({ _id: { $in: subjectIds } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: authorIds } })
      .select('fullName')
      .lean(),
  ]);
  const tMap = new Map(topics.map((t) => [String(t._id), t.name]));
  const sMap = new Map(subjects.map((s) => [String(s._id), s.name]));
  const aMap = new Map(authors.map((a) => [String(a._id), a.fullName]));
  return {
    subject: (q) => sMap.get(String(q.subjectId)) ?? null,
    topic: (q) => tMap.get(String(q.topicId)) ?? null,
    author: (q) => aMap.get(String(q.authorId)) ?? null,
  };
}

const refsOf = (r: Awaited<ReturnType<typeof refsFor>>, q: QuestionDoc): QuestionRefs => ({
  subjectName: r.subject(q),
  topicName: r.topic(q),
  authorName: r.author(q),
});

/** Fan ishlatilishi mumkinmi: o'qituvchi uchun o'zi o'qitadigani, hamma uchun maktabga ko'rinadigan faol fan */
async function assertSubjectUsable(scope: ExamScope, schoolId: string, subjectId: string) {
  if (!scope.all && !scope.subjectIds.includes(subjectId)) {
    throw AppError.forbidden('Bu fan sizga biriktirilmagan');
  }
  const ok = await Subject.exists({
    _id: subjectId,
    isActive: true,
    $or: [{ schoolId: null }, { schoolId }],
  });
  if (!ok) throw AppError.notFound('Fan topilmadi');
}

type Blk = { type: string; assetId?: unknown };

/** 'users' ulashishi: tanlanganlar shu maktabning faol o'qituvchilari bo'lishi shart */
async function assertSharingUsers(schoolId: string, input: QuestionInput) {
  const ids = input.sharing.userIds;
  if (!ids.length) return;
  const found = await User.countDocuments({
    _id: { $in: ids },
    schoolId,
    role: 'teacher',
    isActive: true,
  });
  if (found !== ids.length) {
    throw AppError.validation("O'qituvchi topilmadi", [
      {
        path: 'sharing.userIds',
        message: "Faqat shu maktabning faol o'qituvchilarini tanlash mumkin",
      },
    ]);
  }
}

/** Rasm bloklaridagi assetId lar shu maktabga tegishli bo'lishi shart */
async function assertAssetsExist(schoolId: string, input: QuestionInput) {
  const blocks: Blk[] = [...input.content, ...input.options.flatMap((o) => o.content)];
  const ids = uniq(
    blocks.filter((b) => b.type === 'image' && b.assetId).map((b) => String(b.assetId)),
  );
  if (!ids.length) return;
  const found = await ExamAsset.countDocuments({ schoolId, _id: { $in: ids } });
  if (found !== ids.length) {
    throw AppError.validation('Rasm topilmadi', [{ path: 'content', message: 'Rasm topilmadi' }]);
  }
}

function parseInput(candidate: unknown): QuestionInput {
  const r = questionInput.safeParse(candidate);
  if (!r.success) {
    const details: ErrorDetail[] = r.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    throw AppError.validation("Ma'lumotlar noto'g'ri", details);
  }
  return r.data;
}

/** Mavjud savolning kiritish shakli (tahrirda patch bilan birlashtirish uchun) */
function docToInput(doc: QuestionDoc) {
  const answer = Object.fromEntries(
    Object.entries(toAnswerDto(doc.type, doc.answer)).filter(
      ([, v]) => v !== null && v !== '' && v !== undefined,
    ),
  );
  return {
    subjectId: String(doc.subjectId),
    topicId: String(doc.topicId),
    difficulty: doc.difficulty,
    type: doc.type,
    content: doc.content.map(toBlockDto),
    options: doc.options.map((o) => ({ id: o.id, content: o.content.map(toBlockDto) })),
    answer,
    points: doc.points,
    status: doc.status === 'archived' ? 'draft' : doc.status,
    sharing: sharingOf(doc),
  } as Record<string, unknown>;
}

/** Kalitlari tartiblangan, bo'sh qiymatlari tashlangan JSON: o'zgarishni aniqlash uchun */
function stable(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([, val]) => val !== null && val !== undefined && val !== '')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

const VERSIONED = ['type', 'content', 'options', 'answer', 'points'] as const;
const TRACKED = ['subjectId', 'topicId', 'difficulty', 'status', 'sharing', ...VERSIONED] as const;

const audit = (
  ctx: Ctx,
  schoolId: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
) =>
  auditService.log({
    userId: ctx.actor.id,
    schoolId,
    action,
    entity: 'exam_question',
    entityId,
    before,
    after,
    ip: ctx.ip,
  });

async function teachersOfSubject(schoolId: string, subjectId: string): Promise<Set<string>> {
  const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  if (!year) return new Set();
  const ids = await ClassSubject.distinct('teacherId', {
    schoolId,
    subjectId,
    academicYearId: year._id,
  });
  return new Set(ids.map(String));
}

// ---------- Servis ----------

export const questionsService = {
  /**
   * Fan kartalari. O'qituvchi: faqat o'zi o'qitadigan fanlar. Ma'muriyat: maktabning faol fanlari +
   * mavzulari bor nofaol fanlar (isActive=false bilan). Sonlar: mavzular soni va shu foydalanuvchiga
   * KO'RINADIGAN savollar soni (ulashish qoidalari bilan).
   */
  async subjects(ctx: Ctx, schoolId: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const topicRows = await ExamTopic.aggregate<{ _id: unknown; n: number }>([
      { $match: { schoolId: new Types.ObjectId(schoolId), isDeleted: { $ne: true } } },
      { $group: { _id: '$subjectId', n: { $sum: 1 } } },
    ]);
    const topicCounts = new Map(topicRows.map((r) => [String(r._id), r.n]));
    const withTopics = [...topicCounts.keys()];
    const filter: Record<string, unknown> = scope.all
      ? {
          $and: [
            { $or: [{ schoolId: null }, { schoolId }] },
            { $or: [{ isActive: true }, { _id: { $in: withTopics } }] },
          ],
        }
      : { isActive: true, _id: { $in: scope.subjectIds } };
    const [docs, qCounts] = await Promise.all([
      Subject.find(filter).sort({ order: 1, name: 1 }).select('name isActive'),
      visibleCounts(ctx.actor, schoolId, scope, 'subjectId'),
    ]);
    return {
      scope: scope.all ? ('all' as const) : ('own' as const),
      subjects: docs.map((s) => ({
        id: s.id as string,
        name: s.name,
        isActive: s.isActive,
        topicsCount: topicCounts.get(s.id as string) ?? 0,
        questionsCount: qCounts.get(s.id as string) ?? 0,
      })),
    };
  },

  /** Ulashish uchun maktab o'qituvchilari (fanni o'qitadiganlar birinchi) */
  async teachers(ctx: Ctx, schoolId: string, subjectId?: string) {
    const [docs, taught] = await Promise.all([
      User.find({ schoolId, role: 'teacher', isActive: true })
        .sort({ fullName: 1 })
        .select('fullName')
        .limit(500),
      subjectId && isId(subjectId)
        ? teachersOfSubject(schoolId, subjectId)
        : Promise.resolve(new Set<string>()),
    ]);
    const items = docs
      .filter((u) => u.id !== ctx.actor.id)
      .map((u) => ({
        id: u.id as string,
        fullName: u.fullName,
        teachesSubject: taught.has(u.id as string),
      }));
    return items.sort((a, b) => Number(b.teachesSubject) - Number(a.teachesSubject));
  },

  async list(ctx: Ctx, schoolId: string, q: ListQuery) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const and = visibilityFilter(ctx.actor, schoolId, scope);
    if (q.subjectId) and.push({ subjectId: q.subjectId });
    if (q.difficulty) and.push({ difficulty: q.difficulty });
    if (q.type) and.push({ type: q.type });
    if (q.status) and.push({ status: q.status });
    if (q.shared) {
      and.push({ authorId: { $ne: ctx.actor.id } });
      and.push({ $or: sharedWithClauses(ctx.actor, scope) });
    }
    if (q.mine) and.push({ authorId: ctx.actor.id });
    else if (q.authorId) and.push({ authorId: q.authorId });
    if (q.topicId) and.push({ topicId: q.topicId });
    if (q.search) {
      and.push({ 'content.text': new RegExp(escapeRegex(q.search), 'i') });
    }
    const filter = { $and: and };
    const [docs, total] = await Promise.all([
      Question.find(filter)
        .select('-answer') // ro'yxatda javob kaliti hech qachon yuklanmaydi
        .sort({ updatedAt: -1, _id: 1 })
        .skip(skipOf(q.page, q.limit))
        .limit(q.limit),
      Question.countDocuments(filter),
    ]);
    const refs = await refsFor(docs);
    return {
      items: docs.map((d) =>
        toQuestionListDto(
          d,
          refsOf(refs, d),
          canEditDoc(ctx.actor, scope, d),
          String(d.authorId) === ctx.actor.id,
        ),
      ),
      meta: buildMeta(q.page, q.limit, total),
    };
  },

  async get(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const doc = await findVisible(ctx.actor, schoolId, scope, id);
    return this.dto(ctx, scope, doc);
  },

  async dto(ctx: Ctx, scope: ExamScope, doc: QuestionDoc) {
    const refs = await refsFor([doc]);
    return toQuestionDto(
      doc,
      refsOf(refs, doc),
      canEditDoc(ctx.actor, scope, doc),
      String(doc.authorId) === ctx.actor.id,
    );
  },

  /**
   * Savol mavzuga qo'shiladi: fan mavzudan olinadi (mijoz yuborgan subjectId bo'lsa, mavzu fani bilan
   * bir xil bo'lishi shart). O'qituvchi faqat o'z fani mavzusiga qo'sha oladi.
   */
  async create(ctx: Ctx, schoolId: string, raw: Record<string, unknown>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const topicId = typeof raw.topicId === 'string' ? raw.topicId : '';
    const topic = await loadTargetTopic(schoolId, scope, topicId);
    const subjectId = String(topic.subjectId);
    if (raw.subjectId !== undefined && raw.subjectId !== subjectId) {
      throw AppError.validation('Fan mavzuga mos emas', [
        { path: 'subjectId', message: "Fan tanlangan mavzuning fani bilan bir xil bo'lishi kerak" },
      ]);
    }
    const input = parseInput({ ...raw, subjectId });
    await assertSubjectUsable(scope, schoolId, input.subjectId);
    await assertAssetsExist(schoolId, input);
    await assertSharingUsers(schoolId, input);
    const doc = await Question.create({
      ...input,
      schoolId,
      scope: 'school',
      authorId: ctx.actor.id,
      version: 1,
    });
    await audit(ctx, schoolId, 'exam.question.create', doc.id, null, questionAuditSummary(doc));
    return this.dto(ctx, scope, doc);
  },

  async update(ctx: Ctx, schoolId: string, id: string, patch: UpdateBody) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const doc = await findEditable(ctx.actor, schoolId, scope, id);
    if (doc.status === 'archived') {
      throw AppError.conflict('Arxivdagi savolni tahrirlashdan oldin tiklang');
    }
    const before = docToInput(doc);
    const beforeSummary = questionAuditSummary(doc);

    const candidate: Record<string, unknown> = { ...before };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) candidate[k] = v;
    if (patch.type && patch.type !== doc.type) {
      // Tur o'zgarsa eski variantlar va kalit mos kelmaydi: yangisi berilmasa tozalanadi
      if (patch.options === undefined) candidate.options = [];
      if (patch.answer === undefined) candidate.answer = {};
    }
    if (patch.topicId !== undefined && patch.topicId !== String(doc.topicId)) {
      // Boshqa mavzuga ko'chirish: xuddi shu fan ichida ruxsat; boshqa fanga faqat shu fanni o'qitgan
      // muharrir (ma'muriyat har doim)
      const target = await loadTargetTopic(schoolId, scope, patch.topicId);
      candidate.subjectId = String(target.subjectId);
    }
    const next = parseInput(candidate);
    if (next.subjectId !== String(doc.subjectId)) {
      await assertSubjectUsable(scope, schoolId, next.subjectId);
    }
    await assertAssetsExist(schoolId, next);
    await assertSharingUsers(schoolId, next);

    const changed = TRACKED.filter(
      (k) => stable((before as Record<string, unknown>)[k]) !== stable(next[k]),
    );
    if (!changed.length) return this.dto(ctx, scope, doc);

    doc.set({ ...next });
    if (changed.some((k) => (VERSIONED as readonly string[]).includes(k))) {
      doc.version = (doc.version ?? 1) + 1;
    }
    await doc.save();
    await audit(ctx, schoolId, 'exam.question.update', doc.id, beforeSummary, {
      ...questionAuditSummary(doc),
      changed: [...changed],
    });
    return this.dto(ctx, scope, doc);
  },

  /**
   * Ommaviy holat o'zgartirish (faqat holat: versiya oshmaydi). Faqat muallif yoki ma'muriyat o'zgartira
   * oladigan, shu maktabning ko'rinadigan savollariga qo'llanadi; qolganlari `skipped` da sababi bilan.
   * Faollashtirishda savol yakka tahrirdagi bilan bir xil tekshiruvdan o'tishi shart.
   */
  async bulkStatus(ctx: Ctx, schoolId: string, body: BulkStatusBody) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const and = visibilityFilter(ctx.actor, schoolId, scope);
    if (body.ids) and.push({ _id: { $in: uniq(body.ids).map((x) => new Types.ObjectId(x)) } });
    if (body.topicId) and.push({ topicId: new Types.ObjectId(body.topicId) });
    if (body.fromStatus) and.push({ status: body.fromStatus });
    const docs = await Question.find({ $and: and }).limit(MAX_BULK + 1);
    if (docs.length > MAX_BULK) {
      throw AppError.validation(`Bir martada ${MAX_BULK} tadan ko'p savol o'zgartirib bo'lmaydi`, [
        { path: 'topicId', message: 'Filtrni toraytiring yoki bir necha bosqichda bajaring' },
      ]);
    }
    const skipped: { id: string; reason: string }[] = [];
    const found = new Set(docs.map((d) => d.id as string));
    for (const id of uniq(body.ids ?? [])) {
      if (!found.has(id)) skipped.push({ id, reason: 'Savol topilmadi' });
    }
    const okIds: Types.ObjectId[] = [];
    let unchanged = 0;
    for (const d of docs) {
      if (!canEditDoc(ctx.actor, scope, d)) {
        skipped.push({
          id: d.id as string,
          reason: "Faqat muallif yoki ma'muriyat o'zgartira oladi",
        });
        continue;
      }
      if (d.status === body.toStatus) {
        unchanged++;
        continue;
      }
      if (body.toStatus === 'active') {
        const r = questionInput.safeParse({ ...docToInput(d), status: 'active' });
        if (!r.success) {
          skipped.push({
            id: d.id as string,
            reason: r.error.issues[0]?.message ?? "Savol to'liq emas",
          });
          continue;
        }
      }
      okIds.push(d._id as Types.ObjectId);
    }
    let updated = 0;
    if (okIds.length) {
      // Aniq filtr: maktab + id ro'yxati + (o'qituvchi uchun) muallif sharti
      const r = await Question.updateMany(
        {
          schoolId,
          isDeleted: { $ne: true },
          _id: { $in: okIds },
          ...(scope.all ? {} : { authorId: ctx.actor.id }),
        },
        { $set: { status: body.toStatus } },
      );
      updated = r.modifiedCount;
    }
    await audit(ctx, schoolId, 'exam.question.bulk_status', body.topicId ?? 'ids', null, {
      toStatus: body.toStatus,
      fromStatus: body.fromStatus ?? null,
      mode: body.ids ? 'ids' : 'topic',
      updated,
      unchanged,
      skipped: skipped.length,
    });
    return { updated, unchanged, skipped };
  },

  async archive(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const doc = await findEditable(ctx.actor, schoolId, scope, id);
    if (doc.status !== 'archived') {
      const before = questionAuditSummary(doc);
      doc.status = 'archived';
      await doc.save();
      await audit(
        ctx,
        schoolId,
        'exam.question.archive',
        doc.id,
        before,
        questionAuditSummary(doc),
      );
    }
    return this.dto(ctx, scope, doc);
  },

  /** Arxivdan tiklash: qoralama holatiga (qayta faollashtirish muallif/ma'muriyat qarori) */
  async restore(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const doc = await findEditable(ctx.actor, schoolId, scope, id);
    if (doc.status === 'archived') {
      const before = questionAuditSummary(doc);
      doc.status = 'draft';
      await doc.save();
      await audit(
        ctx,
        schoolId,
        'exam.question.restore',
        doc.id,
        before,
        questionAuditSummary(doc),
      );
    }
    return this.dto(ctx, scope, doc);
  },

  /**
   * Yumshoq o'chirish (isDeleted): muallif yoki ma'muriyat istalgan holatdagi savolni o'chira oladi.
   * Keyinchalik imtihon sessiyalari savolning TO'LIQ NUSXASINI (snapshot) saqlaydi, shuning uchun
   * banksdan o'chirish eski natijalarni hech qachon buzmaydi.
   */
  async remove(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const doc = await findEditable(ctx.actor, schoolId, scope, id);
    const before = questionAuditSummary(doc);
    doc.isDeleted = true;
    doc.deletedAt = new Date();
    await doc.save();
    await audit(ctx, schoolId, 'exam.question.delete', doc.id, before, null);
    return { id: doc.id as string, deleted: true };
  },

  /**
   * Nusxa: yangi qoralama, muallif = amal bajaruvchi. Faqat tahrirlash huquqi bor savol nusxalanadi
   * (aks holda o'qituvchi hamkasbining javob kalitini nusxa orqali ko'rib olardi).
   */
  async duplicate(ctx: Ctx, schoolId: string, id: string) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    // Ulashilgan savolni ko'ra oladigan o'qituvchi ham nusxa ola oladi (kalit bilan, muallif ruxsati)
    const src = await findVisible(ctx.actor, schoolId, scope, id);
    // Nusxa: yangi qoralama, ulashish o'chirilgan (private), muallif = nusxa oluvchi
    const input = parseInput({
      ...docToInput(src),
      status: 'draft',
      sharing: { mode: 'private', userIds: [] },
    });
    await assertSubjectUsable(scope, schoolId, input.subjectId);
    const doc = await Question.create({
      ...input,
      schoolId,
      scope: 'school',
      authorId: ctx.actor.id,
      version: 1,
    });
    await audit(ctx, schoolId, 'exam.question.duplicate', doc.id, null, {
      ...questionAuditSummary(doc),
      sourceId: src.id as string,
    });
    return this.dto(ctx, scope, doc);
  },
};
