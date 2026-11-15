import { child, childrenNamed, elems, textOf, type XNode } from './xml';

/**
 * OMML (Word formulasi) -> LaTeX. Qamrov: kasr, daraja/indeks, ildiz, yig'indi/integral, qavslar, funksiyalar,
 * aksentlar, matritsa, tenglamalar tizimi. Tanilmagan element uchrasa `ok=false` (chaqiruvchi "[formula]"
 * bloki va ogohlantirish bilan almashtiradi, import to'xtamaydi). Natija KaTeX da trust:false bilan chiziladi.
 */
export interface OmmlResult {
  tex: string;
  ok: boolean;
}

const SYMBOLS: Record<string, string> = {
  '×': '\\times ',
  '÷': '\\div ',
  '·': '\\cdot ',
  '±': '\\pm ',
  '∓': '\\mp ',
  '≤': '\\le ',
  '≥': '\\ge ',
  '≠': '\\ne ',
  '≈': '\\approx ',
  '≡': '\\equiv ',
  '∞': '\\infty ',
  '∂': '\\partial ',
  '∇': '\\nabla ',
  '→': '\\to ',
  '←': '\\leftarrow ',
  '⇒': '\\Rightarrow ',
  '⇔': '\\Leftrightarrow ',
  '∈': '\\in ',
  '∉': '\\notin ',
  '⊂': '\\subset ',
  '⊆': '\\subseteq ',
  '∪': '\\cup ',
  '∩': '\\cap ',
  '∅': '\\emptyset ',
  '∀': '\\forall ',
  '∃': '\\exists ',
  '°': '^{\\circ}',
  '′': "'",
  '…': '\\ldots ',
  '−': '-',
  '∠': '\\angle ',
  '⊥': '\\perp ',
  '∥': '\\parallel ',
  α: '\\alpha ',
  β: '\\beta ',
  γ: '\\gamma ',
  δ: '\\delta ',
  ε: '\\varepsilon ',
  θ: '\\theta ',
  λ: '\\lambda ',
  μ: '\\mu ',
  π: '\\pi ',
  ρ: '\\rho ',
  σ: '\\sigma ',
  τ: '\\tau ',
  φ: '\\varphi ',
  ω: '\\omega ',
  Δ: '\\Delta ',
  Σ: '\\Sigma ',
  Ω: '\\Omega ',
  Π: '\\Pi ',
  Φ: '\\Phi ',
  Γ: '\\Gamma ',
  Λ: '\\Lambda ',
  Θ: '\\Theta ',
};
const NARY: Record<string, string> = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '⋃': '\\bigcup',
  '⋂': '\\bigcap',
};
const FUNCS = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'log',
  'ln',
  'lg',
  'lim',
  'max',
  'min',
  'exp',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'det',
  'gcd',
]);
const ACCENTS: Record<string, string> = {
  '̂': 'hat',
  '^': 'hat',
  '̄': 'bar',
  '¯': 'bar',
  '̃': 'tilde',
  '~': 'tilde',
  '→': 'vec',
  '⃗': 'vec',
  '̇': 'dot',
  '̈': 'ddot',
};
const OPEN: Record<string, string> = {
  '(': '(',
  '[': '[',
  '{': '\\{',
  '|': '|',
  '‖': '\\|',
  '⟨': '\\langle ',
  '⌊': '\\lfloor ',
  '⌈': '\\lceil ',
  '': '.',
};
const CLOSE: Record<string, string> = {
  ')': ')',
  ']': ']',
  '}': '\\}',
  '|': '|',
  '‖': '\\|',
  '⟩': '\\rangle ',
  '⌋': '\\rfloor ',
  '⌉': '\\rceil ',
  '': '.',
};
const ESC: Record<string, string> = {
  '\\': '\\backslash ',
  '{': '\\{',
  '}': '\\}',
  _: '\\_',
  '^': '\\^{}',
  '#': '\\#',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '~': '\\sim ',
};

const isProps = (name: string) => /Pr$/.test(name);

function mapText(s: string): string {
  let out = '';
  for (const ch of s) out += SYMBOLS[ch] ?? ESC[ch] ?? ch;
  return out;
}

class Ctx {
  ok = true;
  depth = 0;
}

const EMPTY: XNode = { name: '', attrs: {}, children: [] };

function seq(n: XNode, c: Ctx): string {
  c.depth++;
  if (c.depth > 60) {
    c.ok = false;
    c.depth--;
    return '';
  }
  const out = elems(n)
    .map((e) => node(e, c))
    .join('');
  c.depth--;
  return out;
}

const arg = (n: XNode, name: string, c: Ctx): string => {
  const e = child(n, name);
  return e ? seq(e, c).trim() : '';
};
const grp = (s: string) => `{${s}}`;
const valOf = (n: XNode | undefined, tag: string): string | undefined => {
  const p = n ? child(n, tag) : undefined;
  return p?.attrs['m:val'];
};

