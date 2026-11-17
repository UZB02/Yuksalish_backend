import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Imtihon shabloni: bo'limlar, har bir bo'limda qo'lda tanlangan savollar va/yoki qoidalar
 * ("shu mavzudan N ta, qiyinlik X"). Qoida bo'yicha savollar ishtirokchi urinishi boshlanganda
 * (E4) deterministik seed bilan tanlanadi, shuning uchun har ishtirokchida to'plam farq qilishi mumkin.
 */
export interface IExamItemManual {
  kind: 'manual';
  questionIds: Types.ObjectId[];
}
export interface IExamItemRule {
  kind: 'rule';
  topicId: Types.ObjectId;
  count: number;
  /** 1..3, yo'q = istalgan */
  difficulty?: number | null;
  /** single|multi|short|essay, yo'q = istalgan */
  type?: string | null;
}
export type IExamItem = IExamItemManual | IExamItemRule;
export interface IExamSection {
  title: string;
  items: IExamItem[];
}

export const SCORING_MODES = ['points', 'coefficient'] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];
export const TIMING_MODES = ['common', 'per_block'] as const;
export type TimingMode = (typeof TIMING_MODES)[number];
export const BLOCK_STATUSES = ['open', 'ready'] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

/** Blokka biriktirilgan o'qituvchi qo'shgan savol (tuzuvchi ro'yxatidan alohida: bir-birini bosib yubormaydi) */
export interface IBlockContribQuestion {
  questionId: Types.ObjectId;
  addedBy: Types.ObjectId;
  addedAt: Date;
}

/**
 * Imtihon bloki (bitta fan). `items`: tuzuvchi qo'ygan qo'lda/qoida elementlari; `contribQuestions`:
 * biriktirilgan o'qituvchilar qo'shgan savollar. Eski hujjatlarda `blocks` yo'q: blocks.core.ts normalizatori
 * `sections` + `subjectId` dan BITTA blok yasaydi (migratsiya yo'q).
 */
export interface IExamBlock {
  blockId: string;
  subjectId: Types.ObjectId;
  title: string;
  targetCount: number;
  coefficient: number;
  durationMin: number | null;
  contributors: Types.ObjectId[];
  items: IExamItem[];
  contribQuestions: IBlockContribQuestion[];
  status: BlockStatus;
}

export interface IExamTemplate {
  schoolId: Types.ObjectId;
  title: string;
  subjectId: Types.ObjectId | null;
  sections: IExamSection[];
  blocks: IExamBlock[];
  scoringMode: ScoringMode;
  timingMode: TimingMode;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  createdBy: Types.ObjectId;
  isDeleted: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamTemplateDoc = HydratedDocument<IExamTemplate>;

/** Bo'lim tuzilmasi sessiyada ham shu sxema bilan saqlanadi (nusxa) */
export const sectionsField = {
  type: [
    new Schema(
      {
        title: { type: String, required: true },
        items: { type: [Schema.Types.Mixed], default: [] },
      },
      { _id: false },
    ),
  ],
  default: [],
};

/** Bloklar sessiyada ham shu sxema bilan saqlanadi */
export const blocksField = {
  type: [
    new Schema(
      {
        blockId: { type: String, required: true },
        subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
        title: { type: String, default: '' },
        targetCount: { type: Number, default: 0 },
        coefficient: { type: Number, default: 1 },
        durationMin: { type: Number, default: null },
        contributors: { type: [Schema.Types.ObjectId], default: [] },
        items: { type: [Schema.Types.Mixed], default: [] },
        contribQuestions: { type: [Schema.Types.Mixed], default: [] },
        status: { type: String, enum: BLOCK_STATUSES, default: 'open' },
      },
      { _id: false },
    ),
  ],
  default: [],
};

const schema = new Schema<IExamTemplate>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    title: { type: String, required: true, trim: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    sections: sectionsField,
    blocks: blocksField,
    scoringMode: { type: String, enum: SCORING_MODES, default: 'points' },
    timingMode: { type: String, enum: TIMING_MODES, default: 'common' },
    shuffleQuestions: { type: Boolean, default: true },
    shuffleOptions: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ schoolId: 1, isDeleted: 1, createdBy: 1 });

export const ExamTemplate = model<IExamTemplate>('ExamTemplate', schema);
