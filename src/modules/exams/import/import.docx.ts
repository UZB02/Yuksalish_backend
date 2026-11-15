import JSZip from 'jszip';
import {
  importError,
  MAX_IMPORT_QUESTIONS,
  type Block,
  type RawItem,
  type RawOption,
} from './import.common';
import { ommlToLatex } from './omml';
import { child, childrenNamed, elems, hasDtd, parseXml, textOf, XmlError, type XNode } from './xml';

/**
 * Word (.docx) import. Xavfsizlik (zip va XML):
 *  - faqat .docx: ZIP magic (PK\x03\x04), [Content_Types].xml va word/document.xml shart;
 *    makro (.docm: macroEnabled kontent turi, vbaProject) rad etiladi;
 *  - zip-bomba himoyasi PARSEDAN OLDIN: yozuvlar soni, deklaratsiya qilingan va HAQIQIY ochilgan hajm (oqim
 *    bo'yicha sanaladi, yolg'on sarlavhaga ishonilmaydi), siqish nisbati;
 *  - istalgan XML da DOCTYPE/ENTITY bo'lsa rad etiladi;
 *  - rasmlar soni cheklangan va har biri qayta kodlanadi (processExamImage), HTML hech qachon saqlanmaydi.
 */
export const DOCX_LIMITS = {
  maxEntries: 500,
  maxTotalBytes: 50 * 1024 * 1024,
  maxXmlBytes: 20 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxRatio: 200,
  maxImages: 200,
  timeoutMs: 60_000,
} as const;

const MAIN_CT = 'wordprocessingml.document.main+xml';

export interface DocxEnv {
  /** Rasmni saqlaydi va assetId qaytaradi (xato bo'lsa tashlaydi) */
  saveImage: (bytes: Buffer) => Promise<string>;
  deadline: number;
}

interface ZipGuard {
  zip: JSZip;
  total: number;
}

const decl = (f: JSZip.JSZipObject) =>
  (f as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data ?? {};

/** Zip tuzilishini PARSEDAN OLDIN tekshiradi (hech narsa ochilmaydi) */
export async function openDocx(buffer: Buffer): Promise<ZipGuard> {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw importError('Fayl .docx (Word) formatida emas');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw importError('Fayl buzilgan yoki .docx formatida emas');
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > DOCX_LIMITS.maxEntries)
    throw importError('Fayl tuzilishi juda murakkab (yozuvlar ko‘p)');
  let declared = 0;
  for (const f of entries) {
    const { uncompressedSize = 0, compressedSize = 0 } = decl(f);
    declared += uncompressedSize;
    const lim = f.name.startsWith('word/media/')
      ? DOCX_LIMITS.maxImageBytes
      : DOCX_LIMITS.maxXmlBytes;
    if (uncompressedSize > lim) throw importError('Faylda juda katta qism bor');
    if (
      uncompressedSize > 256 * 1024 &&
      uncompressedSize / Math.max(compressedSize, 1) > DOCX_LIMITS.maxRatio
    ) {
      throw importError('Fayl shubhali: siqish nisbati juda yuqori');
    }
  }
  if (declared > DOCX_LIMITS.maxTotalBytes) throw importError('Fayl ochilgandagi hajmi juda katta');
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
    throw importError('Fayl Word (.docx) hujjati emas');
  }
  if (entries.some((f) => /vbaProject|\.bin$/i.test(f.name) && /vba/i.test(f.name))) {
    throw importError('Makroli fayllar (.docm) qabul qilinmaydi');
  }
  return { zip, total: 0 };
}

interface ZipStream {
  on(ev: 'data', fn: (d: Uint8Array) => void): ZipStream;
  on(ev: 'error', fn: (e: unknown) => void): ZipStream;
  on(ev: 'end', fn: () => void): ZipStream;
  pause(): void;
  resume(): void;
}

