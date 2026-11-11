import type { Types } from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { School } from '../src/models/School';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { settingsStore } from '../src/modules/settings/settings.store';
import { handleIncoming, handleIncomingRich } from '../src/modules/telegram/telegram.bot';
import type { BotReply } from '../src/modules/telegram/telegram.client';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { commandsForRole } from '../src/modules/telegram/telegram.menu';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { runDailyReports, runWeeklyReports } from '../src/modules/telegram/telegram.report';
import { handleSettingsCallback } from '../src/modules/telegram/telegram.superadmin';
import { clock } from '../src/utils/clock';
import { makeSchool, makeUser, makeYear, useTestDb } from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
const DAILY = new Date('2026-11-04T11:00:00Z'); // chorshanba, Toshkent 16:00
const WEEKLY = new Date('2026-11-07T12:00:00Z'); // shanba, Toshkent 17:00

let fake: FakeTelegram;
let sA: Doc, sB: Doc, sC: Doc;
let adminA: Doc, root: Doc;

const link = (id: string, chatId: number) =>
  User.updateOne({ _id: id }, { 'telegram.chatId': chatId, 'telegram.linkedAt': new Date() });
const scopeOf = async (id: string) =>
  (await User.findById(id).select('telegram.reportScope'))?.telegram?.reportScope ?? null;
const setScope = (id: string, v: string | null) =>
  User.updateOne({ _id: id }, { 'telegram.reportScope': v });
const sentTo = async (chatId: number) =>
  (await TelegramOutbox.find({ chatId }).sort({ _id: 1 })).map((r) => r.text);
const kinds = async (chatId: number) =>
  (await TelegramOutbox.find({ chatId })).map((r) => r.dedupeKey);
const cb = (chatId: number, data: string, chatType = 'private') =>
  handleSettingsCallback({ chatId, chatType, data });
const buttons = (r: BotReply) => r.keyboard!.flat();

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
  clock.set(() => DAILY);
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  sA = await makeSchool('sa1');
  sB = await makeSchool('sa2');
  sC = await makeSchool('sa3');
  for (const s of [sA, sB, sC]) await makeYear(s.id);
  adminA = await makeUser({ username: 'sa_admin', role: 'school_admin', schoolId: sA.id });
  root = await makeUser({ username: 'sa_root', role: 'superadmin' });
  await link(adminA.id, 201);
  await link(root.id, 900);
});
afterAll(uninstallTelegram);

