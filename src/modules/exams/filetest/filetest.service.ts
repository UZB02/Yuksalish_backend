import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { objectIdSchema } from '../../../core/validators';
import { ExamAttempt } from '../../../models/ExamAttempt';
import { ExamFile, type ExamFileDoc } from '../../../models/ExamFile';
import { ExamSession, type ExamSessionDoc } from '../../../models/ExamSession';
import { clock } from '../../../utils/clock';
import { isId } from '../../../utils/helpers';
import { resolveExamScope } from '../exams.scope';
import { isCreator, isSupervisor } from '../sessions/sessions.service';
import { normalizeBlocks, type NBlock } from '../blocks/blocks.core';
import { assertUnlocked, audit, lockOf, writeGuard, type Role } from '../blocks/blocks.service';
import {
  DEFAULT_OPTIONS,
  MAX_ACCEPTED,
  MAX_ACCEPTED_LEN,
  MAX_FILES_PER_VARIANT,
  MAX_KEY_ITEMS,
  MAX_POINTS,
  MIN_POINTS,
  OPTION_LETTERS,
  VARIANT_LETTERS,
  fileQid,
  fileTestCount,
  fileTestSummary,
  insertBlockItems,
  orderOfVariant,
  parseKeyText,
  validateFileTest,
  type FileTest,
  type ValidationIssue,
} from './filetest.core';
import { assertFilesExist } from './filetest.guard';
import {
  commitFile,
  deleteFiles,
  expireFiles,
  inspectUpload,
  recommitFile,
} from './filetest.storage';

const oid = (s: string) => new Types.ObjectId(s);
const notFoundBlock = () => AppError.notFound('Blok topilmadi');

// ---------- Kirish sxemalari ----------
const points = z.number().min(MIN_POINTS).max(MAX_POINTS);
const no = z.number().int().min(1).max(MAX_KEY_ITEMS);
const keyItem = z.discriminatedUnion('type', [
  z
    .object({
      no,
      type: z.literal('choice'),
      options: z.number().int().min(2).max(6).default(DEFAULT_OPTIONS),
      correct: z.array(z.enum(OPTION_LETTERS)).max(6),
      points: points.default(1),
    })
    .strict(),
  z
    .object({
      no,
      type: z.literal('short'),
      accepted: z.array(z.string().max(MAX_ACCEPTED_LEN)).max(MAX_ACCEPTED),
      points: points.default(1),
    })
    .strict(),
]);
const variant = z
  .object({
    letter: z.enum(VARIANT_LETTERS),
    kind: z.enum(['pdf', 'image']),
    files: z.array(objectIdSchema).max(MAX_FILES_PER_VARIANT),
    key: z.array(keyItem).max(MAX_KEY_ITEMS),
  })
  .strict();
export const fileTestBody = z
  .object({
    delivery: z.enum(['screen', 'paper']).default('screen'),
    variants: z.array(variant).max(VARIANT_LETTERS.length),
  })
  .strict();
export type FileTestBody = z.output<typeof fileTestBody>;

export const parseKeyBody = z
  .object({
    text: z.string().max(20_000),
    options: z.number().int().min(2).max(6).optional(),
    points: points.optional(),
  })
  .strict();

/** Rejimni almashtirish: `from` - mijoz ko'rgan joriy rejim (boshqa o'qituvchi allaqachon almashtirgan bo'lsa 409) */
export const contentBody = z
  .object({ content: z.enum(['bank', 'file']), from: z.enum(['bank', 'file']) })
  .strict();
export type ContentBody = z.output<typeof contentBody>;

export const variantCorrectBody = z
  .object({ blockId: z.string().regex(/^[0-9a-f]{24}$/), variant: z.enum(VARIANT_LETTERS) })
  .strict();

const toValidation = (issues: ValidationIssue[]) =>
  AppError.validation(
    issues[0]!.message,
    issues.map((i) => ({ path: i.path, message: i.message })),
  );

