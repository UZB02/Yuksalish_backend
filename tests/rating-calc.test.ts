import { describe, expect, it } from 'vitest';
import { Debouncer, type Timers } from '../src/modules/ratings/debouncer';
import {
  buildClassRows,
  buildSchoolRow,
  buildStudentRows,
  rankChange,
  rankClasses,
  rankSchools,
  rankStudents,
  scoreOf,
  type StudentAgg,
  type StudentInfo,
} from '../src/modules/ratings/rating.calc';
import { resolvePeriod, type ActiveYearInfo } from '../src/modules/ratings/rating.period';
import { normalizeRating, ratingValuesSchema } from '../src/modules/settings/rating.settings';

const year: ActiveYearInfo = {
  id: 'y1',
  name: '2026-2027',
  startDate: '2026-09-01',
  endDate: '2027-05-31',
  periods: [
    { id: 'p2', name: '2-chorak', startDate: '2026-11-03', endDate: '2026-12-30' },
    { id: 'p1', name: '1-chorak', startDate: '2026-09-01', endDate: '2026-10-31' },
  ],
};
const base = { periodType: 'month' as const, customFrom: null, customTo: null };

describe('resolvePeriod', () => {
  it('week: joriy dushanba-yakshanba (chegaralar ham)', () => {
    const w = (d: string) => resolvePeriod({ ...base, periodType: 'week' }, null, d);
    expect(w('2026-10-14')).toMatchObject({
      type: 'week',
      from: '2026-10-12',
      to: '2026-10-18',
      key: 'week:2026-10-12',
      label: '12–18-oktyabr',
    });
    expect(w('2026-10-12')).toMatchObject({ from: '2026-10-12', to: '2026-10-18' }); // dushanba
    expect(w('2026-10-18')).toMatchObject({ from: '2026-10-12', to: '2026-10-18' }); // yakshanba
    expect(w('2026-10-19')).toMatchObject({ from: '2026-10-19', to: '2026-10-25' });
    const cross = w('2026-10-01'); // payshanba, oy chegarasi
    expect(cross).toMatchObject({
      from: '2026-09-28',
      to: '2026-10-04',
      label: '28-sentyabr – 4-oktyabr',
    });
    expect(w('2026-12-31')).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('month: kalendar oy (kabisa yil, yil oxiri)', () => {
    const m = (d: string) => resolvePeriod(base, null, d);
    expect(m('2026-10-14')).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      key: 'month:2026-10',
      label: '2026-yil oktyabr',
    });
    expect(m('2028-02-10')).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(m('2027-02-28').to).toBe('2027-02-28');
    expect(m('2026-12-31')).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
      label: '2026-yil dekabr',
    });
  });

  it("quarter: bugun tushadigan chorak; tanaffusda eng oxirgi tugagan; bo'lmasa yil; yil yo'q -> month fallback", () => {
    const q = (d: string, y: ActiveYearInfo | null = year) =>
      resolvePeriod({ ...base, periodType: 'quarter' }, y, d);
    expect(q('2026-10-14')).toMatchObject({
      type: 'quarter',
      from: '2026-09-01',
      to: '2026-10-31',
      label: '2026-2027, 1-chorak',
    });
    expect(q('2026-10-31').from).toBe('2026-09-01'); // chegara
    expect(q('2026-11-03').label).toBe('2026-2027, 2-chorak');
    expect(q('2026-11-01')).toMatchObject({ from: '2026-09-01', label: '2026-2027, 1-chorak' }); // tanaffus
    expect(q('2027-03-01')).toMatchObject({ from: '2026-11-03', to: '2026-12-30' }); // oxirgi tugagan
    expect(q('2026-08-20', { ...year, periods: [] })).toMatchObject({
      from: '2026-09-01',
      to: '2027-05-31',
      label: '2026-2027',
    });
    expect(q('2026-08-20')).toMatchObject({ type: 'quarter', label: '2026-2027' }); // hali boshlanmagan: yilning o'zi
    const fb = q('2026-10-14', null);
    expect(fb).toMatchObject({ type: 'month', fallback: true, key: 'month:2026-10' });
  });

  it('academic_year va custom', () => {
    expect(
      resolvePeriod({ ...base, periodType: 'academic_year' }, year, '2026-10-14'),
    ).toMatchObject({
      type: 'academic_year',
      from: '2026-09-01',
      to: '2027-05-31',
      label: '2026-2027',
    });
    expect(
      resolvePeriod({ ...base, periodType: 'academic_year' }, null, '2026-10-14'),
    ).toMatchObject({ type: 'month', fallback: true });
    expect(
      resolvePeriod(
        { periodType: 'custom', customFrom: '2026-10-01', customTo: '2026-10-10' },
        year,
        '2026-10-14',
      ),
    ).toMatchObject({
      type: 'custom',
      from: '2026-10-01',
      to: '2026-10-10',
      key: 'custom:2026-10-01:2026-10-10',
    });
  });
});

