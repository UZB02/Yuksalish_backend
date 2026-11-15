import JSZip from 'jszip';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const p = (t: string, bold = false) =>
  `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;

/** Word shabloni: qo'llanma + namunaviy savollar (shablonning o'zi xatosiz import qilinadi) */
export async function buildWordTemplate(): Promise<Buffer> {
  const body = [
    p('Savollar banki: Word shabloni', true),
    p('Qoidalar (ushbu matn import qilinmaydi, chunki u 1-savoldan oldin turibdi):'),
    p(
      'Qoida A: har bir savol "1." kabi raqam bilan boshlanadi. Variantlar "A)", "B)" ... "J)" (ko‘pi bilan 10 ta).',
    ),
    p(
      'Qoida B: to‘g‘ri variant oldiga * qo‘ying (masalan, *B)). Yoki hujjat oxirida "Javoblar" ro‘yxati: 1-B, 2-AC, 3: 12,5.',
    ),
    p(
      'Qoida C: ixtiyoriy qatorlar (savol ostida): Qiyinlik: 1-3, Ball: 1, Tur: single/multi/short/essay, Qisman ball: ha, Javob: 12,5 | 12.5.',
    ),
    p(
      'Qoida D: rasmlar va Word formulalari (Insert > Equation) avtomatik olinadi. Formula o‘tmasa [formula] belgisi qo‘yiladi.',
    ),
    p(
      'Savollar import oynasida tanlangan mavzuga qo‘shiladi; Fan: va Mavzu: qatorlari kerak emas (bo‘lsa e’tiborsiz qoldiriladi).',
    ),
    p('Quyida namunalar:', true),
    p('1. 2 + 2 nechiga teng?'),
    p('Qiyinlik: 1'),
    p('A) 3'),
    p('*B) 4'),
    p('C) 5'),
    p('2. Qaysilari tub sonlar?'),
    p('Tur: multi'),
    p('Qisman ball: ha'),
    p('*A) 2'),
    p('B) 4'),
    p('*C) 7'),
    p('D) 9'),
    p('3. 5 / 2 nechiga teng?'),
    p('Tur: short'),
    p('Javob: 2,5 | 2.5'),
    p('4. Bahor haqida insho yozing.'),
    p('Tur: essay'),
    p('Ball: 5'),
    p('5. Eng katta sayyora qaysi?'),
    p('A) Yer'),
    p('B) Yupiter'),
    p('C) Mars'),
    p('Javoblar', true),
    p('5-B'),
  ].join('');
  const ns =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