// ---------- Kirish ----------
/** Tuzuvchi (ma'muriyat yoki imtihon yaratuvchisi) yoki shu blokka biriktirilgan o'qituvchi; aks holda 404 */
export async function fileBlockAccess(
  ctx: Ctx,
  schoolId: string,
  sessionId: string,
  blockId: string,
) {
  const scope = await resolveExamScope(ctx.actor, schoolId);
  const s: ExamSessionDoc | null = isId(sessionId)
    ? await ExamSession.findOne({ _id: sessionId, schoolId, isDeleted: { $ne: true } })
    : null;
  if (!s) throw notFoundBlock();
  const b = normalizeBlocks(s).find((x) => x.blockId === blockId && !x.legacy);
  if (!b) throw notFoundBlock();
  const manager = scope.all || isCreator(s, ctx.actor);
  if (!manager && !b.contributors.includes(ctx.actor.id)) throw notFoundBlock();
  const role: Role = manager ? 'composer' : 'contributor';
  return { s, b, role };
}

function assertFileMode(b: NBlock) {
  if (b.content !== 'file') {
    throw AppError.conflict('Blok "Fayl + kalit" rejimida emas: avval shu rejimni tanlang');
  }
}

// ---------- Ko'rinish ----------
const fileDto = (
  f: Pick<ExamFileDoc, 'kind' | 'contentType' | 'size' | 'width' | 'height' | 'pages' | 'state'> & {
    id: string;
  },
) => ({
  id: f.id,
  kind: f.kind,
  contentType: f.contentType,
  size: f.size,
  width: f.width,
  height: f.height,
  pages: f.pages,
  /** 'ready': diskda; 'expired': muddati tugagan (kalit saqlangan); 'pending': yuklanmoqda */
  state: f.state,
});

async function viewOf(schoolId: string, sessionId: string, b: NBlock) {
  const ft = b.fileTest;
  const ids = (ft?.variants ?? []).flatMap((v) => v.files);
  const files = ids.length
    ? await ExamFile.find({ schoolId, sessionId, _id: { $in: ids.map(oid) } }).lean()
    : [];
  const byId = new Map(files.map((f) => [String(f._id), f]));
  return {
    delivery: ft?.delivery ?? 'screen',
    variants: (ft?.variants ?? []).map((v) => ({
      letter: v.letter,
      kind: v.kind,
      files: v.files.map((id) => {
        const f = byId.get(id);
        return f
          ? fileDto({ ...f, id })
          : {
              id,
              kind: v.kind,
              contentType: '',
              size: 0,
              width: 0,
              height: 0,
              pages: 0,
              state: 'expired' as const,
            };
      }),
      key: v.key,
    })),
    questions: fileTestCount(ft),
  };
}

