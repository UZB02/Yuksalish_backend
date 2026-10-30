/**
 * PDF/Excel sarlavhasidagi logo yordamchilari. Logo `processLogo` ning `doc` varianti (PNG),
 * shuning uchun o'lchamni PNG IHDR dan o'qiymiz (qo'shimcha dekodlash kerak emas).
 */
export interface LogoBox {
  buffer: Buffer;
  width: number;
  height: number;
}

/** PNG ni berilgan balandlikka (nuqta/piksel) moslab, o'lchamini hisoblaydi; yaroqsiz bo'lsa null */
export function fitLogo(
  buf: Buffer | null | undefined,
  maxH: number,
  maxW = maxH * 3,
): LogoBox | null {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h) return null;
  const k = Math.min(maxH / h, maxW / w);
  return {
    buffer: buf,
    width: Math.round(w * k * 100) / 100,
    height: Math.round(h * k * 100) / 100,
  };
}

/**
 * Varaqning yuqori-chap burchagiga logo qo'yadi (balandligi `heightPx` pikselgacha) va matnni
 * o'ngga surish uchun kerak bo'lgan alignment.indent qiymatini qaytaradi (logo yo'q bo'lsa 0).
 */
export function placeExcelLogo(
  wb: import('exceljs').Workbook,
  ws: import('exceljs').Worksheet,
  buf: Buffer | null | undefined,
  heightPx: number,
): number {
  const box = fitLogo(buf, heightPx, heightPx * 3);
  if (!box) return 0;
  const id = wb.addImage({ buffer: box.buffer as never, extension: 'png' });
  ws.addImage(id, {
    tl: { col: 0.05, row: 0.1 },
    ext: { width: box.width, height: box.height },
    editAs: 'oneCell',
  });
  return Math.min(15, Math.ceil((box.width + 12) / 10));
}
