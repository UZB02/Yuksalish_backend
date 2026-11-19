import { LIMITS } from '../questions.schema';

/**
 * "Matnni joylash": oddiy matndan test savollarini ajratib oladigan TOZA funksiya (DB ga tegmaydi).
 * Yagona haqiqat manbai: oldindan ko'rish ham, saqlash ham shu funksiyadan o'tadi.
 *
 * Qo'llab-quvvatlanadigan yozuvlar:
 *  - savol raqami: `1.` `1)` `1-savol` `1 - savol:` `Savol 1:` `Вопрос 1.` `Question 1.`
 *  - variant: `A)` `A.` `a)` `(A)` `A -` `A:` (har biri alohida qatorda YOKI bir qatorda: `A) 90 B) 180 C) 270`)
 *  - kirill harflari: А Б В Г Д Е (o'rniga qarab A B C D E), `С` -> C
 *  - to'g'ri javob: `Javob: B`, `To'g'ri javob: B`, `Answer: B`, `Ответ: B`, `Javob: A, C` (ko'p javobli),
 *    variant belgisi (`*B) 4`, `+B) 4`, `B) 4 +`, `B) 4 *`, `B) 4 (+)`, `B) 4 ✓`), oxirida javoblar bloki
 *    (`Javoblar: 1-B 2-C 3-A` yoki `1B 2C 3A`), `Javob:` variant matni bilan ham bo'lishi mumkin
 *  - ko'p qatorli savol/variant matni, bo'sh qatorlar va sarlavhalar e'tiborsiz
 *  - formula: `$...$` (va `$$...$$`) oralig'i `math` blok sifatida; HTML hech qachon talqin qilinmaydi
 */

export type PasteBlock = { type: 'text'; text: string } | { type: 'math'; tex: string };

export type WarnCode =
  | 'noText'
  | 'noAnswer'
  | 'fewOptions'
  | 'dupLetters'
  | 'badAnswer'
  | 'conflict'
  | 'tooLong'
  | 'unparsed'
  | 'badMath';

export interface PasteWarning {
  code: WarnCode;
  message: string;
  /** Hal qilinmagan "to'sqinlik qiluvchi" ogohlantirish: savol saqlashdan chiqariladi */
  blocking: boolean;
}

export interface PasteOptionOut {
  /** Pozitsion identifikator: A, B, C ... (matndagi harfdan qat'i nazar) */
  id: string;
  content: PasteBlock[];
}

export interface PasteQuestion {
  /** 1 dan boshlab tartib raqami (saqlashda tuzatish/chiqarib tashlash shu raqam bilan) */
  idx: number;
  /** Matndagi raqam (bo'lsa) */
  number: number | null;
  /** Matndagi boshlanish qatori (1 dan) */
  line: number;
  content: PasteBlock[];
  options: PasteOptionOut[];
  /** To'g'ri variant id lari; bo'sh = topilmadi */
  correct: string[];
  type: 'single' | 'multi';
  warnings: PasteWarning[];
  /** Foydalanuvchi javobni qo'lda tanlay oladi (javob yo'q/noaniq) */
  pickable: boolean;
}

export interface PasteResult {
  questions: PasteQuestion[];
  /** Hech bir savolga tegishli bo'lmagan qatorlar (sarlavha va h.k.) */
  ignored: { line: number; text: string }[];
}

// ---------- Yordamchilar ----------

