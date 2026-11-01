import { Schema, Types, model } from 'mongoose';

export interface ITelegramLinkToken {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const schema = new Schema<ITelegramLinkToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Muddati o'tgan tokenlarni Mongo o'zi o'chiradi
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TelegramLinkToken = model<ITelegramLinkToken>('TelegramLinkToken', schema);
