import { createDoc } from '../../reports/reports.pdf';

export interface PinCard {
  fullName: string;
  className: string;
  pin: string | null;
  /** Shaxsiy kirish kodi (XXX-XXX-XXX); eski ishtirokchida yo'q: kod+PIN ko'rinishi chop etiladi */
  code?: string | null;
}
export interface PinSheetInput {
  schoolName: string;
  title: string;
  code: string;
  /** Imtihon sahifasi manzili (EXAM_PUBLIC_URL), bo'lsa chop etiladi */
  examUrl?: string | null;
  start: Date;
  durationMin: number;
  list: PinCard[];
}

const FONT = 'Body';
const FONT_BOLD = 'BodyBold';
const COLS = 2;
const ROWS = 5;
const MARGIN = 28;

/** Toshkent vaqti (UTC+5) bo'yicha "DD.MM.YYYY HH:mm" */
export function fmtTashkent(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/** Kesib olinadigan PIN kartochkalari: A4 da 2x5, punktir chiziq bilan */
export function renderPinSheet(input: PinSheetInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = createDoc({ size: 'A4', margin: MARGIN, info: { Title: `PIN: ${input.title}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - MARGIN * 2;
    const H = doc.page.height - MARGIN * 2;
    const cw = W / COLS;
    const ch = H / ROWS;
    const perPage = COLS * ROWS;
    const fit = (text: string, w: number, font: string, size: number) => {
      doc.font(font).fontSize(size);
      let s = text;
      while (s.length > 1 && doc.widthOfString(s) > w) s = s.slice(0, -1);
      return s === text ? s : `${s.slice(0, -1)}…`;
    };
    const when = `${fmtTashkent(input.start)}, ${input.durationMin} daqiqa`;

    input.list.forEach((c, i) => {
      if (i > 0 && i % perPage === 0) doc.addPage();
      const idx = i % perPage;
      const x = MARGIN + (idx % COLS) * cw;
      const y = MARGIN + Math.floor(idx / COLS) * ch;
      const pad = 10;
      const iw = cw - pad * 2;
      doc
        .save()
        .dash(3, { space: 3 })
        .lineWidth(0.6)
        .strokeColor('#888')
        .rect(x, y, cw, ch)
        .stroke()
        .undash()
        .restore();
      doc.fillColor('#000');
      doc
        .font(FONT_BOLD)
        .fontSize(9)
        .text(fit(input.schoolName, iw, FONT_BOLD, 9), x + pad, y + 8, { lineBreak: false });
      doc
        .font(FONT)
        .fontSize(9)
        .text(fit(input.title, iw, FONT, 9), x + pad, y + 22, { lineBreak: false });
      doc
        .fontSize(8)
        .fillColor('#444')
        .text(fit(when, iw, FONT, 8), x + pad, y + 35, { lineBreak: false });
      doc
        .fillColor('#000')
        .font(FONT_BOLD)
        .fontSize(11)
        .text(fit(c.fullName, iw, FONT_BOLD, 11), x + pad, y + 54, { lineBreak: false });
      doc
        .font(FONT)
        .fontSize(9)
        .text(fit(c.className, iw, FONT, 9), x + pad, y + 70, { lineBreak: false });
      if (c.code) {
        // Yagona shaxsiy kod: katta, qolgani kichik eslatma
        doc
          .fontSize(8)
          .fillColor('#444')
          .text('Shaxsiy kirish kodi', x + pad, y + 90, { lineBreak: false });
        doc
          .fillColor('#000')
          .font(FONT_BOLD)
          .fontSize(24)
          .text(c.code, x + pad, y + 102, { lineBreak: false });
        doc
          .font(FONT)
          .fontSize(7.5)
          .fillColor('#444')
          .text(
            fit(
              input.examUrl ? `Sahifa: ${input.examUrl}` : 'Imtihon sahifasiga kiring',
              iw,
              FONT,
              7.5,
            ),
            x + pad,
            y + 134,
            { lineBreak: false },
          );
        doc.text(fit('Kodni hech kimga bermang', iw, FONT, 7.5), x + pad, y + 145, {
          lineBreak: false,
        });
      } else {
        doc
          .fontSize(8)
          .fillColor('#444')
          .text('Imtihon kodi', x + pad, y + 92, { lineBreak: false });
        doc.text('PIN', x + pad + iw / 2, y + 92, { lineBreak: false });
        doc
          .fillColor('#000')
          .font(FONT_BOLD)
          .fontSize(18)
          .text(input.code, x + pad, y + 104, { lineBreak: false });
        doc.text(c.pin ?? '(qayta yarating)', x + pad + iw / 2, y + 104, { lineBreak: false });
      }
    });
    if (!input.list.length) doc.font(FONT).fontSize(12).text("Ishtirokchilar yo'q", MARGIN, MARGIN);
    doc.end();
  });
}
