/**
 * "Fayl + kalit" bloki (IMTIHON_REJA §22): sof (DB siz) yordamchilar.
 *
 * Blok `content='file'` bo'lsa o'quvchi savollarni PDF/rasm ko'rinishida oladi, javoblarni varaqada belgilaydi,
 * baholash kalit bo'yicha. Mavjud mexanizm (savollar nusxasi, javoblar, baholash, natijalar) qayta ishlatiladi:
 * har kalit elementi muzlatishda SUN'IY savolga aylanadi (`poolOfFileBlock`), shuning uchun baholash, tahlil,
 * eksport va profil natijalari alohida kodsiz ishlaydi.
 */
import { seededRandom, shuffled } from '../../exam-client/selection';
import { normalizeShortAnswer } from '../questions.normalize';

export const VARIANT_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type VariantLetter = (typeof VARIANT_LETTERS)[number];
export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export const MAX_KEY_ITEMS = 200;
export const MAX_FILES_PER_VARIANT = 40;
export const MAX_ACCEPTED = 10;
export const MAX_ACCEPTED_LEN = 100;
export const MIN_POINTS = 0.1;
export const MAX_POINTS = 100;
export const DEFAULT_OPTIONS = 4;

export interface FileKeyItem {
  no: number;
  type: 'choice' | 'short';
  /** choice: variantlar soni (2..6) */
  options?: number;
  /** choice: to'g'ri harflar (bittasi yoki bir nechta: to'liq mos kelsa ball beriladi) */
  correct?: string[];
  /** short: qabul qilinadigan javoblar (harf-raqam katta-kichikligi, probel va 12,5 = 12.50 e'tiborga olinmaydi) */
  accepted?: string[];
  points: number;
}

export interface FileVariant {
  letter: VariantLetter;
  kind: 'pdf' | 'image';
  /** Tartiblangan fayl id lari: PDF bo'lsa bitta, rasm bo'lsa 1..MAX_FILES_PER_VARIANT */
  files: string[];
  key: FileKeyItem[];
}

/**
 * Yetkazish: 'screen' - fayl serverda VAQTINCHA turadi, o'quvchi ekranda ko'radi (variant avtomatik beriladi);
 * 'paper' - fayl yuklanmaydi, test chop etib tarqatiladi, o'quvchi faqat javob varaqasini to'ldiradi va qog'ozidagi
 * variantni O'ZI tanlaydi (tasdiq bilan, keyin qulflanadi; xato bo'lsa tuzuvchi/nazoratchi tuzatadi).
 */
export type Delivery = 'screen' | 'paper';
export const DELIVERIES: readonly Delivery[] = ['screen', 'paper'];

