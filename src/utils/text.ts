// Apostrof variantlarini bittaga keltiradi
const APOS = /[’ʻʼ‘`´]/g;

/** Bo'sh joylarni siqadi, boshqaruv belgilarini olib tashlaydi */
export const cleanText = (s: string): string =>
  s
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Dublikat aniqlash uchun ism kaliti */
export const nameKeyOf = (s: string): string => cleanText(s).replace(APOS, "'").toLowerCase();

/** Sinf nomini solishtirish uchun kalit: "7-A", "7 a", "7A" bir xil */
export const classKeyOf = (s: string): string =>
  cleanText(s)
    .replace(APOS, "'")
    .toLowerCase()
    .replace(/[\s\-_.]/g, '');

/** Sarlavhani solishtirish uchun kalit */
export const headerKeyOf = (s: string): string =>
  cleanText(s)
    .replace(APOS, '')
    .replace(/'/g, '')
    .toLowerCase()
    .replace(/[\s\-_.]/g, '');