describe('rejali hisobot: superadmin', () => {
  it('reportScope null (default): superadmin hech narsa olmaydi, school_admin esa oladi', async () => {
    await startBot();
    await runDailyReports(DAILY);
    expect(await sentTo(900)).toEqual([]);
    expect((await sentTo(201)).length).toBe(1);
  });

  it("'all': har bir faol maktab hisobotini oladi (kunlik va haftalik)", async () => {
    await startBot();
    await setScope(root.id, 'all');
    const r = await runDailyReports(DAILY);
    expect(r.sent).toBe(4); // sA: admin + root, sB: root, sC: root
    const texts = await sentTo(900);
    expect(texts.length).toBe(3);
    for (const n of ['sa1', 'sa2', 'sa3']) expect(texts.join('\n')).toContain(`Maktab ${n}`);
    const w = await runWeeklyReports(WEEKLY);
    expect(w.sent).toBe(4);
    expect((await kinds(900)).filter((k) => k!.startsWith('weekly:')).length).toBe(3);
  });

  it('bitta maktab tanlangan: faqat shu maktab hisoboti (kunlik va haftalik)', async () => {
    await startBot();
    await setScope(root.id, sB.id);
    await runDailyReports(DAILY);
    await runWeeklyReports(WEEKLY);
    const keys = await kinds(900);
    expect(keys.sort()).toEqual(
      [`daily:${sB.id}:${root.id}:2026-11-04`, `weekly:${sB.id}:${root.id}:2026-W45`].sort(),
    );
    expect((await sentTo(900)).join('\n')).not.toContain('Maktab sa1');
  });

  it('faol bo‘lmagan, ulanmagan superadmin va maydoni yo‘q eski hujjat hech narsa olmaydi', async () => {
    await startBot();
    const off = await makeUser({ username: 'sa_off', role: 'superadmin', isActive: false });
    await link(off.id, 901);
    await setScope(off.id, 'all');
    const unl = await makeUser({ username: 'sa_unl', role: 'superadmin' });
    await setScope(unl.id, 'all'); // chat ulanmagan
    const legacy = await makeUser({ username: 'sa_legacy', role: 'superadmin' });
    await link(legacy.id, 902);
    await User.collection.updateOne(
      { _id: legacy._id },
      { $unset: { 'telegram.reportScope': '' } },
    );
    await runDailyReports(DAILY);
    expect(await TelegramOutbox.countDocuments({ chatId: { $in: [900, 901, 902] } })).toBe(0);
    expect(await TelegramOutbox.countDocuments({ userId: unl._id })).toBe(0);
  });

  it('faol bo‘lmagan yoki o‘chirilgan maktab tanlangan bo‘lsa hech narsa yuborilmaydi', async () => {
    await startBot();
    await setScope(root.id, sC.id);
    await School.updateOne({ _id: sC.id }, { isActive: false });
    await runDailyReports(DAILY);
    expect(await sentTo(900)).toEqual([]);
    await setScope(root.id, '64b000000000000000000001'); // mavjud emas
    await runDailyReports(DAILY);
    expect(await sentTo(900)).toEqual([]);
  });

  it('school_admin yo‘q maktab uchun ham obunachi superadminga yuboriladi', async () => {
    await startBot();
    await setScope(root.id, sB.id); // sB da school_admin yo'q
    const r = await runDailyReports(DAILY);
    expect(r.sent).toBe(2); // sA admini + root
    expect((await sentTo(900))[0]).toContain('Maktab sa2');
  });

  it('maktabning o‘z sozlamasi qachon va yuborilish-yuborilmasligini hal qiladi', async () => {
    await startBot();
    await setScope(root.id, 'all');
    await settingsStore.set(
      'school',
      sA.id,
      'telegram',
      { notify: { dailyReport: false } },
      root.id,
    );
    await runDailyReports(DAILY);
    const texts = (await sentTo(900)).join('\n');
    expect(texts).not.toContain('Maktab sa1');
    expect(texts).toContain('Maktab sa2');
    expect(await sentTo(201)).toEqual([]);
  });

  it('takroriy chaqiruv dublikat yaratmaydi (dedupeKey)', async () => {
    await startBot();
    await setScope(root.id, 'all');
    await runDailyReports(DAILY);
    await runDailyReports(DAILY);
    await runWeeklyReports(WEEKLY);
    await runWeeklyReports(WEEKLY);
    expect(await TelegramOutbox.countDocuments({ chatId: 900 })).toBe(6);
  });
});