const st = (id: string, name: string, classId = 'c1'): StudentInfo => ({
  id,
  fullName: name,
  classId,
});
const agg = (days: number, scores: number, sum: number): StudentAgg => ({
  daysCount: days,
  scoresCount: scores,
  sumDays: sum,
});
const opts = { method: 'average' as const, minScoresCount: 3 };

describe("o'quvchi balli, eligible va tartiblash", () => {
  it('scoreOf: average / sum, 2 xona', () => {
    expect(scoreOf(250, 3, 'average')).toBe(83.33);
    expect(scoreOf(250, 3, 'sum')).toBe(250);
    expect(scoreOf(0, 0, 'average')).toBe(0);
  });

  it("eligible = daysCount >= minScoresCount; eligible bo'lmaganlar rank=null va oxirida", () => {
    const rows = rankStudents(
      buildStudentRows(
        [st('a', 'Ali'), st('b', 'Bobur'), st('c', 'Chingiz'), st('d', 'Dilnoza')],
        new Map([
          ['a', agg(3, 3, 240)],
          ['b', agg(2, 2, 200)], // yetarli emas
          ['c', agg(5, 6, 450)],
        ]),
        opts,
      ),
      ['daysCount', 'alphabetical'],
    );
    expect(rows.map((r) => [r.studentId, r.rank, r.eligible])).toEqual([
      ['c', 1, true], // 90
      ['a', 2, true], // 80
      ['b', null, false],
      ['d', null, false],
    ]);
    expect(rows[0].score).toBe(90);
  });

  it("tie-break: daysCount, scoresCount, alphabetical (ketma-ketlik bo'yicha) va noyob rank", () => {
    const make = (tb: ('daysCount' | 'scoresCount' | 'alphabetical')[]) =>
      rankStudents(
        buildStudentRows(
          [st('z', 'Zafar'), st('a', 'Ali'), st('m', 'Malika'), st('k', 'Komil')],
          new Map([
            ['z', agg(4, 4, 320)], // 80, 4 kun, 4 baho
            ['a', agg(3, 5, 240)], // 80, 3 kun, 5 baho
            ['m', agg(4, 6, 320)], // 80, 4 kun, 6 baho
            ['k', agg(4, 4, 320)], // 80, 4 kun, 4 baho (Zafar bilan to'liq teng)
          ]),
          opts,
        ),
        tb,
      ).map((r) => r.studentId);

    expect(make(['daysCount', 'alphabetical'])).toEqual(['k', 'm', 'z', 'a']);
    expect(make(['daysCount', 'scoresCount', 'alphabetical'])).toEqual(['m', 'k', 'z', 'a']);
    expect(make(['scoresCount', 'alphabetical'])).toEqual(['m', 'a', 'k', 'z']);
    expect(make(['alphabetical'])).toEqual(['a', 'k', 'm', 'z']);
    const ranks = rankStudents(
      buildStudentRows(
        [st('a', 'Ali'), st('b', 'Ali')],
        new Map([
          ['a', agg(3, 3, 240)],
          ['b', agg(3, 3, 240)],
        ]),
        opts,
      ),
      ['alphabetical'],
    );
    expect(ranks.map((r) => r.rank)).toEqual([1, 2]); // to'liq teng bo'lsa ham noyob
  });

  it("method=sum: yig'indi bo'yicha tartib", () => {
    const rows = rankStudents(
      buildStudentRows(
        [st('a', 'Ali'), st('b', 'Bobur')],
        new Map([
          ['a', agg(3, 3, 270)],
          ['b', agg(10, 10, 800)],
        ]),
        { method: 'sum', minScoresCount: 3 },
      ),
      ['daysCount'],
    );
    expect(rows.map((r) => [r.studentId, r.score])).toEqual([
      ['b', 800],
      ['a', 270],
    ]);
  });
});

