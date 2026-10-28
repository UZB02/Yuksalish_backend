import { cleanText, nameKeyOf } from '../../utils/text';

/**
 * O'qituvchilarni Excel'dan import qilishning sof (DB'siz) qoidalari:
 * telefon normalizatsiyasi, login va parol generatsiyasi, takrorlarni ajratish.
 */

export const MAX_LOGIN_LEN = 32;
const BASE_MAX = 20;
const SURNAME_PART_MAX = 8;
const MAX_NUMERIC = 60;

/** Telefon: 9 xonali mahalliy -> `+998 XX XXX XX XX`; xalqaro `+` raqamlar saqlanadi */
export function normalizePhone(raw: string): { value: string | null; error?: string } {
  const text = raw.trim();
  if (!text) return { value: null };
  const digits = text.replace(/\D/g, '');
  const bad = { value: null, error: `Telefon raqami noto'g'ri: ${text}` };
  let local: string;
  if (digits.length === 9) local = digits;
  else if (digits.length === 10 && digits.startsWith('0')) local = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('998')) local = digits.slice(3);
  else if (text.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return { value: `+${digits}` };
  } else return bad;
  if (!/^\d{9}$/.test(local)) return bad;
  const m = /^(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(local) as RegExpExecArray;
  return { value: `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` };
}

/** Apostrof variantlarini olib tashlab, faqat [a-z0-9] qoldiradi */
export function slugWord(word: string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’‘ʻʼ`´]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface NameParts {
  /** Ism (F.I.Sh.dagi 2-so'z; bitta so'z bo'lsa o'sha so'z) */
  given: string;
  /** Familiya (1-so'z) */
  surname: string;
  singleWord: boolean;
}

export function splitName(fullName: string): NameParts {
  const words = cleanText(fullName).split(' ').filter(Boolean);
  if (words.length < 2) {
    return { given: words[0] ?? '', surname: words[0] ?? '', singleWord: true };
  }
  return { given: words[1], surname: words[0], singleWord: false };
}

/** Ismdan bazaviy login; yaroqsiz bo'lsa null (3 belgidan kam) */
export function baseLoginOf(fullName: string): string | null {
  const base = slugWord(splitName(fullName).given).slice(0, BASE_MAX);
  return base.length >= 3 ? base : null;
}

/** Login nomzodi: 0 = bazaviy, 1..L = `.familiya[:k]`, undan keyin raqamli qo'shimcha */
export function loginCandidate(base: string, surnameSlug: string, stage: number): string {
  if (stage === 0) return base;
  const s = (surnameSlug || 'x').slice(0, SURNAME_PART_MAX);
  if (stage <= s.length) return `${base}.${s.slice(0, stage)}`;
  return `${base}.${s}${stage - s.length + 1}`;
}

/** Bo'sh parol: login (nuqtasiz) + 12345 */
export const defaultPasswordFor = (login: string): string => `${login.replace(/\./g, '')}12345`;

export const personKey = (fullName: string): string => nameKeyOf(fullName);

export interface GenInput {
  /** Qator indeksi (chaqiruvchi o'zi belgilaydi) */
  idx: number;
  base: string;
  surnameSlug: string;
}

export interface GenContext {
  /** Allaqachon band logins (fayldagi kiritilgan loginlar) */
  used: Set<string>;
  /** login band bo'lsa: shu login bazadagi o'sha odamniki ('same') yoki boshqaniki ('other'); bo'sh = erkin */
  dbState: (login: string) => 'free' | 'same' | 'other';
}

export interface GenResult {
  login: string;
  stage: number;
  /** Fayl ichida ism takrorlangani uchun bosh harf qo'shildi */
  dupInFile: boolean;
  /** Bazadagi boshqa foydalanuvchi bilan to'qnashuv sabab o'zgardi */
  dbCollision: boolean;
  /** Bazada shu odam allaqachon shu loginda mavjud */
  existing: boolean;
}

/**
 * Generatsiya qilinadigan loginlarni taqsimlaydi.
 * Bir xil bazaviy loginli BARCHA qatorlar `.<familiya bosh harfi>` oladi; baribir to'qnashsa
 * to'qnashganlarning barchasi keyingi bosqichga (ko'proq harf, oxirida raqam) o'tadi.
 */
export function assignGeneratedLogins(
  inputs: GenInput[],
  ctx: GenContext,
): Map<number, GenResult | null> {
  const out = new Map<number, GenResult | null>();
  const baseCount = new Map<string, number>();
  for (const i of inputs) baseCount.set(i.base, (baseCount.get(i.base) ?? 0) + 1);

  const state = inputs.map((i) => ({
    ...i,
    start: (baseCount.get(i.base) ?? 0) > 1 ? 1 : 0,
    dupInFile: (baseCount.get(i.base) ?? 0) > 1,
    dbCollision: false,
    done: false,
  }));
  const used = new Set(ctx.used);

  const maxStage = SURNAME_PART_MAX + MAX_NUMERIC;
  for (let stage = 0; stage <= maxStage; stage++) {
    const active = state.filter((s) => !s.done && s.start <= stage);
    if (!active.length) continue;
    const groups = new Map<string, typeof active>();
    for (const s of active) {
      const c = loginCandidate(s.base, s.surnameSlug, stage);
      groups.set(c, [...(groups.get(c) ?? []), s]);
    }
    for (const [cand, members] of groups) {
      // Familiya harflari tugagan (bir xil familiya): birinchi qator oladi, qolganlari raqamga o'tadi
      const exhausted = members.every(
        (m) => stage > Math.min(m.surnameSlug.length || 1, SURNAME_PART_MAX),
      );
      if ((members.length > 1 && !exhausted) || cand.length > MAX_LOGIN_LEN || used.has(cand)) {
        continue;
      }
      const st = ctx.dbState(cand);
      const s = members[0];
      if (st === 'other') {
        s.dbCollision = true;
        continue;
      }
      used.add(cand);
      s.done = true;
      out.set(s.idx, {
        login: cand,
        stage,
        dupInFile: s.dupInFile,
        dbCollision: s.dbCollision,
        existing: st === 'same',
      });
    }
  }
  for (const s of state) if (!s.done) out.set(s.idx, null);
  return out;
}
