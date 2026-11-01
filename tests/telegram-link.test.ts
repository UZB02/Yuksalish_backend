import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { TelegramLinkToken } from '../src/models/TelegramLinkToken';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { handleIncoming } from '../src/modules/telegram/telegram.bot';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { clock } from '../src/utils/clock';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

const API = '/api/v1/telegram';
let fake: FakeTelegram;
let sa: string;
let tch: string;
let tchId: string;
let school: Awaited<ReturnType<typeof makeSchool>>;

const dm = (chatId: number, text: string, username: string | null = 'tg_user') =>
  handleIncoming({ chatId, chatType: 'private', text, username });

const issue = async (token = tch) => {
  const res = await request(app).post(`${API}/me/link`).set(bearer(token));
  const url: string = res.body?.data?.url ?? '';
  return { res, payload: url.split('?start=')[1] ?? '' };
};

const chatIdOf = async (id: string) =>
  (await User.findById(id).select('+telegram.chatId'))?.telegram.chatId ?? null;

beforeEach(async () => {
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  school = await makeSchool('s1');
  await makeUser({ username: 'sa', role: 'superadmin' });
  tchId = (await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id })).id;
  sa = (await login('sa')).token;
  tch = (await login('tch')).token;
});
afterAll(uninstallTelegram);

const enableBot = () =>
  request(app).put(`${API}/config`).set(bearer(sa)).send({ token: VALID_TOKEN });

describe('GET /telegram/me', () => {
  it('bot sozlanmagan: available=false', async () => {
    const res = await request(app).get(`${API}/me`).set(bearer(tch));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      available: false,
      botUsername: null,
      linked: false,
      username: null,
      linkedAt: null,
    });
    expect((await request(app).get(`${API}/me`)).status).toBe(401);
  });

  it('bot ishlayotganda available=true va botUsername', async () => {
    await enableBot();
    const res = await request(app).get(`${API}/me`).set(bearer(tch));
    expect(res.body.data).toMatchObject({
      available: true,
      botUsername: 'yuksalish_test_bot',
      linked: false,
    });
  });
});

