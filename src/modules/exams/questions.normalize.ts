// Qisqa javobni solishtirish uchun normallashtirish (E1 da kalitni saqlash, E6 da tekshirish uchun).
// Qoidalar: katta-kichik harf va ortiqcha probellar e'tiborga olinmaydi; sonlarda 12,5 == 12.5 == 12.50.

// Apostrof variantlarini bittaga keltiradi (utils/text.ts dagi bilan bir xil to'plam)
const APOS = /[’ʻʼ‘`´]/g;

const NUM = /^[+-]?\d+(?:[.,]\d+)?$/;
// Ming ajratuvchi probel: "1 000", "12 500,5"
const NUM_GROUPED = /^[+-]?\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/;

/** "+012,50" -> "12.5"; qiymat son bo'lmasa null. Float ishlatilmaydi (aniqlik yo'qolmaydi) */
function canonicalNumber(s: string): string | null {
  const compact = NUM_GROUPED.test(s) ? s.replace(/ /g, '') : s;
  if (!NUM.test(compact)) return null;
  let sign = compact.startsWith('-') ? '-' : '';
  const body = compact.replace(/^[+-]/, '').replace(',', '.');
  const [intRaw, fracRaw = ''] = body.split('.');
  const int = intRaw.replace(/^0+(?=\d)/, '');
  const frac = fracRaw.replace(/0+$/, '');
  if (int === '0' && !frac) sign = ''; // -0 == 0
  return `${sign}${int}${frac ? '.' + frac : ''}`;
}

/** Qisqa javobni solishtirish kalitiga aylantiradi */
export function normalizeShortAnswer(input: string): string {
  const s = input.normalize('NFC').replace(APOS, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  return canonicalNumber(s) ?? s;
}

/** Berilgan javob qabul qilinadigan javoblardan biriga mos keladimi */
export function isShortAnswerCorrect(accepted: readonly string[], given: string): boolean {
  const g = normalizeShortAnswer(given);
  if (!g) return false;
  return accepted.some((a) => normalizeShortAnswer(a) === g);
}
