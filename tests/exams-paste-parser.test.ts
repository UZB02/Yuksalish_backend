import { describe, expect, it } from 'vitest';
import { hasBlocking, parsePasteText, toBlocks } from '../src/modules/exams/import/import.paste';

const txt = (b: { type: string; text?: string; tex?: string }[]) =>
  b.map((x) => (x.type === 'text' ? x.text : `$${x.tex}$`)).join(' ');
const optTexts = (q: { options: { content: never[] }[] }) =>
  q.options.map((o) => txt(o.content as never));

describe('paste parser: asosiy shakllar', () => {
  it('raqamli savollar, har variant alohida qatorda, "Javob:" qatori', () => {
    const r = parsePasteText(`
Matematika 9-sinf test

1. 7 + 5 nechiga teng?
A) 11
B) 12
C) 13
D) 14
Javob: B

2) 3 * 4 = ?
A. 10
B. 12
C. 14
Javob: B

3. Eng katta son?
a) 1
b) 5
c) 3
To'g'ri javob: b
`);
    expect(r.questions).toHaveLength(3);
    expect(r.ignored.map((x) => x.text)).toEqual(['Matematika 9-sinf test']);
    const [q1, q2, q3] = r.questions;
    expect(txt(q1!.content)).toBe('7 + 5 nechiga teng?');
    expect(optTexts(q1! as never)).toEqual(['11', '12', '13', '14']);
    expect(q1!.correct).toEqual(['B']);
    expect(q1!.type).toBe('single');
    expect(q2!.options.map((o) => o.id)).toEqual(['A', 'B', 'C']);
    expect(q2!.correct).toEqual(['B']);
    expect(q3!.correct).toEqual(['B']);
    expect(r.questions.every((q) => !hasBlocking(q))).toBe(true);
    expect(r.questions.map((q) => q.idx)).toEqual([1, 2, 3]);
    expect(r.questions.map((q) => q.number)).toEqual([1, 2, 3]);
  });

  it('bir qatorda bir nechta variant va savol bilan bir qatorda variantlar', () => {
    const r = parsePasteText(`1. Burchak yig'indisi?
A) 90 B) 180 C) 270 D) 360
Javob: B
2. 2+2=? A) 3 B) 4 C) 5
Javob: B
3-savol: Poytaxt? A. Toshkent  B. Samarqand  C. Buxoro
Answer: A`);
    expect(r.questions).toHaveLength(3);
    expect(optTexts(r.questions[0]! as never)).toEqual(['90', '180', '270', '360']);
    expect(r.questions[0]!.correct).toEqual(['B']);
    expect(txt(r.questions[1]!.content)).toBe('2+2=?');
    expect(optTexts(r.questions[1]! as never)).toEqual(['3', '4', '5']);
    expect(r.questions[1]!.correct).toEqual(['B']);
    expect(txt(r.questions[2]!.content)).toBe('Poytaxt?');
    expect(optTexts(r.questions[2]! as never)).toEqual(['Toshkent', 'Samarqand', 'Buxoro']);
    expect(r.questions[2]!.correct).toEqual(['A']);
  });

  it('savol raqami variantlari: 1-savol, Savol 2:, 3), Вопрос 4., Question 5.', () => {
    const r = parsePasteText(`1-savol. Birinchi?
A) a1 B) b1
*B) b1
2 - savol: Ikkinchi?
A) x B) y
Javob: A
Savol 3: Uchinchi?
A) x B) y
Javob: A
Вопрос 4. Тўртинчи?
A) x B) y
Javob: B
Question 5. Fifth?
A) x B) y
Javob: A`);
    expect(r.questions.map((q) => q.number)).toEqual([1, 2, 3, 4, 5]);
    expect(r.questions.map((q) => txt(q.content))).toEqual([
      'Birinchi?',
      'Ikkinchi?',
      'Uchinchi?',
      'Тўртинчи?',
      'Fifth?',
    ]);
  });

  it('"Javob:" nomlari va tutuq belgilari', () => {
    const variants = [
      'To‘g‘ri javob: B',
      "To'g'ri javob: B",
      'Togri javob: B',
      'JAVOB: B',
      'Answer: B',
      'Correct answer: B',
      'Ответ: Б',
      'Правильный ответ: Б',
      'Javob - B',
      'Javob: B)',
      'Javob: B) 4',
      'Javob: (B)',
    ];
    for (const v of variants) {
      const r = parsePasteText(`1. Savol\nA) 3\nB) 4\n${v}`);
      expect(r.questions[0]!.correct, v).toEqual(['B']);
    }
  });

  it('"Javob:" qiymati variant matni bo`lsa', () => {
    const r = parsePasteText(`1. Poytaxt?\nA) Toshkent\nB) Samarqand\nJavob: Samarqand`);
    expect(r.questions[0]!.correct).toEqual(['B']);
    const bad = parsePasteText(`1. Poytaxt?\nA) Toshkent\nB) Samarqand\nJavob: Xiva`);
    expect(bad.questions[0]!.correct).toEqual([]);
    expect(bad.questions[0]!.warnings.map((w) => w.code)).toContain('badAnswer');
  });

  it('variant oxiridagi "Javob: B" (D qatorida) ajratiladi', () => {
    const r = parsePasteText(`1. Savol\nA) 1\nB) 2\nC) 3 Javob: C`);
    expect(r.questions[0]!.correct).toEqual(['C']);
    expect(optTexts(r.questions[0]! as never)).toEqual(['1', '2', '3']);
  });
});

