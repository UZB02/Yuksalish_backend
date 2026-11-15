import { HydratedDocument, Schema, Types, model } from 'mongoose';

export const QUESTION_TYPES = ['single', 'multi', 'short', 'essay'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_STATUSES = ['draft', 'active', 'archived'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** Kontent bloki: HTML saqlanmaydi, faqat strukturaviy bloklar */
export interface IBlock {
  type: 'text' | 'math' | 'image';
  text?: string;
  tex?: string;
  assetId?: Types.ObjectId;
}

export interface IOption {
  id: string;
  content: IBlock[];
}

/** Javob kaliti: alohida maydon, DTO lar uni oq ro'yxat bilan chiqaradi (yoki umuman chiqarmaydi) */
export interface IAnswerKey {
  /** single */
  optionId?: string;
  /** multi */
  optionIds?: string[];
  partialCredit?: boolean;
  /** short */
  acceptedAnswers?: string[];
  /** essay */
  rubric?: string;
}

export const SHARING_MODES = ['private', 'subject', 'users'] as const;
export type SharingMode = (typeof SHARING_MODES)[number];

/**
 * Ulashish (muallif ruxsati bilan). Maydon yo'q (eski hujjat) = 'private'.
 * subject: shu fanni faol yilda o'qitadigan maktab o'qituvchilari; users: tanlangan o'qituvchilar.
 */
export interface ISharing {
  mode: SharingMode;
  userIds: Types.ObjectId[];
}

export interface IQuestion {
  schoolId: Types.ObjectId;
  /** 'school' (standart). Kelajakda umumiy bank uchun 'global' qo'shilishi mumkin */
  scope: 'school';
  subjectId: Types.ObjectId;
  /** Mavzu (ExamTopic). subjectId mavzuning fani bilan bir xil (filtr va doira uchun denormallashgan) */
  topicId: Types.ObjectId;
  difficulty: 1 | 2 | 3;
  type: QuestionType;
  content: IBlock[];
  options: IOption[];
  answer: IAnswerKey;
  points: number;
  sharing?: ISharing;
  status: QuestionStatus;
  /** Mazmun/kalit o'zgarganda oshadi */
  version: number;
  authorId: Types.ObjectId;
  isDeleted: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type QuestionDoc = HydratedDocument<IQuestion>;

const blockSchema = new Schema<IBlock>(
  {
    type: { type: String, enum: ['text', 'math', 'image'], required: true },
    text: { type: String },
    tex: { type: String },
    assetId: { type: Schema.Types.ObjectId, ref: 'ExamAsset' },
  },
  { _id: false },
);

const optionSchema = new Schema<IOption>(
  {
    id: { type: String, required: true },
    content: { type: [blockSchema], default: [] },
  },
  { _id: false },
);

const answerSchema = new Schema<IAnswerKey>(
  {
    optionId: { type: String },
    optionIds: { type: [String], default: undefined },
    partialCredit: { type: Boolean },
    acceptedAnswers: { type: [String], default: undefined },
    rubric: { type: String },
  },
  { _id: false },
);

const sharingSchema = new Schema<ISharing>(
  {
    mode: { type: String, enum: SHARING_MODES, default: 'private' },
    userIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

const questionSchema = new Schema<IQuestion>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    scope: { type: String, enum: ['school'], default: 'school' },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
    topicId: { type: Schema.Types.ObjectId, ref: 'ExamTopic', required: true },
    difficulty: { type: Number, enum: [1, 2, 3], default: 2 },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    content: { type: [blockSchema], default: [] },
    options: { type: [optionSchema], default: [] },
    answer: { type: answerSchema, default: () => ({}) },
    points: { type: Number, default: 1 },
    sharing: { type: sharingSchema, default: () => ({ mode: 'private', userIds: [] }) },
    status: { type: String, enum: QUESTION_STATUSES, default: 'draft' },
    version: { type: Number, default: 1 },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Faqat qidiruv indekslari. UNIQUE yo'q: bir xil savollar normal holat
questionSchema.index({ schoolId: 1, subjectId: 1, status: 1 });
questionSchema.index({ schoolId: 1, authorId: 1 });
questionSchema.index({ schoolId: 1, topicId: 1, status: 1 });

export const Question = model<IQuestion>('Question', questionSchema);
