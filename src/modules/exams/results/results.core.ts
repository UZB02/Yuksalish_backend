import { ExamAttempt, type ExamAttemptDoc } from '../../../models/ExamAttempt';
import type { ExamSessionDoc } from '../../../models/ExamSession';
import { ensureScored } from '../../exam-client/exam-client.service';
import type { PoolQuestion } from '../../exam-client/selection';
import { normalizeBlocks } from '../blocks/blocks.core';

/**
 * Natijalar hisobi (ruxsatsiz, sof ma'lumot): ham admin API, ham Telegram xulosasi ishlatadi.
 * Ball har doim javoblar + kalit + qo'lda baholardan qayta hisoblanishi mumkin (idempotent).
 */
export type RowStatus = 'not_started' | 'joined' | 'in_progress' | 'submitted' | 'auto_submitted';

export interface ResultRow {
  key: string;
  kind: 'student' | 'guest' | 'candidate';
  fullName: string;
  className: string | null;
  status: RowStatus;
  earned: number | null;
  max: number | null;
  percent: number | null;
  passed: boolean | null;
  answered: number;
  total: number;
  timeSpentSec: number | null;
  warnings: number;
  essayPending: number;
  rank: number | null;
  /** Blok bo'yicha ballar (yagona/eski imtihonda bitta element). Topshirmagan: bo'sh */
  blocks: { blockId: string; earned: number; max: number }[];
}

export interface ResultSummary {
  participants: number;
  started: number;
  submitted: number;
  averagePercent: number | null;
  maxPercent: number | null;
  minPercent: number | null;
  passPercent: number | null;
  passRate: number | null;
  passedCount: number;
  essayPending: number;
}

/** Natijalar jadvali uchun bloklar (eski imtihon: bitta blok, legacy) */
export const blockHeadersOf = (s: ExamSessionDoc) =>
  normalizeBlocks(s).map((b) => ({
    id: b.blockId,
    legacy: b.legacy,
    subjectId: b.subjectId,
    title: b.title,
    coefficient: b.coefficient,
    durationMin: b.durationMin,
  }));

export const poolMapOf = (s: ExamSessionDoc): Map<string, PoolQuestion> =>
  new Map((s.questionPool as unknown as PoolQuestion[]).map((q) => [String(q.questionId), q]));

const round1 = (n: number) => Math.round(n * 10) / 10;
const isFinished = (a: ExamAttemptDoc) => a.status === 'submitted' || a.status === 'auto_submitted';

/** Barcha urinishlarni yuklaydi; topshirilganlarning bahosi bo'lmasa hisoblab saqlaydi (lazy) */
export async function loadAttempts(session: ExamSessionDoc): Promise<ExamAttemptDoc[]> {
  const attempts = await ExamAttempt.find({ sessionId: session._id, schoolId: session.schoolId });
  for (const a of attempts) {
    if (isFinished(a) && !a.score) {
      const { score } = await ensureScored(a, session);
      a.score = score;
    }
  }
  return attempts;
}

export function buildRows(session: ExamSessionDoc, attempts: ExamAttemptDoc[]) {
  const byKey = new Map(attempts.map((a) => [a.participantKey, a]));
  const pass = session.passPercent ?? null;
  const firstBlock = normalizeBlocks(session)[0]!.blockId;
  const rows: ResultRow[] = session.participants.map((p) => {
    const a = byKey.get(p.key);
    const c = (a?.counters ?? {}) as Record<string, number>;
    const finished = !!a && isFinished(a) && !!a.score;
    const percent =
      finished && a!.score!.max > 0
        ? round1((a!.score!.earned / a!.score!.max) * 100)
        : finished
          ? 0
          : null;
    const end = a?.submittedAt ?? a?.lastSeenAt ?? null;
    return {
      key: p.key,
      kind: p.kind,
      fullName: p.fullName,
      className: p.className ?? p.origin ?? null,
      status: (a?.status ?? 'not_started') as RowStatus,
      earned: finished ? a!.score!.earned : null,
      max: finished ? a!.score!.max : null,
      percent,
      passed: finished && pass !== null && percent !== null ? percent >= pass : null,
      answered: a?.answeredCount ?? 0,
      total: a?.order?.length ?? 0,
      timeSpentSec:
        a?.startedAt && end
          ? Math.max(0, Math.round((end.getTime() - a.startedAt.getTime()) / 1000))
          : null,
      warnings: (c.blur ?? 0) + (c.fullscreenExit ?? 0) + (c.visibilityHidden ?? 0),
      essayPending: finished ? a!.score!.essayPending : 0,
      rank: null,
      blocks: finished
        ? (a!.score!.blocks?.length
            ? a!.score!.blocks
            : [{ blockId: firstBlock, earned: a!.score!.earned, max: a!.score!.max }]
          ).map((b) => ({ blockId: b.blockId, earned: b.earned, max: b.max }))
        : [],
    };
  });
  // O'rin: foiz kamayish bo'yicha, teng ballar bir xil o'rin (1,1,3)
  const scored = rows.filter((r) => r.percent !== null).sort((a, b) => b.percent! - a.percent!);
  scored.forEach((r, i) => {
    r.rank = i > 0 && r.percent === scored[i - 1]!.percent ? scored[i - 1]!.rank : i + 1;
  });
  const pcts = scored.map((r) => r.percent!);
  const summary: ResultSummary = {
    participants: rows.length,
    started: rows.filter(
      (r) =>
        r.status === 'in_progress' || r.status === 'submitted' || r.status === 'auto_submitted',
    ).length,
    submitted: pcts.length,
    averagePercent: pcts.length ? round1(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null,
    maxPercent: pcts.length ? Math.max(...pcts) : null,
    minPercent: pcts.length ? Math.min(...pcts) : null,
    passPercent: pass,
    passedCount: rows.filter((r) => r.passed === true).length,
    passRate:
      pass !== null && pcts.length
        ? round1((rows.filter((r) => r.passed === true).length / pcts.length) * 100)
        : null,
    essayPending: rows.reduce((s, r) => s + r.essayPending, 0),
  };
  return { rows, summary };
}

/** Tartib: o'rin bo'yicha, keyin baholanmaganlar (ism bo'yicha) */
export const sortRanked = (rows: ResultRow[]): ResultRow[] =>
  [...rows].sort((a, b) => {
    if (a.rank !== null && b.rank !== null)
      return a.rank - b.rank || a.fullName.localeCompare(b.fullName);
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.fullName.localeCompare(b.fullName);
  });
