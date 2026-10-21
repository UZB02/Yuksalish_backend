import { describe, expect, it } from 'vitest';
import {
  categoryLabel,
  fmtDate,
  fmtDateShort,
  fmtDateTime,
  fmtPeriod,
  kindLabel,
  roleLabel,
  studentStatusLabel,
  toExcelDate,
} from '../src/modules/reports/reports.labels';
import { createDoc, planColumns } from '../src/modules/reports/reports.pdf';
import type { Column, Table } from '../src/modules/reports/reports.layout';

describe('reports.labels', () => {
  it("xulq turi va davomat kategoriyalari o'zbekcha", () => {
    expect(kindLabel('positive')).toBe('Ijobiy');
    expect(kindLabel('negative')).toBe('Salbiy');
    expect(kindLabel('neutral')).toBe('Neytral');
    expect(categoryLabel('present')).toBe('Keldi');
    expect(categoryLabel('late')).toBe('Kechikdi');
    expect(categoryLabel('absent_excused')).toBe("Sababli yo'q");
    expect(categoryLabel('absent_unexcused')).toBe("Sababsiz yo'q");
    expect(studentStatusLabel('active')).toBe('Faol');
    expect(roleLabel('teacher')).toBe("O'qituvchi");
  });

  it("noma'lum qiymat o'zgarishsiz, bo'sh qiymat bo'sh qator", () => {
    expect(categoryLabel('custom_status')).toBe('custom_status');
    expect(kindLabel(null)).toBe('');
    expect(kindLabel(undefined)).toBe('');
  });

  it('sana formatlari: DD.MM.YYYY, grafik uchun DD.MM, davr, Toshkent vaqti', () => {
    expect(fmtDate('2026-10-05')).toBe('05.10.2026');
    expect(fmtDateShort('2026-10-06')).toBe('06.10');
    expect(fmtPeriod({ from: '2026-10-05', to: '2026-10-18' })).toBe('05.10.2026 — 18.10.2026');
    expect(fmtDateTime('2026-10-14T07:00:00.000Z')).toBe('14.10.2026 12:00');
    expect(fmtDateTime(null)).toBe('');
  });

  it('Excel sana qiymati: UTC yarim tun yoki null', () => {
    expect(toExcelDate('2026-10-05')?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(toExcelDate('05.10.2026')).toBeNull();
    expect(toExcelDate(5)).toBeNull();
  });
});

const num = (header: string, key: string, short?: string): Column => ({
  header,
  key,
  width: 8,
  type: 'int',
  align: 'right',
  short,
});

// Sinf hisobotidagi kabi keng jadval (portrait emas, landscape kengligi)
const wideTable = (): Table => ({
  title: 'Test',
  columns: [
    { header: 'F.I.Sh.', key: 'fullName', width: 30 },
    { header: 'ID', key: 'code', width: 10 },
    num("O'rin", 'a'),
    num("O'rtacha", 'b'),
    num('Maks', 'c'),
    num('Kunlar', 'd'),
    num('Baholar', 'e'),
    num('Kechikdi', 'f', 'Kech.'),
    num('Sababli', 'g', 'Sab.'),
    num('Sababsiz', 'h', 'Sabs.'),
    num('Davomat, %', 'i', 'Dav. %'),
    { header: 'Ko‘p uchragan xulq', key: 'j', width: 22, short: 'Xulq' },
  ],
  rows: [
    {
      fullName: "Oʻrinboyev G'ani Toʻraqul oʻgʻli",
      code: 'A-1',
      a: 1,
      b: 77.78,
      c: 100,
      d: 12,
      e: 30,
      f: 1,
      g: 0,
      h: 2,
      i: 66.67,
      j: 'Namunali xulq',
    },
  ],
});

describe('planColumns', () => {
  it("sarlavha so'zi ustun kengligidan keng emas (harf o'rtasida bo'linmaydi)", () => {
    const doc = createDoc({ size: 'A4', layout: 'landscape' });
    for (const width of [770, 560, 500]) {
      const table = wideTable();
      const plan = planColumns(doc, table, width);
      expect(plan.widths.reduce((s, x) => s + x, 0)).toBeCloseTo(width, 1);
      doc.font('BodyBold').fontSize(plan.headerSize);
      plan.headers.forEach((h, i) => {
        for (const word of h.split(/\s+/)) {
          expect(doc.widthOfString(word), `${h} @${width}`).toBeLessThanOrEqual(plan.widths[i]);
        }
      });
    }
    doc.end();
  });

  it('keng joyda to‘liq sarlavhalar saqlanadi, tor joyda qisqartma ishlatiladi', () => {
    const doc = createDoc({ size: 'A4', layout: 'landscape' });
    const wide = planColumns(doc, wideTable(), 770);
    expect(wide.usedShort).toBe(false);
    expect(wide.headers).toContain('Kechikdi');
    const narrow = planColumns(doc, wideTable(), 470);
    expect(narrow.usedShort).toBe(true);
    expect(narrow.headers).toContain('Kech.');
    doc.end();
  });
});