export interface FileTest {
  delivery: Delivery;
  variants: FileVariant[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Saqlangan (ishonchsiz) qiymatni FileTest ga o'giradi; yaroqsiz bo'lsa null. Sxema tekshiruvi EMAS (validateFileTest bor) */
export function fileTestOf(raw: unknown): FileTest | null {
  if (!raw || typeof raw !== 'object') return null;
  const vs = (raw as { variants?: unknown }).variants;
  if (!Array.isArray(vs)) return null;
  return {
    delivery: (raw as { delivery?: unknown }).delivery === 'paper' ? 'paper' : 'screen',
    variants: vs.map((v) => {
      const x = v as Record<string, unknown>;
      return {
        letter: String(x.letter) as VariantLetter,
        kind: x.kind === 'image' ? 'image' : 'pdf',
        files: ((x.files as unknown[]) ?? []).map(String),
        key: ((x.key as Record<string, unknown>[]) ?? []).map((k) => ({
          no: Number(k.no),
          type: k.type === 'short' ? 'short' : 'choice',
          ...(k.type === 'short'
            ? { accepted: ((k.accepted as unknown[]) ?? []).map(String) }
            : {
                options: Number(k.options ?? DEFAULT_OPTIONS),
                correct: ((k.correct as unknown[]) ?? []).map(String),
              }),
          points: Number(k.points ?? 1),
        })),
      };
    }),
  };
}

/** Blokdagi savollar soni (har ishtirokchi ko'radigan): variantlar bir xil N ga ega bo'lishi shart, birinchisi olinadi */
export const fileTestCount = (ft: FileTest | null): number => ft?.variants[0]?.key.length ?? 0;

export const keyPoints = (key: readonly FileKeyItem[]): number =>
  round(key.reduce((n, k) => n + k.points, 0));

// ---------- Tekshirish ----------
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Bitta kalit elementini tekshiradi (xabarlar o'zbekcha, `where` = "A varianti, 3-savol") */
function itemIssues(k: FileKeyItem, where: string): string[] {
  const out: string[] = [];
  if (!(k.points >= MIN_POINTS && k.points <= MAX_POINTS)) {
    out.push(`${where}: ball ${MIN_POINTS} dan ${MAX_POINTS} gacha bo'lsin`);
  }
  if (k.type === 'choice') {
    const n = k.options ?? DEFAULT_OPTIONS;
    if (!Number.isInteger(n) || n < 2 || n > 6) out.push(`${where}: variantlar soni 2 dan 6 gacha`);
    const correct = k.correct ?? [];
    if (!correct.length) out.push(`${where}: to'g'ri javob belgilanmagan`);
    const allowed = new Set(OPTION_LETTERS.slice(0, Number.isInteger(n) ? n : DEFAULT_OPTIONS));
    if (new Set(correct).size !== correct.length) out.push(`${where}: harflar takrorlangan`);
    for (const c of correct) {
      if (!allowed.has(c as never)) out.push(`${where}: "${c}" variantlar orasida yo'q`);
    }
  } else {
    const acc = k.accepted ?? [];
    if (!acc.length) out.push(`${where}: javob kiritilmagan`);
    if (acc.length > MAX_ACCEPTED) out.push(`${where}: javoblar ${MAX_ACCEPTED} tadan oshmasin`);
    for (const a of acc) {
      if (!normalizeShortAnswer(a)) out.push(`${where}: bo'sh javob`);
      if (a.length > MAX_ACCEPTED_LEN)
        out.push(`${where}: javob ${MAX_ACCEPTED_LEN} belgidan oshmasin`);
    }
  }
  return out;
}

/**
 * Fayl testini to'liq tekshiradi. `strict` (rejalashtirishda): har variantda fayl va to'liq kalit, barcha variantlarda
 * savollar soni VA ballar yig'indisi bir xil (natijalar variantlar orasida solishtirma bo'lishi uchun).
 * `strict=false` (qoralamani saqlash): tuzilma va elementlar to'g'ri bo'lishi shart, lekin to'liq bo'lmasligi mumkin.
 */
export function validateFileTest(ft: FileTest | null, strict: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (message: string, path = 'fileTest') => issues.push({ path, message });
  if (!ft || !ft.variants.length) {
    if (strict) add('Fayl testi to‘ldirilmagan: kamida bitta variant kerak');
    return issues;
  }
  if (ft.variants.length > VARIANT_LETTERS.length) add('Variantlar 4 tadan oshmasin');
  const seen = new Set<string>();
  ft.variants.forEach((v, i) => {
    const label = `${v.letter} varianti`;
    if (!VARIANT_LETTERS.includes(v.letter)) add(`${i + 1}-variant harfi noto'g'ri`);
    if (seen.has(v.letter)) add(`${label} takrorlangan`);
    seen.add(v.letter);
    if (v.kind === 'pdf' && v.files.length > 1) add(`${label}: PDF uchun bitta fayl`);
    if (v.files.length > MAX_FILES_PER_VARIANT)
      add(`${label}: fayllar ${MAX_FILES_PER_VARIANT} tadan oshmasin`);
    if (new Set(v.files).size !== v.files.length) add(`${label}: fayl takrorlangan`);
    if (strict && ft.delivery === 'screen' && !v.files.length) add(`${label}: fayl yuklanmagan`);
    if (v.key.length > MAX_KEY_ITEMS) add(`${label}: savollar ${MAX_KEY_ITEMS} tadan oshmasin`);
    if (strict && !v.key.length) add(`${label}: kalit bo'sh`);
    // Raqamlar 1..N ketma-ket, takrorsiz
    const nos = v.key.map((k) => k.no);
    for (let j = 0; j < nos.length; j++) {
      if (nos[j] !== j + 1) {
        add(
          `${label}: savol raqamlari 1 dan ketma-ket bo'lishi kerak (${j + 1}-o'rinda ${nos[j]})`,
        );
        break;
      }
    }
    for (const k of v.key) for (const m of itemIssues(k, `${label}, ${k.no}-savol`)) add(m);
  });
  if (strict) {
    const first = ft.variants[0]!;
    for (const v of ft.variants.slice(1)) {
      if (v.key.length !== first.key.length) {
        add(
          `Variantlarda savollar soni bir xil bo'lishi kerak: ${first.letter} - ${first.key.length}, ${v.letter} - ${v.key.length}`,
        );
      } else if (Math.abs(keyPoints(v.key) - keyPoints(first.key)) > 1e-6) {
        add(
          `Variantlarda ballar yig'indisi bir xil bo'lishi kerak: ${first.letter} - ${keyPoints(first.key)}, ${v.letter} - ${keyPoints(v.key)}`,
        );
      }
    }
  }
  return [...new Map(issues.map((x) => [x.message, x])).values()];
}

// ---------- Kalitni matndan o'qish ----------
export interface ParsedKey {
  items: FileKeyItem[];
  errors: string[];
  warnings: string[];
}

const SEP = String.raw`[-–—.:)=]`;
// "12-C", "12)B,D", "7=25,5*2", "3. 12|12.0"
const TOKEN = new RegExp(String.raw`(\d{1,3})\s*${SEP}\s*([^\s;*]+)(?:\*(\d+(?:[.,]\d+)?))?`, 'g');
const LETTERS_ONLY = /^[A-Fa-f]+$/;
// Kirill o'xshash harflar (А В С Е) lotin harfga o'giriladi
const HOMO: Record<string, string> = {
  А: 'A',
  В: 'B',
  С: 'C',
  Е: 'E',
  а: 'a',
  в: 'b',
  с: 'c',
  е: 'e',
};

/**
 * Tez kiritish: "1-C 2-A 3-25 4-B,D 5-12|12.5*2".
 *  - Raqam va javob orasida `- . : ) =` belgilaridan biri; yozuvlar probel/qator/`;` bilan ajratiladi.
 *  - Javob harf(lar) A-F (bir nechtasi: `B,D` yoki `BD`, ya'ni bir nechta to'g'ri javob) bo'lsa - tanlash savoli,
 *    aks holda qisqa javob (`|` bilan bir nechta qabul qilinadigan javob).
 *  - `*N` oxirida: ball (standart `defaults.points`). Variantlar soni: `defaults.options`, kerak bo'lsa kattaroq harfga qarab oshadi.
 */
export function parseKeyText(
  text: string,
  defaults: { options?: number; points?: number } = {},
): ParsedKey {
  const errors: string[] = [];
  const warnings: string[] = [];
  const defOptions = Math.min(6, Math.max(2, defaults.options ?? DEFAULT_OPTIONS));
  const defPoints = defaults.points ?? 1;
  const cleaned = text
    .replace(/[\u00A0\u200B]/g, ' ')
    .replace(/,\s+/g, ',')
    .replace(/\s*\|\s*/g, '|');
  const byNo = new Map<number, FileKeyItem>();
  let matched = 0;
  for (const m of cleaned.matchAll(TOKEN)) {
    matched++;
    const no = Number(m[1]);
    const raw = m[2]!.replace(/[АВСЕавсе]/g, (c) => HOMO[c] ?? c);
    const pts = m[3] ? Number(m[3].replace(',', '.')) : defPoints;
    if (no < 1 || no > MAX_KEY_ITEMS) {
      errors.push(`${no}-savol: raqam 1 dan ${MAX_KEY_ITEMS} gacha bo'lsin`);
      continue;
    }
    if (byNo.has(no)) {
      errors.push(`${no}-savol takrorlangan`);
      continue;
    }
    const letters = raw.replace(/,/g, '');
    const parts = raw.split(',');
    const isChoice =
      LETTERS_ONLY.test(letters) &&
      letters.length <= 6 &&
      new Set(letters.toUpperCase()).size === letters.length &&
      (parts.length === 1 || parts.every((p) => p.length === 1));
    let item: FileKeyItem;
    if (isChoice) {
      const correct = [...letters.toUpperCase()].sort();
      const need = Math.max(...correct.map((c) => OPTION_LETTERS.indexOf(c as never))) + 1;
      item = { no, type: 'choice', options: Math.max(defOptions, need), correct, points: pts };
    } else {
      const accepted = raw
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean);
      item = { no, type: 'short', accepted, points: pts };
    }
    for (const msg of itemIssues(item, `${no}-savol`)) errors.push(msg);
    byNo.set(no, item);
  }
  if (!matched && text.trim()) {
    errors.push("Kalit o'qilmadi. Misol: 1-C 2-A 3-25 4-B,D");
  }
  const items = [...byNo.values()].sort((a, b) => a.no - b.no);
  if (items.length) {
    const max = items[items.length - 1]!.no;
    const missing: number[] = [];
    for (let i = 1; i <= max; i++) if (!byNo.has(i)) missing.push(i);
    if (missing.length) {
      const shown = missing.slice(0, 12).join(', ');
      warnings.push(
        `Kalitda ${missing.length} ta savol yo'q: ${shown}${missing.length > 12 ? '…' : ''}`,
      );
    }
  }
  return { items, errors: [...new Set(errors)], warnings };
}

// ---------- Muzlatilgan savollar (sun'iy) ----------
/** Sun'iy savol id si: `fk:<blockId>:<harf>:<raqam>` (<= 40 belgi: javoblar sxemasi chegarasi) */
export const fileQid = (blockId: string, letter: string, no: number): string =>
  `fk:${blockId}:${letter}:${no}`;

export interface SyntheticPoolQuestion {
  questionId: string;
  version: number;
  topicId: null;
  subjectId: unknown;
  type: 'single' | 'multi' | 'short';
  difficulty: number;
  points: number;
  content: { type: 'text'; text: string }[];
  options: { id: string; content: { type: 'text'; text: string }[] }[];
  answer: Record<string, unknown>;
}

/**
 * Blokning barcha variantlari kalitini savollar nusxasiga (pool) aylantiradi. `content` natijalar jadvalida
 * ko'rinadi ("A varianti: 3-savol"); o'quvchi mijozi matnni ishlatmaydi: faylni ko'radi, javob varaqasini to'ldiradi.
 * To'g'ri javobi bir nechta tanlash savoli 'multi' (to'liq mos kelsa ball), bittasi 'single'.
 */
export function poolOfFileBlock(
  blockId: string,
  subjectId: unknown,
  ft: FileTest,
): SyntheticPoolQuestion[] {
  const out: SyntheticPoolQuestion[] = [];
  for (const v of ft.variants) {
    for (const k of v.key) {
      const label = [{ type: 'text' as const, text: `${v.letter} varianti: ${k.no}-savol` }];
      const base = {
        questionId: fileQid(blockId, v.letter, k.no),
        version: 1,
        topicId: null,
        subjectId,
        difficulty: 2,
        points: k.points,
        content: label,
      };
      if (k.type === 'short') {
        out.push({
          ...base,
          type: 'short',
          options: [],
          answer: { acceptedAnswers: [...(k.accepted ?? [])] },
        });
        continue;
      }
      const n = k.options ?? DEFAULT_OPTIONS;
      const correct = k.correct ?? [];
      out.push({
        ...base,
        type: correct.length > 1 ? 'multi' : 'single',
        options: OPTION_LETTERS.slice(0, n).map((l) => ({
          id: l,
          content: [{ type: 'text' as const, text: l }],
        })),
        answer:
          correct.length > 1
            ? { optionIds: [...correct], partialCredit: false }
            : { optionId: correct[0] },
      });
    }
  }
  return out;
}

/** Variant uchun urinish tartibi elementlari (aralashtirilmaydi: raqamlar varaqadagi tartibda) */
export function orderOfVariant(blockId: string, v: FileVariant) {
  return v.key.map((k) => ({
    blockId,
    qid: fileQid(blockId, v.letter, k.no),
    type: k.type === 'short' ? 'short' : (k.correct?.length ?? 0) > 1 ? 'multi' : 'single',
    points: k.points,
    optionPerm:
      k.type === 'short' ? [] : OPTION_LETTERS.slice(0, k.options ?? DEFAULT_OPTIONS).map(String),
    variant: v.letter,
    no: k.no,
  }));
}

/**
 * Tekis tasodifiy variant: `c` - blokda shu ishtirokchigacha variant olganlar soni (0 dan). Har V ta ketma-ket
 * ishtirokchi (bir "davr") barcha variantlarni BIR martadan oladi, davr ichida tartib tasodifiy (seed: sessiya+blok+davr).
 * Shuning uchun istalgan paytda variantlar soni orasidagi farq <= 1.
 */
export function balancedVariant(letters: readonly string[], c: number, seed: string): string {
  const v = letters.length;
  if (v === 1) return letters[0]!;
  const round = Math.floor(c / v);
  const perm = shuffled(letters, seededRandom(`${seed}:${round}`));
  return perm[c % v]!;
}

/** Admin ko'rinishi uchun qisqa xulosa (kalitsiz) */
export function fileTestSummary(ft: FileTest | null) {
  return {
    delivery: ft?.delivery ?? 'screen',
    variants: (ft?.variants ?? []).map((v) => ({
      letter: v.letter,
      kind: v.kind,
      files: v.files.length,
      questions: v.key.length,
      points: keyPoints(v.key),
    })),
    questions: fileTestCount(ft),
  };
}

/** Tanlanmagan paper blok savollarini attempt.order ga blok tartibi bo'yicha joylaydi */
export function insertBlockItems(
  order: { blockId?: string }[],
  blocks: { blockId: string }[],
  blockId: string,
  items: object[],
): object[] {
  const rank = new Map(blocks.map((b, i) => [b.blockId, i]));
  const mine = rank.get(blockId) ?? 0;
  let at = order.length;
  for (let i = 0; i < order.length; i++) {
    const r = rank.get(order[i]!.blockId ?? '') ?? 0;
    if (r > mine) {
      at = i;
      break;
    }
  }
  return [...order.slice(0, at), ...items, ...order.slice(at)];
}