const APOS = /[‘’ʻʼ`´]/g;
/** Moslashtirish uchun: tutuq belgilarini ' ga keltiradi (uzunlik o'zgarmaydi) */
const norm = (s: string) => s.replace(APOS, "'");

/** Harf -> variant o'rni (0..5). Kirill: А Б В Г Д Е (alifbo tartibida), С = C */
const LETTER_POS: Record<string, number> = {};
const POS_LETTERS: string[][] = [
  ['A', 'a', 'А', 'а'],
  ['B', 'b', 'Б', 'б'],
  ['C', 'c', 'В', 'в', 'С', 'с'],
  ['D', 'd', 'Г', 'г'],
  ['E', 'e', 'Д', 'д', 'Е', 'е'],
  ['F', 'f'],
];
POS_LETTERS.forEach((ls, i) => ls.forEach((l) => (LETTER_POS[l] = i)));
const LETTER_CLASS = POS_LETTERS.flat().join('');
const posOf = (ch: string): number => LETTER_POS[ch] ?? -1;
const idOf = (pos: number) => String.fromCharCode(65 + pos);

// savol boshlanishi
const Q_NUM =
  /^\s*(\d{1,3})\s*(?:\)\s*|\.(?:\s+|$)|\s*-\s*(?:savol|вопрос|question)(?![\p{L}\p{N}])\s*[:.)-]?\s*)(.*)$/iu;
const Q_WORD = /^\s*(?:savol|вопрос|question)\s*[№#]?\s*(\d{1,3})\s*[:.)-]\s*(.*)$/iu;
// variant boshlanishi: [belgi] [(]HARF[)|.|' -'|:]
const OPT = new RegExp(
  `^\\s*([*+])?\\s*\\(?([${LETTER_CLASS}])(?:\\)|\\.(?=\\s)|\\s+[-\\u2013\\u2014](?=\\s)|:(?=\\s)|\\](?=\\s))\\s*(.*)$`,
  'u',
);
// "Javob: B"
const ANSWER =
  /^\s*(?:to'g'ri\s+javob|togri\s+javob|javob|answer|correct\s+answer|ответ|правильный\s+ответ|жавоб|тўғри\s+жавоб)\s*[:=\-–—]\s*(.+)$/iu;
// oxirida qolgan "Javob: B" (variant/savol qatori oxirida)
const ANSWER_TAIL =
  /\s+(?:to'g'ri\s+javob|togri\s+javob|javob|answer|ответ)\s*[:=]\s*(\(?[^\s]{1,2}\)?)\s*$/iu;
// javoblar bloki sarlavhasi
const KEY_HEAD =
  /^\s*(?:javoblar|kalitlar|kalit|javob\s+kaliti|answers|answer\s+key|keys|ответы|жавоблар)\s*[:.\-–—]?\s*(.*)$/iu;
const KEY_PAIR = new RegExp(
  `(\\d{1,3})\\s*[-.):=]?\\s*([${LETTER_CLASS}])(?![\\p{L}\\p{N}])`,
  'gu',
);

/** `1-B 2-C 3-A` ko'rinishidagi qatordan juftliklarni oladi; qator to'liq shunday bo'lmasa null */
function parseKeyPairs(s: string): Map<number, number> | null {
  const t = s.trim();
  if (!t) return null;
  const re = new RegExp(KEY_PAIR.source, 'gu');
  const out = new Map<number, number>();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (t.slice(last, m.index).replace(/[\s,;]/g, '') !== '') return null;
    last = m.index + m[0].length;
    out.set(Number(m[1]), posOf(m[2]!));
  }
  if (!out.size) return null;
  if (t.slice(last).replace(/[\s,;.]/g, '') !== '') return null;
  return out;
}

/** `$...$` / `$$...$$` bo'yicha bloklarga ajratadi. Yopilmagan `$` matn bo'lib qoladi (badMath) */
export function toBlocks(raw: string): { blocks: PasteBlock[]; badMath: boolean } {
  const blocks: PasteBlock[] = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let badMath = false;
  const pushText = (s: string) => {
    const t = s.trim();
    if (!t) return;
    if (t.includes('$')) badMath = true;
    blocks.push({ type: 'text', text: t });
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    pushText(raw.slice(last, m.index));
    const tex = (m[1] ?? m[2] ?? '').trim();
    if (tex) blocks.push({ type: 'math', tex });
    last = m.index + m[0].length;
  }
  pushText(raw.slice(last));
  return { blocks, badMath };
}

/** $...$ ichini bo'shliqqa (maxsus belgi) almashtirib nusxa qaytaradi: ichidan variant qidirilmaydi */
const maskMath = (s: string) =>
  s.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => '\u0001'.repeat(m.length));

/**
 * Bir qatordagi ketma-ket variantlarni ajratadi: `A) 90 B) 180 C) 270`. Birinchi harfdan keyin
 * KETMA-KET keyingi harflar (B, C, ...) qidiriladi; shu tartib topilmasa bo'linmaydi.
 */
function splitInline(text: string, firstPos: number): string[] | null {
  const masked = maskMath(text);
  const cuts: { at: number; len: number; pos: number; marker: boolean }[] = [];
  let from = 0;
  let pos = firstPos + 1;
  while (pos < POS_LETTERS.length) {
    const chars = POS_LETTERS[pos]!.join('');
    const re = new RegExp(
      `(^|\\s)([*+])?\\(?([${chars}])(?:\\)|\\.(?=\\s)|\\s+[-\\u2013\\u2014](?=\\s)|:(?=\\s))`,
      'u',
    );
    const m = re.exec(masked.slice(from));
    if (!m) break;
    const at = from + m.index + m[1]!.length;
    const len = m[0].length - m[1]!.length;
    cuts.push({ at, len, pos, marker: m[2] === '*' || m[2] === '+' });
    from = at + len;
    pos++;
  }
  if (!cuts.length) return null;
  const parts: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    parts.push(text.slice(prev, c.at));
    prev = c.at + c.len;
    // belgi keyingi variantga tegishli: qayta qo'shamiz (marker sifatida o'qiladi)
    if (c.marker) parts.push('\u0002');
  }
  parts.push(text.slice(prev));
  // '\u0002' belgisi: keyingi bo'lak oldiga "*" qo'yish uchun
  const out: string[] = [];
  let mark = false;
  for (const p of parts) {
    if (p === '\u0002') {
      mark = true;
      continue;
    }
    out.push((mark ? '*' : '') + p);
    mark = false;
  }
  return out;
}

const TRAIL_MARK = /\s+(?:\(\+\)|\(to'g'ri\)|\(togri\)|[+*✓✔])\s*$/iu;
function stripTrailMark(s: string): { text: string; marked: boolean } {
  const n = norm(s);
  const m = TRAIL_MARK.exec(n);
  if (!m) return { text: s, marked: false };
  return { text: s.slice(0, m.index), marked: true };
}

interface RawOpt {
  pos: number;
  lines: string[];
  marked: boolean;
}
interface RawQ {
  number: number | null;
  line: number;
  stem: string[];
  opts: RawOpt[];
  /** "Javob:" qatoridan olingan harflar o'rinlari */
  javob: number[] | null;
  /** "Javob:" qiymati harf emas bo'lsa: variant matni bilan solishtiriladi */
  javobText: string | null;
  unparsed: string[];
}

const newQ = (number: number | null, line: number, first: string): RawQ => ({
  number,
  line,
  stem: first ? [first] : [],
  opts: [],
  javob: null,
  javobText: null,
  unparsed: [],
});

/** "Javob:" dan keyin: harflar ro'yxati (A, C) yoki matn */
function parseAnswerValue(rest: string): { letters: number[] | null; text: string | null } {
  const t = norm(rest).trim();
  const re = new RegExp(`^\\(?([${LETTER_CLASS}])(?![\\p{L}\\p{N}])\\)?`, 'u');
  const first = re.exec(t);
  if (!first) return { letters: null, text: t || null };
  const letters = [posOf(first[1]!)];
  let tail = t.slice(first[0].length);
  const more = new RegExp(
    `^\\s*(?:[,;/&]|\\s(?:va|and|и)\\s)\\s*\\(?([${LETTER_CLASS}])(?![\\p{L}\\p{N}])\\)?`,
    'iu',
  );
  let m: RegExpExecArray | null;
  while ((m = more.exec(tail))) {
    letters.push(posOf(m[1]!));
    tail = tail.slice(m[0].length);
  }
  // "Javob: B) 4" yoki "B." kabi: qolgani e'tiborsiz. Lekin "Javob: Toshkent" (bitta harf emas) matn
  // harfdan keyin ')' kelgan bo'lsa ("B) 4") qolgani variant matni: e'tiborsiz
  if (first[0].endsWith(')') || /^[\s.)]*$/.test(tail) || /^\.\s/.test(tail)) {
    return { letters: [...new Set(letters)], text: null };
  }
  return { letters: null, text: t };
}

const plainOf = (blocks: PasteBlock[]) =>
  blocks
    .map((b) => (b.type === 'text' ? b.text : `$${b.tex}$`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Tozalash: boshqaruv belgilari, BOM, NBSP, tab */
export function normalizePasteText(text: string): string {
  return (
    text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00A0\u2007\u202F\t]/g, ' ')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '')
  );
}

export function parsePasteText(input: string): PasteResult {
  const lines = normalizePasteText(input).split('\n');
  const nlines = lines.map(norm);
  const numbered = nlines.some((l) => Q_NUM.test(l) || Q_WORD.test(l));
  const ignored: { line: number; text: string }[] = [];
  const raws: RawQ[] = [];
  const key = new Map<number, number[]>();
  let cur: RawQ | null = null;
  let keyMode = false;
  let pendingSplit = false;
  let afterBlank = false;

  const finishQ = () => {
    if (cur) raws.push(cur);
    cur = null;
  };
  const addKey = (m: Map<number, number>) => {
    for (const [n, p] of m) key.set(n, [p]);
  };

  const startOption = (q: RawQ, pos: number, marked: boolean, text: string) => {
    q.opts.push({ pos, lines: [text], marked });
  };
  /** Qator matnini (variantlar bir qatorda bo'lishi mumkin) joriy savolga qo'shadi */
  const feedOptionText = (q: RawQ, pos: number, marked: boolean, text: string) => {
    const parts = splitInline(text, pos);
    if (!parts) return startOption(q, pos, marked, text);
    // parts[0] = shu variant matni, keyingilari: sertli harflar tartibida
    startOption(q, pos, marked, parts[0]!);
    let p = pos + 1;
    for (const part of parts.slice(1)) {
      const mk = part.startsWith('*');
      startOption(q, p, mk, mk ? part.slice(1) : part);
      p++;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i]!;
    const n = nlines[i]!;
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) {
      if (cur && cur.opts.length) pendingSplit = true;
      afterBlank = true;
      continue;
    }
    const wasBlank = afterBlank;
    afterBlank = false;

    // --- javoblar bloki ---
    if (keyMode) {
      const km = parseKeyPairs(n);
      if (km) {
        addKey(km);
        continue;
      }
      keyMode = false;
    }
    const head = KEY_HEAD.exec(n);
    if (head) {
      const rest = (head[1] ?? '').trim();
      const km = rest ? parseKeyPairs(rest) : null;
      if (km || !rest) {
        // "Kalit: B" (bitta harf) bo'lsa pastda javob qatori sifatida o'qiladi
        if (km) addKey(km);
        keyMode = true;
        continue;
      }
    }
    // sarlavhasiz javoblar qatori: kamida ikkita juftlik
    const bare = parseKeyPairs(n);
    if (bare && bare.size >= 2) {
      addKey(bare);
      continue;
    }

    // --- "Javob: B" ---
    const am = ANSWER.exec(n);
    if (am && cur) {
      const v = parseAnswerValue(raw.slice(raw.length - am[1]!.length));
      if (v.letters) cur.javob = v.letters;
      else cur.javobText = v.text;
      continue;
    }

    // --- yangi savol ---
    const qm = Q_NUM.exec(n) ?? Q_WORD.exec(n);
    if (qm) {
      finishQ();
      pendingSplit = false;
      const textStart = raw.length - (qm[2] ?? '').length;
      cur = newQ(Number(qm[1]), lineNo, '');
      raw = raw.slice(textStart);
      absorbStemLine(cur, raw);
      continue;
    }

    // --- raqamsiz rejimda: bo'sh qatordan keyin matn = yangi savol ---
    const om = OPT.exec(raw);
    if (!numbered && cur && pendingSplit && !om) {
      finishQ();
      pendingSplit = false;
      cur = newQ(null, lineNo, '');
      absorbStemLine(cur, raw);
      continue;
    }
    pendingSplit = false;

    // --- variant ---
    if (om) {
      if (!cur) {
        if (numbered) {
          ignored.push({ line: lineNo, text: trimmed });
          continue;
        }
        cur = newQ(null, lineNo, '');
      }
      const pos = posOf(om[2]!);
      feedOptionText(cur, pos, om[1] === '*' || om[1] === '+', om[3] ?? '');
      absorbTailAnswer(cur);
      continue;
    }

    // --- oddiy matn ---
    if (!cur) {
      if (numbered) ignored.push({ line: lineNo, text: trimmed });
      else {
        cur = newQ(null, lineNo, '');
        absorbStemLine(cur, raw);
      }
      continue;
    }
    if (cur.opts.length === 0) {
      absorbStemLine(cur, raw);
    } else if (!wasBlank) {
      // oxirgi variantning davomi (ko'p qatorli variant)
      cur.opts[cur.opts.length - 1]!.lines.push(trimmed);
      absorbTailAnswer(cur);
    } else {
      cur.unparsed.push(trimmed);
    }
  }
  finishQ();

  // ----- Xom savollarni tayyor ko'rinishga keltirish -----
  const questions: PasteQuestion[] = raws.map((r, k) => buildQuestion(r, k + 1, key));
  return { questions, ignored };

  /** Savol matni qatori: variantlar shu qatorda bo'lishi mumkin ("5+3=? A) 7 B) 8") */
  function absorbStemLine(q: RawQ, text: string) {
    const t = text.trim();
    if (!t) return;
    const masked = maskMath(t);
    const re = new RegExp(`(^|\\s)([*+])?\\(?([Aa\\u0410\\u0430])(?:\\)|\\.(?=\\s))`, 'u');
    const m = re.exec(masked);
    if (m && q.opts.length === 0) {
      const at = m.index + m[1]!.length;
      const after = t.slice(at + m[0].length - m[1]!.length);
      if (splitInline(after, 0)) {
        const stem = t.slice(0, at).trim();
        if (stem) q.stem.push(stem);
        feedOptionText(q, 0, m[2] === '*' || m[2] === '+', after);
        absorbTailAnswer(q);
        return;
      }
    }
    q.stem.push(t);
    absorbTailAnswer(q);
  }

  /** Oxirgi qator oxiridagi "Javob: B" ni ajratib oladi */
  function absorbTailAnswer(q: RawQ) {
    const arr = q.opts.length ? q.opts[q.opts.length - 1]!.lines : q.stem;
    const last = arr[arr.length - 1];
    if (last === undefined) return;
    const m = ANSWER_TAIL.exec(norm(last));
    if (!m) return;
    const v = parseAnswerValue(m[1]!);
    if (!v.letters) return;
    q.javob = v.letters;
    arr[arr.length - 1] = last.slice(0, m.index);
  }
}

function buildQuestion(r: RawQ, idx: number, key: Map<number, number[]>): PasteQuestion {
  const warnings: PasteWarning[] = [];
  const warn = (code: WarnCode, message: string, blocking = true) =>
    warnings.push({ code, message, blocking });
  let badMath = false;
  const stem = toBlocks(r.stem.join('\n'));
  badMath ||= stem.badMath;
  if (!stem.blocks.length) warn('noText', "Savol matni yo'q");

  // variantlar: pozitsion id; harflar takrorlansa ogohlantirish
  const seen = new Set<number>();
  let dup = false;
  const markedIds: string[] = [];
  const labelToId = new Map<number, string>();
  const options: PasteOptionOut[] = [];
  const optText: string[] = [];
  r.opts.forEach((o, i) => {
    const joined = o.lines.join('\n');
    const stripped = stripTrailMark(joined);
    const blocks = toBlocks(stripped.text);
    badMath ||= blocks.badMath;
    if (!blocks.blocks.length) {
      // bo'sh variant (masalan "C)" va hech narsa): matn yo'q
      blocks.blocks.push({ type: 'text', text: '—' });
      warn('fewOptions', `${idOf(o.pos)} varianti bo'sh`);
    }
    const id = idOf(i);
    if (seen.has(o.pos)) dup = true;
    else {
      seen.add(o.pos);
      labelToId.set(o.pos, id);
    }
    if (o.marked || stripped.marked) markedIds.push(id);
    options.push({ id, content: blocks.blocks });
    optText.push(plainOf(blocks.blocks));
  });
  if (dup) warn('dupLetters', 'Variant harflari takrorlangan');
  if (options.length < 2) {
    warn('fewOptions', `Kamida 2 ta variant kerak (${options.length} ta topildi)`);
  }

  // to'g'ri javob: belgi > "Javob:" > oxiridagi blok; kelishmasa conflict
  const idsOf = (poss: number[]): string[] | null => {
    const ids = poss.map((p) => labelToId.get(p));
    return ids.every((x): x is string => !!x) ? (ids as string[]) : null;
  };
  let explicit: string[] | null = null;
  let badAnswer = false;
  if (r.javob) {
    explicit = idsOf(r.javob);
    if (!explicit) badAnswer = true;
  } else if (r.javobText) {
    const hit = optText.findIndex((t) => t === r.javobText!.replace(/\s+/g, ' ').toLowerCase());
    if (hit >= 0) explicit = [idOf(hit)];
    else badAnswer = true;
  }
  const keyed = key.get(r.number ?? idx);
  let fromKey: string[] | null = null;
  if (keyed) {
    fromKey = idsOf(keyed);
    if (!fromKey && !explicit && !markedIds.length) badAnswer = true;
  }
  const cands = [markedIds.length ? markedIds : null, explicit, fromKey].filter(
    (x): x is string[] => !!x,
  );
  let correct: string[] = [];
  let conflict = false;
  if (cands.length) {
    const first = [...cands[0]!].sort().join();
    if (cands.every((c) => [...c].sort().join() === first))
      correct = [...new Set(cands[0]!)].sort();
    else conflict = true;
  }
  if (conflict) {
    warn('conflict', 'Javob belgisi, "Javob:" qatori yoki javoblar bloki bir-biriga mos kelmaydi');
  } else if (badAnswer && !correct.length) {
    warn('badAnswer', "Ko'rsatilgan javob variantlar orasida yo'q");
  } else if (!correct.length) {
    warn('noAnswer', "To'g'ri javob ko'rsatilmagan");
  }

  if (r.unparsed.length) {
    warn(
      'unparsed',
      `Tushunilmagan qatorlar e'tiborsiz qoldirildi: ${r.unparsed
        .slice(0, 2)
        .map((x) => `"${x.slice(0, 40)}"`)
        .join(', ')}${r.unparsed.length > 2 ? ' ...' : ''}`,
      false,
    );
  }
  if (badMath) {
    warn(
      'badMath',
      "Formula belgisi ($) yopilmagan: matn sifatida qoldi. Formula $...$ oralig'ida",
      false,
    );
  }
  const tooLong =
    stem.blocks.length > LIMITS.blocks ||
    stem.blocks.some((b) =>
      b.type === 'text' ? b.text.length > LIMITS.textChars : b.tex.length > LIMITS.texChars,
    ) ||
    options.some(
      (o) =>
        o.content.length > LIMITS.optionBlocks ||
        o.content.some((b) =>
          b.type === 'text' ? b.text.length > LIMITS.textChars : b.tex.length > LIMITS.texChars,
        ),
    );
  if (tooLong) warn('tooLong', 'Savol yoki variant matni juda uzun');

  const pickable = warnings.some(
    (w) => w.code === 'noAnswer' || w.code === 'badAnswer' || w.code === 'conflict',
  );
  return {
    idx,
    number: r.number,
    line: r.line,
    content: stem.blocks,
    options,
    correct,
    type: correct.length > 1 ? 'multi' : 'single',
    warnings,
    pickable,
  };
}

export const hasBlocking = (q: PasteQuestion) => q.warnings.some((w) => w.blocking);
