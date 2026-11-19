import { ExamAttempt, type ExamAttemptDoc } from '../../../models/ExamAttempt';
import { ExamSession, type ExamSessionDoc } from '../../../models/ExamSession';
import { ensureScored } from '../../exam-client/exam-client.service';
import { buildMeta, namesFor, type ResultsMeta } from './results.meta';

/**
 * Ishtirokchining (o'quvchi yoki nomzod) yakunlangan imtihon natijalari: profil sahifalari uchun.
 *
 * BARQAROR DTO (kelajakdagi ota-onalar platformasi ham aynan shuni ishlatadi, shakli o'zgarmaydi, faqat qo'shiladi):
 *   { items: ProfileExamResult[], summary: { count, averagePercent, passedCount } }
 *   ProfileExamResult = {
 *     sessionId, title, heldAt, closedAt, subjects: string[], scoringMode: 'points'|'coefficient',
 *     passPercent: number|null, earned, max, percent, passed: boolean|null, essayPending: number,
 *     blocks: [{ id, title, subjectName, coefficient, earned, max, percent }],
 *     examDeleted: boolean   // imtihon o'chirilgan, lekin natijalar saqlangan (batafsil ko'rinish yo'q)
 *   }
 * Manba: ExamAttempt.score + sessiyadagi `resultsMeta` ko'chirmasi (imtihon keyin o'zgarsa yoki "faqat imtihon"
 * rejimida o'chirilsa ham natija turadi). "Natijalari bilan o'chirilgan" imtihon (sessiya hujjati yo'q) chiqmaydi.
 * Faqat YAKUNLANGAN (closed) imtihonlar. Bu xodim ko'rinishi: natija rejimi (resultsMode) bu yerda cheklov emas.
 */
export interface ProfileExamResult {
  sessionId: string;
  title: string;
  heldAt: Date;
  closedAt: Date | null;
  subjects: string[];
  scoringMode: string;
  passPercent: number | null;
  earned: number;
  max: number;
  percent: number;
  passed: boolean | null;
  essayPending: number;
  blocks: {
    id: string;
    title: string;
    subjectName: string | null;
    coefficient: number;
    earned: number;
    max: number;
    percent: number;
  }[];
  examDeleted: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (earned: number, max: number) => (max > 0 ? round1((earned / max) * 100) : 0);
const FINISHED = ['submitted', 'auto_submitted'] as const;
const MAX_ITEMS = 100;

export async function profileExamResults(
  schoolId: string,
  kind: 'student' | 'candidate',
  refId: string,
): Promise<{
  items: ProfileExamResult[];
  summary: { count: number; averagePercent: number | null; passedCount: number };
}> {
  const sessions = await ExamSession.find({
    schoolId,
    status: 'closed',
    participants: { $elemMatch: { kind, refId } },
    $or: [{ isDeleted: { $ne: true } }, { isDeleted: true, resultsKept: true }],
  })
    .sort({ scheduledStart: -1 })
    .limit(MAX_ITEMS);
  if (!sessions.length)
    return { items: [], summary: { count: 0, averagePercent: null, passedCount: 0 } };

  const attempts = await ExamAttempt.find({
    schoolId,
    sessionId: { $in: sessions.map((s) => s._id) },
    participantKind: kind === 'student' ? 'student' : 'candidate',
    status: { $in: FINISHED },
  });
  const byKey = new Map<string, ExamAttemptDoc>(
    attempts.map((a) => [`${String(a.sessionId)}:${a.participantKey}`, a]),
  );
  const names = await namesFor(sessions.filter((s) => !s.resultsMeta));

  const items: ProfileExamResult[] = [];
  for (const s of sessions) {
    const p = s.participants.find((x) => x.kind === kind && String(x.refId) === refId);
    const a = p ? byKey.get(`${String(s._id)}:${p.key}`) : undefined;
    if (!p || !a) continue;
    const { score } = await ensureScored(a, s as ExamSessionDoc);
    const meta = (s.resultsMeta as ResultsMeta | null) ?? buildMeta(s, names, []);
    const metaBlocks = new Map(meta.blocks.map((b) => [b.id, b]));
    const scored = score.blocks?.length
      ? score.blocks
      : [{ blockId: meta.blocks[0]?.id ?? 'main', earned: score.earned, max: score.max }];
    const percent = pct(score.earned, score.max);
    items.push({
      sessionId: String(s._id),
      title: meta.title,
      heldAt: meta.heldAt,
      closedAt: meta.closedAt,
      subjects: meta.subjects.map((x) => x.name).filter(Boolean),
      scoringMode: meta.scoringMode,
      passPercent: meta.passPercent,
      earned: score.earned,
      max: score.max,
      percent,
      passed: meta.passPercent !== null ? percent >= meta.passPercent : null,
      essayPending: score.essayPending ?? 0,
      blocks: scored.map((b) => {
        const m = metaBlocks.get(b.blockId);
        return {
          id: b.blockId,
          title: m?.title ?? '',
          subjectName: m?.subjectName ?? null,
          coefficient: m?.coefficient ?? 1,
          earned: b.earned,
          max: b.max,
          percent: pct(b.earned, b.max),
        };
      }),
      examDeleted: !!s.isDeleted,
    });
  }
  const percents = items.map((i) => i.percent);
  return {
    items,
    summary: {
      count: items.length,
      averagePercent: percents.length
        ? round1(percents.reduce((x, y) => x + y, 0) / percents.length)
        : null,
      passedCount: items.filter((i) => i.passed === true).length,
    },
  };
}