/** Yozuvni oqim bilan o'qiydi: HAQIQIY bayt soni cheklanadi (sarlavhadagi hajmga ishonilmaydi) */
function readEntry(g: ZipGuard, name: string, max: number): Promise<Buffer | null> {
  const f = g.zip.file(name);
  if (!f) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const s = (f as unknown as { internalStream(t: 'uint8array'): ZipStream }).internalStream(
      'uint8array',
    );
    s.on('data', (d: Uint8Array) => {
      size += d.length;
      g.total += d.length;
      if (size > max || g.total > DOCX_LIMITS.maxTotalBytes) {
        s.pause();
        reject(importError('Fayl ochilgandagi hajmi juda katta'));
        return;
      }
      chunks.push(Buffer.from(d));
    });
    s.on('error', () => reject(importError('Fayl buzilgan')));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.resume();
  });
}

async function readXml(g: ZipGuard, name: string): Promise<XNode | null> {
  const buf = await readEntry(g, name, DOCX_LIMITS.maxXmlBytes);
  if (!buf) return null;
  const xml = buf.toString('utf8');
  if (hasDtd(xml))
    throw importError('Faylda DOCTYPE/ENTITY e’lonlari bor: xavfsizlik uchun rad etildi');
  try {
    return parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw importError('Fayl ichidagi XML buzilgan');
    throw e;
  }
}

// ---------- Paragraf -> qismlar ----------
type Part =
  { k: 'text'; t: string } | { k: 'math'; tex: string | null } | { k: 'image'; rid: string };

function pushText(parts: Part[], t: string) {
  if (!t) return;
  const last = parts[parts.length - 1];
  if (last?.k === 'text') last.t += t;
  else parts.push({ k: 'text', t });
}

function walk(n: XNode, parts: Part[]) {
  for (const c of elems(n)) {
    switch (c.name) {
      case 'w:t':
        pushText(parts, textOf(c));
        break;
      case 'w:tab':
        pushText(parts, ' ');
        break;
      case 'w:br':
      case 'w:cr':
        pushText(parts, ' ');
        break;
      case 'w:del':
      case 'w:delText':
      case 'w:pPr':
      case 'w:rPr':
        break;
      case 'm:oMathPara':
        for (const m of childrenNamed(c, 'm:oMath')) {
          const r = ommlToLatex(m);
          parts.push({ k: 'math', tex: r.ok ? r.tex : null });
        }
        break;
      case 'm:oMath': {
        const r = ommlToLatex(c);
        parts.push({ k: 'math', tex: r.ok ? r.tex : null });
        break;
      }
      case 'a:blip': {
        const rid = c.attrs['r:embed'];
        if (rid) parts.push({ k: 'image', rid });
        break;
      }
      case 'v:imagedata': {
        const rid = c.attrs['r:id'];
        if (rid) parts.push({ k: 'image', rid });
        break;
      }
      default:
        walk(c, parts);
    }
  }
}

const paraParts = (p: XNode): Part[] => {
  const parts: Part[] = [];
  walk(p, parts);
  return parts;
};

// ---------- Tuzilma tanish ----------
const QUESTION_RE = /^\s*(\d{1,4})\s*[.)]\s+([\s\S]*)$/;
const OPTION_RE = /^\s*(\*)?\s*([A-Ja-j])\s*[).]\s*([\s\S]*)$/;
const META_RE = /^\s*(Mavzu|Qiyinlik|Ball|Tur|Fan|Javob|Qisman ball|Qisman)\s*:\s*([\s\S]*)$/i;
const ANSWERS_RE =
  /^\s*(javoblar|kalitlar|javob\s+kaliti|answers?|answer\s+key)\b[\s:.]*([\s\S]*)$/i;

const letterId = (ch: string) => ch.toLowerCase();