describe('sinf va maktab balli', () => {
  const students = [
    st('a', 'A', 'x'),
    st('b', 'B', 'y'),
    st('c', 'C', 'y'),
    st('d', 'D', 'y'),
    st('e', 'E', 'y'),
  ];
  const aggs = new Map<string, StudentAgg>([
    ['a', agg(3, 3, 300)], // 100, sinf x
    ['b', agg(3, 3, 180)], // 60
    ['c', agg(3, 3, 180)], // 60
    ['d', agg(3, 3, 180)], // 60
    ['e', agg(1, 1, 50)], // eligible emas
  ]);
  const rows = rankStudents(buildStudentRows(students, aggs, opts), ['alphabetical']);

  it("sinf = eligible o'quvchilar o'rtachasi; ratedStudents/totalStudents; eligible yo'q sinf kirmaydi", () => {
    const classes = new Map([
      ['x', { id: 'x', name: '5-A', grade: 5 }],
      ['y', { id: 'y', name: '5-B', grade: 5 }],
      ['z', { id: 'z', name: '6-A', grade: 6 }],
    ]);
    const cr = rankClasses(
      buildClassRows(
        rows,
        classes,
        new Map([
          ['x', 1],
          ['y', 4],
          ['z', 2],
        ]),
      ),
    );
    expect(cr.map((c) => [c.classId, c.rank, c.score, c.ratedStudents, c.totalStudents])).toEqual([
      ['x', 1, 100, 1, 1],
      ['y', 2, 60, 3, 4],
    ]);
  });

  it("sinf tie-break: ratedStudents desc, so'ng nom", () => {
    const cr = rankClasses([
      {
        classId: '1',
        className: 'B',
        grade: 5,
        score: 70,
        ratedStudents: 2,
        totalStudents: 2,
        rank: null,
      },
      {
        classId: '2',
        className: 'A',
        grade: 5,
        score: 70,
        ratedStudents: 2,
        totalStudents: 2,
        rank: null,
      },
      {
        classId: '3',
        className: 'C',
        grade: 5,
        score: 70,
        ratedStudents: 5,
        totalStudents: 5,
        rank: null,
      },
    ]);
    expect(cr.map((c) => c.classId)).toEqual(['3', '2', '1']);
  });

  it("maktab balli = BARCHA eligible o'quvchilar o'rtachasi (sinflar o'rtachasi emas)", () => {
    const school = buildSchoolRow({ id: 's', name: 'Maktab', slug: 'm' }, rows, 5);
    // sinflar o'rtachasi (100+60)/2 = 80; o'quvchilar o'rtachasi (100+60*3)/4 = 70
    expect(school).toMatchObject({ score: 70, ratedStudents: 4, totalStudents: 5 });
  });

  it('maktablar tartibi: score, ratedStudents, nom; ratedStudents=0 reytingga kirmaydi', () => {
    const mk = (id: string, name: string, score: number, rated: number) => ({
      schoolId: id,
      name,
      slug: id,
      score,
      ratedStudents: rated,
      totalStudents: 10,
      rank: null,
    });
    const ranked = rankSchools([
      mk('a', 'Beta', 80, 5),
      mk('b', 'Alfa', 80, 5),
      mk('c', 'Gamma', 90, 1),
      mk('d', 'Delta', 0, 0),
      mk('e', 'Eps', 80, 9),
    ]);
    expect(ranked.map((r) => [r.schoolId, r.rank])).toEqual([
      ['c', 1],
      ['e', 2],
      ['b', 3],
      ['a', 4],
      ['d', null],
    ]);
  });

  it("rankChange = previousRank - rank (musbat = ko'tarildi)", () => {
    expect(rankChange(2, 5)).toBe(3);
    expect(rankChange(5, 2)).toBe(-3);
    expect(rankChange(3, null)).toBeNull();
    expect(rankChange(null, 3)).toBeNull();
  });
});