describe('paste parser: to`g`ri javob belgilari', () => {
  it('variant oldida *, + va oxirida +, *, (+), ✓', () => {
    const r = parsePasteText(`1. Birinchi
A) 1
*B) 2
C) 3
2. Ikkinchi
A) 1
+B) 2
C) 3
3. Uchinchi
A) 1
B) 2 +
C) 3
4. To'rtinchi
A) 1
B) 2 *
C) 3
5. Beshinchi
A) 1
B) 2 (+)
C) 3
6. Oltinchi
A) 1
B) 2 ✓
C) 3
7. Yettinchi
*A) 1 B) 2 C) 3`);
    expect(r.questions.map((q) => q.correct)).toEqual([
      ['B'],
      ['B'],
      ['B'],
      ['B'],
      ['B'],
      ['B'],
      ['A'],
    ]);
    // belgi matnga kirib qolmaydi
    expect(optTexts(r.questions[2]! as never)).toEqual(['1', '2', '3']);
    expect(optTexts(r.questions[0]! as never)).toEqual(['1', '2', '3']);
  });

  it('bir nechta belgi yoki "Javob: A, C" = ko`p javobli', () => {
    const r = parsePasteText(`1. Tub sonlar?
*A) 2
B) 4
*C) 5
2. Juft sonlar?
A) 2
B) 4
C) 5
Javob: A, B`);
    expect(r.questions[0]!.correct).toEqual(['A', 'C']);
    expect(r.questions[0]!.type).toBe('multi');
    expect(r.questions[1]!.correct).toEqual(['A', 'B']);
    expect(r.questions[1]!.type).toBe('multi');
  });

  it('belgi va "Javob:" mos kelmasa = conflict, tanlash mumkin', () => {
    const r = parsePasteText(`1. Savol\nA) 1\n*B) 2\nC) 3\nJavob: C`);
    const q = r.questions[0]!;
    expect(q.correct).toEqual([]);
    expect(q.warnings.map((w) => w.code)).toContain('conflict');
    expect(q.pickable).toBe(true);
  });

  it('belgi va "Javob:" mos kelsa muammo yo`q', () => {
    const r = parsePasteText(`1. Savol\nA) 1\n*B) 2\nC) 3\nJavob: B`);
    expect(r.questions[0]!.correct).toEqual(['B']);
    expect(hasBlocking(r.questions[0]!)).toBe(false);
  });
});

describe('paste parser: javoblar bloki', () => {
  const body = `1. Birinchi
A) a
B) b
C) c
2. Ikkinchi
A) a
B) b
C) c
3. Uchinchi
A) a
B) b
C) c
`;
  it.each([
    ['Javoblar: 1-B 2-C 3-A', ['B', 'C', 'A']],
    ['Javoblar: 1B 2C 3A', ['B', 'C', 'A']],
    ['Javoblar:\n1-B\n2-C\n3-A', ['B', 'C', 'A']],
    ['Kalitlar: 1) B, 2) C, 3) A', ['B', 'C', 'A']],
    ['Answers: 1.B 2.C 3.A', ['B', 'C', 'A']],
    ['1-B 2-C 3-A', ['B', 'C', 'A']],
    ['1B 2C 3A', ['B', 'C', 'A']],
    ['Javoblar\n1 - B\n2 - C\n3 - A', ['B', 'C', 'A']],
    ['Javoblar: 1-Б 2-В 3-А', ['B', 'C', 'A']],
  ])('%s', (key, exp) => {
    const r = parsePasteText(body + key);
    expect(r.questions).toHaveLength(3);
    expect(r.questions.map((q) => q.correct[0])).toEqual(exp);
    expect(r.ignored).toEqual([]);
  });

  it('kalitda yo`q savol = javobsiz; kalit variantda yo`q harf = badAnswer', () => {
    const r = parsePasteText(body + 'Javoblar: 1-B 3-F');
    expect(r.questions[0]!.correct).toEqual(['B']);
    expect(r.questions[1]!.warnings.map((w) => w.code)).toContain('noAnswer');
    expect(r.questions[2]!.warnings.map((w) => w.code)).toContain('badAnswer');
  });

  it('raqamsiz savollar uchun kalit tartib raqami bo`yicha', () => {
    const r = parsePasteText(`Birinchi savol?
A) 1
B) 2

Ikkinchi savol?
A) 1
B) 2

Javoblar: 1-B 2-A`);
    expect(r.questions).toHaveLength(2);
    expect(r.questions.map((q) => q.correct[0])).toEqual(['B', 'A']);
  });
});

