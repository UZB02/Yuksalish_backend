import { describe, expect, it } from 'vitest';
import { computeCoverage } from '../src/modules/reports/types/teachers.report';

// 2026-10-05 dushanba ... 2026-10-11 yakshanba
const base = {
  from: '2026-10-05',
  to: '2026-10-11',
  workingWeekdays: [1, 2, 3, 4, 5, 6],
  classIds: ['A', 'B'],
};

describe('computeCoverage', () => {
  it('kutilgan = ish kunlari x sinflar; oddiy holat', () => {
    const r = computeCoverage({
      ...base,
      scored: [
        { classId: 'A', date: '2026-10-05' },
        { classId: 'B', date: '2026-10-05' },
      ],
    });
    expect(r).toEqual({ expectedClassDays: 12, scoredClassDays: 2, rate: 16.67 });
  });

  it('dam olish kuniga qo`yilgan baho qamrovga kirmaydi', () => {
    const r = computeCoverage({ ...base, scored: [{ classId: 'A', date: '2026-10-11' }] });
    expect(r.scoredClassDays).toBe(0);
  });

  it('kunda ikki marta baho bir marta sanaladi', () => {
    const r = computeCoverage({
      ...base,
      scored: [
        { classId: 'A', date: '2026-10-06' },
        { classId: 'A', date: '2026-10-06' },
      ],
    });
    expect(r.scoredClassDays).toBe(1);
  });

  it('boshqa (biriktirilmagan) sinf bahosi kirmaydi', () => {
    const r = computeCoverage({ ...base, scored: [{ classId: 'Z', date: '2026-10-06' }] });
    expect(r.scoredClassDays).toBe(0);
  });

  it('davr chegaralari: tashqaridagi kunlar kirmaydi, chegara kunlari kiradi', () => {
    const r = computeCoverage({
      ...base,
      scored: [
        { classId: 'A', date: '2026-10-04' },
        { classId: 'A', date: '2026-10-05' },
        { classId: 'A', date: '2026-10-10' },
        { classId: 'A', date: '2026-10-12' },
      ],
    });
    expect(r.scoredClassDays).toBe(2);
  });

  it('rate hech qachon 100 dan oshmaydi', () => {
    const scored = [];
    for (let d = 5; d <= 11; d++)
      for (const c of ['A', 'B'])
        scored.push({ classId: c, date: `2026-10-${String(d).padStart(2, '0')}` });
    const r = computeCoverage({ ...base, scored });
    expect(r).toEqual({ expectedClassDays: 12, scoredClassDays: 12, rate: 100 });
  });

  it('sinf yoki ish kuni yo`q bo`lsa rate null', () => {
    expect(computeCoverage({ ...base, classIds: [], scored: [] }).rate).toBeNull();
    expect(computeCoverage({ ...base, workingWeekdays: [], scored: [] }).rate).toBeNull();
  });
});