function node(n: XNode, c: Ctx): string {
  switch (n.name) {
    case 'm:r': {
      const t = childrenNamed(n, 'm:t').map(textOf).join('');
      const normal = child(child(n, 'm:rPr') ?? EMPTY, 'm:nor');
      if (normal && normal.attrs['m:val'] !== '0' && normal.attrs['m:val'] !== 'false') {
        return `\\text{${t.replace(/[\\{}]/g, '')}}`;
      }
      return mapText(t);
    }
    case 'm:t':
      return mapText(textOf(n));
    case 'm:f': {
      const type = valOf(child(n, 'm:fPr'), 'm:type');
      const num = arg(n, 'm:num', c);
      const den = arg(n, 'm:den', c);
      return type === 'noBar' ? `\\binom${grp(num)}${grp(den)}` : `\\frac${grp(num)}${grp(den)}`;
    }
    case 'm:sSup':
      return `${grp(arg(n, 'm:e', c))}^${grp(arg(n, 'm:sup', c))}`;
    case 'm:sSub':
      return `${grp(arg(n, 'm:e', c))}_${grp(arg(n, 'm:sub', c))}`;
    case 'm:sSubSup':
      return `${grp(arg(n, 'm:e', c))}_${grp(arg(n, 'm:sub', c))}^${grp(arg(n, 'm:sup', c))}`;
    case 'm:sPre':
      return `{}_${grp(arg(n, 'm:sub', c))}^${grp(arg(n, 'm:sup', c))}${grp(arg(n, 'm:e', c))}`;
    case 'm:rad': {
      const hide = valOf(child(n, 'm:radPr'), 'm:degHide');
      const deg = arg(n, 'm:deg', c);
      const e = arg(n, 'm:e', c);
      return deg && hide !== '1' && hide !== 'true' ? `\\sqrt[${deg}]${grp(e)}` : `\\sqrt${grp(e)}`;
    }
    case 'm:nary': {
      const chr = valOf(child(n, 'm:naryPr'), 'm:chr') ?? '∫';
      const op = NARY[chr];
      if (!op) c.ok = false;
      const sub = arg(n, 'm:sub', c);
      const sup = arg(n, 'm:sup', c);
      return `${op ?? ''}${sub ? `_${grp(sub)}` : ''}${sup ? `^${grp(sup)}` : ''} ${arg(n, 'm:e', c)}`;
    }
    case 'm:d': {
      const pr = child(n, 'm:dPr');
      const beg = valOf(pr, 'm:begChr') ?? '(';
      const end = valOf(pr, 'm:endChr') ?? ')';
      const sep = valOf(pr, 'm:sepChr') ?? '|';
      const items = childrenNamed(n, 'm:e').map((e) => seq(e, c).trim());
      const l = OPEN[beg];
      const r = CLOSE[end];
      if (l === undefined || r === undefined) c.ok = false;
      return `\\left${l ?? '('} ${items.join(sep === '|' ? ' \\mid ' : mapText(sep))} \\right${r ?? ')'}`;
    }
    case 'm:func': {
      const name = arg(n, 'm:fName', c);
      const e = arg(n, 'm:e', c);
      const plain = name.replace(/[^a-z]/g, '');
      return `${FUNCS.has(plain) ? `\\${plain} ` : `\\operatorname${grp(name)} `}${e}`;
    }
    case 'm:acc': {
      const chr = valOf(child(n, 'm:accPr'), 'm:chr') ?? '̂';
      const cmd = ACCENTS[chr];
      if (!cmd) c.ok = false;
      return `\\${cmd ?? 'hat'}${grp(arg(n, 'm:e', c))}`;
    }
    case 'm:bar': {
      const pos = valOf(child(n, 'm:barPr'), 'm:pos');
      return `${pos === 'bot' ? '\\underline' : '\\overline'}${grp(arg(n, 'm:e', c))}`;
    }
    case 'm:limLow':
      return `${grp(arg(n, 'm:e', c))}_${grp(arg(n, 'm:lim', c))}`;
    case 'm:limUpp':
      return `${grp(arg(n, 'm:e', c))}^${grp(arg(n, 'm:lim', c))}`;
    case 'm:eqArr': {
      const rows = childrenNamed(n, 'm:e').map((e) => seq(e, c).trim());
      return `\\begin{aligned} ${rows.join(' \\\\ ')} \\end{aligned}`;
    }
    case 'm:m': {
      const rows = childrenNamed(n, 'm:mr').map((r) =>
        childrenNamed(r, 'm:e')
          .map((e) => seq(e, c).trim())
          .join(' & '),
      );
      return `\\begin{matrix} ${rows.join(' \\\\ ')} \\end{matrix}`;
    }
    case 'm:oMath':
    case 'm:oMathPara':
    case 'm:e':
    case 'm:num':
    case 'm:den':
    case 'm:sub':
    case 'm:sup':
    case 'm:box':
    case 'm:borderBox':
    case 'm:phant':
    case 'm:groupChr':
    case 'm:fName':
    case 'm:lim':
    case 'm:deg':
      return seq(n, c);
    default:
      if (isProps(n.name) || n.name.startsWith('w:')) return '';
      c.ok = false;
      return seq(n, c);
  }
}

export function ommlToLatex(root: XNode): OmmlResult {
  const c = new Ctx();
  let tex: string;
  try {
    tex = seq({ name: 'x', attrs: {}, children: [root] }, c)
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return { tex: '', ok: false };
  }
  if (!tex || tex.length > 1900) return { tex, ok: false };
  return { tex, ok: c.ok };
}
