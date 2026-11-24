import crypto from 'crypto';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { ExamAsset } from '../../models/ExamAsset';
import {
  ExamAttempt,
  EVENT_TYPES,
  MAX_EVENTS,
  type AttemptEventType,
  type ExamAttemptDoc,
  type IAttemptOrderItem,
  type IAttemptScore,
} from '../../models/ExamAttempt';
import { ExamEntryCode } from '../../models/ExamEntryCode';
import { ExamJoinGuard } from '../../models/ExamJoinGuard';
import { ExamSession, type ExamSessionDoc } from '../../models/ExamSession';
import { School } from '../../models/School';
import { clock } from '../../utils/clock';
import { EXAMS_KEY, type ExamsSettings } from '../settings/exams.settings';
import { settingsService } from '../settings/settings.service';
import {
  hashEntryCode,
  isWellFormedEntryCode,
  normalizeEntryCode,
  signConfirm,
  verifyConfirm,
} from '../exams/sessions/entryCode';
import { hashPin, normalizePin } from '../exams/sessions/pin';
import { fmtTashkent } from '../exams/sessions/sessions.pdf';
import {
  advanceExpired,
  canEnter,
  commonEnd,
  finishCurrentBlock,
  initBlockState,
  participantDeadline,
  projectedDeadline,
  type BlockStateLike,
} from '../exams/sessions/timing';
import {
  effectiveItems,
  normalizeBlocks,
  scoringOf,
  timingModeOf,
  totalQuestionCount,
  type NBlock,
} from '../exams/blocks/blocks.core';
import { balancedVariant, orderOfVariant } from '../exams/filetest/filetest.core';
import { insertBlockItems } from '../exams/filetest/filetest.core';
import { ExamFile } from '../../models/ExamFile';
import { gradeAttempt } from './grading';
import { selectQuestions, type PoolQuestion, type StoredSection } from './selection';

// ---------- Sozlamalar ----------
/** Deadline dan keyin yozuvlar shuncha qabul qilinadi (tarmoq kechikishi uchun) */
export const DEADLINE_GRACE_MS = 5_000;
const DEVICE_MAX_FAILS = 5;
const DEVICE_WINDOW_MS = 10 * 60_000;
const DEVICE_BLOCK_MS = 5 * 60_000;
const IP_MAX_FAILS = 100;
const IP_WINDOW_MS = 10 * 60_000;
const IP_BLOCK_MS = 10 * 60_000;
/** Sessiya bo'yicha shuncha noto'g'ri urinishdan keyin nazoratchiga ogohlantirish */
export const SESSION_FAIL_ALERT = 200;
const TOKEN_TAIL_MS = 12 * 3_600_000;

/**
 * Shaxsiy kod bilan kirishdagi himoya: qurilma (qattiq), IP va umumiy.
 * E7 qarori (egasi, 2026-11-23): IP chegarasi 100 -> 500 xato (10 daqiqada), blok 10 -> 5 daqiqa. Sabab: butun maktab
 * bitta NAT IP dan kiradi; eski 100 chegarasi 300-500 o'quvchining oddiy yozuv xatolarida butun maktabni 10 daqiqaga
 * bloklardi. Xavfsizlik narxi: 9 belgili kod (31^9 = 2,6e13) va ~500 ta yaroqli kod bilan bitta IP dan kuniga eng
 * ko'pi ~144 oyna x 500 = ~72 ming taxmin: muvaffaqiyat ehtimoli ~1,4e-6 (kuniga). Qurilma chegarasi (5 xato/5 daq)
 * mijoz bergan deviceId bo'yicha, shuning uchun asosiy to'siq emas; umumiy chegara taqsimlangan hujumni ushlaydi.
 */
export const CODE_DEV_MAX_FAILS = 5;
const CODE_DEV_BLOCK_MS = 5 * 60_000;
export const CODE_IP_MAX_FAILS = 500;
export const CODE_IP_BLOCK_MS = 5 * 60_000;
export const CODE_GLOBAL_MAX_FAILS = 20_000;
const CODE_GLOBAL_BLOCK_MS = 2 * 60_000;
const CODE_MSG = "Kod noto'g'ri yoki muddati tugagan";
const codeError = () => AppError.unauthorized(CODE_MSG);

const GENERIC_MSG = "Kod yoki PIN noto'g'ri";
/** Barcha muvaffaqiyatsiz kirishlar (noto'g'ri kod / PIN / mavjud emas / modul o'chiq) uchun BIR XIL javob */
const generic = () => AppError.unauthorized(GENERIC_MSG);

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqualHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// ---------- Kirish sxemalari ----------
export const joinBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
    pin: z.string().trim().min(4).max(12),
    deviceId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
export type JoinBody = z.output<typeof joinBody>;

const deviceIdField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,64}$/);
/** Shaxsiy kod: erkin matn (bo'shliq/chiziqcha/kirill harflar normallashtiriladi), uzunlik cheklangan */
export const joinCodeBody = z
  .object({ code: z.string().trim().min(1).max(40), deviceId: deviceIdField })
  .strict();
export type JoinCodeBody = z.output<typeof joinCodeBody>;
export const joinConfirmBody = z
  .object({ confirmToken: z.string().trim().min(10).max(1000), deviceId: deviceIdField })
  .strict();
export type JoinConfirmBody = z.output<typeof joinConfirmBody>;

const answerItem = z
  .object({
    qid: z.string().min(1).max(40),
    value: z.union([z.string().max(10_000), z.array(z.string().max(64)).max(20), z.null()]),
    flagged: z.boolean().optional(),
  })
  .strict();
export const answersBody = z
  .object({
    clientSeq: z.number().int().min(0).max(1_000_000_000),
    answers: z.array(answerItem).max(200),
  })
  .strict();
export type AnswersBody = z.output<typeof answersBody>;