describe('paste parser: kirill harflari', () => {
  it('А Б В Г -> A B C D', () => {
    const r = parsePasteText(`1. Савол
А) бир
Б) икки
В) уч
Г) тўрт
Жавоб: В`);
    const q = r.questions[0]!;
    expect(q.options.map((o) => o.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(optTexts(q as never)).toEqual(['бир', 'икки', 'уч', 'тўрт']);
    expect(q.correct).toEqual(['C']);
  });

  it('kirill harflar bir qatorda', () => {
    const r = parsePasteText(`1. Савол? А) 90 Б) 180 В) 270 Г) 360\nJavob: Б`);
    expect(optTexts(r.questions[0]! as never)).toEqual(['90', '180', '270', '360']);
    expect(r.questions[0]!.correct).toEqual(['B']);
  });

  it('kirill va lotin aralash (А lotin A bilan bir xil)', () => {
    const r = parsePasteText(`1. Savol\nА) 1\nB) 2\nJavob: B`);
    expect(r.questions[0]!.correct).toEqual(['B']);
    expect(hasBlocking(r.questions[0]!)).toBe(false);
  });
});

describe('paste parser: ko`p qatorli va ortiqcha qatorlar', () => {
  it('ko`p qatorli savol matni va ko`p qatorli variant', () => {
    const r = parsePasteText(`1. Quyidagi ma'lumotga qarang.
Ikkinchi qator.

Uchinchi qator?
A) birinchi
davomi
B) ikkinchi
Javob: A`);
    const q = r.questions[0]!;
    expect(txt(q.content)).toBe("Quyidagi ma'lumotga qarang.\nIkkinchi qator.\nUchinchi qator?");
    expect(optTexts(q as never)).toEqual(['birinchi\ndavomi', 'ikkinchi']);
    expect(q.correct).toEqual(['A']);
  });

  it('bo`sh qatorlar, sarlavhalar va ortiqcha bo`shliqlar e`tiborsiz', () => {
    const r = parsePasteText(
      `\n\n   Fizika - nazorat ishi   \n\n\n1.   Tezlik?   \n\n  A)   m/s  \n  B)   kg  \n\n  Javob:   A  \n\n\n`,
    );
    expect(r.questions).toHaveLength(1);
    expect(r.ignored).toHaveLength(1);
    expect(txt(r.questions[0]!.content)).toBe('Tezlik?');
    expect(optTexts(r.questions[0]! as never)).toEqual(['m/s', 'kg']);
    expect(r.questions[0]!.correct).toEqual(['A']);
  });

  it('Windows qator oxirlari, tab, NBSP va ko`rinmas belgilar', () => {
    const r = parsePasteText('﻿1. Savol\r\nA)\t1\r\nB)​ 2\r\nJavob: B\r\n');
    expect(r.questions).toHaveLength(1);
    expect(optTexts(r.questions[0]! as never)).toEqual(['1', '2']);
  });

  it('savol raqami keyingi qatorda: "1." va matn pastda', () => {
    const r = parsePasteText(`1.\nSavol matni\nA) x\nB) y\nJavob: A`);
    expect(r.questions).toHaveLength(1);
    expect(txt(r.questions[0]!.content)).toBe('Savol matni');
  });

  it('ketma-ket nuqtali o`nlik sonlar va yil savol boshlanishi emas', () => {
    const r = parsePasteText(`1. Uzunlik?
3.5 metr va 2026. yilda
A) 3.5
B) 4
Javob: A`);
    expect(r.questions).toHaveLength(1);
    expect(txt(r.questions[0]!.content)).toContain('3.5 metr va 2026. yilda');
    expect(optTexts(r.questions[0]! as never)).toEqual(['3.5', '4']);
  });

  it('variantlar: A -, (A), A:', () => {
    const r = parsePasteText(`1. S
A - bir
B - ikki
Javob: A
2. S
(A) bir
(B) ikki
Javob: B
3. S
A: bir
B: ikki
Javob: A`);
    expect(r.questions.map((q) => optTexts(q as never))).toEqual([
      ['bir', 'ikki'],
      ['bir', 'ikki'],
      ['bir', 'ikki'],
    ]);
    expect(r.questions.map((q) => q.correct[0])).toEqual(['A', 'B', 'A']);
  });

  it('raqamsiz savollar bo`sh qator bilan ajratilgan', () => {
    const r = parsePasteText(`Birinchi savol?
A) 1
B) 2
Javob: A

Ikkinchi savol?
A) 3
B) 4
Javob: B`);
    expect(r.questions).toHaveLength(2);
    expect(r.questions.map((q) => q.correct[0])).toEqual(['A', 'B']);
    expect(txt(r.questions[1]!.content)).toBe('Ikkinchi savol?');
  });

  it('6 tagacha variant (A-F), 2 tadan kam bo`lsa ogohlantirish', () => {
    const r = parsePasteText(`1. S
A) 1
B) 2
C) 3
D) 4
E) 5
F) 6
Javob: F
2. S
A) faqat bitta
Javob: A`);
    expect(r.questions[0]!.options).toHaveLength(6);
    expect(r.questions[0]!.correct).toEqual(['F']);
    expect(r.questions[1]!.warnings.map((w) => w.code)).toContain('fewOptions');
    expect(hasBlocking(r.questions[1]!)).toBe(true);
  });
});

describe('paste parser: formula (LaTeX)', () => {
  it('$...$ math blok bo`ladi, matn bilan aralash', () => {
    const r = parsePasteText(`1. Hisoblang: $\\frac{1}{2} + \\frac{1}{3}$ ni toping
A) $\\frac{5}{6}$
B) $\\frac{2}{5}$
Javob: A`);
    const q = r.questions[0]!;
    expect(q.content).toEqual([
      { type: 'text', text: 'Hisoblang:' },
      { type: 'math', tex: '\\frac{1}{2} + \\frac{1}{3}' },
      { type: 'text', text: 'ni toping' },
    ]);
    expect(q.options[0]!.content).toEqual([{ type: 'math', tex: '\\frac{5}{6}' }]);
  });

  it('formula ichidagi "A)" va "B)" variant sifatida ajratilmaydi', () => {
    const r = parsePasteText(`1. $f(x) = a) + b)$ qiymati? A) 1 B) 2\nJavob: A`);
    expect(r.questions[0]!.options).toHaveLength(2);
    expect(r.questions[0]!.content.some((b) => b.type === 'math')).toBe(true);
  });

  it('$$...$$ va yopilmagan $', () => {
    const r = parsePasteText(`1. $$x^2$$ nechiga teng? Narxi 5$
A) 1
B) 2
Javob: A`);
    expect(r.questions[0]!.content[0]).toEqual({ type: 'math', tex: 'x^2' });
    expect(r.questions[0]!.warnings.map((w) => w.code)).toContain('badMath');
    // badMath bloklamaydi
    expect(hasBlocking(r.questions[0]!)).toBe(false);
  });

  it('toBlocks: HTML matn bo`lib qoladi (talqin qilinmaydi)', () => {
    const { blocks } = toBlocks('<b>qalin</b> <script>alert(1)</script>');
    expect(blocks).toEqual([{ type: 'text', text: '<b>qalin</b> <script>alert(1)</script>' }]);
  });
});

describe('paste parser: ogohlantirishlar va buzuq kirish', () => {
  it('javobsiz savol: noAnswer, pickable', () => {
    const r = parsePasteText(`1. Savol\nA) 1\nB) 2`);
    const q = r.questions[0]!;
    expect(q.warnings).toEqual([expect.objectContaining({ code: 'noAnswer', blocking: true })]);
    expect(q.pickable).toBe(true);
    expect(q.correct).toEqual([]);
  });

  it('takroriy variant harflari: dupLetters', () => {
    const r = parsePasteText(`1. Savol\nA) 1\nB) 2\nB) 3\nJavob: A`);
    expect(r.questions[0]!.warnings.map((w) => w.code)).toContain('dupLetters');
    expect(hasBlocking(r.questions[0]!)).toBe(true);
  });

  it('bo`sh qatordan keyingi tushunilmagan qator: unparsed (bloklamaydi)', () => {
    const r = parsePasteText(`1. Savol\nA) 1\nB) 2\nJavob: A\n\nIzoh: bu shunchaki yozuv`);
    const w = r.questions[0]!.warnings;
    expect(w.map((x) => x.code)).toEqual(['unparsed']);
    expect(w[0]!.blocking).toBe(false);
  });

  it('matni yo`q savol', () => {
    const r = parsePasteText(`1.\nA) 1\nB) 2\nJavob: A`);
    expect(r.questions[0]!.warnings.map((w) => w.code)).toContain('noText');
  });

  it('bo`sh va savolsiz kirish', () => {
    expect(parsePasteText('').questions).toEqual([]);
    expect(parsePasteText('   \n\n \n').questions).toEqual([]);
    const r = parsePasteText('Faqat oddiy matn.\nBoshqa narsa yo`q.');
    expect(r.questions.length).toBeLessThanOrEqual(1);
  });

  it('juda uzun matn: tooLong bloklaydi', () => {
    const r = parsePasteText(`1. ${'a'.repeat(5100)}\nA) 1\nB) 2\nJavob: A`);
    expect(r.questions[0]!.warnings.map((w) => w.code)).toContain('tooLong');
  });

  it('buzilgan kirishda ham yiqilmaydi va tez ishlaydi', () => {
    const garbage = [
      ')))))((((',
      '1.1.1.1.1.1',
      'A)A)A)A)A)A)',
      '$'.repeat(5000),
      '*'.repeat(3000) + '\nA) ' + '+'.repeat(3000),
      Array.from({ length: 2000 }, (_, i) => `${i % 999}. x\nA) y\nB) z`).join('\n'),
      '\u0000\u0001\u0002 1. a\nA) b\nB) c',
      'Javob: B\nJavoblar:\n1-B',
    ];
    const t0 = Date.now();
    for (const g of garbage) expect(() => parsePasteText(g)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('qayta ishlatiladi: bir xil kirish bir xil natija (toza funksiya)', () => {
    const src = `1. Savol\nA) 1\nB) 2\nJavob: B`;
    expect(parsePasteText(src)).toEqual(parsePasteText(src));
  });
});

describe('paste parser: haqiqiy aralash test (10 savol)', () => {
  const real = `Matematika 8-sinf, 2-chorak

1. 7 + 5 nechiga teng?
A) 11
B) 12
C) 13
D) 14
Javob: B

2. Uchburchak burchaklari yig'indisi?
A) 90 B) 180 C) 270 D) 360
Javob: B

3-savol. $x^2 = 16$ tenglamaning musbat ildizi?
A) 2
B) 4
*C) 4
D) 8

4. Eng kichik tub son?
A) 0
B) 1
C) 2 +
D) 3

5. Asosiy xossa
A. a
B. b
C. c
Javob: C

6. Parallelogramm?
A) bir
B) ikki
C) uch

7. Poytaxt?
Toshkent
A) Toshkent
B) Samarqand
Javob: A

8. 12 / 4 = ?  А) 2  Б) 3  В) 4
Javob: Б

9. Tenglama
$x + 1 = 3$
A) $x=1$
B) $x=2$
Javob: B

10. Oxirgisi
A) 1
B) 2
D) 3
Javob: A

Javoblar: 6-A`;
  it('10 savol, bittasida javob yo`q (6-savolga kalit orqali javob beriladi)', () => {
    const r = parsePasteText(real);
    expect(r.questions).toHaveLength(10);
    expect(r.ignored.map((x) => x.text)).toEqual(['Matematika 8-sinf, 2-chorak']);
    expect(r.questions.map((q) => q.correct.join(''))).toEqual([
      'B',
      'B',
      'C',
      'C',
      'C',
      'A',
      'A',
      'B',
      'B',
      'A',
    ]);
    expect(r.questions.every((q) => !hasBlocking(q))).toBe(true);
  });
  it('kalitsiz: aynan bitta savol javobsiz', () => {
    const r = parsePasteText(real.replace('\nJavoblar: 6-A', ''));
    const missing = r.questions.filter((q) => hasBlocking(q));
    expect(missing.map((q) => q.idx)).toEqual([6]);
    expect(missing[0]!.pickable).toBe(true);
  });
});
