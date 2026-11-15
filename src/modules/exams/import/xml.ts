/**
 * Minimal XAVFSIZ XML o'qigich (faqat OOXML to'plami uchun).
 *
 * Nega o'zimiz yozdik (mammoth o'rniga): mammoth HTML chiqaradi (biz HTML saqlamaymiz), OMML formulalarini
 * tashlab ketadi va tranzitiv XML kutubxonalarini (xmldom) qo'shadi. Bu o'qigich:
 *  - DOCTYPE va ENTITY e'lonini umuman qabul qilmaydi (XXE va "billion laughs" imkonsiz);
 *  - faqat 5 ta standart va raqamli belgi havolalarini ochadi, boshqa entity matn bo'lib qoladi;
 *  - chuqurlik va tugunlar soni bo'yicha cheklangan. Yangi dependency kerak emas.
 */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: (XNode | string)[];
}

export class XmlError extends Error {}

const MAX_DEPTH = 120;
const MAX_NODES = 1_500_000;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code < 0xe000)
      )
        return '';
      return String.fromCodePoint(code);
    }
    return NAMED[e] ?? m;
  });
}

/** DOCTYPE/ENTITY bor XML rad etiladi (oldindan tekshirish uchun ham eksport qilinadi) */
export const hasDtd = (xml: string): boolean => /<!\s*(DOCTYPE|ENTITY)/i.test(xml);

export function parseXml(xml: string): XNode {
  if (hasDtd(xml)) throw new XmlError('DTD/ENTITY e’lon qilingan XML qabul qilinmaydi');
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  let nodes = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const t = xml.slice(i);
      if (t.trim()) stack[stack.length - 1]!.children.push(decode(t));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.children.push(decode(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e === -1) throw new XmlError('Izoh yopilmagan');
      i = e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e === -1) throw new XmlError('CDATA yopilmagan');
      stack[stack.length - 1]!.children.push(xml.slice(lt + 9, e));
      i = e + 3;
    } else if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e === -1) throw new XmlError("Ko'rsatma yopilmagan");
      i = e + 2;
    } else if (xml.startsWith('</', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e === -1) throw new XmlError('Teg yopilmagan');
      const name = xml.slice(lt + 2, e).trim();
      const top = stack.pop();
      if (!top || stack.length === 0 || top.name !== name) throw new XmlError('Teglar mos emas');
      i = e + 1;
    } else {
      // Ochuvchi teg: atribut qiymati ichida '>' bo'lishi mumkin
      let j = lt + 1;
      let quote = '';
      while (j < n) {
        const c = xml[j]!;
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= n) throw new XmlError('Teg yopilmagan');
      let body = xml.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new XmlError("Teg nomi yo'q");
      const node: XNode = { name: m[1]!, attrs: {}, children: [] };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      const rest = body.slice(m[1]!.length);
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(rest))) node.attrs[am[1]!] = decode(am[3] ?? am[4] ?? '');
      if (++nodes > MAX_NODES) throw new XmlError('XML juda katta');
      stack[stack.length - 1]!.children.push(node);
      if (!selfClose) {
        if (stack.length > MAX_DEPTH) throw new XmlError('XML juda chuqur');
        stack.push(node);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError('XML tugallanmagan');
  const first = root.children.find((c): c is XNode => typeof c !== 'string');
  if (!first) throw new XmlError("XML bo'sh");
  return first;
}

export const elems = (n: XNode): XNode[] =>
  n.children.filter((c): c is XNode => typeof c !== 'string');
export const child = (n: XNode, name: string): XNode | undefined =>
  elems(n).find((c) => c.name === name);
export const childrenNamed = (n: XNode, name: string): XNode[] =>
  elems(n).filter((c) => c.name === name);
export function textOf(n: XNode): string {
  let out = '';
  for (const c of n.children) out += typeof c === 'string' ? c : textOf(c);
  return out;
}
