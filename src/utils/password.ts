import bcrypt from 'bcrypt';
import { env } from '../config/env';

export const hashPassword = (plain: string) => bcrypt.hash(plain, env.BCRYPT_COST);
export const comparePassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Foydalanuvchi topilmaganda ham vaqt bir xil bo'lishi uchun (timing hujumiga qarshi)
let dummy: string | undefined;
export async function dummyCompare(plain: string): Promise<void> {
  dummy ??= await bcrypt.hash('dummy-password-1', env.BCRYPT_COST);
  await bcrypt.compare(plain, dummy);
}
