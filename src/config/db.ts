import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../core/logger';
import { runMigrations } from './migrations';

/**
 * @param opts.autoIndex false bo'lsa indekslar fon rejimida emas, ensureIndexes() orqali ketma-ket yaratiladi
 * @param opts.maxPoolSize seed skriptlari ketma-ket ishlaydi — 1 ta ulanish yetarli (xotiradagi test mongod da parallel ulanishlar qotib qolishi kuzatilgan)
 */
export async function connectDb(
  uri: string = env.MONGODB_URI,
  opts: { autoIndex?: boolean; maxPoolSize?: number } = {},
): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    ...(opts.maxPoolSize ? { maxPoolSize: opts.maxPoolSize } : {}),
    autoIndex: opts.autoIndex ?? true,
    autoCreate: opts.autoIndex ?? true,
  });
  logger.info('MongoDB ulandi');
}

/** Barcha modellarning kolleksiya va indekslarini ketma-ket yaratadi (parallel qurish navbatda qotib qolmasligi uchun) */
export async function ensureIndexes(): Promise<void> {
  await runMigrations();
  for (const m of Object.values(mongoose.models)) {
    await m.createCollection().catch(() => undefined); // mavjud bo'lsa e'tiborsiz
    await m.createIndexes();
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
