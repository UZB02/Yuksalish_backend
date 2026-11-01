import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { TelegramApiError } from '../src/modules/telegram/telegram.client';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import {
  MAX_ATTEMPTS,
  processOutboxOnce,
  telegramNotify,
} from '../src/modules/telegram/telegram.outbox';
import { makeSchool, makeUser, useTestDb } from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

let fake: FakeTelegram;
let uid: string;
let uid2: string;

const link = (id: string, chatId: number) =>
  User.updateOne({ _id: id }, { 'telegram.chatId': chatId, 'telegram.linkedAt': new Date() });

async function startBot() {
  await TelegramBotConfig.create({
    key: 'platform',
    tokenEnc: encryptToken(VALID_TOKEN),
    tokenLast4: VALID_TOKEN.slice(-4),
    botUsername: 'yuksalish_test_bot',
    enabled: true,
  });
  await telegramManager.reload();
}

beforeEach(async () => {
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  const school = await makeSchool('s1');
  uid = (await makeUser({ username: 'u1', role: 'teacher', schoolId: school.id })).id;
  uid2 = (await makeUser({ username: 'u2', role: 'teacher', schoolId: school.id })).id;
});
afterAll(uninstallTelegram);

describe('telegramNotify.enqueue', () => {
  it('bot ishlamayotgan bolsa jim otkazib yuboradi', async () => {
    await link(uid, 1);
    expect(await telegramNotify.enqueue({ userId: uid, text: 'salom', kind: 't' })).toBe(0);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it('ulanmagan yoki nofaol foydalanuvchiga yozmaydi va tashlamaydi', async () => {
    await startBot();
    expect(await telegramNotify.enqueue({ userId: uid, text: 'salom', kind: 't' })).toBe(0);
    await link(uid2, 2);
    await User.updateOne({ _id: uid2 }, { isActive: false });
    expect(await telegramNotify.enqueue({ userId: uid2, text: 'salom', kind: 't' })).toBe(0);
    expect(await telegramNotify.enqueue({ userId: 'not-an-id', text: 'x', kind: 't' })).toBe(0);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it('ulangan foydalanuvchiga yozadi; enqueueMany bir nechtasiga', async () => {
    await startBot();
    await link(uid, 10);
    await link(uid2, 20);
    const n = await telegramNotify.enqueueMany([
      { userId: uid, text: 'a', kind: 'k' },
      { userId: uid2, text: 'b', kind: 'k' },
    ]);
    expect(n).toBe(2);
    const rows = await TelegramOutbox.find().sort({ chatId: 1 });
    expect(rows.map((r) => [r.chatId, r.text, r.status])).toEqual([
      [10, 'a', 'pending'],
      [20, 'b', 'pending'],
    ]);
  });

  it('dedupeKey takroriy xabarni oldini oladi', async () => {
    await startBot();
    await link(uid, 10);
    await telegramNotify.enqueue({ userId: uid, text: 'a', kind: 'k', dedupeKey: 'd1' });
    await telegramNotify.enqueue({ userId: uid, text: 'a', kind: 'k', dedupeKey: 'd1' });
    await telegramNotify.enqueueMany([
      { userId: uid, text: 'a', kind: 'k', dedupeKey: 'd1' },
      { userId: uid, text: 'b', kind: 'k', dedupeKey: 'd2' },
    ]);
    expect(await TelegramOutbox.countDocuments()).toBe(2);
  });

  it('uzun matn 4096 dan bolinadi', async () => {
    await startBot();
    await link(uid, 10);
    const text = Array.from({ length: 900 }, (_, i) => `Qator ${i}`).join('\n');
    await telegramNotify.enqueue({ userId: uid, text, kind: 'k', dedupeKey: 'long' });
    const rows = await TelegramOutbox.find().sort({ _id: 1 });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.text.length <= 4096)).toBe(true);
    expect(rows.map((r) => r.dedupeKey)).toEqual(rows.map((_, i) => `long#${i + 1}`));
  });
});

describe('processOutboxOnce', () => {
  beforeEach(async () => {
    await startBot();
    await link(uid, 10);
  });

  it('xabarlarni mock klient orqali yuboradi va sent deb belgilaydi', async () => {
    await telegramNotify.enqueue({ userId: uid, text: 'salom', kind: 'k' });
    const r = await processOutboxOnce();
    expect(r.sent).toBe(1);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ chatId: 10, text: 'salom', token: VALID_TOKEN });
    const row = await TelegramOutbox.findOne();
    expect(row).toMatchObject({ status: 'sent', attempts: 1 });
    expect(row?.sentAt).toBeTruthy();
    expect(row?.cleanupAt).toBeTruthy();
    expect((await processOutboxOnce()).sent).toBe(0);
  });

  it('sendAfter kelmagan xabar yuborilmaydi', async () => {
    await telegramNotify.enqueue({ userId: uid, text: 'keyin', kind: 'k' });
    await TelegramOutbox.updateOne({}, { sendAfter: new Date(Date.now() + 3600_000) });
    expect((await processOutboxOnce()).sent).toBe(0);
    expect(fake.sent).toHaveLength(0);
  });

  it('429: retry_after gacha kechiktiriladi, urinish hisoblanmaydi, partiya toxtaydi', async () => {
    await telegramNotify.enqueueMany([
      { userId: uid, text: 'a', kind: 'k' },
      { userId: uid, text: 'b', kind: 'k' },
    ]);
    fake.sendErrors.push(new TelegramApiError('Too Many Requests', { code: 429, retryAfter: 7 }));
    const now = new Date();
    const r = await processOutboxOnce(now);
    expect(r.rateLimited).toBe(true);
    expect(r.sent).toBe(0);
    const rows = await TelegramOutbox.find().sort({ _id: 1 });
    expect(rows.map((x) => x.status)).toEqual(['pending', 'pending']);
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.sendAfter.getTime()).toBe(now.getTime() + 7000);
    // Kutilgandan keyin yuboriladi
    const later = new Date(now.getTime() + 8000);
    expect((await processOutboxOnce(later)).sent).toBe(2);
  });

  it('403 (bot bloklangan): xabar failed, foydalanuvchi uziladi, qolgan navbat bekor', async () => {
    await telegramNotify.enqueueMany([
      { userId: uid, text: 'a', kind: 'k' },
      { userId: uid, text: 'b', kind: 'k' },
    ]);
    fake.sendErrors.push(new TelegramApiError('Forbidden: bot was blocked', { code: 403 }));
    const r = await processOutboxOnce();
    expect(r.failed).toBeGreaterThanOrEqual(1);
    const u = await User.findById(uid).select('+telegram.chatId');
    expect(u?.telegram.chatId).toBeNull();
    const rows = await TelegramOutbox.find();
    expect(rows.every((x) => x.status === 'failed')).toBe(true);
    expect(fake.sent).toHaveLength(0);
    const log = await AuditLog.findOne({ action: 'telegram.unlink' });
    expect(log?.after).toMatchObject({ reason: 'bot_blocked' });
  });

  it('vaqtinchalik xato: eksponensial backoff, MAX_ATTEMPTS dan keyin failed', async () => {
    await telegramNotify.enqueue({ userId: uid, text: 'a', kind: 'k' });
    let now = new Date();
    const delays: number[] = [];
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      fake.sendErrors.push(new TelegramApiError('boom', { code: 502 }));
      const r = await processOutboxOnce(now);
      const row = await TelegramOutbox.findOne();
      if (i < MAX_ATTEMPTS) {
        expect(r.retried).toBe(1);
        expect(row?.status).toBe('pending');
        expect(row?.attempts).toBe(i);
        delays.push(row!.sendAfter.getTime() - now.getTime());
        now = row!.sendAfter;
      } else {
        expect(row?.status).toBe('failed');
        expect(row?.attempts).toBe(MAX_ATTEMPTS);
      }
    }
    expect(delays[1]).toBe(delays[0]! * 2);
    expect(delays[2]).toBe(delays[0]! * 4);
  });

  it('doimiy 4xx xato (masalan 400) darhol failed', async () => {
    await telegramNotify.enqueue({ userId: uid, text: 'a', kind: 'k' });
    fake.sendErrors.push(new TelegramApiError('Bad Request: chat not found', { code: 400 }));
    await processOutboxOnce();
    expect(await TelegramOutbox.findOne()).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('yuborishdan oldin uzilgan foydalanuvchiga yuborilmaydi', async () => {
    await telegramNotify.enqueue({ userId: uid, text: 'a', kind: 'k' });
    await User.updateOne({ _id: uid }, { 'telegram.chatId': null });
    const r = await processOutboxOnce();
    expect(r.sent).toBe(0);
    expect(fake.sent).toHaveLength(0);
    expect((await TelegramOutbox.findOne())?.status).toBe('failed');
  });

  it('bot ishlamayotganda hech narsa qilmaydi', async () => {
    await telegramNotify.enqueue({ userId: uid, text: 'a', kind: 'k' });
    await telegramManager.stop();
    expect((await processOutboxOnce()).sent).toBe(0);
    expect((await TelegramOutbox.findOne())?.status).toBe('pending');
  });
});
