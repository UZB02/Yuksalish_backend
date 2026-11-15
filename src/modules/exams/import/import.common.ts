import { AppError } from '../../../core/errors';
import { QUESTION_TYPES, type QuestionType } from '../../../models/Question';
import { Subject } from '../../../models/Subject';
import { nameKeyOf } from '../../../utils/text';
import type { ExamScope } from '../exams.scope';
import { questionInput, type QuestionInput } from '../questions.schema';

export const MAX_IMPORT_QUESTIONS = 1000;

export type Block =
  | { type: 'text'; text: string }
  | { type: 'math'; tex: string }
  | { type: 'image'; assetId: string };

export interface RawOption {
  id: string;
  content: Block[];
}

/** Faylni o'qigichdan chiqqan xom savol (hali tekshirilmagan) */
export interface RawItem {
  /** Excel: qator raqami; Word: savol raqami */
  row: number;
  subjectName: string | null;
  topic: string | null;
  difficulty: number | null;
  type: string | null;
  points: number | null;
  partialCredit: boolean;
  content: Block[];
  options: RawOption[];
  correctIds: string[];
  accepted: string[];
  rubric: string;
  warnings: string[];
  errors: string[];
}

export interface ImportAnswer {
  optionId?: string;
  optionIds?: string[];
  partialCredit?: boolean;
  acceptedAnswers?: string[];
  rubric?: string;
}

/** Sessiyada saqlanadigan va oldindan ko'rishda qaytariladigan savol */
export interface ImportItem {
  row: number;
  subjectName: string | null;
  subjectId: string | null;
  difficulty: number;
  type: QuestionType | null;
  points: number;
  content: Block[];
  options: RawOption[];
  answer: ImportAnswer;
  errors: string[];
  warnings: string[];
}

const TYPE_ALIASES: Record<string, QuestionType> = {
  single: 'single',
  bitta: 'single',
  bittatogri: 'single',
  multi: 'multi',
  multiple: 'multi',
  birnechta: 'multi',
  koptogri: 'multi',
  short: 'short',
  qisqa: 'short',
  qisqajavob: 'short',
  essay: 'essay',
  esse: 'essay',
  ochiq: 'essay',
};

export function parseType(raw: string | null): QuestionType | null | 'bad' {
  if (!raw || !raw.trim()) return null;
  const k = nameKeyOf(raw).replace(/[^a-z]/g, '');
  return TYPE_ALIASES[k] ?? 'bad';
}

export const YES = new Set(['ha', 'yes', 'true', '1', 'da', '+']);

export interface ResolveCtx {
  scope: ExamScope;
  /** nomKey -> subject id (maktabga ko'rinadigan faol fanlar) */
  subjectsByKey: Map<string, string>;
  /** Ruxsat etilgan fan id lari (maktabga ko'rinadigan faol fanlar) */
  subjectIds: Set<string>;
  subjectNames: Map<string, string>;
  /** Import nishoni (mavzu): barcha savollar shu mavzu va uning fani ichiga tushadi */
  defaultSubjectId: string | null;
  topicId: string;
}

export async function loadResolveCtx(
  schoolId: string,
  scope: ExamScope,
  defaultSubjectId: string | null,
  topicId: string,
): Promise<ResolveCtx> {
  const subjects = await Subject.find({
    isActive: true,
    $or: [{ schoolId: null }, { schoolId }],
  })
    .select('name nameKey schoolId')
    .lean();
  const subjectsByKey = new Map<string, string>();
  const subjectNames = new Map<string, string>();
  // Maktab fani umumiy fan bilan bir nomda bo'lmaydi (subjects xizmati), lekin maktabnikini ustun qo'yamiz
  for (const s of subjects.sort((a, b) => Number(!!a.schoolId) - Number(!!b.schoolId))) {
    subjectsByKey.set(s.nameKey, String(s._id));
    subjectNames.set(String(s._id), s.name);
  }
  return {
    scope,
    subjectsByKey,
    subjectNames,
    subjectIds: new Set(subjects.map((s) => String(s._id))),
    defaultSubjectId,
    topicId,
  };
}

/** Fan nomi bo'yicha id; bo'sh nom = standart fan */
export function resolveSubject(name: string | null, ctx: ResolveCtx): string | null {
  if (!name || !name.trim()) return ctx.defaultSubjectId;
  return ctx.subjectsByKey.get(nameKeyOf(name)) ?? null;
}

const ZERO_ID = '000000000000000000000000';

