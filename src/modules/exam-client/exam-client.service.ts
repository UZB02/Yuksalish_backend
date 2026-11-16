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
import { ExamJoinGuard } from '../../models/ExamJoinGuard';
import { ExamSession, type ExamSessionDoc } from '../../models/ExamSession';
import { School } from '../../models/School';
import { clock } from '../../utils/clock';
import { EXAMS_KEY, type ExamsSettings } from '../settings/exams.settings';
import { settingsService } from '../settings/settings.service';
import { hashPin, normalizePin } from '../exams/sessions/pin';
import { fmtTashkent } from '../exams/sessions/sessions.pdf';
import { canEnter, commonEnd, participantDeadline } from '../exams/sessions/timing';
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
    type: string;
    points: number;
    content: ReturnType<typeof blockDto>[];
    options: { id: string; content: ReturnType<typeof blockDto>[] }[];
  }[] = [];
  for (const o of order) {
    const q = pool.get(o.qid);
    if (!q) continue;
    const byId = new Map((q.options ?? []).map((x) => [x.id, x]));
    out.push({
      id: o.qid,
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

const poolOf = (s: ExamSessionDoc): Map<string, PoolQuestion> =>
  new Map((s.questionPool as unknown as PoolQuestion[]).map((q) => [String(q.questionId), q]));

async function loadSessionWithPool(id: unknown): Promise<ExamSessionDoc> {
  const s = await ExamSession.findOne({ _id: id, isDeleted: { $ne: true } }).select(
    '+questionPool',
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
function questionCountOf(sections: StoredSection[]): number {
  const manual = new Set<string>();
  let rules = 0;
  for (const s of sections) {
    for (const it of s.items) {
      if (it.kind === 'manual') for (const q of it.questionIds ?? []) manual.add(String(q));
      else rules += it.count ?? 0;
    }
  }
  return manual.size + rules;
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
  if (mode === 'score') return { ...base, available: true as const, score: summary };
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
      type,
      got: it.got,
      max: it.max,
      ok: it.ok,
      given: given.get(it.qid) ?? null,
      reveal,
    };
  });
  return { ...base, available: true as const, score: summary, review };
}

/** Bahoni (kerak bo'lsa) hisoblab saqlaydi. Idempotent: javoblar va kalit manba, qayta hisoblash xavfsiz */
export async function ensureScored(
  attempt: ExamAttemptDoc,
  session?: ExamSessionDoc,
): Promise<{ score: IAttemptScore; session: ExamSessionDoc }> {
  const s = session ?? (await loadSessionWithPool(attempt.sessionId));
  if (attempt.score) return { score: attempt.score, session: s };
  const score = gradeAttempt(attempt.order, attempt.saved, poolOf(s), attempt.manual ?? []);
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
    if (!(await assertSchoolActive(session.schoolId))) throw generic();
    await ExamJoinGuard.deleteOne({ key: devKey });

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
      if (attempt.deviceId !== body.deviceId) {
        if (!participant.allowReentry) throw AppError.conflict('Boshqa qurilmada ochilgan');
        // Nazoratchi ruxsat bergan: yangi qurilmaga o'tkaziladi, ruxsat bir martalik
        await ExamSession.updateOne(
          { _id: session._id, 'participants.key': participant.key },
          { $set: { 'participants.$.allowReentry': false } },
        );
      }
      attempt = await ExamAttempt.findOneAndUpdate(
        { _id: attempt._id },
        { $set: { tokenHash, tokenExpiresAt, deviceId: body.deviceId, lastSeenAt: now } },
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
          deviceId: body.deviceId,
          lastSeenAt: now,
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
        // Parallel kirish: boshqasi yaratib qo'ydi. Qurilma shu bo'lsa token almashtiriladi, aks holda rad.
        const other = await ExamAttempt.findOne({
          sessionId: session._id,
          participantKey: participant.key,
        });
        if (!other || other.deviceId !== body.deviceId)
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

    const sections = session.sections as unknown as StoredSection[];
    return {
      token,
      serverNow: now,
      attemptStatus: attempt.status,
      participant: { fullName: attempt.fullName, className: attempt.className },
      exam: {
        title: session.title,
        type: session.type,
        durationMin: session.durationMin,
        questionCount: attempt.order.length || questionCountOf(sections),
        resultsMode: session.resultsMode,
        startsAt: session.scheduledStart,
        endsAt: commonEnd(session),
        /** Hozir boshlansa tugash vaqti (kechikkan o'quvchi uchun qisqargan) */
        deadlinePreview: attempt.deadline ?? end,
        freeNavigation: true,
      },
    };
  },

  /** Boshlash (idempotent): savollar tanlanadi, deadline server tomonda hisoblanadi, mavjud bo'lsa o'sha qaytadi */
  async start(attempt: ExamAttemptDoc) {
    const now = clock.now();
    if (attempt.status === 'submitted' || attempt.status === 'auto_submitted') {
      throw AppError.conflict('Imtihon topshirilgan');
    }
    const session = await loadSessionWithPool(attempt.sessionId);
    const pool = poolOf(session);
    let current = attempt;
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
      const order = selectQuestions({
        sections: session.sections as unknown as StoredSection[],
        pool,
        shuffleQuestions: session.shuffleQuestions,
        shuffleOptions: session.shuffleOptions,
        seed: `${session.id}:${attempt.id}`,
      });
      const assetIds = assetIdsOf(toClientQuestions(order, pool));
      const deadline = participantDeadline(session, participant, now);
      const upd = await ExamAttempt.findOneAndUpdate(
        { _id: attempt._id, status: 'joined' },
        {
          $set: {
            status: 'in_progress',
            startedAt: now,
            deadline,
            order,
            assetIds,
            lastSeenAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      current = upd ?? (await ExamAttempt.findById(attempt._id)) ?? attempt;
    }
    const questions = toClientQuestions(current.order, pool);
    return {
      serverNow: now,
      status: current.status,
      startedAt: current.startedAt,
      deadline: current.deadline,
      questions,
      saved: current.saved.map((s) => ({
        id: s.qid,
        value: s.value ?? null,
        flagged: !!s.flagged,
      })),
      clientSeq: current.clientSeq,
    };
  },

  async state(attempt: ExamAttemptDoc) {
    const now = clock.now();
    await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { lastSeenAt: now } });
    return {
      serverNow: now,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadline: attempt.deadline,
      answeredCount: attempt.answeredCount,
      total: attempt.order.length,
      clientSeq: attempt.clientSeq,
    };
  },

  /** Javoblarni saqlash: atomik findOneAndUpdate (token + holat + deadline + clientSeq filtrda) */
  async saveAnswers(attempt: ExamAttemptDoc, body: AnswersBody) {
    const now = clock.now();
    const byQid = new Map(attempt.order.map((o) => [o.qid, o]));
    const items: { qid: string; value: unknown; flagged: boolean; answered: boolean; at: Date }[] =
      [];
    const seen = new Set<string>();
    for (const a of body.answers) {
      const o = byQid.get(a.qid);
      if (!o)
        throw AppError.validation('Savol topilmadi', [
          { path: 'answers', message: "Bu savol sizning imtihoningizda yo'q" },
        ]);
      if (seen.has(a.qid)) continue; // bir so'rovda takror: birinchisi
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
    const qids = items.map((i) => i.qid);
    const updated = await ExamAttempt.findOneAndUpdate(
      {
        _id: attempt._id,
        tokenHash: attempt.tokenHash,
        status: 'in_progress',
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
    if (updated)
      return { savedSeq: updated.clientSeq, answeredCount: updated.answeredCount, serverNow: now };
    // Saqlanmadi: sabab aniqlanadi (eskirgan seq xato emas; topshirilgan/muddati o'tgan: 409)
    const fresh = await ExamAttempt.findById(attempt._id).select(
      'status deadline clientSeq answeredCount',
    );
    if (!fresh) throw AppError.notFound('Urinish topilmadi');
    if (fresh.status !== 'in_progress') throw AppError.conflict('Imtihon topshirilgan');
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
    const r = await ExamAttempt.updateOne(
      { _id: attempt._id, status: 'in_progress' },
      {
        $push: { events: { $each: [{ type: body.type, at, serverAt: now }], $slice: -MAX_EVENTS } },
        $inc: { [`counters.${key[body.type]}`]: 1 },
        $set: { lastSeenAt: now },
      },
    );
    return { recorded: r.modifiedCount > 0, serverNow: now };
  },

  async heartbeat(attempt: ExamAttemptDoc) {
    const now = clock.now();
    await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { lastSeenAt: now } });
    return { serverNow: now, status: attempt.status, deadline: attempt.deadline };
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
export async function authenticateAttempt(token: string | undefined): Promise<ExamAttemptDoc> {
  if (!token) throw AppError.unauthorized("Avtorizatsiyadan o'tilmagan");
  const a = await ExamAttempt.findOne({
    tokenHash: sha256(token),
    tokenExpiresAt: { $gt: clock.now() },
  });
  if (!a) throw AppError.unauthorized("Avtorizatsiyadan o'tilmagan");
  return a;
}
