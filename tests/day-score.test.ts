import { describe, expect, it } from 'vitest';
import { addDaysStr, tashkentDate } from '../src/utils/clock';
import { dailyScore, round2 } from '../src/utils/dayScore';

const at = (value: number, ms: number) => ({ value, createdAt: new Date(ms) });

describe('dailyScore (kunlik ball agregatsiyasi)', () => {
  it("baho bo'lmasa null", () => {
    for (const mode of ['average', 'min', 'last'] as const) expect(dailyScore([], mode)).toBeNull();
  });

  it("average: o'rtacha, 2 xonagacha yaxlitlanadi", () => {
    expect(dailyScore([at(80, 1)], 'average')).toBe(80);
    expect(dailyScore([at(80, 1), at(90, 2)], 'average')).toBe(85);
    expect(dailyScore([at(80, 1), at(81, 2), at(81, 3)], 'average')).toBe(80.67);
    expect(dailyScore([at(100, 1), at(99, 2), at(99, 3)], 'average')).toBe(99.33);
  });

  it('min: eng past', () => {
    expect(dailyScore([at(80, 1), at(55, 2), at(90, 3)], 'min')).toBe(55);
  });

  it("last: createdAt bo'yicha oxirgisi (massiv tartibiga bog'liq emas)", () => {
    expect(dailyScore([at(70, 30), at(90, 10), at(60, 20)], 'last')).toBe(70);
    expect(dailyScore([at(60, 20), at(70, 30), at(90, 10)], 'last')).toBe(70);
  });

  it('round2', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.345)).toBe(2.35);
    expect(round2(7)).toBe(7);
  });
});

describe('Asia/Tashkent kun hisobi', () => {
  it('UTC+5: UTC 19:00 dan keyin Toshkentda keyingi kun', () => {
    expect(tashkentDate(new Date('2026-10-14T18:59:00Z'))).toBe('2026-10-14');
    expect(tashkentDate(new Date('2026-10-14T19:00:00Z'))).toBe('2026-10-15');
    expect(tashkentDate(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });

  it('addDaysStr', () => {
    expect(addDaysStr('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysStr('2026-12-30', 3)).toBe('2027-01-02');
  });
});