export const eventBody = z
  .object({
    type: z.enum(EVENT_TYPES),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type EventBody = z.output<typeof eventBody>;

/** Nazoratchi ogohlantirishlarini ko'rdim deb tasdiqlash (urinish tokeni bilan: faqat o'z ogohlantirishlari) */
export const ackBody = z
  .object({ ids: z.array(z.string().min(1).max(40)).min(1).max(20) })
  .strict();
export type AckBody = z.output<typeof ackBody>;

/** Blokni yakunlash: faqat JORIY blok id si (ikki marta bosish keyingi blokni o'tkazib yubormasin) */
export const finishBlockBody = z.object({ blockId: z.string().min(1).max(40) }).strict();
/** Qog'oz yetkazish: o'quvchi qog'ozidagi variant */
export const chooseVariantBody = z
  .object({ blockId: z.string().min(1).max(40), variant: z.enum(['A', 'B', 'C', 'D']) })
  .strict();
export type ChooseVariantBody = z.output<typeof chooseVariantBody>;
export type FinishBlockBody = z.output<typeof finishBlockBody>;

// ---------- Himoya hisoblagichlari (DB) ----------
async function isBlocked(keys: string[], now: Date): Promise<boolean> {
  return (
    (await ExamJoinGuard.countDocuments({ key: { $in: keys }, blockedUntil: { $gt: now } })) > 0
  );
}

async function recordFailure(
  key: string,
  now: Date,
  max: number,
  windowMs: number,
  blockMs: number,
): Promise<void> {
  const g = await ExamJoinGuard.findOne({ key });
  let count = 1;
  let windowStart = now;
  if (g && g.windowStart.getTime() > now.getTime() - windowMs) {
    count = g.count + 1;
    windowStart = g.windowStart;
  }
  const blocked = count >= max;
  await ExamJoinGuard.updateOne(
    { key },
    {
      $set: {
        count: blocked ? 0 : count,
        windowStart: blocked ? now : windowStart,
        blockedUntil: blocked ? new Date(now.getTime() + blockMs) : (g?.blockedUntil ?? null),
        expiresAt: new Date(now.getTime() + Math.max(windowMs, blockMs) + 60_000),
      },
    },
    { upsert: true },
  );
}

// ---------- DTO (OQ RO'YXAT: hujjat hech qachon spread qilinmaydi) ----------
type RawBlock = { type?: string; text?: string; tex?: string; assetId?: unknown };
const blockDto = (b: RawBlock) => {
  if (b.type === 'math') return { type: 'math' as const, tex: String(b.tex ?? '') };
  if (b.type === 'image') return { type: 'image' as const, assetId: String(b.assetId) };
  return { type: 'text' as const, text: String(b.text ?? '') };
};
const blocksDto = (list: unknown[] | undefined) => (list ?? []).map((b) => blockDto(b as RawBlock));

/** Klientga yuboriladigan savol: JAVOB KALITI, qiyinlik, mavzu va h.k. YO'Q */
export function toClientQuestions(
  order: readonly IAttemptOrderItem[],
  pool: Map<string, PoolQuestion>,
) {
  const out: {
    id: string;
    blockId?: string;
    type: string;
    points: number;
    /** Fayl bloki (§22): varaqadagi savol raqami va variant harfi; matn/variant mazmuni yo'q (fayldan o'qiladi) */
    no?: number;
    variant?: string;
    content: ReturnType<typeof blockDto>[];
    options: { id: string; content: ReturnType<typeof blockDto>[] }[];
  }[] = [];
  for (const o of order) {
    const q = pool.get(o.qid);
    if (!q) continue;
    const byId = new Map((q.options ?? []).map((x) => [x.id, x]));
    if (o.variant) {
      out.push({
        id: o.qid,
        ...(o.blockId ? { blockId: o.blockId } : {}),
        type: o.type,
        points: o.points,
        no: o.no,
        variant: o.variant,
        content: [],
        options: o.optionPerm.map((id) => ({ id, content: [] })),
      });
      continue;
    }
    out.push({
      id: o.qid,
      ...(o.blockId ? { blockId: o.blockId } : {}),
      type: o.type,
      points: o.points,
      content: blocksDto(q.content),
      options: o.optionPerm
        .map((id) => byId.get(id))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => ({ id: x.id, content: blocksDto(x.content) })),
    });
  }
  return out;
}

function assetIdsOf(questions: ReturnType<typeof toClientQuestions>): string[] {
  const ids = new Set<string>();
  for (const q of questions) {
    for (const b of q.content) if (b.type === 'image') ids.add(b.assetId);
    for (const o of q.options)
      for (const b of o.content) if (b.type === 'image') ids.add(b.assetId);
  }
  return [...ids];
}

/**
 * Fayl bloki uchun variant tartib raqami (blokda shu ishtirokchigacha variant olganlar soni, 0 dan): DB da atomik
 * hisoblagich, shuning uchun parallel boshlashda ham variantlar tekis taqsimlanadi va restartdan keyin ham.
 */
async function nextFileVariantIndex(sessionId: string, blockId: string): Promise<number> {
  const before = (await ExamSession.findOneAndUpdate(
    { _id: sessionId },
    { $inc: { [`fileCounters.${blockId}`]: 1 } },
    { returnDocument: 'before', projection: { fileCounters: 1 } },
  ).lean()) as { fileCounters?: Record<string, number> } | null;
  return before?.fileCounters?.[blockId] ?? 0;
}

/**
 * Klientga: ko'rinadigan fayl bloklari. 'screen': variant harfi va fayl id lari; 'paper': fayl yo'q, o'quvchi
 * variantni tanlagunicha `variant: null` va `variants` (tanlash uchun harflar). Kalit hech qachon chiqmaydi.
 */
function fileBlocksView(
  a: Pick<ExamAttemptDoc, 'fileVariants'>,
  session: ExamSessionDoc,
  visible: ReadonlySet<string>,
) {
  const variants = a.fileVariants ?? {};
  return normalizeBlocks(session)
    .filter((b) => b.content === 'file' && b.fileTest && visible.has(b.blockId))
    .map((b) => {
      const ft = b.fileTest!;
      const chosen = variants[b.blockId] ?? null;
      const v = ft.variants.find((x) => x.letter === chosen);
      return {
        blockId: b.blockId,
        delivery: ft.delivery,
        variant: chosen,
        variants: ft.delivery === 'paper' ? ft.variants.map((x) => x.letter) : [],
        kind: v?.kind ?? ft.variants[0]?.kind ?? 'pdf',
        files: ft.delivery === 'screen' ? (v?.files ?? []).map((id) => ({ id })) : [],
      };
    });
}

const poolOf = (s: ExamSessionDoc): Map<string, PoolQuestion> =>
  new Map((s.questionPool as unknown as PoolQuestion[]).map((q) => [String(q.questionId), q]));

/**
 * Qaynoq yo'llar (kirish, boshlash, blok, baholash) uchun YENGIL sessiya: Mongoose hujjatiga aylantirilmaydi (lean),
 * faqat kerakli maydonlar olinadi; 300-500 ishtirokchili ro'yxatdan faqat BITTA ishtirokchi (`$elemMatch`),
 * savollar hovuzi (`questionPool`) faqat kerak bo'lganda. Yuklama testi (E7): to'liq hujjatni har so'rovda
 * Mongoose subhujjatlariga aylantirish CPU ning asosiy qismini yeyardi. Natija `ExamSessionDoc` sifatida ishlatiladi
 * (faqat quyidagi maydonlar to'ldirilgan; `id` qo'shiladi); yozuvlar baribir atomik `updateOne` bilan qilinadi.
 */
const LITE_FIELDS = {
  schoolId: 1,
  title: 1,
  type: 1,
  subjectId: 1,
  scheduledStart: 1,
  durationMin: 1,
  status: 1,
  code: 1,
  codeActive: 1,
  sections: 1,
  blocks: 1,
  scoringMode: 1,
  timingMode: 1,
  shuffleQuestions: 1,
  shuffleOptions: 1,
  resultsMode: 1,
  passPercent: 1,
  resultsPublished: 1,
  isDeleted: 1,
} as const;

export async function loadLiteSession(
  filter: Record<string, unknown>,
  opts: { participantKey?: string; pool?: boolean } = {},
): Promise<ExamSessionDoc | null> {
  const projection: Record<string, unknown> = { ...LITE_FIELDS };
  if (opts.participantKey) projection.participants = { $elemMatch: { key: opts.participantKey } };
  if (opts.pool) projection.questionPool = 1;
  const s = (await ExamSession.findOne(filter, projection as never).lean()) as {
    _id: unknown;
    participants?: unknown[];
    questionPool?: unknown[];
  } | null;
  if (!s) return null;
  return {
    ...s,
    id: String(s._id),
    participants: s.participants ?? [],
    questionPool: opts.pool ? (s.questionPool ?? []) : [],
  } as unknown as ExamSessionDoc;
}

async function loadSessionWithPool(id: unknown, participantKey?: string): Promise<ExamSessionDoc> {
  const s = await loadLiteSession(
    { _id: id, isDeleted: { $ne: true } },
    { pool: true, participantKey },
  );
  if (!s) throw AppError.notFound('Imtihon topilmadi');
  return s;
}

async function assertSchoolActive(schoolId: unknown): Promise<boolean> {
  const school = await School.findById(schoolId).select('isActive deletingAt').lean();
  if (!school || !school.isActive || school.deletingAt) return false;
  const exams = await settingsService.getEffective<ExamsSettings>(EXAMS_KEY, String(schoolId));
  return !!exams.enabled;
}

/** Har ishtirokchiga ko'rsatiladigan savollar soni (qo'lda takrorsiz + qoidalar) */
const questionCountOf = (s: ExamSessionDoc): number => totalQuestionCount(normalizeBlocks(s));

/** Bloklar haqida klientga ma'lumot (kalitsiz): id, nom, savollar soni, davomiylik */
function blocksMeta(session: ExamSessionDoc, order: readonly IAttemptOrderItem[]) {
  const blocks = normalizeBlocks(session);
  const first = blocks[0]!.blockId;
  const known = new Set(blocks.map((b) => b.blockId));
  const counts = new Map<string, number>();
  for (const o of order) {
    const id = o.blockId && known.has(o.blockId) ? o.blockId : first;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return blocks.map((b) => ({
    id: b.blockId,
    title: b.title,
    questionCount: order.length ? (counts.get(b.blockId) ?? 0) : blockQuestionCountOf(b),
    durationMin: b.durationMin,
  }));
}
const blockQuestionCountOf = (b: NBlock): number => totalQuestionCount([b]);

/**
 * Blokma-blok urinish: vaqti tugagan bloklarni (grace dan keyin) ketma-ket yopib, keyingisini ochadi; oxirgi blok ham
 * tugagan bo'lsa urinishni avtomatik topshiradi. Faqat DB dagi holatdan ishlaydi (xotira yo'q). Optimistik
 * (blockIndex filtri): parallel so'rovda biri yutadi, qolganlari yangi holatni o'qiydi.
 */
export async function syncBlocks(attempt: ExamAttemptDoc, now: Date): Promise<ExamAttemptDoc> {
  if (attempt.status !== 'in_progress' || !attempt.blockState?.length) return attempt;
  const hard = attempt.hardDeadline ?? attempt.deadline;
  if (!hard) return attempt;
  const adv = advanceExpired(
    attempt.blockState as BlockStateLike[],
    attempt.blockIndex ?? 0,
    now,
    hard,
    DEADLINE_GRACE_MS,
  );
  if (!adv.changed) return attempt;
  const filter = {
    _id: attempt._id,
    status: 'in_progress' as const,
    blockIndex: attempt.blockIndex ?? 0,
  };
  const set = adv.finished
    ? {
        status: 'auto_submitted',
        submittedAt: adv.finishedAt,
        blockState: adv.state,
        blockIndex: adv.index,
      }
    : {
        blockState: adv.state,
        blockIndex: adv.index,
        deadline: projectedDeadline(adv.state, adv.index, hard),
      };
  const upd = await ExamAttempt.findOneAndUpdate(
    filter,
    { $set: set as never },
    { returnDocument: 'after' },
  );
  return upd ?? (await ExamAttempt.findById(attempt._id)) ?? attempt;
}

/** Hali tasdiqlanmagan nazoratchi ogohlantirishlari (eng ko'pi 5 ta, eskisidan boshlab): state/heartbeat javobida */
export function pendingWarnings(a: Pick<ExamAttemptDoc, 'warnings'>) {
  return (a.warnings ?? [])
    .filter((w) => !w.ackAt)
    .slice(0, 5)
    .map((w) => ({ id: w.id, text: w.text, at: w.at }));
}

/** Klientga: joriy blok holati (blokma-blok urinish) yoki null */
function blockView(a: ExamAttemptDoc) {
  const st = (a.blockState ?? []) as BlockStateLike[];
  if (!st.length) return null;
  const cur = st[a.blockIndex ?? 0];
  return {
    index: a.blockIndex ?? 0,
    total: st.length,
    id: cur?.blockId ?? null,
    startedAt: cur?.startedAt ?? null,
    deadline: cur?.deadline ?? null,
  };
}

// ---------- Natija ----------
function resultPayload(
  attempt: ExamAttemptDoc,
  session: Pick<ExamSessionDoc, 'resultsMode' | 'resultsPublished'> & { questionPool?: unknown },
  score: IAttemptScore | null,
) {
  // after_publish: o'qituvchi e'lon qilgach ball ko'rinadi (faqat ball)
  const published = session.resultsMode === 'after_publish' && session.resultsPublished;
  const mode = published ? 'score' : session.resultsMode;
  const base = {
    status: attempt.status,
    mode,
    submittedAt: attempt.submittedAt,
    answeredCount: attempt.answeredCount,
    total: attempt.order.length,
    /** Nazoratchi to'xtatgan (sabab o'quvchiga ko'rsatilmaydi) */
    terminated: !!attempt.terminated,
  };
  if ((mode !== 'score' && mode !== 'score_answers') || !score) {
    return { ...base, available: false as const };
  }
  const summary = {
    earned: score.earned,
    max: score.max,
    autoMax: score.autoMax,
    essayPending: score.essayPending,
  };
  // Blok bo'yicha ballar: faqat bir nechta blokli imtihonda (eski natija shakli o'zgarmaydi)
  const nblocks = normalizeBlocks(session as ExamSessionDoc);
  const blocksScore =
    nblocks.length > 1 && score.blocks?.length
      ? {
          blocks: score.blocks.map((b) => ({
            id: b.blockId,
            title: nblocks.find((x) => x.blockId === b.blockId)?.title ?? '',
            earned: b.earned,
            max: b.max,
          })),
        }
      : {};
  const blockOfQ = new Map(attempt.order.map((o) => [o.qid, o.blockId ?? null]));
  if (mode === 'score') {
    return { ...base, available: true as const, score: summary, ...blocksScore };
  }
  const pool = poolOf(session as ExamSessionDoc);
  const given = new Map(attempt.saved.map((s) => [s.qid, s.value]));
  const review = score.items.map((it) => {
    const q = pool.get(it.qid);
    const key = (q?.answer ?? {}) as Record<string, unknown>;
    const type = q?.type ?? '';
    const reveal =
      type === 'single'
        ? { optionIds: key.optionId ? [String(key.optionId)] : [] }
        : type === 'multi'
          ? { optionIds: ((key.optionIds as string[]) ?? []).map(String) }
          : type === 'short'
            ? { texts: ((key.acceptedAnswers as string[]) ?? []).map(String) }
            : {};
    return {
      id: it.qid,
      blockId: blockOfQ.get(it.qid) ?? null,
      type,
      got: it.got,
      max: it.max,
      ok: it.ok,
      given: given.get(it.qid) ?? null,
      reveal,
    };
  });
  return { ...base, available: true as const, score: summary, ...blocksScore, review };
}

/** Bahoni (kerak bo'lsa) hisoblab saqlaydi. Idempotent: javoblar va kalit manba, qayta hisoblash xavfsiz */
export async function ensureScored(
  attempt: ExamAttemptDoc,
  session?: ExamSessionDoc,
): Promise<{ score: IAttemptScore; session: ExamSessionDoc }> {
  const s = session ?? (await loadSessionWithPool(attempt.sessionId));
  if (attempt.score) return { score: attempt.score, session: s };
  const score = gradeAttempt(
    attempt.order,
    attempt.saved,
    poolOf(s),
    attempt.manual ?? [],
    scoringOf(s),
  );
  await ExamAttempt.updateOne(
    { _id: attempt._id, score: null },
    { $set: { score, scoredAt: clock.now() } },
  );
  return { score, session: s };
}

// ---------- Servis ----------
export const examClientService = {
  /**
   * Kirish: kod + PIN + qurilma. Kod bo'yicha faol (scheduled/open) sessiyalar topiladi (kod maktablar
   * orasida takrorlanishi mumkin; PIN sessiya tuzi bilan tekshiriladi). Hamma xato holatlari bir xil javob.
   * `scheduled` holatdagi sessiyaga ham boshlanish vaqtidan keyin kirilaveradi: birinchi muvaffaqiyatli kirishda
   * sessiya avtomatik `open` ga o'tadi (nazoratchi qo'lda ochishi shart emas).
   */
  async join(body: JoinBody, ip: string) {
    const now = clock.now();
    const devKey = `dev:${body.code}:${body.deviceId}`;
    const ipKey = `ip:${body.code}:${ip}`;
    if (await isBlocked([devKey, ipKey], now)) {
      throw AppError.rateLimited(
        "Ko'p noto'g'ri urinish. Bir necha daqiqadan so'ng qayta urinib ko'ring",
      );
    }
    const candidates = await ExamSession.find({
      code: body.code,
      codeActive: true,
      status: { $in: ['scheduled', 'open'] },
      isDeleted: { $ne: true },
    }).limit(5);

    let session: ExamSessionDoc | null = null;
    let participant: ExamSessionDoc['participants'][number] | null = null;
    const pin = normalizePin(body.pin);
    for (const c of candidates) {
      const h = hashPin(c.pinSalt, pin);
      let found: (typeof c.participants)[number] | null = null;
      for (const p of c.participants) if (safeEqualHex(p.pinHash, h)) found = p; // butun ro'yxat: vaqt bir xil
      if (found && !session) {
        session = c;
        participant = found;
      }
    }
    if (!session || !participant) {
      await Promise.all([
        recordFailure(devKey, now, DEVICE_MAX_FAILS, DEVICE_WINDOW_MS, DEVICE_BLOCK_MS),
        recordFailure(ipKey, now, IP_MAX_FAILS, IP_WINDOW_MS, IP_BLOCK_MS),
      ]);
      if (candidates.length) {
        const ids = candidates.map((c) => c._id);
        await ExamSession.updateMany(
          { _id: { $in: ids } },
          { $inc: { 'joinFailures.count': 1 }, $set: { 'joinFailures.lastAt': now } },
        );
        await ExamSession.updateMany(
          {
            _id: { $in: ids },
            'joinFailures.count': { $gte: SESSION_FAIL_ALERT },
            'joinFailures.alertAt': null,
          },
          { $set: { 'joinFailures.alertAt': now } },
        );
      }
      throw generic();
    }
    return examClientService.enter(session, participant, body.deviceId, now, devKey);
  },

  /**
   * Shaxsiy kod bilan kirish, 1-qadam ("Bu sizmisiz?"): kod topilsa ishtirokchi va imtihon haqida minimal ma'lumot
   * + qisqa muddatli tasdiqlash tokeni qaytadi. Urinish hujjati YARATILMAYDI va imtihon boshlanmaydi.
   * Noto'g'ri/muddati tugagan/o'chirilgan imtihon kodi uchun BIR XIL xato; qurilma, IP va umumiy hisoblagichlar.
   */
  async joinCode(body: JoinCodeBody, ip: string) {
    const now = clock.now();
    const devKey = `cdev:${body.deviceId}`;
    const ipKey = `cip:${ip}`;
    const globKey = 'cglob';
    if (await isBlocked([devKey, ipKey, globKey], now)) {
      throw AppError.rateLimited(
        "Ko'p noto'g'ri urinish. Bir necha daqiqadan so'ng qayta urinib ko'ring",
      );
    }
    const norm = normalizeEntryCode(body.code);
    let session: ExamSessionDoc | null = null;
    let participant: ExamSessionDoc['participants'][number] | null = null;
    // Shakli noto'g'ri kod bazaga umuman murojaat qilmaydi (lekin urinish sifatida hisoblanadi)
    const hit = isWellFormedEntryCode(norm)
      ? await ExamEntryCode.findOne({ codeHash: hashEntryCode(norm) }).lean()
      : null;
    if (hit) {
      session = await loadLiteSession(
        {
          _id: hit.sessionId,
          schoolId: hit.schoolId,
          codeActive: true,
          status: { $in: ['scheduled', 'open'] },
          isDeleted: { $ne: true },
        },
        { participantKey: hit.participantKey },
      );
      participant = session?.participants.find((p) => p.key === hit.participantKey) ?? null;
    }
    if (!session || !participant || !(await assertSchoolActive(session.schoolId))) {
      await Promise.all([
        recordFailure(devKey, now, CODE_DEV_MAX_FAILS, DEVICE_WINDOW_MS, CODE_DEV_BLOCK_MS),
        recordFailure(ipKey, now, CODE_IP_MAX_FAILS, IP_WINDOW_MS, CODE_IP_BLOCK_MS),
        recordFailure(globKey, now, CODE_GLOBAL_MAX_FAILS, IP_WINDOW_MS, CODE_GLOBAL_BLOCK_MS),
      ]);
      throw codeError();
    }
    await ExamJoinGuard.deleteOne({ key: devKey });
    const attempt = await ExamAttempt.findOne({
      sessionId: session._id,
      participantKey: participant.key,
    }).select('status');
    const blocks = normalizeBlocks(session).filter((b) => !b.legacy);
    return {
      confirmToken: signConfirm(
        {
          sessionId: session.id as string,
          participantKey: participant.key,
          deviceId: body.deviceId,
        },
        now,
      ),
      serverNow: now,
      participant: {
        fullName: participant.fullName,
        className: participant.className ?? participant.origin ?? null,
      },
      exam: {
        title: session.title,
        subjectsCount: blocks.length || 1,
        durationMin: session.durationMin,
        startsAt: session.scheduledStart,
        endsAt: commonEnd(session),
        phase:
          now < session.scheduledStart
            ? 'upcoming'
            : now < commonEnd(session)
              ? 'running'
              : 'ended',
      },
      attemptStatus: attempt?.status ?? null,
    };
  },

  /** 2-qadam ("Ha, boshlash"): tasdiqlash tokeni yaroqli bo'lsa mavjud kirish oqimi (urinish + token) */
  async joinConfirm(body: JoinConfirmBody) {
    const now = clock.now();
    const v = verifyConfirm(body.confirmToken, body.deviceId, now);
    const expired = () =>
      AppError.validation('Tasdiqlash muddati tugadi: kodni qayta kiriting', [
        { path: 'confirmToken', message: 'Tasdiqlash muddati tugadi' },
      ]);
    if (!v) throw expired();
    const session = await loadLiteSession(
      {
        _id: v.sessionId,
        codeActive: true,
        status: { $in: ['scheduled', 'open'] },
        isDeleted: { $ne: true },
      },
      { participantKey: v.participantKey },
    );
    const participant = session?.participants.find((p) => p.key === v.participantKey) ?? null;
    if (!session || !participant) throw expired();
    return examClientService.enter(session, participant, body.deviceId, now);
  },

  /**
   * Ishtirokchini imtihonga kiritadi (kod+PIN yoki shaxsiy kod tasdiqlangach): maktab faolligi, vaqt oynasi, urinish
   * hujjati va token. Faqat TAYYOR (topilgan va tasdiqlangan) session+participant bilan chaqiriladi.
   */
  async enter(
    session: ExamSessionDoc,
    participant: ExamSessionDoc['participants'][number],
    deviceId: string,
    now: Date,
    devKey?: string,
  ) {
    if (!(await assertSchoolActive(session.schoolId))) throw generic();
    if (devKey) await ExamJoinGuard.deleteOne({ key: devKey });

    let attempt = await ExamAttempt.findOne({
      sessionId: session._id,
      participantKey: participant.key,
    });
    const finished =
      !!attempt && (attempt.status === 'submitted' || attempt.status === 'auto_submitted');
    if (!finished && !canEnter(session, participant, now)) {
      // Kod+PIN jufti to'g'ri bo'lgandan keyingina (kod/PIN noto'g'ri bo'lsa umumiy xato)
      throw AppError.conflict(
        now < session.scheduledStart
          ? 'Imtihon hali boshlanmagan'
          : `Imtihon ${fmtTashkent(commonEnd(session)).slice(-5)} da tugagan. Nazoratchiga murojaat qiling.`,
      );
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const end = participantDeadline(session, participant, now);
    const tokenExpiresAt = new Date(
      Math.max(end.getTime(), commonEnd(session).getTime()) + TOKEN_TAIL_MS,
    );

    if (attempt) {
      if (attempt.deviceId !== deviceId) {
        if (!participant.allowReentry) throw AppError.conflict('Boshqa qurilmada ochilgan');
        // Nazoratchi ruxsat bergan: yangi qurilmaga o'tkaziladi, ruxsat bir martalik
        await ExamSession.updateOne(
          { _id: session._id, 'participants.key': participant.key },
          { $set: { 'participants.$.allowReentry': false } },
        );
      }
      attempt = await ExamAttempt.findOneAndUpdate(
        { _id: attempt._id },
        { $set: { tokenHash, tokenExpiresAt, deviceId: deviceId, lastSeenAt: now } },
        { returnDocument: 'after' },
      );
    } else {
      try {
        attempt = await ExamAttempt.create({
          schoolId: session.schoolId,
          sessionId: session._id,
          participantKey: participant.key,
          participantKind: participant.kind,
          fullName: participant.fullName,
          className: participant.className ?? participant.origin ?? null,
          tokenHash,
          tokenExpiresAt,
          deviceId: deviceId,
          lastSeenAt: now,
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
        // Parallel kirish: boshqasi yaratib qo'ydi. Qurilma shu bo'lsa token almashtiriladi, aks holda rad.
        const other = await ExamAttempt.findOne({
          sessionId: session._id,
          participantKey: participant.key,
        });
        if (!other || other.deviceId !== deviceId)
          throw AppError.conflict('Boshqa qurilmada ochilgan');
        attempt = await ExamAttempt.findOneAndUpdate(
          { _id: other._id },
          { $set: { tokenHash, tokenExpiresAt, lastSeenAt: now } },
          { returnDocument: 'after' },
        );
      }
    }
    if (!attempt) throw generic();

    if (session.status === 'scheduled' && now >= session.scheduledStart) {
      await ExamSession.updateOne(
        { _id: session._id, status: 'scheduled' },
        { $set: { status: 'open', openedAt: now } },
      );
    }

    const timing = timingModeOf(session);
    return {
      token,
      serverNow: now,
      attemptStatus: attempt.status,
      terminated: !!attempt.terminated,
      participant: { fullName: attempt.fullName, className: attempt.className },
      exam: {
        title: session.title,
        type: session.type,
        durationMin: session.durationMin,
        questionCount: attempt.order.length || questionCountOf(session),
        resultsMode: session.resultsMode,
        startsAt: session.scheduledStart,
        endsAt: commonEnd(session),
        /** Hozir boshlansa tugash vaqti (kechikkan o'quvchi uchun qisqargan) */
        deadlinePreview: attempt.deadline ?? end,
        /** per_block: bloklar orasida erkin o'tish YO'Q */
        freeNavigation: timing === 'common',
        timingMode: timing,
        blocks: blocksMeta(session, attempt.order),
      },
    };
  },

  /**
   * Boshlash (idempotent): savollar tanlanadi, deadline server tomonda hisoblanadi, mavjud bo'lsa o'sha qaytadi.
   * Blokma-blok rejimda faqat JORIY blok savollari qaytadi (yopilgan va hali ochilmagan bloklar yuborilmaydi).
   */
  async start(attempt: ExamAttemptDoc) {
    const now = clock.now();
    if (attempt.status === 'submitted' || attempt.status === 'auto_submitted') {
      throw AppError.conflict('Imtihon topshirilgan');
    }
    const session = await loadSessionWithPool(attempt.sessionId, attempt.participantKey);
    const pool = poolOf(session);
    let current: ExamAttemptDoc;
    if (attempt.status === 'joined') {
      const participant = session.participants.find((p) => p.key === attempt.participantKey);
      if (!participant) throw AppError.forbidden('Siz bu imtihon ishtirokchisi emassiz');
      if (
        !['scheduled', 'open'].includes(session.status) ||
        !(await assertSchoolActive(session.schoolId))
      ) {
        throw AppError.conflict('Imtihon hozir mavjud emas');
      }
      if (!canEnter(session, participant, now)) {
        throw AppError.conflict(
          now < session.scheduledStart
            ? 'Imtihon hali boshlanmagan'
            : `Imtihon ${fmtTashkent(commonEnd(session)).slice(-5)} da tugagan. Nazoratchiga murojaat qiling.`,
        );
      }
      const nblocks = normalizeBlocks(session);
      const base = selectQuestions({
        ...(nblocks[0]!.legacy
          ? { sections: session.sections as unknown as StoredSection[] }
          : {
              blocks: nblocks.map((b) => ({
                blockId: b.blockId,
                items: effectiveItems(b),
              })),
            }),
        pool,
        shuffleQuestions: session.shuffleQuestions,
        shuffleOptions: session.shuffleOptions,
        seed: `${session.id}:${attempt.id}`,
      });
      // Fayl + kalit bloklari (§22/§23): ekranda variant tekis tasodifiy beriladi, savollar kalit tartibida (aralashtirilmaydi)
      const fileVariants: Record<string, string> = {};
      const fileMap: Record<string, string> = {};
      const order: IAttemptOrderItem[] = nblocks[0]!.legacy
        ? base
        : (
            await Promise.all(
              nblocks.map(async (b) => {
                if (b.content !== 'file' || !b.fileTest?.variants.length) {
                  return base.filter((o) => o.blockId === b.blockId);
                }
                // Qog'oz: variant o'quvchi tomonidan tanlanadi (chooseVariant), savollar o'shanda yaratiladi
                if (b.fileTest.delivery === 'paper') return [];
                const letters = b.fileTest.variants.map((v) => v.letter);
                const letter = balancedVariant(
                  letters,
                  await nextFileVariantIndex(String(session.id), b.blockId),
                  `${session.id}:${b.blockId}`,
                );
                const v = b.fileTest.variants.find((x) => x.letter === letter)!;
                fileVariants[b.blockId] = letter;
                for (const f of v.files) fileMap[f] = b.blockId;
                return orderOfVariant(b.blockId, v);
              }),
            )
          ).flat();
      const assetIds = assetIdsOf(toClientQuestions(order, pool));
      const hard = participantDeadline(session, participant, now);
      const perBlock = timingModeOf(session) === 'per_block' && !nblocks[0]!.legacy;
      const blockState = perBlock
        ? initBlockState(
            nblocks.map((b) => ({ blockId: b.blockId, durationMin: b.durationMin ?? 1 })),
            now,
            hard,
          )
        : [];
      const upd = await ExamAttempt.findOneAndUpdate(
        { _id: attempt._id, status: 'joined' },
        {
          $set: {
            status: 'in_progress',
            startedAt: now,
            deadline: perBlock ? projectedDeadline(blockState, 0, hard) : hard,
            ...(perBlock ? { blockState, blockIndex: 0, hardDeadline: hard } : {}),
            order,
            assetIds,
            fileVariants,
            fileMap,
            lastSeenAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      current = upd ?? (await ExamAttempt.findById(attempt._id)) ?? attempt;
    } else {
      current = await syncBlocks(attempt, now);
      if (current.status === 'auto_submitted') throw AppError.conflict('Imtihon topshirilgan');
    }
    return this.view(current, session, pool, now);
  },

  /** Joriy ko'rinish (start/blokni yakunlash javobi): savollar (blokma-blok: faqat joriy blok), saqlanganlar, bloklar */
  view(
    current: ExamAttemptDoc,
    session: ExamSessionDoc,
    pool: Map<string, PoolQuestion>,
    now: Date,
  ) {
    const bv = blockView(current);
    const order = bv ? current.order.filter((o) => o.blockId === bv.id) : current.order;
    const qids = new Set(order.map((o) => o.qid));
    return {
      serverNow: now,
      status: current.status,
      startedAt: current.startedAt,
      deadline: current.deadline,
      timingMode: timingModeOf(session),
      blocks: blocksMeta(session, current.order),
      block: bv,
      /** Fayl bloklari (§22/§23): faqat ko'rinadigan (joriy) bloklar; kalit hech qachon chiqmaydi */
      files: fileBlocksView(
        current,
        session,
        new Set(bv ? [bv.id ?? ''] : normalizeBlocks(session).map((b) => b.blockId)),
      ),
      questions: toClientQuestions(order, pool),
      saved: current.saved
        .filter((s) => qids.has(s.qid))
        .map((s) => ({
          id: s.qid,
          value: s.value ?? null,
          flagged: !!s.flagged,
        })),
      clientSeq: current.clientSeq,
    };
  },

  async state(attempt0: ExamAttemptDoc) {
    const now = clock.now();
    const attempt = await syncBlocks(attempt0, now);
    await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { lastSeenAt: now } });
    return {
      serverNow: now,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadline: attempt.deadline,
      answeredCount: attempt.answeredCount,
      total: attempt.order.length,
      clientSeq: attempt.clientSeq,
      block: blockView(attempt),
      terminated: !!attempt.terminated,
      warnings: pendingWarnings(attempt),
    };
  },

  /**
   * Blokni yakunlash (blokma-blok rejim): joriy blok yopiladi (orqaga qaytish yo'q), keyingi blok hozirdan boshlanadi;
   * oxirgi blok bo'lsa imtihon topshiriladi. `blockId` joriy blok bo'lmasa hech narsa o'zgarmaydi (idempotent).
   */
  async finishBlock(attempt0: ExamAttemptDoc, body: FinishBlockBody) {
    const now = clock.now();
    const attempt = await syncBlocks(attempt0, now);
    if (attempt.status === 'submitted' || attempt.status === 'auto_submitted') {
      return { finished: true as const, ...(await this.result(attempt)) };
    }
    if (attempt.status !== 'in_progress') throw AppError.conflict('Imtihon hali boshlanmagan');
    if (!attempt.blockState?.length) {
      throw AppError.conflict('Bu imtihon blokma-blok emas');
    }
    const session = await loadSessionWithPool(attempt.sessionId);
    const pool = poolOf(session);
    const bv = blockView(attempt)!;
    if (bv.id !== body.blockId) {
      // Eskirgan so'rov (blok allaqachon almashgan): joriy holatni qaytaramiz
      return { finished: false as const, ...this.view(attempt, session, pool, now) };
    }
    const hard = attempt.hardDeadline ?? attempt.deadline!;
    const adv = finishCurrentBlock(attempt.blockState as BlockStateLike[], bv.index, now, hard);
    const filter = { _id: attempt._id, status: 'in_progress' as const, blockIndex: bv.index };
    if (adv.finished) {
      const done = await ExamAttempt.findOneAndUpdate(
        filter,
        {
          $set: {
            status: 'submitted',
            submittedAt: now,
            lastSeenAt: now,
            blockState: adv.state,
          },
        },
        { returnDocument: 'after' },
      );
      const cur = done ?? (await ExamAttempt.findById(attempt._id)) ?? attempt;
      return { finished: true as const, ...(await this.result(cur)) };
    }
    const upd = await ExamAttempt.findOneAndUpdate(
      filter,
      {
        $set: {
          blockState: adv.state,
          blockIndex: adv.index,
          deadline: projectedDeadline(adv.state, adv.index, hard),
          lastSeenAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    const cur = upd ?? (await ExamAttempt.findById(attempt._id)) ?? attempt;
    return { finished: false as const, ...this.view(cur, session, pool, now) };
  },

  /** Javoblarni saqlash: atomik findOneAndUpdate (token + holat + deadline + clientSeq filtrda) */
  async saveAnswers(attempt0: ExamAttemptDoc, body: AnswersBody) {
    const now = clock.now();
    // Blokma-blok: vaqti tugagan bloklar avval yopiladi
    const attempt = await syncBlocks(attempt0, now);
    const bv = attempt.status === 'in_progress' ? blockView(attempt) : null;
    const byQid = new Map(attempt.order.map((o) => [o.qid, o]));
    const items: { qid: string; value: unknown; flagged: boolean; answered: boolean; at: Date }[] =
      [];
    const rejected: string[] = [];
    const seen = new Set<string>();
    for (const a of body.answers) {
      const o = byQid.get(a.qid);
      if (!o)
        throw AppError.validation('Savol topilmadi', [
          { path: 'answers', message: "Bu savol sizning imtihoningizda yo'q" },
        ]);
      if (seen.has(a.qid)) continue; // bir so'rovda takror: birinchisi
      if (
        bv &&
        (o.blockId !== bv.id ||
          !bv.deadline ||
          now.getTime() > bv.deadline.getTime() + DEADLINE_GRACE_MS)
      ) {
        // Yopilgan (yoki hali ochilmagan) blokka javob yozilmaydi
        seen.add(a.qid);
        rejected.push(a.qid);
        continue;
      }
      seen.add(a.qid);
      const v = normalizeValue(o, a.value);
      items.push({
        qid: a.qid,
        value: v.value,
        answered: v.answered,
        flagged: a.flagged === true,
        at: now,
      });
    }
    if (bv && !items.length) {
      // Hammasi yopiq blokniki: navbat to'xtashi uchun tasdiqlanadi, lekin hech narsa saqlanmaydi
      return {
        savedSeq: Math.max(attempt.clientSeq, body.clientSeq),
        answeredCount: attempt.answeredCount,
        serverNow: now,
        rejected,
        blockId: bv.id,
      };
    }
    const qids = items.map((i) => i.qid);
    const updated = await ExamAttempt.findOneAndUpdate(
      {
        _id: attempt._id,
        tokenHash: attempt.tokenHash,
        status: 'in_progress',
        ...(bv ? { blockIndex: bv.index } : {}),
        deadline: { $gt: new Date(now.getTime() - DEADLINE_GRACE_MS) },
        clientSeq: { $lt: body.clientSeq },
      },
      [
        {
          $set: {
            saved: {
              $concatArrays: [
                {
                  $filter: {
                    input: '$saved',
                    as: 's',
                    cond: { $not: [{ $in: ['$$s.qid', { $literal: qids }] }] },
                  },
                },
                { $literal: items },
              ],
            },
            clientSeq: body.clientSeq,
            lastSeenAt: now,
          },
        },
        {
          $set: {
            answeredCount: {
              $size: { $filter: { input: '$saved', as: 's', cond: '$$s.answered' } },
            },
          },
        },
      ],
      {
        returnDocument: 'after',
        updatePipeline: true,
        projection: { clientSeq: 1, answeredCount: 1 },
      },
    );
    if (updated) {
      return {
        savedSeq: updated.clientSeq,
        answeredCount: updated.answeredCount,
        serverNow: now,
        ...(rejected.length ? { rejected, blockId: bv?.id ?? null } : {}),
      };
    }
    // Saqlanmadi: sabab aniqlanadi (eskirgan seq xato emas; topshirilgan/muddati o'tgan: 409)
    const fresh = await ExamAttempt.findById(attempt._id).select(
      'status deadline clientSeq answeredCount blockIndex terminated',
    );
    if (!fresh) throw AppError.notFound('Urinish topilmadi');
    if (fresh.status !== 'in_progress') {
      throw AppError.conflict(
        fresh.terminated ? 'Imtihon nazoratchi tomonidan to‘xtatilgan' : 'Imtihon topshirilgan',
      );
    }
    if (bv && (fresh.blockIndex ?? 0) !== bv.index) {
      // Blok almashgan (poyga): bu paketdagi javoblar eski blokniki, saqlanmaydi
      return {
        savedSeq: Math.max(fresh.clientSeq, body.clientSeq),
        answeredCount: fresh.answeredCount,
        serverNow: now,
        rejected: items.map((i) => i.qid).concat(rejected),
        blockId: bv.id,
      };
    }
    if (!fresh.deadline || fresh.deadline.getTime() <= now.getTime() - DEADLINE_GRACE_MS) {
      throw AppError.conflict('Imtihon vaqti tugagan');
    }
    return {
      savedSeq: fresh.clientSeq,
      answeredCount: fresh.answeredCount,
      serverNow: now,
      stale: true,
    };
  },

  async recordEvent(attempt: ExamAttemptDoc, body: EventBody) {
    const now = clock.now();
    const key: Record<AttemptEventType, string> = {
      blur: 'blur',
      fullscreen_exit: 'fullscreenExit',
      visibility_hidden: 'visibilityHidden',
      reconnect: 'reconnect',
    };
    const at = body.at ? new Date(body.at) : null;
    const leave = body.type !== 'reconnect';
    const r = await ExamAttempt.updateOne(
      { _id: attempt._id, status: 'in_progress' },
      {
        $push: { events: { $each: [{ type: body.type, at, serverAt: now }], $slice: -MAX_EVENTS } },
        $inc: { [`counters.${key[body.type]}`]: 1 },
        $set: { lastSeenAt: now, ...(leave ? { lastLeaveAt: now } : {}) },
      },
    );
    return { recorded: r.modifiedCount > 0, serverNow: now };
  },

  async heartbeat(attempt0: ExamAttemptDoc) {
    const now = clock.now();
    const attempt = await syncBlocks(attempt0, now);
    await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { lastSeenAt: now } });
    return {
      serverNow: now,
      status: attempt.status,
      deadline: attempt.deadline,
      block: blockView(attempt),
      terminated: !!attempt.terminated,
      warnings: pendingWarnings(attempt),
    };
  },

  /** Ogohlantirishlarni tasdiqlash (idempotent): faqat shu urinishning o'z ogohlantirishlari */
  async ackWarnings(attempt: ExamAttemptDoc, body: AckBody) {
    const now = clock.now();
    const r = await ExamAttempt.updateOne(
      { _id: attempt._id, 'warnings.id': { $in: body.ids } },
      {
        $set: { 'warnings.$[w].ackAt': now, lastSeenAt: now },
        $push: {
          events: {
            $each: [{ type: 'warning_ack', at: null, serverAt: now }],
            $slice: -MAX_EVENTS,
          },
        },
      },
      { arrayFilters: [{ 'w.id': { $in: body.ids }, 'w.ackAt': null }] },
    );
    return { acknowledged: r.modifiedCount > 0, serverNow: now };
  },

  /** Topshirish (idempotent): in_progress -> submitted; qayta chaqirilsa mavjud natija qaytadi */
  async submit(attempt: ExamAttemptDoc) {
    const now = clock.now();
    const done = await ExamAttempt.findOneAndUpdate(
      { _id: attempt._id, status: 'in_progress' },
      { $set: { status: 'submitted', submittedAt: now, lastSeenAt: now } },
      { returnDocument: 'after' },
    );
    const cur = done ?? (await ExamAttempt.findById(attempt._id));
    if (!cur) throw AppError.notFound('Urinish topilmadi');
    if (cur.status === 'joined') throw AppError.conflict('Imtihon hali boshlanmagan');
    return this.result(cur);
  },

  async result(attempt: ExamAttemptDoc) {
    if (attempt.status === 'in_progress' || attempt.status === 'joined') {
      throw AppError.conflict('Imtihon hali tugamagan');
    }
    const { score, session } = await ensureScored(attempt);
    // Natija hisoblangan bo'lsa yangi hujjatni qayta o'qimaymiz: score lokal qiymat bilan to'ldiriladi
    return resultPayload(attempt, session, score);
  },

  /**
   * Test fayli yozuvi (§22/§23): faqat shu urinishga berilgan variant fayllari. Imtihon boshlangandan keyin (urinish
   * in_progress), blokma-blok rejimda faqat JORIY blok fayli. Topshirilgandan keyin faqat natija rejimi `score_answers`
   * bo'lsa. Boshqa urinish/sessiya fayli: 404. Baytlar chaqiruvchida diskdan oqim bilan beriladi.
   */
  async file(attempt: ExamAttemptDoc, id: string) {
    const blockId = (attempt.fileMap ?? {})[id];
    if (!blockId) throw AppError.notFound('Fayl topilmadi');
    if (attempt.status === 'in_progress') {
      const bv = blockView(attempt);
      if (bv && bv.id !== blockId) throw AppError.notFound('Fayl topilmadi');
    } else if (attempt.status === 'submitted' || attempt.status === 'auto_submitted') {
      const s = await ExamSession.findById(attempt.sessionId).select('resultsMode').lean();
      if (s?.resultsMode !== 'score_answers') throw AppError.notFound('Fayl topilmadi');
    } else {
      throw AppError.notFound('Fayl topilmadi');
    }
    const doc = await ExamFile.findOne({
      _id: id,
      schoolId: attempt.schoolId,
      sessionId: attempt.sessionId,
    });
    if (!doc) throw AppError.notFound('Fayl topilmadi');
    return doc;
  },

  /**
   * Qog'oz yetkazish: o'quvchi qog'ozidagi variantni tanlaydi (tasdiqdan keyin qulflanadi). Savollar tanlangan variant
   * kaliti bo'yicha shu zahoti yaratiladi (kalit sessiya nusxasida oldindan tayyor sun'iy savollar sifatida turadi).
   * Atomik: filtrda "variant hali tanlanmagan" sharti bor; qayta tanlash 409 (tuzatish faqat tuzuvchi/nazoratchi).
   * Blokma-blok rejimda faqat JORIY blok uchun.
   */
  async chooseVariant(attempt0: ExamAttemptDoc, body: ChooseVariantBody) {
    const now = clock.now();
    const attempt = await syncBlocks(attempt0, now);
    if (attempt.status !== 'in_progress')
      throw AppError.conflict('Imtihon hali boshlanmagan yoki tugagan');
    const bv = blockView(attempt);
    if (bv && bv.id !== body.blockId) throw AppError.conflict('Bu blok hozir ochiq emas');
    const session = await loadSessionWithPool(attempt.sessionId);
    const blk = normalizeBlocks(session).find((b) => b.blockId === body.blockId);
    if (!blk || blk.content !== 'file' || blk.fileTest?.delivery !== 'paper') {
      throw AppError.conflict('Bu blokda variant tanlanmaydi');
    }
    const target = blk.fileTest.variants.find((v) => v.letter === body.variant);
    if (!target)
      throw AppError.validation('Variant topilmadi', [
        { path: 'variant', message: 'Bunday variant yo‘q' },
      ]);
    const cur = (attempt.fileVariants ?? {})[body.blockId];
    if (cur) {
      throw AppError.conflict(
        `Variant allaqachon tanlangan (${cur}). Xato bo‘lsa nazoratchiga murojaat qiling`,
      );
    }
    const order = insertBlockItems(
      attempt.order as never,
      normalizeBlocks(session),
      body.blockId,
      orderOfVariant(body.blockId, target),
    );
    const upd = await ExamAttempt.findOneAndUpdate(
      {
        _id: attempt._id,
        status: 'in_progress',
        [`fileVariants.${body.blockId}`]: { $exists: false },
      },
      { $set: { order: order as never, [`fileVariants.${body.blockId}`]: body.variant } },
      { returnDocument: 'after' },
    );
    if (!upd) throw AppError.conflict('Variant allaqachon tanlangan');
    return this.view(upd, session, poolOf(session), now);
  },

  /** Rasm: faqat shu urinish savollarida ishlatilgan rasmlar (token bilan) */
  async asset(attempt: ExamAttemptDoc, id: string) {
    if (!attempt.assetIds.includes(id)) throw AppError.notFound('Rasm topilmadi');
    const a = await ExamAsset.findOne({ _id: id, schoolId: attempt.schoolId }).select(
      '+data contentType',
    );
    if (!a) throw AppError.notFound('Rasm topilmadi');
    return { data: a.data, contentType: a.contentType || 'image/webp' };
  },
};

// ---------- Qiymatni tekshirish ----------
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeValue(o: IAttemptOrderItem, raw: string | string[] | null) {
  const bad = (msg: string) =>
    AppError.validation("Javob noto'g'ri", [{ path: 'answers', message: msg }]);
  if (raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    return { value: null, answered: false };
  }
  if (o.type === 'single') {
    if (typeof raw !== 'string' || !o.optionPerm.includes(raw)) throw bad("Variant ro'yxatda yo'q");
    return { value: raw, answered: true };
  }
  if (o.type === 'multi') {
    if (!Array.isArray(raw)) throw bad('Bir nechta variant ro‘yxat bo‘lishi kerak');
    const uniq = [...new Set(raw)];
    if (uniq.some((x) => !o.optionPerm.includes(x))) throw bad("Variant ro'yxatda yo'q");
    return { value: uniq, answered: true };
  }
  if (typeof raw !== 'string') throw bad('Javob matn bo‘lishi kerak');
  const text = raw.replace(CTRL, '');
  const limit = o.type === 'essay' ? 10_000 : 500;
  if (text.length > limit) throw bad(`Javob ${limit} belgidan oshmasligi kerak`);
  return { value: text, answered: text.trim().length > 0 };
}

// ---------- Token orqali autentifikatsiya ----------
export async function authenticateAttempt(
  token: string | undefined,
  /** 'light': heartbeat/hodisa/tasdiq uchun katta massivlarsiz (order, saved, manual, score ham olinmaydi) */
  mode: 'full' | 'light' = 'full',
): Promise<ExamAttemptDoc> {
  if (!token) throw AppError.unauthorized("Avtorizatsiyadan o'tilmagan");
  // events hech bir exam-client yo'lida o'qilmaydi (faqat $push bilan yoziladi): hech qachon yuklanmaydi
  const q = ExamAttempt.findOne({
    tokenHash: sha256(token),
    tokenExpiresAt: { $gt: clock.now() },
  });
  if (mode === 'light') {
    // Eng ko'p chaqiriladigan yo'llar (heartbeat/hodisa/tasdiq): Mongoose hujjatisiz (lean), katta massivlarsiz
    const l = await q.select('-events -order -saved -manual -score -assetIds').lean();
    if (!l) throw AppError.unauthorized("Avtorizatsiyadan o'tilmagan");
    return { ...l, id: String(l._id) } as unknown as ExamAttemptDoc;
  }
  const a = await q.select('-events');
  if (!a) throw AppError.unauthorized("Avtorizatsiyadan o'tilmagan");
  return a;
}
