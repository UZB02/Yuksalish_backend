import crypto from 'crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { ExamAttempt, MAX_EVENTS, MAX_WARNINGS } from '../../../models/ExamAttempt';
import { ExamSession, type ExamSessionDoc } from '../../../models/ExamSession';
import { clock } from '../../../utils/clock';
import { ensureScored } from '../../exam-client/exam-client.service';
import { normalizeBlocks, timingModeOf } from '../blocks/blocks.core';
import { resolveExamScope, type ExamScope } from '../exams.scope';
import { audit, findSession, isCreator, isSupervisor } from './sessions.service';
import { isId } from '../../../utils/helpers';

/**
 * Nazoratchi jonli ekrani (E5): yengil so'rov (savol matni, javoblar va kalit YO'Q), ogohlantirish yuborish va
 * imtihonni to'xtatish. Ruxsat: ma'muriyat (doira "hammasi"), imtihon yaratuvchisi va nazoratchilari; boshqa o'qituvchi
 * (masalan, faqat blok muallifi) uchun imtihon topilmaydi (findSession).
 */

/** Bir urinishga ogohlantirish yuborish oralig'i (tezlik cheklovi) */
export const WARN_MIN_GAP_MS = 10_000;
/** Shundan uzoq jim bo'lsa "aloqa yo'q" (mijoz heartbeat 10 s) */
export const STALE_AFTER_MS = 60_000;

// eslint-disable-next-line no-control-regex
const NOCTRL = /^[^\u0000-\u001F\u007F]*$/;
const plain = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} kiritilishi kerak`)
    .max(max, `${label} ${max} belgidan oshmasligi kerak`)
    .regex(NOCTRL, `${label}da boshqaruv belgilari bo'lmasligi kerak`);

export const warnBody = z.object({ text: plain('Ogohlantirish matni', 200) }).strict();
export const terminateBody = z.object({ reason: plain('Sabab', 300) }).strict();

type Actor = Ctx['actor'];

function assertWatcher(s: ExamSessionDoc, scope: ExamScope, actor: Actor) {
  if (!scope.all && !isSupervisor(s, actor) && !isCreator(s, actor)) throw AppError.forbidden();
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Jonli ekran uchun sessiyaning yengil ko'rinishi (lean; ishtirokchilardan faqat ko'rsatiladigan maydonlar) */
interface LiveSession {
  _id: unknown;
  title: string;
  status: string;
  timingMode?: string | null;
  scheduledStart: Date;
  durationMin: number;
  createdBy: unknown;
  supervisorIds: unknown[];
  blocks?: unknown[];
  sections?: unknown[];
  subjectId?: unknown;
  joinFailures?: { count: number; lastAt: Date | null; alertAt: Date | null } | null;
  updatedAt?: Date;
  participants: {
    key: string;
    kind: string;
    fullName: string;
    className?: string | null;
    origin?: string | null;
    fullTimeGranted?: boolean;
    extraMinutes?: number;
    allowReentry?: boolean;
  }[];
}

/**
 * findSession bilan bir xil ruxsat qoidasi, lekin Mongoose hujjatisiz: bitta aggregate, ishtirokchilar serverda
 * kichraytiriladi (PIN xeshlari/shifrlangan kodlar sessiya hujjatidan chiqmaydi).
 */
async function loadLiveSession(ctx: Ctx, schoolId: string, scope: ExamScope, id: string) {
  const [s] = isId(id)
    ? await ExamSession.aggregate<LiveSession>([
        {
          $match: {
            _id: new Types.ObjectId(id),
            schoolId: new Types.ObjectId(schoolId),
            isDeleted: { $ne: true },
          },
        },
        {
          $project: {
            title: 1,
            status: 1,
            timingMode: 1,
            scheduledStart: 1,
            durationMin: 1,
            createdBy: 1,
            supervisorIds: 1,
            blocks: 1,
            sections: 1,
            subjectId: 1,
            joinFailures: 1,
            updatedAt: 1,
            participants: {
              $map: {
                input: '$participants',
                as: 'p',
                in: {
                  key: '$$p.key',
                  kind: '$$p.kind',
                  fullName: '$$p.fullName',
                  className: '$$p.className',
                  origin: '$$p.origin',
                  fullTimeGranted: '$$p.fullTimeGranted',
                  extraMinutes: '$$p.extraMinutes',
                  allowReentry: '$$p.allowReentry',
                },
              },
            },
          },
        },
      ])
    : [];
  if (!s) throw AppError.notFound('Imtihon topilmadi');
  const doc = s as unknown as ExamSessionDoc;
  if (!scope.all && !isCreator(doc, ctx.actor) && !isSupervisor(doc, ctx.actor)) {
    throw AppError.notFound('Imtihon topilmadi');
  }
  return s;
}

