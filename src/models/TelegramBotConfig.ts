import { Schema, Types, model } from 'mongoose';

/** Platforma darajasidagi yagona hujjat (key='platform') */
export interface ITelegramBotConfig {
  key: 'platform';
  /** AES-256-GCM: base64(iv + tag + ciphertext). Hech qachon API ga chiqmaydi */
  tokenEnc: string | null;
  tokenLast4: string | null;
  botUsername: string | null;
  botName: string | null;
  enabled: boolean;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ITelegramBotConfig>(
  {
    key: { type: String, enum: ['platform'], default: 'platform', unique: true },
    tokenEnc: { type: String, default: null },
    tokenLast4: { type: String, default: null },
    botUsername: { type: String, default: null },
    botName: { type: String, default: null },
    enabled: { type: Boolean, default: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const TelegramBotConfig = model<ITelegramBotConfig>('TelegramBotConfig', schema);