/** "1-B, 2-AC, 3: 12,5" -> [[1,'B'],[2,'AC'],[3,'12,5']] */
export function parseAnswerPairs(text: string): [number, string][] {
  const out: [number, string][] = [];
  const re = /(\d{1,4})\s*[-–—:.)]\s*([\s\S]+?)(?=(?:[,;]\s*\d{1,4}\s*[-–—:.)]\s*)|;|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = m[2]!.trim();
    if (v) out.push([Number(m[1]), v]);
  }
  return out;
}

const LETTERS_ONLY = /^[A-Ja-j]([\s,;/]*[A-Ja-j])*$/;

interface Draft {
  raw: RawItem;
  starred: boolean;
  target: 'content' | RawOption;
}

function newRaw(row: number): RawItem {
  return {
    row,
    subjectName: null,
    topic: null,
    difficulty: null,
    type: null,
    points: null,
    partialCredit: false,
    content: [],
    options: [],
    correctIds: [],
    accepted: [],
    rubric: '',
    warnings: [],
    errors: [],
  };
}

export interface DocxResult {
  items: RawItem[];
  warnings: string[];
}

export async function parseDocx(buffer: Buffer, env: DocxEnv): Promise<DocxResult> {
  const g = await openDocx(buffer);

  // Kontent turlari: faqat oddiy .docx (makrosiz)
  const ctBuf = await readEntry(g, '[Content_Types].xml', DOCX_LIMITS.maxXmlBytes);
  const ct = ctBuf?.toString('utf8') ?? '';
  if (hasDtd(ct))
    throw importError('Faylda DOCTYPE/ENTITY e’lonlari bor: xavfsizlik uchun rad etildi');
  if (/macroEnabled|vbaProject/i.test(ct))
    throw importError('Makroli fayllar (.docm) qabul qilinmaydi');
  if (!ct.includes(MAIN_CT)) throw importError('Fayl oddiy Word (.docx) hujjati emas');

  const doc = await readXml(g, 'word/document.xml');
  const rels = await readXml(g, 'word/_rels/document.xml.rels');
  if (!doc) throw importError('Fayl Word (.docx) hujjati emas');
  const relMap = new Map<string, string>();
  if (rels) {
    for (const r of childrenNamed(rels, 'Relationship')) {
      if (r.attrs['Id'] && r.attrs['Target'] && r.attrs['TargetMode'] !== 'External') {
        relMap.set(r.attrs['Id'], r.attrs['Target']);
      }
    }
  }
  const body = child(doc, 'w:body');
  if (!body) throw importError("Hujjat bo'sh");

  const warnings: string[] = [];
  const imageCache = new Map<string, string | null>();
  let imageCount = 0;

  const imageOf = async (rid: string, label: string, warn: string[]): Promise<string | null> => {
    if (imageCache.has(rid)) return imageCache.get(rid)!;
    let id: string | null = null;
    if (imageCount >= DOCX_LIMITS.maxImages) {
      warn.push(
        `${label}: rasmlar soni ${DOCX_LIMITS.maxImages} dan oshdi, rasm o'tkazib yuborildi`,
      );
    } else {
      imageCount++;
      const target = relMap.get(rid);
      let path = target ? (target.startsWith('/') ? target.slice(1) : `word/${target}`) : '';
      path = path.replace(/\/\.\//g, '/');
      const buf = path.startsWith('word/media/')
        ? await readEntry(g, path, DOCX_LIMITS.maxImageBytes)
        : null;
      if (!buf) warn.push(`${label}: rasm fayli topilmadi, qo'lda qo'shing`);
      else {
        try {
          id = await env.saveImage(buf);
        } catch {
          warn.push(`${label}: rasm qo'llanmaydi (faqat JPG, PNG, WebP), qo'lda qo'shing`);
        }
      }
    }
    imageCache.set(rid, id);
    return id;
  };

  const toBlocks = async (parts: Part[], label: string, warn: string[]): Promise<Block[]> => {
    const blocks: Block[] = [];
    for (const p of parts) {
      if (p.k === 'text') {
        const t = p.t.replace(/\s+/g, ' ').trim();
        if (t) blocks.push({ type: 'text', text: t.slice(0, 5000) });
      } else if (p.k === 'math') {
        if (p.tex) blocks.push({ type: 'math', tex: p.tex });
        else {
          blocks.push({ type: 'text', text: '[formula]' });
          warn.push(
            `${label}: formulani LaTeX ga o'tkazib bo'lmadi, "[formula]" qo'yildi, qo'lda tuzating`,
          );
        }
      } else {
        const id = await imageOf(p.rid, label, warn);
        if (id) blocks.push({ type: 'image', assetId: id });
      }
    }
    return blocks;
  };

  const items: RawItem[] = [];
  let cur: Draft | null = null;
  let inAnswers = false;
  const answerPairs: [number, string][] = [];
  const ignoredTables = { n: 0 };

  const flatten = (n: XNode): XNode[] => {
    const out: XNode[] = [];
    for (const c of elems(n)) {
      if (c.name === 'w:p' || c.name === 'w:tbl') out.push(c);
      else if (c.name === 'w:sdt' || c.name === 'w:sdtContent' || c.name === 'w:customXml')
        out.push(...flatten(c));
    }
    return out;
  };

  for (const el of flatten(body)) {
    if (Date.now() > env.deadline) throw importError('Import vaqti tugadi (fayl juda murakkab)');
    if (el.name === 'w:tbl') {
      // Javoblar jadvali: qatorlar (raqam, javob) juftliklari
      let got = 0;
      for (const tr of childrenNamed(el, 'w:tr')) {
        const cells = childrenNamed(tr, 'w:tc').map((tc) => textOf(tc).replace(/\s+/g, ' ').trim());
        if (cells.length >= 2 && cells.length % 2 === 0) {
          for (let i = 0; i + 1 < cells.length; i += 2) {
            if (/^\d{1,4}$/.test(cells[i]!) && cells[i + 1]) {
              answerPairs.push([Number(cells[i]), cells[i + 1]!]);
              got++;
            }
          }
        }
      }
      if (!got) ignoredTables.n++;
      continue;
    }
    const parts = paraParts(el);
    const plain = parts
      .filter((p): p is { k: 'text'; t: string } => p.k === 'text')
      .map((p) => p.t)
      .join('')
      .trim();
    const nonText = parts.some((p) => p.k !== 'text');
    if (!plain && !nonText) continue;

    if (inAnswers) {
      answerPairs.push(...parseAnswerPairs(plain));
      continue;
    }
    const first = parts[0];
    const firstText = first?.k === 'text' ? first.t : '';

    const am = ANSWERS_RE.exec(plain);
    if (am && !QUESTION_RE.test(plain)) {
      inAnswers = true;
      if (am[2]) answerPairs.push(...parseAnswerPairs(am[2]));
      continue;
    }

    const qm = firstText ? QUESTION_RE.exec(firstText) : null;
    if (qm) {
      if (items.length >= MAX_IMPORT_QUESTIONS)
        throw importError(`Savollar soni ${MAX_IMPORT_QUESTIONS} tadan oshmasligi kerak`);
      const raw = newRaw(Number(qm[1]));
      items.push(raw);
      cur = { raw, starred: false, target: 'content' };
      const rest: Part[] = [{ k: 'text', t: qm[2]! }, ...parts.slice(1)];
      raw.content.push(...(await toBlocks(rest, `${raw.row}-savol`, raw.warnings)));
      continue;
    }
    if (!cur) continue; // savollardan oldingi tushuntirish matni

    const mm = firstText && parts.length === 1 ? META_RE.exec(firstText) : null;
    if (mm) {
      const key = mm[1]!.toLowerCase();
      const val = mm[2]!.trim();
      const r = cur.raw;
      if (key === 'mavzu') r.topic = val.slice(0, 200) || null;
      else if (key === 'fan') r.subjectName = val || null;
      else if (key === 'tur') r.type = val;
      else if (key === 'qiyinlik') {
        const n = Number(val.replace(',', '.'));
        if (Number.isFinite(n)) r.difficulty = n;
        else r.errors.push(`Qiyinlik raqam bo'lishi kerak: "${val}"`);
      } else if (key === 'ball') {
        const n = Number(val.replace(',', '.'));
        if (Number.isFinite(n)) r.points = n;
        else r.errors.push(`Ball raqam bo'lishi kerak: "${val}"`);
      } else if (key.startsWith('qisman')) r.partialCredit = /^(ha|yes|true|1|da|\+)$/i.test(val);
      else if (key === 'javob') {
        r.accepted = val
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      continue;
    }

    const om = firstText ? OPTION_RE.exec(firstText) : null;
    if (
      om &&
      letterId(om[2]!) === String.fromCharCode(97 + cur.raw.options.length) &&
      cur.raw.options.length < 10
    ) {
      const opt: RawOption = { id: letterId(om[2]!), content: [] };
      cur.raw.options.push(opt);
      if (om[1]) cur.raw.correctIds.push(opt.id);
      cur.target = opt;
      const rest: Part[] = [{ k: 'text', t: om[3]! }, ...parts.slice(1)];
      opt.content.push(...(await toBlocks(rest, `${cur.raw.row}-savol`, cur.raw.warnings)));
      continue;
    }
    if (om && cur.raw.options.length >= 10) {
      cur.raw.warnings.push(`${cur.raw.row}-savol: 10 tadan ortiq variant e'tiborsiz qoldirildi`);
      continue;
    }

    // Davomi: savol yoki oxirgi variant matni
    const blocks = await toBlocks(parts, `${cur.raw.row}-savol`, cur.raw.warnings);
    if (cur.target === 'content') cur.raw.content.push(...blocks);
    else cur.target.content.push(...blocks);
  }

  // Javoblar jadvali/ro'yxatini qo'llash (yulduzcha bo'lmagan savollarga)
  const byNumber = new Map<number, RawItem>();
  for (const it of items) if (!byNumber.has(it.row)) byNumber.set(it.row, it);
  for (const [num, value] of answerPairs) {
    const it = byNumber.get(num);
    if (!it) {
      warnings.push(`Javoblar ro'yxatida ${num}-savol yo'q`);
      continue;
    }
    if (it.options.length) {
      if (LETTERS_ONLY.test(value)) {
        if (it.correctIds.length) {
          it.warnings.push(
            `${num}-savol: yulduzcha va javoblar ro'yxati ikkalasi bor, yulduzcha ishlatildi`,
          );
        } else {
          it.correctIds = [
            ...new Set(
              value
                .replace(/[^A-Za-z]/g, '')
                .split('')
                .map(letterId),
            ),
          ];
        }
      } else it.errors.push(`Javoblar ro'yxatidagi qiymat harf emas: "${value}"`);
    } else if (!it.accepted.length) {
      it.accepted = value
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (ignoredTables.n)
    warnings.push(`${ignoredTables.n} ta jadval javoblar jadvali emas, e'tiborsiz qoldirildi`);
  if (!items.length)
    throw importError("Hujjatda savollar topilmadi (savollar '1.' kabi raqamlanishi kerak)");

  // Tekshiruv: to'g'ri javob ko'rsatilmaganlar finalizeRaw/zod da xato bo'ladi
  for (const it of items) {
    if (it.options.length) {
      const ids = new Set(it.options.map((o) => o.id));
      const bad = it.correctIds.filter((c) => !ids.has(c));
      if (bad.length)
        it.errors.push(
          `To'g'ri javob variantlari orasida yo'q: ${bad.map((b) => b.toUpperCase()).join(', ')}`,
        );
    }
  }
  return { items, warnings };
}