export const liveService = {
  /**
   * Jonli holat: ikkita yengil aggregate (sessiya va urinishlar; `order`/`saved` serverda sanalib tashlanadi).
   * Javob kichraytirilgan (E7): qatorlarda standart qiymatlar (0/null/false) yozilmaydi; ishtirokchilar ro'yxati
   * (`roster`: ism, sinf, tur, individual vaqt) faqat mijozdagi `rosterKey` eskirgan bo'lsa yuboriladi.
   */
  async live(ctx: Ctx, schoolId: string, id: string, knownRoster = '') {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await loadLiveSession(ctx, schoolId, scope, id);
    if (!['scheduled', 'open', 'closed'].includes(s.status)) {
      throw AppError.conflict('Imtihon hali ochilmagan');
    }
    const now = clock.now();
    const rows = await ExamAttempt.aggregate<{
      participantKey: string;
      status: string;
      answeredCount?: number;
      total: number;
      startedAt: Date | null;
      submittedAt: Date | null;
      deadline: Date | null;
      lastSeenAt: Date | null;
      lastLeaveAt?: Date | null;
      counters?: Record<string, number>;
      blockId?: string | null;
      blockDeadline?: Date | null;
      blocksTotal: number;
      warningsSent: number;
      warningsPending: number;
      lastWarnAt?: Date | null;
      terminated?: { at: Date; byName: string; reason: string } | null;
    }>([
      { $match: { sessionId: s._id as Types.ObjectId, schoolId: new Types.ObjectId(schoolId) } },
      {
        $addFields: {
          _cur: {
            $arrayElemAt: [{ $ifNull: ['$blockState', []] }, { $ifNull: ['$blockIndex', 0] }],
          },
          _w: { $ifNull: ['$warnings', []] },
        },
      },
      {
        $project: {
          _id: 0,
          participantKey: 1,
          status: 1,
          answeredCount: 1,
          startedAt: 1,
          submittedAt: 1,
          deadline: 1,
          lastSeenAt: 1,
          lastLeaveAt: 1,
          counters: 1,
          lastWarnAt: 1,
          terminated: 1,
          total: { $size: { $ifNull: ['$order', []] } },
          blockId: '$_cur.blockId',
          blockDeadline: '$_cur.deadline',
          blocksTotal: { $size: { $ifNull: ['$blockState', []] } },
          warningsSent: { $size: '$_w' },
          warningsPending: {
            $size: { $filter: { input: '$_w', as: 'w', cond: { $lte: ['$$w.ackAt', null] } } },
          },
        },
      },
    ]);
    const byKey = new Map(rows.map((r) => [r.participantKey, r]));
    const sdoc = s as unknown as ExamSessionDoc;
    const blocks = normalizeBlocks(sdoc);
    const perBlock = timingModeOf(sdoc) === 'per_block' && !blocks[0]?.legacy;
    const titleOf = new Map(blocks.map((b) => [b.blockId, b.title]));

    // To'liq (ichki) qatorlar: hisoblagichlar uchun; javobga siqilgan ko'rinishda chiqadi
    const items = s.participants.map((p) => {
      const a = byKey.get(p.key);
      const c = a?.counters ?? {};
      const blur = num(c.blur);
      const fullscreen = num(c.fullscreenExit);
      const hidden = num(c.visibilityHidden);
      return {
        key: p.key,
        status: a?.status ?? 'not_started',
        answered: a?.answeredCount ?? 0,
        total: a?.total ?? 0,
        block:
          perBlock && a && a.status === 'in_progress' && a.blockId
            ? {
                id: a.blockId,
                title: titleOf.get(a.blockId) ?? '',
                index: blocks.findIndex((b) => b.blockId === a.blockId),
                total: a.blocksTotal,
                deadline: a.blockDeadline ?? null,
              }
            : null,
        startedAt: a?.startedAt ?? null,
        submittedAt: a?.submittedAt ?? null,
        deadline: a?.deadline ?? null,
        lastSeenAt: a?.lastSeenAt ?? null,
        leaves: blur + fullscreen + hidden,
        leaveDetail: { blur, fullscreen, hidden },
        lastLeaveAt: a?.lastLeaveAt ?? null,
        reconnects: num(c.reconnect),
        warningsSent: a?.warningsSent ?? 0,
        warningsPending: a?.warningsPending ?? 0,
        lastWarnAt: a?.lastWarnAt ?? null,
        terminated: a?.terminated
          ? { at: a.terminated.at, byName: a.terminated.byName, reason: a.terminated.reason }
          : null,
      };
    });
    const counts = {
      total: items.length,
      notStarted: items.filter((i) => i.status === 'not_started').length,
      joined: items.filter((i) => i.status === 'joined').length,
      inProgress: items.filter((i) => i.status === 'in_progress').length,
      submitted: items.filter(
        (i) => ['submitted', 'auto_submitted'].includes(i.status) && !i.terminated,
      ).length,
      terminated: items.filter((i) => !!i.terminated).length,
      warned: items.filter((i) => i.warningsSent > 0).length,
      withLeaves: items.filter((i) => i.leaves > 0).length,
    };
    const jf = s.joinFailures ?? { count: 0, lastAt: null, alertAt: null };
    const rosterKey = `${s.participants.length}:${s.updatedAt ? s.updatedAt.getTime() : 0}`;
    const roster =
      knownRoster === rosterKey
        ? undefined
        : s.participants.map((p) => ({
            key: p.key,
            kind: p.kind,
            fullName: p.fullName,
            className: p.className ?? p.origin ?? null,
            ...(p.fullTimeGranted ? { fullTimeGranted: true } : {}),
            ...(p.extraMinutes ? { extraMinutes: p.extraMinutes } : {}),
            ...(p.allowReentry === true ? { allowReentry: true } : {}),
          }));
    return {
      serverNow: now,
      session: {
        id: String(s._id),
        title: s.title,
        status: s.status,
        timingMode: timingModeOf(sdoc),
        scheduledStart: s.scheduledStart,
        endsAt: new Date(s.scheduledStart.getTime() + s.durationMin * 60_000),
      },
      /** Faqat ochiq imtihonda ogohlantirish va to'xtatish mumkin */
      canIntervene: s.status === 'open',
      staleAfterSec: STALE_AFTER_MS / 1000,
      counts,
      rosterKey,
      ...(roster ? { roster } : {}),
      /** Standart qiymatli maydonlar (0, null, false) tushirib qoldirilgan: mijoz to'ldiradi */
      rows: items.map((i) => ({
        key: i.key,
        status: i.status,
        ...(i.answered ? { answered: i.answered } : {}),
        ...(i.total ? { total: i.total } : {}),
        ...(i.block ? { block: i.block } : {}),
        ...(i.startedAt ? { startedAt: i.startedAt } : {}),
        ...(i.submittedAt ? { submittedAt: i.submittedAt } : {}),
        ...(i.deadline ? { deadline: i.deadline } : {}),
        ...(i.lastSeenAt ? { lastSeenAt: i.lastSeenAt } : {}),
        ...(i.leaves ? { leaves: i.leaves, leaveDetail: i.leaveDetail } : {}),
        ...(i.lastLeaveAt ? { lastLeaveAt: i.lastLeaveAt } : {}),
        ...(i.reconnects ? { reconnects: i.reconnects } : {}),
        ...(i.warningsSent ? { warningsSent: i.warningsSent } : {}),
        ...(i.warningsPending ? { warningsPending: i.warningsPending } : {}),
        ...(i.lastWarnAt ? { lastWarnAt: i.lastWarnAt } : {}),
        ...(i.terminated ? { terminated: i.terminated } : {}),
      })),
      joinAlert: {
        failures: jf.count ?? 0,
        lastAt: jf.lastAt ?? null,
        alertAt: jf.alertAt ?? null,
      },
    };
  },

  /**
   * Ogohlantirish yuborish: matn o'quvchining keyingi heartbeat/state javobida keladi, u tasdiqlaydi. Bitta urinishga
   * 10 soniyada bittadan oshmaydi (atomik shart: `lastWarnAt`). Hodisa urinishga va audit'ga yoziladi.
   */
  async warn(ctx: Ctx, schoolId: string, id: string, key: string, body: z.output<typeof warnBody>) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertWatcher(s, scope, ctx.actor);
    if (s.status !== 'open')
      throw AppError.conflict('Faqat ochiq imtihonda ogohlantirish yuboriladi');
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    const now = clock.now();
    const w = {
      id: crypto.randomBytes(8).toString('hex'),
      text: body.text,
      at: now,
      by: ctx.actor.id,
      byName: ctx.actor.fullName,
      ackAt: null,
    };
    const upd = await ExamAttempt.findOneAndUpdate(
      {
        sessionId: s._id,
        schoolId: s.schoolId,
        participantKey: key,
        status: 'in_progress',
        $or: [
          { lastWarnAt: null },
          { lastWarnAt: { $lt: new Date(now.getTime() - WARN_MIN_GAP_MS) } },
        ],
      },
      {
        $push: {
          warnings: { $each: [w], $slice: -MAX_WARNINGS },
          events: {
            $each: [{ type: 'warning_sent', at: null, serverAt: now }],
            $slice: -MAX_EVENTS,
          },
        },
        $set: { lastWarnAt: now },
      },
      { returnDocument: 'after', projection: { _id: 1 } },
    );
    if (!upd) {
      const a = await ExamAttempt.findOne({
        sessionId: s._id,
        schoolId: s.schoolId,
        participantKey: key,
      }).select('status');
      if (!a || a.status !== 'in_progress') {
        throw AppError.conflict('O‘quvchi hozir imtihon yechmayapti');
      }
      throw AppError.rateLimited(
        `Ogohlantirish juda tez-tez yuborilmoqda: ${WARN_MIN_GAP_MS / 1000} soniya kuting`,
      );
    }
    await audit(ctx, schoolId, 'exam.session.warn', s.id, null, {
      participantKey: key,
      kind: p.kind,
      text: body.text,
    });
    return { warningId: w.id, sentAt: now };
  },

  /**
   * Imtihonni to'xtatish: urinish darhol `submitted` bo'ladi (atomik shart status=in_progress: o'quvchi topshirishi
   * yoki avtomatik topshirish bilan poygada bittasi yutadi), shu paytgacha berilgan javoblar baholanadi (ensureScored)
   * va natija sifatida qoladi; `terminated` belgisi sabab bilan qo'shiladi. Qayta kirib davom ettirib BO'LMAYDI.
   */
  async terminate(
    ctx: Ctx,
    schoolId: string,
    id: string,
    key: string,
    body: z.output<typeof terminateBody>,
  ) {
    const scope = await resolveExamScope(ctx.actor, schoolId);
    const s = await findSession(ctx, schoolId, scope, id);
    assertWatcher(s, scope, ctx.actor);
    if (s.status !== 'open') throw AppError.conflict('Faqat ochiq imtihonni to‘xtatish mumkin');
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    const now = clock.now();
    const terminated = {
      at: now,
      by: ctx.actor.id,
      byName: ctx.actor.fullName,
      reason: body.reason,
    };
    const upd = await ExamAttempt.findOneAndUpdate(
      { sessionId: s._id, schoolId: s.schoolId, participantKey: key, status: 'in_progress' },
      {
        $set: { status: 'submitted', submittedAt: now, terminated },
        $push: {
          events: { $each: [{ type: 'terminated', at: null, serverAt: now }], $slice: -MAX_EVENTS },
        },
      },
      { returnDocument: 'after' },
    );
    if (!upd) {
      const a = await ExamAttempt.findOne({
        sessionId: s._id,
        schoolId: s.schoolId,
        participantKey: key,
      }).select('status');
      if (!a) throw AppError.conflict('O‘quvchi hali imtihonga kirmagan');
      if (a.status === 'joined') throw AppError.conflict('O‘quvchi hali imtihonni boshlamagan');
      throw AppError.conflict('O‘quvchi imtihonni allaqachon topshirgan');
    }
    const { score } = await ensureScored(upd);
    await audit(ctx, schoolId, 'exam.session.terminate', s.id, null, {
      participantKey: key,
      kind: p.kind,
      reason: body.reason,
      earned: score.earned,
      max: score.max,
    });
    return { terminated: true, score: { earned: score.earned, max: score.max } };
  },
};