function answerFromRaw(type: QuestionType, r: RawItem): ImportAnswer {
  if (type === 'single') return { optionId: r.correctIds[0] };
  if (type === 'multi') return { optionIds: r.correctIds, partialCredit: r.partialCredit };
  if (type === 'short') return { acceptedAnswers: r.accepted };
  return r.rubric ? { rubric: r.rubric } : {};
}

/** Xom savolni ImportItem ga aylantiradi (turni aniqlaydi) va tekshiradi */
export function finalizeRaw(r: RawItem, ctx: ResolveCtx): ImportItem {
  const errors = [...r.errors];
  let type = parseType(r.type);
  if (type === 'bad') {
    errors.push(`Noma'lum tur: "${r.type}" (single, multi, short, essay)`);
    type = null;
  }
  if (!type) {
    if (r.options.length >= 1) type = r.correctIds.length > 1 ? 'multi' : 'single';
    else if (r.accepted.length) type = 'short';
  }
  // Fayldagi "Fan" va "Mavzu" qiymatlari e'tiborsiz: savollar import nishoni (mavzu)ga tushadi
  const subjectId = ctx.defaultSubjectId;
  const item: ImportItem = {
    row: r.row,
    subjectName: ctx.defaultSubjectId ? (ctx.subjectNames.get(ctx.defaultSubjectId) ?? null) : null,
    subjectId,
    difficulty: r.difficulty ?? 2,
    type,
    points: r.points ?? 1,
    content: r.content,
    options: r.options,
    answer: type ? answerFromRaw(type, r) : {},
    errors,
    warnings: r.warnings,
  };
  const v = validateItem(item, ctx, r.subjectName);
  // Fayl o'qish bosqichidagi xatolar (masalan, noma'lum tur) oldinga qo'yiladi
  return { ...v, errors: [...new Set([...errors, ...v.errors])] };
}

const fieldLabel: Record<string, string> = {
  subjectId: 'Fan',
  topicId: 'Mavzu',
  difficulty: 'Qiyinlik',
  type: 'Tur',
  content: 'Savol matni',
  options: 'Variantlar',
  answer: "To'g'ri javob",
  points: 'Ball',
};

export interface ValidatedItem {
  item: ImportItem;
  parsed: QuestionInput | null;
}

/** Elementni (qayta) tekshiradi: zod qoidalari, fan va o'qituvchi doirasi. `errors` yangilanadi */
export function validateItem(
  item: ImportItem,
  ctx: ResolveCtx,
  subjectNameRaw?: string | null,
): ImportItem {
  return validateItemFull(item, ctx, subjectNameRaw).item;
}

export function validateItemFull(
  item: ImportItem,
  ctx: ResolveCtx,
  subjectNameRaw?: string | null,
): ValidatedItem {
  const errors: string[] = [];
  const out: ImportItem = { ...item, errors };
  const msg = (m: string) => errors.push(m);

  if (!out.subjectId || !ctx.subjectIds.has(out.subjectId)) {
    msg(
      subjectNameRaw || out.subjectName
        ? `Fan topilmadi: "${subjectNameRaw ?? out.subjectName}"`
        : 'Fan ko‘rsatilmagan',
    );
    out.subjectId = null;
  } else if (!ctx.scope.all && !ctx.scope.subjectIds.includes(out.subjectId)) {
    msg('Bu fan sizga biriktirilmagan');
  } else {
    out.subjectName = ctx.subjectNames.get(out.subjectId) ?? out.subjectName;
  }
  if (!out.type) {
    msg("Savol turi aniqlanmadi yoki to'g'ri javob ko'rsatilmagan");
    return { item: out, parsed: null };
  }
  const candidate = {
    subjectId: out.subjectId ?? ZERO_ID,
    topicId: ctx.topicId,
    difficulty: out.difficulty,
    type: out.type,
    content: out.content,
    options: out.type === 'single' || out.type === 'multi' ? out.options : [],
    answer: out.answer,
    points: out.points,
    status: 'draft',
    sharing: { mode: 'private', userIds: [] },
  };
  const r = questionInput.safeParse(candidate);
  if (!r.success) {
    for (const i of r.error.issues) {
      const p = String(i.path[0] ?? '');
      if (p === 'subjectId') continue; // fan xabari yuqorida
      msg(`${fieldLabel[p] ?? p}: ${i.message}`);
    }
    return { item: out, parsed: null };
  }
  if (errors.length) return { item: out, parsed: null };
  return { item: out, parsed: r.data };
}

export const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function importError(message: string, path = 'file') {
  return AppError.validation(message, [{ path, message }]);
}

export { QUESTION_TYPES };
