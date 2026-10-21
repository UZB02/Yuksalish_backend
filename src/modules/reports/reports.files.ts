const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

export type ExportFormat = keyof typeof CONTENT_TYPES;
export const contentTypeOf = (f: ExportFormat) => CONTENT_TYPES[f];

/** Xavfsiz fayl nomi: harf/raqam/._- dan boshqa belgilar '-' ga almashtiriladi */
export function safeFileName(base: string, from: string, to: string, ext: ExportFormat): string {
  const clean = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${clean || 'hisobot'}_${from}_${to}.${ext}`;
}

/** RFC 6266: ASCII zaxira nomi + filename*=UTF-8'' */
export function contentDisposition(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
