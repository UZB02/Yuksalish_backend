import { logger } from '../../core/logger';
import { ExamAttempt } from '../../models/ExamAttempt';
import { ExamSession, type ExamSessionDoc } from '../../models/ExamSession';
import { auditService } from '../audit/audit.service';
import { notifyExamClosed } from '../telegram/telegram.exams';
import { clock } from '../../utils/clock';
import { commonEnd } from '../exams/sessions/timing';
import { persistResultsMeta } from '../exams/results/results.meta';
import { DEADLINE_GRACE_MS, ensureScored, loadLiteSession } from './exam-client.service';

/** Bir yurishda hisoblanadigan urinishlar soni (sweeper yengil bo'lishi uchun) */
const SCORE_BATCH = 200;
/** Shuncha urinishdan keyin event-loop ga nafas beriladi (yuzlab avtomatik topshirishda API qotib qolmasin) */
const SCORE_CHUNK = 20;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Muddati o'tgan urinishlarni avtomatik topshiradi (mavjud minutlik vazifa ichida chaqiriladi).
 *  1) bitta `updateMany` (indeks {status, deadline}): in_progress va deadline + grace < hozir -> auto_submitted,
 *     submittedAt = deadline. Xotirada hech narsa yo'q: restartdan keyin ham keyingi yurishda tugallanadi.
 *  2) ball hisoblash: bir yurishda eng ko'pi SCORE_BATCH ta urinish (sessiya bo'yicha guruhlab, savollar nusxasi
 *     bir marta o'qiladi), SCORE_CHUNK talik bo'laklarda va bo'laklar orasida event-loop ga nafas berib; lean
 *     (Mongoose hujjatisiz). Qolganlari keyingi yurishda; natija so'ralganda ham lazy hisoblanadi (ensureScored).
 *     Qidiruv `attempts_unscored` qisman indeksidan (faqat bahosizlar) foydalanadi.
 * Qaytadi: avtomatik topshirilganlar soni.
 */
export async function runExamSweeper(): Promise<number> {
  const now = clock.now();
  const cutoff = new Date(now.getTime() - DEADLINE_GRACE_MS);
  const r = await ExamAttempt.updateMany(
    { status: 'in_progress', deadline: { $lt: cutoff } },
    [{ $set: { status: 'auto_submitted', submittedAt: '$deadline' } }],
    { updatePipeline: true },
  );
  const pending = await ExamAttempt.find({ status: 'auto_submitted', score: null })
    .sort({ sessionId: 1 })
    .limit(SCORE_BATCH)
    .select('sessionId order saved manual score')
    .lean();
  const bySession = new Map<string, typeof pending>();
  for (const a of pending) {
    const k = String(a.sessionId);
    bySession.set(k, [...(bySession.get(k) ?? []), a]);
  }
  for (const [sid, list] of bySession) {
    try {
      const session = await loadLiteSession({ _id: sid }, { pool: true });
      if (!session) continue;
      for (const [i, a] of list.entries()) {
        await ensureScored(a as never, session);
        if ((i + 1) % SCORE_CHUNK === 0) await yieldLoop();
      }
    } catch (err) {
      logger.error({ err, sessionId: sid }, 'Imtihon urinishlarini hisoblash xatosi');
    }
  }
  await autoCloseSessions(now);
  return r.modifiedCount;
}

/**
 * Avtomatik yopish: umumiy tugash o'tgan OCHIQ imtihon, agar hech bir urinish jarayonda bo'lmasa
 * (muddati o'tganlari yuqorida allaqachon topshirilgan) va to'liq vaqt/qo'shimcha daqiqa berilgan, hali kirmagan
 * ishtirokchi uchun oyna (umumiy tugash + davomiylik + extra) ham o'tgan bo'lsa -> closed, kod bo'shaydi.
 * Idempotent (holat filtri), audit `exam.session.auto_close`, keyin Telegram xulosasi.
 */
export async function autoCloseSessions(now: Date): Promise<number> {
  const candidates = await ExamSession.find({
    status: 'open',
    isDeleted: { $ne: true },
    $expr: {
      $lt: [{ $add: ['$scheduledStart', { $multiply: ['$durationMin', 60_000] }] }, now],
    },
  });
  let closed = 0;
  for (const s of candidates) {
    if (!(await canAutoClose(s, now))) continue;
    const r = await ExamSession.updateOne(
      { _id: s._id, status: 'open' },
      { $set: { status: 'closed', codeActive: false, closedAt: now } },
    );
    if (!r.modifiedCount) continue;
    closed++;
    await persistResultsMeta(s.id);
    await auditService.log({
      userId: null,
      schoolId: String(s.schoolId),
      action: 'exam.session.auto_close',
      entity: 'exam_session',
      entityId: s.id,
      before: { status: 'open' },
      after: { status: 'closed' },
    });
    void notifyExamClosed(s.id as string);
  }
  return closed;
}

async function canAutoClose(s: ExamSessionDoc, now: Date): Promise<boolean> {
  if (await ExamAttempt.exists({ sessionId: s._id, status: 'in_progress' })) return false;
  const finished = new Set(
    (
      await ExamAttempt.find({ sessionId: s._id, status: { $in: ['submitted', 'auto_submitted'] } })
        .select('participantKey')
        .lean()
    ).map((a) => a.participantKey),
  );
  const end = commonEnd(s).getTime();
  for (const p of s.participants) {
    if (!p.fullTimeGranted && !p.extraMinutes) continue;
    if (finished.has(p.key)) continue;
    // Hali topshirmagan, to'liq vaqt/qo'shimcha berilgan ishtirokchi: uning oynasi tugamaguncha kutamiz
    const window =
      end + (p.fullTimeGranted ? s.durationMin * 60_000 : 0) + (p.extraMinutes ?? 0) * 60_000;
    if (now.getTime() < window) return false;
  }
  return true;
}
