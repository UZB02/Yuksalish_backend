import { ClassModel } from '../../../models/Class';
import { ExamAttempt } from '../../../models/ExamAttempt';
import { ExamSession, type ExamSessionDoc } from '../../../models/ExamSession';
import { Subject } from '../../../models/Subject';
import { normalizeBlocks, scoringModeOf, timingModeOf } from '../blocks/blocks.core';
import { commonEnd } from '../sessions/timing';

/**
 * Natijalar ko'chirmasi (snapshot): imtihon yopilganda sessiya hujjati ichiga (`resultsMeta`) yoziladi, shuning
 * uchun imtihon yoki savol keyin o'zgarsa/o'chirilsa ham natijalar ro'yxati buzilmaydi.
 *
 * Tanlov: yangi kolleksiya EMAS, sessiya ichidagi sub-hujjat. Sabab: schoolPurge ro'yxatiga tegmaydi, yangi
 * indeks/unique yo'q, sessiya bilan birga (with_results) bitta amalda o'chadi, ikkita hujjat orasida nomuvofiqlik
 * bo'lmaydi. Ishtirokchilar ballari urinishlarda (ExamAttempt.score) turadi va o'chirilgan imtihonda ham saqlanadi.
 * Eski yopilgan sessiyalarda `resultsMeta` yo'q: `metaOf` uni jonli ma'lumotdan hisoblaydi (migratsiya yo'q).
 */
export interface ResultsMeta {
  title: string;
  heldAt: Date;
  endsAt: Date;
  closedAt: Date | null;
  subjects: { id: string; name: string }[];
  classes: { id: string; name: string }[];
  blocks: {
    id: string;
    title: string;
    subjectId: string | null;
    subjectName: string | null;
    coefficient: number;
    maxScore: number | null;
  }[];
  scoringMode: string;
  timingMode: string;
  resultsMode: string;
  passPercent: number | null;
  participantsCount: number;
  maxScore: number | null;
  snapshotAt: Date;
}

interface Names {
  subject: Map<string, string>;
  cls: Map<string, string>;
}

export async function namesFor(sessions: ExamSessionDoc[]): Promise<Names> {
  const subjectIds = new Set<string>();
  const classIds = new Set<string>();
  for (const s of sessions) {
    if (s.subjectId) subjectIds.add(String(s.subjectId));
    for (const b of normalizeBlocks(s)) if (b.subjectId) subjectIds.add(b.subjectId);
    for (const c of s.classIds) classIds.add(String(c));
  }
  const [subs, classes] = await Promise.all([
    Subject.find({ _id: { $in: [...subjectIds] } })
      .select('name')
      .lean(),
    ClassModel.find({ _id: { $in: [...classIds] } })
      .select('name')
      .lean(),
  ]);
  return {
    subject: new Map(subs.map((x) => [String(x._id), x.name])),
    cls: new Map(classes.map((x) => [String(x._id), x.name])),
  };
}

type MaxRow = { score?: { max?: number; blocks?: { blockId: string; max: number }[] } | null };

export function buildMeta(s: ExamSessionDoc, names: Names, attempts: MaxRow[]): ResultsMeta {
  const blocks = normalizeBlocks(s);
  const blockMax = new Map<string, number>();
  let total = 0;
  for (const a of attempts) {
    if (!a.score) continue;
    total = Math.max(total, a.score.max ?? 0);
    for (const b of a.score.blocks ?? []) {
      blockMax.set(b.blockId, Math.max(blockMax.get(b.blockId) ?? 0, b.max));
    }
  }
  if (blocks.length === 1 && blocks[0]!.legacy && total) blockMax.set(blocks[0]!.blockId, total);
  const subjectIds = new Set<string>();
  if (s.subjectId) subjectIds.add(String(s.subjectId));
  for (const b of blocks) if (b.subjectId) subjectIds.add(b.subjectId);
  return {
    title: s.title,
    heldAt: s.scheduledStart,
    endsAt: commonEnd(s),
    closedAt: s.closedAt ?? null,
    subjects: [...subjectIds].map((id) => ({ id, name: names.subject.get(id) ?? '' })),
    classes: s.classIds.map((c) => ({ id: String(c), name: names.cls.get(String(c)) ?? '' })),
    blocks: blocks.map((b) => ({
      id: b.blockId,
      title: b.title || (b.subjectId ? (names.subject.get(b.subjectId) ?? '') : ''),
      subjectId: b.subjectId,
      subjectName: b.subjectId ? (names.subject.get(b.subjectId) ?? null) : null,
      coefficient: b.coefficient,
      maxScore: blockMax.get(b.blockId) ?? null,
    })),
    scoringMode: scoringModeOf(s),
    timingMode: timingModeOf(s),
    resultsMode: s.resultsMode,
    passPercent: s.passPercent ?? null,
    participantsCount: s.participants.length,
    maxScore: total || null,
    snapshotAt: new Date(),
  };
}

/** Yopilganda (qo'lda, avtomatik) yoki o'chirishdan oldin ko'chirmani yozadi. Idempotent, xatoda tashlamaydi */
export async function persistResultsMeta(sessionId: unknown): Promise<void> {
  try {
    const s = await ExamSession.findById(sessionId);
    if (!s) return;
    const names = await namesFor([s]);
    const attempts = await ExamAttempt.find({
      sessionId: s._id,
      status: { $in: ['submitted', 'auto_submitted'] },
    })
      .select('score.max score.blocks')
      .lean();
    const meta = buildMeta(s, names, attempts as MaxRow[]);
    await ExamSession.updateOne({ _id: s._id }, { $set: { resultsMeta: meta } });
  } catch {
    /* ko'chirma best-effort: ro'yxat jonli ma'lumotga tushadi */
  }
}
