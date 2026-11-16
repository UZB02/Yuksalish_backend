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

export interface IExamTemplate {
  schoolId: Types.ObjectId;
  title: string;
  subjectId: Types.ObjectId | null;
  sections: IExamSection[];
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

const schema = new Schema<IExamTemplate>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    title: { type: String, required: true, trim: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    sections: sectionsField,
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
