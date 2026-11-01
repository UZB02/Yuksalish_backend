import { Schema, Types, model } from 'mongoose';

export const OUTBOX_STATUSES = ['pending', 'sent', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface ITelegramOutbox {
  userId: Types.ObjectId;
  chatId: number;
  text: string;
  parseMode: 'HTML' | 'MarkdownV2' | null;
  kind: string;
  status: OutboxStatus;
  attempts: number;
  sendAfter: Date;
  lastError: string | null;
  dedupeKey?: string;
  sentAt: Date | null;
  /** sent/failed bo'lganda o'rnatiladi; TTL indeks shu bo'yicha tozalaydi */
  cleanupAt?: Date;
  createdAt: Date;
}

const schema = new Schema<ITelegramOutbox>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    chatId: { type: Number, required: true },
    text: { type: String, required: true },
    parseMode: { type: String, enum: ['HTML', 'MarkdownV2', null], default: null },
    kind: { type: String, required: true },
    status: { type: String, enum: OUTBOX_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    sendAfter: { type: Date, default: () => new Date() },
    lastError: { type: String, default: null },
    dedupeKey: { type: String },
    sentAt: { type: Date, default: null },
    cleanupAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ status: 1, sendAfter: 1 });
schema.index({ userId: 1, status: 1 });
schema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
schema.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });

export const TelegramOutbox = model<ITelegramOutbox>('TelegramOutbox', schema);
