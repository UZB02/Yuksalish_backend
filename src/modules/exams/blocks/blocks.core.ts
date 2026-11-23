/**
 * Blokli imtihon: sof (DB siz) yordamchilar.
 *
 * ORQAGA MOSLIK: eski ExamSession/ExamTemplate hujjatlarida `blocks` yo'q. `normalizeBlocks` ularni
 * `sections` (barcha bo'limlar elementlari ketma-ket) + `subjectId` dan BITTA blok (`blockId = 'main'`) qilib
 * o'qiydi. Migratsiya yo'q: hujjatlar o'zgarmaydi, faqat kod shunday talqin qiladi.
 */
import type { ScoringMode, TimingMode } from '../../../models/ExamTemplate';

export const LEGACY_BLOCK_ID = 'main';
export const MAX_BLOCKS = 10;

export interface StoredItem {
  kind: 'manual' | 'rule';
  questionIds?: unknown[];
  count?: number;
  poolIds?: unknown[];
  topicId?: unknown;
  /**
   * Qoida: bir nechta mavzu (E8). Bo'lsa mavzular birlashmasi, yo'q bo'lsa [topicId] (eski hujjatlar).
   * `allTopics`: blok fanidagi BARCHA mavzular (keyin qo'shilganlari ham); topicIds bo'sh.
   */
  topicIds?: unknown[];
  allTopics?: boolean;
  difficulty?: number | null;
  type?: string | null;
}

/** Tasodifiy tanlash qoidasi (rejim 2), biriktirilgan o'qituvchi/tuzuvchi qo'shgan: egasi `addedBy` */
export interface NBlockRule {
  ruleId: string;
  topicIds: string[];
  allTopics: boolean;
  difficulty: number | null;
  type: string | null;
  count: number;
  addedBy: string;
  addedAt: Date | null;
  /** Rejalashtirilganda muzlatilgan savol id lari (bo'lmasa: hali muzlatilmagan) */
  poolIds?: unknown[];
}

export interface NBlockContrib {
  questionId: string;
  addedBy: string;
  addedAt: Date | null;
}

export interface NBlock {
  blockId: string;
  subjectId: string | null;
  title: string;
  targetCount: number;
  coefficient: number;
  durationMin: number | null;
  contributors: string[];
  items: StoredItem[];
  contribQuestions: NBlockContrib[];
  /** Tasodifiy tanlash qoidalari (E8): items dagi qoidalar kabi ishlaydi */
  contribRules: NBlockRule[];
  status: 'open' | 'ready';
  /** tayyor belgisini qo'ygan: 'contributor' | 'composer' (eski tayyor ma'lumot = composer) | null (tayyor emas) */
  readyBy: 'contributor' | 'composer' | null;
  /** oxirgi "Eslatma" yuborilgan vaqt (yo'q = hech qachon) */
  remindedAt: Date | null;
  /** true: eski (blokisiz) hujjatdan sun'iy yasalgan blok */
  legacy: boolean;
}

interface BlocksSource {
  blocks?: unknown[] | null;
  sections?: unknown[] | null;
  subjectId?: unknown;
}

const str = (v: unknown): string => String(v);

export function normalizeBlocks(doc: BlocksSource): NBlock[] {
  const raw = (doc.blocks ?? []) as Record<string, unknown>[];
  if (raw.length) {
    return raw.map((b) => ({
      blockId: str(b.blockId),
      subjectId: b.subjectId ? str(b.subjectId) : null,
      title: typeof b.title === 'string' ? b.title : '',
      targetCount: Number(b.targetCount ?? 0),
      coefficient: Number(b.coefficient ?? 1),
      durationMin:
        b.durationMin === null || b.durationMin === undefined ? null : Number(b.durationMin),
      contributors: ((b.contributors as unknown[]) ?? []).map(str),
      items: ((b.items as StoredItem[]) ?? []).map((i) => i),
      contribQuestions: ((b.contribQuestions as Record<string, unknown>[]) ?? []).map((c) => ({
        questionId: str(c.questionId),
        addedBy: str(c.addedBy),
        addedAt: (c.addedAt as Date | null) ?? null,
      })),
      contribRules: ((b.contribRules as Record<string, unknown>[]) ?? []).map((r) => ({
        ruleId: str(r.ruleId),
        topicIds: ((r.topicIds as unknown[]) ?? []).map(str),
        allTopics: r.allTopics === true,
        difficulty: typeof r.difficulty === 'number' ? r.difficulty : null,
        type: typeof r.type === 'string' ? r.type : null,
        count: Number(r.count ?? 0),
        addedBy: str(r.addedBy),
        addedAt: (r.addedAt as Date | null) ?? null,
        ...(r.poolIds ? { poolIds: r.poolIds as unknown[] } : {}),
      })),
      status: b.status === 'ready' ? 'ready' : 'open',
      readyBy:
        b.status === 'ready' ? (b.readyBy === 'contributor' ? 'contributor' : 'composer') : null,
      remindedAt: (b.remindedAt as Date | null | undefined) ?? null,
      legacy: false,
    }));
  }
  const sections = (doc.sections ?? []) as { items?: StoredItem[] }[];
  return [
    {
      blockId: LEGACY_BLOCK_ID,
      subjectId: doc.subjectId ? str(doc.subjectId) : null,
      title: '',
      targetCount: 0,
      coefficient: 1,
      durationMin: null,
      contributors: [],
      items: sections.flatMap((s) => s.items ?? []),
      contribQuestions: [],
      contribRules: [],
      status: 'ready',
      readyBy: 'composer',
      remindedAt: null,
      legacy: true,
    },
  ];
}

