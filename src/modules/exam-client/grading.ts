import type {
  IAttemptBlockScore,
  IAttemptOrderItem,
  IAttemptScore,
  IManualGrade,
  ISavedAnswer,
} from '../../models/ExamAttempt';
import { isShortAnswerCorrect } from '../exams/questions.normalize';
import type { PoolQuestion } from './selection';

/**
 * Avtomatik tekshirish (E6 da qayta ishlatiladi; idempotent, faqat javoblar va kalit manba).
 *  - single: to'g'ri variant tanlangan bo'lsa to'liq ball;
 *  - multi: to'plam aynan mos bo'lsa to'liq; `partialCredit` bo'lsa (to'g'ri tanlangan - noto'g'ri tanlangan) / jami to'g'ri,
 *    0 dan past emas;
 *  - short: normallashgan qiymat qabul qilinadiganlardan biriga mos bo'lsa;
 *  - essay: qo'lda tekshiriladi (ok = null, ball 0, essayPending ga sanaladi).
 */
export function gradeQuestion(
  q: PoolQuestion,
  value: unknown,
): { got: number; max: number; ok: boolean | null } {
  const max = q.points;
  const key = q.answer ?? {};
  if (q.type === 'single') {
    const ok = typeof value === 'string' && value !== '' && value === key.optionId;
    return { got: ok ? max : 0, max, ok };
  }
  if (q.type === 'multi') {
    const correct = new Set(((key.optionIds as string[] | undefined) ?? []).map(String));
    const given = new Set(Array.isArray(value) ? value.map(String) : []);
    const right = [...given].filter((x) => correct.has(x)).length;
    const wrong = given.size - right;
    const exact = right === correct.size && wrong === 0 && correct.size > 0;
    if (exact) return { got: max, max, ok: true };
    if (key.partialCredit && correct.size > 0) {
      const frac = Math.max(0, (right - wrong) / correct.size);
      return { got: Math.round(max * frac * 1000) / 1000, max, ok: false };
    }
    return { got: 0, max, ok: false };
  }
  if (q.type === 'short') {
    const accepted = ((key.acceptedAnswers as string[] | undefined) ?? []).map(String);
    const ok = typeof value === 'string' && isShortAnswerCorrect(accepted, value);
    return { got: ok ? max : 0, max, ok };
  }
  return { got: 0, max, ok: null };
}

/** Blokli hisob: ball rejimi va bloklar (id, koeffitsiyent). Berilmasa eski (blokisiz) natija shakli */
export interface ScoringOpts {
  mode: 'points' | 'coefficient';
  blocks: { blockId: string; coefficient: number }[];
}

/**
 * Ball formulalari:
 *  - 'points': blok bali = blokdagi savollar olgan ballar yig'indisi; maks = savol ballari yig'indisi.
 *  - 'coefficient': har savol 1 birlik, "ulushi" = olgan/maks (to'liq to'g'ri = 1, multi qisman ball = ulush,
 *    esse = qo'lda qo'yilgan ball / esse maksimumi). Blok bali = (ulushlar yig'indisi) x koeffitsiyent;
 *    blok maksimumi = (savollar soni) x koeffitsiyent.
 *  - umumiy ball/maks = bloklar yig'indisi. Foiz = ball / maks (ikkala rejimda ham ma'noli).
 */
export function gradeAttempt(
  order: readonly IAttemptOrderItem[],
  saved: readonly ISavedAnswer[],
  pool: Map<string, PoolQuestion>,
  manual: readonly IManualGrade[] = [],
  opts?: ScoringOpts,
): IAttemptScore {
  const manualBy = new Map(manual.map((m) => [m.qid, m]));
  const byQid = new Map(saved.map((s) => [s.qid, s]));
  let earned = 0;
  let max = 0;
  let autoMax = 0;
  let essayPending = 0;
  const items: IAttemptScore['items'] = [];
  for (const o of order) {
    const q = pool.get(o.qid);
    if (!q) continue;
    const r = gradeQuestion(q, byQid.get(o.qid)?.value);
    max += r.max;
    if (r.ok === null) {
      // Esse: o'qituvchi ball qo'ygan bo'lsa hisobga olinadi, aks holda kutilmoqda
      const m = manualBy.get(o.qid);
      if (m) {
        const got = Math.min(Math.max(m.points, 0), r.max);
        earned += got;
        items.push({ qid: o.qid, got, max: r.max, ok: got >= r.max, graded: true });
      } else {
        essayPending++;
        items.push({ qid: o.qid, got: 0, max: r.max, ok: null, graded: false });
      }
      continue;
    }
    autoMax += r.max;
    earned += r.got;
    items.push({ qid: o.qid, got: r.got, max: r.max, ok: r.ok });
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const base = {
    earned: round(earned),
    max: round(max),
    autoMax: round(autoMax),
    essayPending,
    items,
  };
  if (!opts || !opts.blocks.length) return base;

  const firstId = opts.blocks[0]!.blockId;
  const coef = new Map(opts.blocks.map((b) => [b.blockId, b.coefficient]));
  const blockOf = new Map<string, string>();
  for (const o of order) {
    const id = o.blockId && coef.has(o.blockId) ? o.blockId : firstId;
    blockOf.set(o.qid, id);
  }
  const acc = new Map<string, IAttemptBlockScore & { frac: number; autoQ: number }>();
  for (const b of opts.blocks) {
    acc.set(b.blockId, {
      blockId: b.blockId,
      earned: 0,
      max: 0,
      autoMax: 0,
      essayPending: 0,
      questions: 0,
      correct: 0,
      frac: 0,
      autoQ: 0,
    });
  }
  for (const it of items) {
    const a = acc.get(blockOf.get(it.qid) ?? firstId)!;
    a.questions++;
    a.max += it.max;
    a.frac += it.max > 0 ? it.got / it.max : 0;
    a.earned += it.got;
    if (it.ok === null) a.essayPending++;
    else a.autoMax += it.max;
    if (it.ok === true) a.correct++;
    if (it.ok !== null) a.autoQ++;
  }
  const blocks: IAttemptBlockScore[] = opts.blocks.map((b) => {
    const a = acc.get(b.blockId)!;
    const k = b.coefficient;
    if (opts.mode === 'coefficient') {
      return {
        blockId: a.blockId,
        earned: round(a.frac * k),
        max: round(a.questions * k),
        autoMax: round(a.autoQ * k),
        essayPending: a.essayPending,
        questions: a.questions,
        correct: a.correct,
      };
    }
    return {
      blockId: a.blockId,
      earned: round(a.earned),
      max: round(a.max),
      autoMax: round(a.autoMax),
      essayPending: a.essayPending,
      questions: a.questions,
      correct: a.correct,
    };
  });
  return {
    earned: round(blocks.reduce((n, b) => n + b.earned, 0)),
    max: round(blocks.reduce((n, b) => n + b.max, 0)),
    autoMax: round(blocks.reduce((n, b) => n + b.autoMax, 0)),
    essayPending,
    items,
    blocks,
  };
}