export const fileTestService = {
  /** Blok fayl testi: variantlar, fayllar va KALIT (faqat tuzuvchi/biriktirilgan o'qituvchi) */
  async get(ctx: Ctx, schoolId: string, sessionId: string, blockId: string) {
    const { s, b, role } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    const lock = lockOf(s, b, clock.now(), role);
    return {
      role,
      content: b.content,
      locked: lock !== null,
      lockReason: lock,
      status: b.status,
      readyBy: b.readyBy,
      hasBank:
        b.content === 'file'
          ? b.bankCount > 0
          : b.items.length + b.contribQuestions.length + b.contribRules.length > 0,
      hasFile: (b.fileTest?.variants ?? []).some((v) => v.key.length > 0 || v.files.length > 0),
      ...(await viewOf(schoolId, sessionId, b)),
    };
  },

  /**
   * Blok usulini almashtirish (savollar banki <-> fayl+kalit). Faqat blok tahrirga ochiq bo'lganda (savollar bilan
   * bir xil qulflar). Boshqa usul mazmuni O'CHMAYDI (yashirin saqlanadi, qaytganda tiklanadi). Atomik: filtrda
   * joriy rejim bor, shuning uchun bir fanning ikki o'qituvchisi bir vaqtda almashtirsa faqat biri o'tadi.
   */
  async setContent(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: ContentBody,
  ) {
    const { s, b, role } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    assertUnlocked(s, b, role);
    if (body.from !== b.content) {
      throw AppError.conflict(
        'Blok usuli boshqa foydalanuvchi tomonidan o‘zgartirilgan: sahifani yangilang',
      );
    }
    if (body.content === b.content) return fileTestService.get(ctx, schoolId, sessionId, blockId);
    const set: Record<string, unknown> = {
      'blocks.$.content': body.content,
      // Usul o'zgardi: eski "tayyor" belgisi yangi mazmunga taalluqli emas
      'blocks.$.status': 'open',
      'blocks.$.readyBy': null,
    };
    if (body.content === 'file') {
      set['blocks.$.bankTarget'] = b.bankTarget ?? b.targetCount;
      if (b.fileTest && fileTestCount(b.fileTest) > 0) {
        set['blocks.$.targetCount'] = fileTestCount(b.fileTest);
      }
    } else {
      set['blocks.$.targetCount'] = b.bankTarget ?? b.targetCount;
    }
    const r = await ExamSession.updateOne(
      {
        _id: s._id,
        schoolId,
        status: 'draft',
        isDeleted: { $ne: true },
        ...writeGuard(ctx, role, blockId, clock.now(), body.from),
      },
      { $set: set },
    );
    if (!r.matchedCount) {
      const fresh = await ExamSession.findById(s._id).select('blocks').lean();
      const cur = (fresh?.blocks as { blockId: string; content?: string }[] | undefined)?.find(
        (x) => x.blockId === blockId,
      );
      if ((cur?.content ?? 'bank') !== body.from) {
        throw AppError.conflict(
          'Blok usuli boshqa foydalanuvchi tomonidan o‘zgartirilgan: sahifani yangilang',
        );
      }
      throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq');
    }
    await audit(
      ctx,
      schoolId,
      'exam.block.content',
      sessionId,
      { content: body.from },
      {
        blockId,
        content: body.content,
      },
    );
    return fileTestService.get(ctx, schoolId, sessionId, blockId);
  },

  /** Yetkazish, variantlar va kalitni TO'LIQ almashtiradi (qoralama; qulf qoidalari savollar banki bilan bir xil) */
  async put(ctx: Ctx, schoolId: string, sessionId: string, blockId: string, body: FileTestBody) {
    const { s, b, role } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    assertFileMode(b);
    assertUnlocked(s, b, role);
    const paper = body.delivery === 'paper';
    const ft: FileTest = {
      delivery: body.delivery,
      variants: body.variants.map((v) => ({
        letter: v.letter,
        kind: v.kind,
        // Qog'ozda fayl yuklanmaydi
        files: paper ? [] : v.files,
        key: v.key.map((k) =>
          k.type === 'short'
            ? {
                no: k.no,
                type: 'short' as const,
                accepted: k.accepted.map((a) => a.trim()),
                points: k.points,
              }
            : {
                no: k.no,
                type: 'choice' as const,
                options: k.options,
                correct: [...new Set(k.correct)].sort(),
                points: k.points,
              },
        ),
      })),
    };
    const issues = validateFileTest(ft, false);
    if (issues.length) throw toValidation(issues);
    const ids = ft.variants.flatMap((v) => v.files);
    await assertFilesExist(schoolId, sessionId, blockId, ids);
    const r = await ExamSession.updateOne(
      {
        _id: s._id,
        schoolId,
        status: 'draft',
        isDeleted: { $ne: true },
        ...writeGuard(ctx, role, blockId, clock.now(), 'file'),
      },
      {
        $set: {
          'blocks.$.fileTest': ft as never,
          // Maqsad = savollar soni (fayl rejimida alohida maqsad yo'q)
          'blocks.$.targetCount': fileTestCount(ft),
        },
      },
    );
    if (!r.matchedCount) {
      throw AppError.forbidden('Blok hozir tahrirlash uchun yopiq yoki usuli o‘zgartirilgan');
    }
    if (ids.length) {
      await ExamFile.updateMany(
        { schoolId, sessionId, _id: { $in: ids.map(oid) } },
        { $set: { bound: true } },
      );
    }
    // Olib tashlangan/almashtirilgan fayllar darhol o'chiriladi (yozuv va baytlar)
    const prev = (b.fileTest?.variants ?? []).flatMap((v) => v.files);
    const removed = prev.filter((id) => !ids.includes(id));
    if (removed.length) {
      const docs = await ExamFile.find({
        schoolId,
        sessionId,
        _id: { $in: removed.map(oid) },
      }).select('storageName');
      await deleteFiles(docs);
    }
    // Kalit auditga YOZILMAYDI (faqat tuzilma): audit jurnalini ko'radiganlarga javoblar chiqib ketmasin
    await audit(
      ctx,
      schoolId,
      'exam.block.file_test_save',
      sessionId,
      fileTestSummary(b.fileTest),
      {
        blockId,
        ...fileTestSummary(ft),
      },
    );
    return fileTestService.get(ctx, schoolId, sessionId, blockId);
  },

  /** Fayl yuklash (PDF/JPG/PNG), diskka. Faol rejim `file`, yetkazish `screen` va tahrir ochiq bo'lishi shart */
  async upload(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    uploadPath: string | undefined,
  ) {
    const { s, b, role } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    assertFileMode(b);
    if (b.fileTest?.delivery === 'paper') {
      throw AppError.conflict('Qog‘ozda yetkazishda fayl yuklanmaydi: faqat kalit kiritiladi');
    }
    assertUnlocked(s, b, role);
    if (!uploadPath) {
      throw AppError.validation('Fayl yuborilmadi', [
        { path: 'file', message: 'Fayl yuborilmadi' },
      ]);
    }
    const insp = await inspectUpload(uploadPath).catch((e) => {
      throw e;
    });
    const doc = await commitFile(insp, { schoolId, sessionId, blockId, createdBy: ctx.actor.id });
    await audit(ctx, schoolId, 'exam.block.file_upload', sessionId, null, {
      blockId,
      kind: doc.kind,
      size: doc.size,
    });
    return { file: fileDto({ ...doc.toObject(), id: doc.id as string }) };
  },

  /**
   * Muddati tugagan faylni qayta yuklash: yozuv id si o'zgarmaydi, kalit va variantlar tegilmaydi. Faqat tuzuvchi;
   * har qanday imtihon holatida (yopilgan imtihonni qayta ochish uchun ham kerak), o'chirilgan/bekor qilinmagan bo'lsa.
   */
  async replaceExpired(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    fileId: string,
    uploadPath: string | undefined,
  ) {
    const { s, b, role } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    if (role !== 'composer')
      throw AppError.forbidden('Faylni qayta yuklashni faqat tuzuvchi bajaradi');
    if (s.status === 'cancelled') throw AppError.conflict('Bekor qilingan imtihon');
    assertFileMode(b);
    if (!uploadPath)
      throw AppError.validation('Fayl yuborilmadi', [
        { path: 'file', message: 'Fayl yuborilmadi' },
      ]);
    if (!isId(fileId)) throw AppError.notFound('Fayl topilmadi');
    const doc = await ExamFile.findOne({ _id: fileId, schoolId, sessionId, blockId });
    const inBlock = (b.fileTest?.variants ?? []).some((v) => v.files.includes(fileId));
    if (!doc || !inBlock) throw AppError.notFound('Fayl topilmadi');
    if (doc.state === 'ready') throw AppError.conflict('Fayl hali amalda: almashtirish kerak emas');
    const insp = await inspectUpload(uploadPath);
    const variantKind = b.fileTest!.variants.find((v) => v.files.includes(fileId))!.kind;
    if (insp.kind !== variantKind) {
      throw AppError.validation('Fayl turi variantga mos emas', [
        { path: 'file', message: variantKind === 'pdf' ? 'PDF yuklang' : 'Rasm yuklang' },
      ]);
    }
    await recommitFile(doc, insp);
    await audit(ctx, schoolId, 'exam.block.file_replace', sessionId, null, {
      blockId,
      size: insp.size,
    });
    return fileTestService.get(ctx, schoolId, sessionId, blockId);
  },

  /** Ko'rish uchun fayl yozuvi: blok kalitida bor yoki shu foydalanuvchi yuklagan va hali hech qayerga bog'lanmagan */
  async fileFor(ctx: Ctx, schoolId: string, sessionId: string, blockId: string, fileId: string) {
    const { b } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    if (!isId(fileId)) throw AppError.notFound('Fayl topilmadi');
    const doc = await ExamFile.findOne({ _id: fileId, schoolId, sessionId, blockId });
    if (!doc) throw AppError.notFound('Fayl topilmadi');
    const inBlock = (b.fileTest?.variants ?? []).some((v) => v.files.includes(fileId));
    if (!inBlock && !(String(doc.createdBy) === ctx.actor.id && !doc.bound)) {
      throw AppError.notFound('Fayl topilmadi');
    }
    return doc;
  },

  /** Kalit matnini o'qish ("1-C 2-A 3-25 4-B,D"): ko'rib chiqish uchun, hech narsa saqlanmaydi */
  async parseKey(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    blockId: string,
    body: z.output<typeof parseKeyBody>,
  ) {
    const { b } = await fileBlockAccess(ctx, schoolId, sessionId, blockId);
    assertFileMode(b);
    return parseKeyText(body.text, { options: body.options, points: body.points });
  },

  /**
   * Qog'oz yetkazish: o'quvchi tanlagan variant xato bo'lsa tuzuvchi/yaratuvchi/nazoratchi tuzatadi (auditga yoziladi).
   * Urinishdagi savollar va saqlangan javoblar SAVOL RAQAMI bo'yicha yangi variantga ko'chiriladi, ball qayta hisoblanadi.
   * Parallel javob saqlash bilan to'qnashmaslik uchun clientSeq bo'yicha optimistik (3 marta qayta urinish).
   */
  async correctVariant(
    ctx: Ctx,
    schoolId: string,
    sessionId: string,
    participantKey: string,
    body: z.output<typeof variantCorrectBody>,
  ) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s: ExamSessionDoc | null = isId(sessionId)
      ? await ExamSession.findOne({ _id: sessionId, schoolId, isDeleted: { $ne: true } })
      : null;
    if (!s) throw AppError.notFound('Imtihon topilmadi');
    if (!scope.all && !isCreator(s, ctx.actor) && !isSupervisor(s, ctx.actor)) {
      throw AppError.notFound('Imtihon topilmadi');
    }
    const blk = normalizeBlocks(s).find((x) => x.blockId === body.blockId);
    if (!blk || blk.content !== 'file' || blk.fileTest?.delivery !== 'paper') {
      throw AppError.conflict('Bu blokda qog‘oz variantini tuzatib bo‘lmaydi');
    }
    const target = blk.fileTest.variants.find((v) => v.letter === body.variant);
    if (!target)
      throw AppError.validation('Variant topilmadi', [
        { path: 'variant', message: 'Bunday variant yo‘q' },
      ]);
    for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
      const a = await ExamAttempt.findOne({ sessionId: s._id, participantKey, schoolId });
      if (!a) throw AppError.notFound('Urinish topilmadi');
      if (a.status === 'joined') throw AppError.conflict('O‘quvchi hali boshlamagan');
      const before = a.fileVariants?.[body.blockId] ?? null;
      const lastIdx = a.order.reduce((acc, o, i) => (o.blockId === body.blockId ? i : acc), -1);
      const firstIdx = a.order.findIndex((o) => o.blockId === body.blockId);
      const fresh = orderOfVariant(body.blockId, target);
      const order =
        firstIdx < 0
          ? // tanlanmagan edi: blok o'rniga (blok tartibi bo'yicha) qo'yiladi
            insertBlockItems(a.order as never, normalizeBlocks(s), body.blockId, fresh)
          : [...a.order.slice(0, firstIdx), ...fresh, ...a.order.slice(lastIdx + 1)];
      const nos = new Set(target.key.map((k) => k.no));
      const remap = (qid: string) => {
        const m = /^fk:([0-9a-f]{24}):([A-D]):(\d+)$/.exec(qid);
        return m && m[1] === body.blockId ? fileQid(body.blockId, body.variant, Number(m[3])) : qid;
      };
      const saved = (a.saved as { qid: string }[])
        .filter((x) => {
          const m = /^fk:([0-9a-f]{24}):([A-D]):(\d+)$/.exec(x.qid);
          return !(m && m[1] === body.blockId && !nos.has(Number(m[3])));
        })
        .map((x) => ({ ...x, qid: remap(x.qid) }));
      const answeredCount = saved.filter((x) => (x as { answered?: boolean }).answered).length;
      const upd = await ExamAttempt.updateOne(
        { _id: a._id, clientSeq: a.clientSeq },
        {
          $set: {
            order,
            saved,
            answeredCount,
            [`fileVariants.${body.blockId}`]: body.variant,
            score: null,
            scoredAt: null,
          },
        },
      );
      if (!upd.matchedCount) continue;
      await audit(
        ctx,
        schoolId,
        'exam.attempt.variant_correct',
        sessionId,
        { variant: before },
        {
          participantKey,
          blockId: body.blockId,
          variant: body.variant,
        },
      );
      return { variant: body.variant, previous: before };
    }
    throw AppError.conflict('Javoblar o‘zgarmoqda: qayta urinib ko‘ring');
  },
};

export { deleteFiles, expireFiles };