export const scoringModeOf = (d: { scoringMode?: string | null }): ScoringMode =>
  d.scoringMode === 'coefficient' ? 'coefficient' : 'points';
export const timingModeOf = (d: { timingMode?: string | null }): TimingMode =>
  d.timingMode === 'per_block' ? 'per_block' : 'common';

/** Blokning savol elementlari: tuzuvchi elementlari + biriktirilgan o'qituvchilar qo'shgan savollar */
export function effectiveItems(
  b: Pick<NBlock, 'items' | 'contribQuestions'> & { contribRules?: NBlockRule[] },
): StoredItem[] {
  const out: StoredItem[] = b.contribQuestions.length
    ? [...b.items, { kind: 'manual', questionIds: b.contribQuestions.map((c) => c.questionId) }]
    : [...b.items];
  // Tasodifiy tanlash qoidalari oxirida: rejalashtirishda poolIds shu tartib bo'yicha muzlatiladi (contribRuleOffset)
  for (const r of b.contribRules ?? []) out.push(ruleItemOf(r));
  return out;
}

/** Qoida (rejim 2) ni oddiy qoida elementi shaklida beradi (selection/inspect shu bilan ishlaydi) */
export const ruleItemOf = (r: NBlockRule): StoredItem => ({
  kind: 'rule',
  topicId: r.topicIds[0] ?? null,
  topicIds: r.topicIds,
  allTopics: r.allTopics,
  count: r.count,
  difficulty: r.difficulty,
  type: r.type,
  ...(r.poolIds ? { poolIds: r.poolIds } : {}),
});

/** effectiveItems ichida contribRules boshlanadigan indeks */
export const contribRuleOffset = (b: Pick<NBlock, 'items' | 'contribQuestions'>): number =>
  b.items.length + (b.contribQuestions.length ? 1 : 0);

/** Har ishtirokchi blokdan oladigan savollar soni: qo'lda (takrorsiz) + qoidalar */
export function blockQuestionCount(
  b: Pick<NBlock, 'items' | 'contribQuestions'> & { contribRules?: NBlockRule[] },
): number {
  const manual = new Set<string>();
  let rules = 0;
  for (const it of effectiveItems(b)) {
    if (it.kind === 'manual') for (const q of it.questionIds ?? []) manual.add(str(q));
    else rules += it.count ?? 0;
  }
  return manual.size + rules;
}

/** Imtihonning umumiy savollar soni (har ishtirokchiga) */
export const totalQuestionCount = (blocks: NBlock[]): number =>
  blocks.reduce((n, b) => n + blockQuestionCount(b), 0);

/** Qo'lda tanlangan barcha savol id lari (blokma-blok), takrorlar uchun */
export function manualIdsByBlock(blocks: NBlock[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const b of blocks) {
    const set = new Set<string>();
    for (const it of effectiveItems(b)) {
      if (it.kind === 'manual') for (const q of it.questionIds ?? []) set.add(str(q));
    }
    m.set(b.blockId, set);
  }
  return m;
}

/** per_block: bloklar davomiyliklari yig'indisi (daqiqa) */
export const sumBlockDurations = (blocks: Pick<NBlock, 'durationMin'>[]): number =>
  blocks.reduce((n, b) => n + (b.durationMin ?? 0), 0);

/**
 * Hisoblash sozlamasi (grading.ts ScoringOpts). Eski (blokisiz) hujjat uchun undefined: natija eski shaklda
 * (bloklarsiz) saqlanadi va o'qiladi, ya'ni eski imtihonlar natijasi o'zgarmaydi.
 */
export function scoringOf(d: BlocksSource & { scoringMode?: string | null }) {
  const blocks = normalizeBlocks(d);
  if (blocks[0]!.legacy) return undefined;
  return {
    mode: scoringModeOf(d),
    blocks: blocks.map((b) => ({ blockId: b.blockId, coefficient: b.coefficient })),
  };
}
