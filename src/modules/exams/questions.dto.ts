import type { IAnswerKey, IBlock, IOption, QuestionDoc } from '../../models/Question';

// DTO lar OQ RO'YXAT bilan yoziladi: hujjat hech qachon spread qilinmaydi.
// Javob kaliti (`answer`) faqat tahrirlash huquqi bor foydalanuvchiga (toQuestionDto, canEdit=true) chiqadi.

export interface BlockDto {
  type: 'text' | 'math' | 'image';
  text?: string;
  tex?: string;
  assetId?: string;
}

export const toBlockDto = (b: IBlock): BlockDto => {
  if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
  if (b.type === 'math') return { type: 'math', tex: b.tex ?? '' };
  return { type: 'image', assetId: String(b.assetId) };
};

const toOptionDto = (o: IOption) => ({ id: o.id, content: o.content.map(toBlockDto) });

/** Javob kaliti: tur bo'yicha oq ro'yxat */
export function toAnswerDto(type: string, a: IAnswerKey | undefined) {
  const k = a ?? {};
  if (type === 'single') return { optionId: k.optionId ?? null };
  if (type === 'multi') {
    return { optionIds: [...(k.optionIds ?? [])], partialCredit: k.partialCredit ?? false };
  }
  if (type === 'short') return { acceptedAnswers: [...(k.acceptedAnswers ?? [])] };
  return { rubric: k.rubric ?? '' };
}

export interface QuestionRefs {
  subjectName: string | null;
  topicName: string | null;
  authorName: string | null;
}

export const sharingOf = (q: QuestionDoc) => ({
  mode: q.sharing?.mode ?? 'private',
  userIds: (q.sharing?.userIds ?? []).map(String),
});

const common = (q: QuestionDoc, refs: QuestionRefs, canEdit: boolean, mine: boolean) => ({
  id: q.id as string,
  subjectId: String(q.subjectId),
  subjectName: refs.subjectName,
  topicId: String(q.topicId),
  topicName: refs.topicName,
  difficulty: q.difficulty,
  type: q.type,
  points: q.points,
  status: q.status,
  version: q.version ?? 1,
  authorId: String(q.authorId),
  authorName: refs.authorName,
  isMine: mine,
  canEdit,
  /** Ulashilgan (private emas) */
  isShared: (q.sharing?.mode ?? 'private') !== 'private',
  /** Boshqa muallifning savoli menga ulashilgan */
  sharedWithMe: !mine && !canEdit,
  createdAt: q.createdAt,
  updatedAt: q.updatedAt,
});

function previewOf(blocks: IBlock[]): string {
  const t = blocks.find((b) => b.type === 'text' && b.text)?.text;
  if (t) return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  const first = blocks[0];
  return first?.type === 'math' ? (first.tex ?? '').slice(0, 200) : '';
}

/** Ro'yxat DTO: javob kaliti va variantlar YO'Q */
export const toQuestionListDto = (
  q: QuestionDoc,
  refs: QuestionRefs,
  canEdit: boolean,
  mine: boolean,
) => ({
  ...common(q, refs, canEdit, mine),
  preview: previewOf(q.content),
  hasMath: q.content.some((b) => b.type === 'math'),
  hasImage: q.content.some((b) => b.type === 'image'),
  optionsCount: q.options.length,
});

/**
 * To'liq DTO. Ko'ra oladigan har kim (muallif, ma'muriyat, ulashilgan o'qituvchi) javob kalitini
 * ham oladi: ulashish muallif ruxsati bilan. Ulashish sozlamasini faqat tahrir huquqi borlar ko'radi.
 */
export const toQuestionDto = (
  q: QuestionDoc,
  refs: QuestionRefs,
  canEdit: boolean,
  mine: boolean,
) => ({
  ...common(q, refs, canEdit, mine),
  content: q.content.map(toBlockDto),
  options: q.options.map(toOptionDto),
  answer: toAnswerDto(q.type, q.answer),
  ...(canEdit ? { sharing: sharingOf(q) } : {}),
});

/**
 * Audit uchun XULOSA: javob kaliti, matn va variantlar yozilmaydi (faqat kalit borligi va sanoqlar).
 */
export const questionAuditSummary = (q: QuestionDoc) => ({
  subjectId: String(q.subjectId),
  topicId: String(q.topicId),
  difficulty: q.difficulty,
  type: q.type,
  status: q.status,
  points: q.points,
  version: q.version ?? 1,
  contentBlocks: q.content.length,
  optionsCount: q.options.length,
  sharingMode: q.sharing?.mode ?? 'private',
  sharedCount: q.sharing?.userIds?.length ?? 0,
  hasAnswerKey: !!(
    q.answer?.optionId ||
    q.answer?.optionIds?.length ||
    q.answer?.acceptedAnswers?.length ||
    q.answer?.rubric
  ),
});