describe('rating sozlamalari sxemasi', () => {
  it("tieBreak takrorsiz; 'alphabetical' doim oxirida", () => {
    expect(ratingValuesSchema.safeParse({ tieBreak: ['daysCount', 'daysCount'] }).success).toBe(
      false,
    );
    expect(ratingValuesSchema.safeParse({ tieBreak: ['x'] }).success).toBe(false);
    expect(normalizeRating({ tieBreak: ['alphabetical', 'scoresCount'] }).tieBreak).toEqual([
      'scoresCount',
      'alphabetical',
    ]);
    expect(normalizeRating({ tieBreak: [] }).tieBreak).toEqual(['alphabetical']);
    expect(normalizeRating({ method: 'sum' })).toEqual({ method: 'sum' });
  });
});

describe('Debouncer (vaqt mock)', () => {
  function manualTimers() {
    let now = 0;
    let id = 0;
    const jobs = new Map<number, { at: number; fn: () => void }>();
    const timers: Timers = {
      set: (fn, ms) => {
        jobs.set(++id, { at: now + ms, fn });
        return id;
      },
      clear: (h) => void jobs.delete(h as number),
    };
    const advance = async (ms: number) => {
      now += ms;
      for (const [k, j] of [...jobs]) {
        if (j.at <= now) {
          jobs.delete(k);
          j.fn();
        }
      }
      await new Promise((r) => setImmediate(r));
    };
    return { timers, advance, jobs };
  }

  it('tez-tez chaqiruvlar bitta ishga birlashadi (5 s dan keyin)', async () => {
    const calls: string[] = [];
    const t = manualTimers();
    const d = new Debouncer(5000, async (k) => void calls.push(k), t.timers);
    d.schedule('a');
    await t.advance(3000);
    d.schedule('a'); // taymer qayta boshlanadi
    await t.advance(3000);
    expect(calls).toEqual([]);
    await t.advance(2000);
    expect(calls).toEqual(['a']);
    d.schedule('a');
    d.schedule('b');
    await t.advance(5000);
    expect(calls.sort()).toEqual(['a', 'a', 'b']);
  });

  it("ish davomida kelgan so'rov tugagach yana bir marta bajariladi; flush darhol ishlatadi", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = manualTimers();
    const d = new Debouncer(
      1000,
      async () => {
        runs++;
        if (runs === 1) await gate;
      },
      t.timers,
    );
    d.schedule('x');
    await t.advance(1000);
    expect(runs).toBe(1);
    d.schedule('x');
    await t.advance(1000); // birinchi hali tugamagan
    expect(runs).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);

    d.schedule('y');
    expect(d.pendingKeys).toEqual(['y']);
    await d.flush();
    expect(d.pendingKeys).toEqual([]);
    expect(runs).toBe(3);
  });

  it("xato onError ga uzatiladi va keyingi ishlarni to'xtatmaydi", async () => {
    const errs: string[] = [];
    const t = manualTimers();
    const d = new Debouncer(
      10,
      async () => {
        throw new Error('boom');
      },
      t.timers,
      (k) => void errs.push(k),
    );
    d.schedule('q');
    await t.advance(10);
    expect(errs).toEqual(['q']);
  });
});
