import { HydratedDocument, Schema, Types, model } from 'mongoose';

export const BEHAVIOR_KINDS = ['positive', 'negative', 'neutral'] as const;
export type BehaviorKind = (typeof BEHAVIOR_KINDS)[number];

export interface IBehaviorType {
  /** null = global (barcha maktablar uchun) */
  schoolId: Types.ObjectId | null;
  name: string;
  nameKey: string;
  kind: BehaviorKind;
  color: string;
  order: number;
  minScore: number | null;
  maxScore: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type BehaviorTypeDoc = HydratedDocument<IBehaviorType>;

const behaviorTypeSchema = new Schema<IBehaviorType>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    kind: { type: String, enum: BEHAVIOR_KINDS, required: true },
    color: { type: String, required: true },
    order: { type: Number, default: 0 },
    minScore: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Nom scope (global yoki maktab) ichida unique
behaviorTypeSchema.index({ schoolId: 1, nameKey: 1 }, { unique: true });

export const BehaviorType = model<IBehaviorType>('BehaviorType', behaviorTypeSchema);
