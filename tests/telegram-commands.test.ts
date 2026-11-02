import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { User } from '../src/models/User';
import { handleIncoming } from '../src/modules/telegram/telegram.bot';
import { syncAllLinkedCommands } from '../src/modules/telegram/telegram.commands';
import { BOT_COMMANDS, telegramManager } from '../src/modules/telegram/telegram.manager';
import { ADMIN_PERMS, app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

const API = '/api/v1/telegram';
let fake: FakeTelegram;
let school: Awaited<ReturnType<typeof makeSchool>>;

const dm = (chatId: number, text: string) =>
  handleIncoming({ chatId, chatType: 'private', text, username: 'u' });

async function linkAs(
  username: string,
  role: 'teacher' | 'school_admin' | 'superadmin',
  chat: number,
) {
  const user = await makeUser({
    username,
    role,
    schoolId: role === 'superadmin' ? undefined : school.id,
  });
  const token = (await login(username)).token;
  const res = await request(app).post(`${API}/me/link`).set(bearer(token));
  const payload = (res.body.data.url as string).split('?start=')[1]!;
  await dm(chat, `/start ${payload}`);
  return { user, token };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  fake = new FakeTelegram();
  fake.install();
  school = await makeSchool('s1');
  const sa = await makeUser({ username: 'sa0', role: 'superadmin' });
  expect(sa).toBeTruthy();
  const t = (await login('sa0')).token;
  await request(app).put(`${API}/config`).set(bearer(t)).send({ token: VALID_TOKEN });
  await settle();
  fake.commandCalls = [];
});
afterAll(uninstallTelegram);

describe('rolga xos bot menyusi', () => {
  it('default scope faqat /help', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(['help']);
  });

  it('o‘qituvchi, maktab admini va superadmin ulanganda tegishli menyu o‘rnatiladi', async () => {
    await linkAs('tch', 'teacher', 11);
    await linkAs('adm', 'school_admin', 12);
    await linkAs('sup', 'superadmin', 13);
    expect(fake.menuOf(11)).toEqual(['bugun', 'ertaga', 'hafta', 'help', 'stop']);
    expect(fake.menuOf(12)).toEqual(['hisobot', 'haftalik', 'help', 'stop']);
    expect(fake.menuOf(13)).toEqual(['hisobot', 'haftalik', 'help', 'stop']);
  });

  it('/stop chat menyusini o‘chiradi', async () => {
    await linkAs('tch', 'teacher', 21);
    await dm(21, '/stop');
    expect(fake.commandCalls.at(-1)).toEqual({ op: 'delete', chatId: 21 });
  });

  it('DELETE /me/link chat menyusini o‘chiradi', async () => {
    const { token } = await linkAs('tch', 'teacher', 22);
    await request(app).delete(`${API}/me/link`).set(bearer(token));
    expect(fake.commandCalls.at(-1)).toEqual({ op: 'delete', chatId: 22 });
  });

  it('chat boshqa foydalanuvchiga ko‘chsa: avval o‘chiriladi, so‘ng yangi rol menyusi', async () => {
    await linkAs('tch', 'teacher', 31);
    fake.commandCalls = [];
    await linkAs('adm', 'school_admin', 31);
    expect(fake.commandCalls).toEqual([
      { op: 'delete', chatId: 31 },
      { op: 'set', chatId: 31, commands: ['hisobot', 'haftalik', 'help', 'stop'] },
    ]);
  });

  it('Telegram xatosi chaqiruvchiga tashlanmaydi', async () => {
    fake.failCommands = true;
    const { user } = await linkAs('tch', 'teacher', 41);
    const u = await User.findById(user.id).select('+telegram.chatId');
    expect(u?.telegram.chatId).toBe(41);
    expect(await dm(41, '/stop')).toContain('uzildi');
  });

  it('bot ishga tushganda ulangan faol foydalanuvchilar sinxronlanadi, nofaollarniki o‘chiriladi', async () => {
    const tch = await linkAs('tch', 'teacher', 51);
    await linkAs('adm', 'school_admin', 52);
    await User.updateOne({ _id: tch.user.id }, { isActive: false });
    fake.commandCalls = [];
    await telegramManager.reload();
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.commandCalls[0]).toEqual({ op: 'set', commands: ['help'] });
    expect(fake.commandCalls).toContainEqual({ op: 'delete', chatId: 51 });
    expect(fake.menuOf(52)).toEqual(['hisobot', 'haftalik', 'help', 'stop']);
  });

  it('syncAllLinkedCommands ulangan chatlar sonini qaytaradi', async () => {
    await linkAs('tch', 'teacher', 61);
    expect(await syncAllLinkedCommands(0)).toBe(1);
  });

  it('foydalanuvchi faolsizlantirilganda chat menyusi o‘chiriladi', async () => {
    const { user } = await linkAs('tch', 'teacher', 71);
    await makeUser({
      username: 'adm0',
      role: 'school_admin',
      schoolId: school.id,
      permissions: ADMIN_PERMS,
    });
    const sup = (await login('adm0')).token;
    fake.commandCalls = [];
    const res = await request(app)
      .patch(`/api/v1/teachers/${user.id}`)
      .set(bearer(sup))
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(fake.commandCalls).toContainEqual({ op: 'delete', chatId: 71 });
  });
});