describe('POST /telegram/me/link', () => {
  it('bot sozlanmagan: 503 va ozbekcha xabar', async () => {
    const { res } = await issue();
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe('Telegram bot hozircha sozlanmagan');
  });

  it('havola t.me/<bot>?start=<token>, token 64 belgidan oshmaydi va bazada xesh', async () => {
    await enableBot();
    const { res, payload } = await issue();
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(`https://t.me/yuksalish_test_bot?start=${payload}`);
    expect(payload).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    const exp = new Date(res.body.data.expiresAt).getTime();
    expect(exp - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const row = await TelegramLinkToken.findOne();
    expect(row?.tokenHash).not.toContain(payload);
  });

  it('yangi havola oldingisini bekor qiladi', async () => {
    await enableBot();
    const first = await issue();
    const second = await issue();
    expect(await TelegramLinkToken.countDocuments()).toBe(1);
    expect(await dm(111, `/start ${first.payload}`)).toContain('yaroqsiz');
    expect(await dm(111, `/start ${second.payload}`)).toContain('ulandi');
  });
});

describe('bot buyruqlari', () => {
  beforeEach(async () => {
    await enableBot();
  });

  it('/start <token> hisobni ulaydi, /me linked=true; chatId API da korinmaydi', async () => {
    const { payload } = await issue();
    const reply = await dm(555, `/start ${payload}`, 'ali_tg');
    expect(reply).toContain('Salom, Test tch!');
    expect(reply).toContain('ulandi');
    expect(await chatIdOf(tchId)).toBe(555);

    const me = await request(app).get(`${API}/me`).set(bearer(tch));
    expect(me.body.data).toMatchObject({ linked: true, username: 'ali_tg' });
    expect(me.body.data.linkedAt).toBeTruthy();
    expect(JSON.stringify(me.body)).not.toContain('chatId');

    const auth = await request(app).get('/api/v1/auth/me').set(bearer(tch));
    expect(JSON.stringify(auth.body)).not.toContain('chatId');
    expect(await AuditLog.countDocuments({ action: 'telegram.link' })).toBe(1);
  });

  it('token bir martalik', async () => {
    const { payload } = await issue();
    expect(await dm(1, `/start ${payload}`)).toContain('ulandi');
    expect(await dm(2, `/start ${payload}`)).toContain('yaroqsiz');
    expect(await chatIdOf(tchId)).toBe(1);
  });

  it('muddati otgan token rad etiladi', async () => {
    const { payload } = await issue();
    clock.set(() => new Date(Date.now() + 16 * 60_000));
    const reply = await dm(1, `/start ${payload}`);
    expect(reply).toContain('muddati tugagan');
    expect(reply).toContain('Admin panel');
    expect(await chatIdOf(tchId)).toBeNull();
  });

  it('notogri token va tokensiz /start, /help: yordam', async () => {
    expect(await dm(1, '/start nope_nope')).toContain('yaroqsiz');
    expect(await dm(1, '/start')).toContain('profil sahifasi');
    expect(await dm(1, '/help')).toContain('profil sahifasi');
    expect(await dm(1, 'salom')).toContain('/help');
  });

  it('faol bolmagan foydalanuvchi ulanmaydi', async () => {
    const { payload } = await issue();
    await User.updateOne({ _id: tchId }, { isActive: false });
    expect(await dm(1, `/start ${payload}`)).toContain('faol emas');
    expect(await chatIdOf(tchId)).toBeNull();
  });

  it('shaxsiy bolmagan chatlar eʼtiborsiz', async () => {
    const { payload } = await issue();
    const r = await handleIncoming({
      chatId: -100,
      chatType: 'group',
      text: `/start ${payload}`,
      username: null,
    });
    expect(r).toBeNull();
    expect(await chatIdOf(tchId)).toBeNull();
  });

  it('chat boshqa foydalanuvchiga otkazilsa eskisi uziladi', async () => {
    const other = await makeUser({ username: 'tch2', role: 'teacher', schoolId: school.id });
    const t2 = (await login('tch2')).token;
    await dm(777, `/start ${(await issue()).payload}`);
    expect(await chatIdOf(tchId)).toBe(777);

    expect(await dm(777, `/start ${(await issue(t2)).payload}`)).toContain('ulandi');
    expect(await chatIdOf(other.id)).toBe(777);
    expect(await chatIdOf(tchId)).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'telegram.unlink' })).toBe(1);
  });

  it('/stop ulanishni uzadi', async () => {
    await dm(42, `/start ${(await issue()).payload}`);
    expect(await dm(42, '/stop')).toContain('uzildi');
    expect(await chatIdOf(tchId)).toBeNull();
    expect(await dm(42, '/stop')).toContain('ulanmagan');
    const log = await AuditLog.findOne({ action: 'telegram.unlink' });
    expect(log?.after).toMatchObject({ reason: 'bot_stop' });
  });
});

describe('DELETE /telegram/me/link', () => {
  it('uzadi, /me shaklini qaytaradi va vidolashuv xabarini navbatga qoyadi', async () => {
    await enableBot();
    await dm(9, `/start ${(await issue()).payload}`);
    const res = await request(app).delete(`${API}/me/link`).set(bearer(tch));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ linked: false, username: null, linkedAt: null });
    expect(await chatIdOf(tchId)).toBeNull();
    const out = await TelegramOutbox.find({ userId: tchId });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chatId: 9, kind: 'unlink', status: 'pending' });
    expect(await AuditLog.countDocuments({ action: 'telegram.unlink' })).toBe(1);
  });

  it('ulanmagan foydalanuvchi uchun ham xatosiz', async () => {
    const res = await request(app).delete(`${API}/me/link`).set(bearer(tch));
    expect(res.status).toBe(200);
    expect(res.body.data.linked).toBe(false);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });
});