describe('/sozlamalar va callback', () => {
  const say = (chatId: number, text: string) =>
    handleIncomingRich({ chatId, chatType: 'private', text, username: null });

  it('superadmin klaviatura va hozirgi tanlovni (✅) ko‘radi', async () => {
    const r = (await say(900, '/sozlamalar')) as BotReply;
    expect(r.text).toContain("Kunlik va haftalik hisobotlar qaysi maktab bo'yicha yuborilsin?");
    expect(r.text).toContain('o‘chiq');
    const labels = buttons(r).map((b) => b.text);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Maktab sa1',
        'Maktab sa2',
        'Maktab sa3',
        '🏫 Barcha maktablar',
        '✅ 🔕 O‘chirish',
      ]),
    );
    for (const b of buttons(r)) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
    await setScope(root.id, sB.id);
    const r2 = (await say(900, '/sozlamalar@bot')) as BotReply;
    expect(buttons(r2).map((b) => b.text)).toContain('✅ Maktab sa2');
    expect(r2.text).toContain('Hozirgi tanlov: Maktab sa2');
  });

  it('school_admin va ulanmagan chat rad etiladi; handleIncoming bilan mos', async () => {
    expect(await say(201, '/sozlamalar')).toBe('Bu bo‘lim faqat superadmin uchun.');
    expect(typeof (await say(555, '/sozlamalar'))).toBe('string');
    expect(
      await handleIncoming({ chatId: 900, chatType: 'private', text: '/help', username: null }),
    ).toContain('/sozlamalar');
    expect(commandsForRole('superadmin').map((c) => c.command)).toContain('sozlamalar');
    expect(commandsForRole('school_admin').map((c) => c.command)).not.toContain('sozlamalar');
  });

  it('maktab, barcha maktablar va o‘chirishni saqlaydi, xabarni yangilaydi, audit yozadi', async () => {
    const r1 = (await cb(900, `rs:s:${sA.id}:0`))!;
    expect(r1.answer).toBe('Saqlandi');
    expect(await scopeOf(root.id)).toBe(sA.id);
    expect(buttons(r1.edit!).map((b) => b.text)).toContain('✅ Maktab sa1');
    expect(r1.edit!.text).toContain('✅ Saqlandi: Maktab sa1');
    const r2 = (await cb(900, 'rs:a:0'))!;
    expect(await scopeOf(root.id)).toBe('all');
    expect(buttons(r2.edit!).map((b) => b.text)).toContain('✅ 🏫 Barcha maktablar');
    const r3 = (await cb(900, 'rs:o:0'))!;
    expect(await scopeOf(root.id)).toBeNull();
    expect(r3.edit!.text).toContain('o‘chirildi');
    const logs = await AuditLog.find({ action: 'telegram.report_scope' }).sort({ _id: 1 });
    expect(logs.length).toBe(3);
    expect(logs[0]!.after).toEqual({ reportScope: sA.id });
  });

  it('o‘zgarmagan tanlov audit yozmaydi; faol bo‘lmagan/yo‘q maktab rad etiladi', async () => {
    await cb(900, 'rs:a:0');
    await cb(900, 'rs:a:0');
    expect(await AuditLog.countDocuments({ action: 'telegram.report_scope' })).toBe(1);
    await School.updateOne({ _id: sC.id }, { isActive: false });
    const r = (await cb(900, `rs:s:${sC.id}:0`))!;
    expect(r.answer).toContain('topilmadi');
    expect(await scopeOf(root.id)).toBe('all');
    const bad = (await cb(900, 'rs:s:zzz:0'))!;
    expect(bad.answer).toBe('Noma‘lum amal.');
    expect(await cb(900, 'xx:a:0')).toBeNull();
    expect(await cb(900, 'rs:a:0', 'group')).toBeNull();
  });

  it('school_admin, o‘chirilgan superadmin va ulanmagan chat soxta callback bilan o‘zgartira olmaydi', async () => {
    const r = (await cb(201, 'rs:a:0'))!;
    expect(r.answer).toBe('Bu bo‘lim faqat superadmin uchun.');
    expect(r.edit).toBeUndefined();
    expect(await scopeOf(adminA.id)).toBeNull();
    expect((await cb(555, 'rs:a:0'))!.answer).toContain('ulanmagan');
    await User.updateOne({ _id: root.id }, { isActive: false });
    expect((await cb(900, 'rs:a:0'))!.answer).toContain('ulanmagan');
    expect(await scopeOf(root.id)).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'telegram.report_scope' })).toBe(0);
  });

  it('8 tadan ko‘p maktabda sahifalanadi', async () => {
    for (let i = 0; i < 9; i++) await makeSchool(`pg${i}`);
    const r = (await say(900, '/sozlamalar')) as BotReply;
    const schoolBtns = buttons(r).filter((b) => b.data.startsWith('rs:s:'));
    expect(schoolBtns.length).toBe(8);
    expect(buttons(r).map((b) => b.text)).toContain('Keyingi ➡️');
    expect(buttons(r).map((b) => b.text)).not.toContain('⬅️ Oldingi');
    const p2 = (await cb(900, 'rs:p:1'))!;
    expect(p2.edit!.text).toContain('Sahifa 2/2');
    expect(buttons(p2.edit!).filter((b) => b.data.startsWith('rs:s:')).length).toBe(4);
    expect(buttons(p2.edit!).map((b) => b.text)).toContain('⬅️ Oldingi');
    // Sahifadagi maktabni tanlash sahifani saqlaydi
    const pick = buttons(p2.edit!).find((b) => b.data.startsWith('rs:s:'))!;
    const saved = (await cb(900, pick.data))!;
    expect(saved.edit!.text).toContain('Sahifa 2/2');
    expect(await scopeOf(root.id)).toBe(pick.data.split(':')[2]);
  });
});
