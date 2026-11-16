import crypto from 'crypto';
import type { IAttemptOrderItem } from '../../models/ExamAttempt';

/** Imtihon sessiyasi savollar nusxasidagi bitta savol (faqat kerakli maydonlar) */
export interface PoolQuestion {
  questionId: unknown;
  type: string;
  points: number;
  content?: unknown[];
  options?: { id: string; content?: unknown[] }[];
  answer?: Record<string, unknown>;
}

interface StoredItem {
  kind: 'manual' | 'rule';
  questionIds?: unknown[];
  count?: number;
  poolIds?: unknown[];
}
export interface StoredSection {
  title?: string;
  items: StoredItem[];
}

/** Deterministik PRNG (mulberry32): bir xil seed -> bir xil ketma-ketlik (restartdan keyin ham) */
export function seededRandom(seed: string): () => number {
  let a = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface SelectionInput {
  sections: StoredSection[];
  pool: Map<string, PoolQuestion>;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  seed: string;
}

/**
 * Ishtirokchi savollarini tanlaydi:
 *  1) barcha qo'lda tanlanganlar (takrorsiz);
 *  2) qoidalar: mos savollar to'plamidan (qo'lda tanlanganlarni va oldin olinganlarni chiqarib) `count` tadan,
 *     seed bo'yicha deterministik;
 *  3) shuffleQuestions bo'lsa umumiy tartib aralashtiriladi, aks holda bo'limlar tartibi saqlanadi;
 *  4) shuffleOptions bo'lsa single/multi variantlari aralashtiriladi.
 * Hovuzda yo'q savollar (nusxa buzilgan) jim o'tkazib yuboriladi.
 */
export function selectQuestions(input: SelectionInput): IAttemptOrderItem[] {
  const rnd = seededRandom(input.seed);
  const manualIds = new Set<string>();
  for (const sec of input.sections) {
    for (const it of sec.items) {
      if (it.kind === 'manual') for (const q of it.questionIds ?? []) manualIds.add(String(q));
    }
  }
  const chosen = new Set<string>();
  const ordered: string[] = [];
  const take = (id: string) => {
    if (chosen.has(id) || !input.pool.has(id)) return;
    chosen.add(id);
    ordered.push(id);
  };
  for (const sec of input.sections) {
    for (const it of sec.items) {
      if (it.kind === 'manual') {
        for (const q of it.questionIds ?? []) take(String(q));
      }
    }
  }
  for (const sec of input.sections) {
    for (const it of sec.items) {
      if (it.kind !== 'rule') continue;
      const candidates = (it.poolIds ?? [])
        .map(String)
        .filter((id) => !chosen.has(id) && !manualIds.has(id) && input.pool.has(id));
      for (const id of shuffled(candidates, rnd).slice(0, it.count ?? 0)) take(id);
    }
  }
  const finalIds = input.shuffleQuestions ? shuffled(ordered, rnd) : ordered;
  return finalIds.map((id) => {
    const q = input.pool.get(id)!;
    const ids = (q.options ?? []).map((o) => o.id);
    const hasOptions = q.type === 'single' || q.type === 'multi';
    return {
      qid: id,
      type: q.type,
      points: q.points,
      optionPerm: hasOptions ? (input.shuffleOptions ? shuffled(ids, rnd) : ids) : [],
    };
  });
}
