import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';
import { FakeTelegram, OTHER_TOKEN, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

const API = '/api/v1/telegram';
let fake: FakeTelegram;
let sa: string;

beforeEach(async () => {
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  await makeUser({ username: 'sa', role: 'superadmin' });
  sa = (await login('sa')).token;
});
afterAll(uninstallTelegram);

const put = (body: object, token = sa) =>
  request(app).put(`${API}/config`).set(bearer(token)).send(body);

describe('GET/PUT/DELETE /telegram/config', () => {
  it('boshlang‘ich holat: sozlanmagan', async () => {
    const res = await request(app).get(`${API}/config`).set(bearer(sa));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        configured: false,
        source: null,
        enabled: false,
        tokenLast4: null,
        botUsername: null,
        botName: null,
        status: 'stopped',
        lastError: null,
        updatedAt: null,
      },
    });
  });

  it('faqat superadmin: school_admin va teacher 403, tokensiz 401', async () => {
    const school = await makeSchool('s1');
    await makeUser({ username: 'adm', role: 'school_admin', schoolId: school.id });
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    for (const u of ['adm', 'tch']) {
      const t = (await login(u)).token;
      expect((await request(app).get(`${API}/config`).set(bearer(t))).status).toBe(403);
      expect((await put({ enabled: false }, t)).status).toBe(403);
      expect((await request(app).delete(`${API}/config`).set(bearer(t))).status).toBe(403);
    }
    expect((await request(app).get(`${API}/config`)).status).toBe(401);
  });

  it('token saqlanadi, bot ishga tushadi, token hech qayerda qaytmaydi', async () => {
    const res = await put({ token: `  ${VALID_TOKEN}  ` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: true,
      source: 'db',
      enabled: true,
      tokenLast4: VALID_TOKEN.slice(-4),
      botUsername: 'yuksalish_test_bot',
      botName: 'Yuksalish Test',
      status: 'running',
      lastError: null,
    });
    expect(fake.started).toEqual([VALID_TOKEN]);

    const get = await request(app).get(`${API}/config`).set(bearer(sa));
    const dump = JSON.stringify([res.body, get.body]);
    expect(dump).not.toContain(VALID_TOKEN);
    expect(dump).not.toContain(VALID_TOKEN.split(':')[1]);

    const doc = await TelegramBotConfig.findOne();
    expect(doc?.tokenEnc).toBeTruthy();
    expect(doc?.tokenEnc).not.toContain(VALID_TOKEN);

    // Audit: token yoq, faqat last4
    const logs = await AuditLog.find({ action: 'telegram.config.update' }).lean();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(VALID_TOKEN);
    expect(JSON.stringify(logs)).toContain(VALID_TOKEN.slice(-4));
  });

  it('notogri format va getMe rad etgan token: VALIDATION_ERROR, path=token', async () => {
    for (const token of ['abc', OTHER_TOKEN]) {
      const res = await put({ token });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details[0]).toEqual({
        path: 'token',
        message: "Token noto'g'ri yoki bot topilmadi",
      });
    }
    expect(await TelegramBotConfig.countDocuments()).toBe(0);
  });

  it('Telegram tarmogi yoq: 502', async () => {
    fake.networkDown = true;
    const res = await put({ token: VALID_TOKEN });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BAD_GATEWAY');
    expect(res.body.error.message).toContain('Telegram');
  });

  it('bosh body va tokensiz enabled=true rad etiladi', async () => {
    expect((await put({})).status).toBe(400);
    const res = await put({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('token');
  });

  it('enabled=false botni toxtatadi, true qayta yoqadi; yangi token qayta ulaydi', async () => {
    await put({ token: VALID_TOKEN });
    let res = await put({ enabled: false });
    expect(res.body.data).toMatchObject({ enabled: false, status: 'stopped', configured: true });
    expect(fake.stopped).toBeGreaterThan(0);
    res = await put({ enabled: true });
    expect(res.body.data).toMatchObject({ enabled: true, status: 'running' });

    fake.validTokens.set(OTHER_TOKEN, { username: 'second_bot', name: 'Second' });
    res = await put({ token: OTHER_TOKEN });
    expect(res.body.data).toMatchObject({ botUsername: 'second_bot', status: 'running' });
    expect(fake.started.at(-1)).toBe(OTHER_TOKEN);
  });

  it('DELETE tokenni ochiradi va botni toxtatadi', async () => {
    await put({ token: VALID_TOKEN });
    const res = await request(app).delete(`${API}/config`).set(bearer(sa));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: false, source: null, status: 'stopped' });
    expect(await TelegramBotConfig.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'telegram.config.delete' })).toBe(1);
  });

  it('JWT siri almashgan (dekripsiya xatosi): status error, "Token qayta kiritilishi kerak"', async () => {
    await TelegramBotConfig.create({
      key: 'platform',
      tokenEnc: encryptToken(VALID_TOKEN, 'x'.repeat(40)),
      tokenLast4: VALID_TOKEN.slice(-4),
      enabled: true,
    });
    await telegramManager.reload();
    const res = await request(app).get(`${API}/config`).set(bearer(sa));
    expect(res.body.data).toMatchObject({
      configured: true,
      source: 'db',
      status: 'error',
      lastError: 'Token qayta kiritilishi kerak',
    });
    const fixed = await put({ token: VALID_TOKEN });
    expect(fixed.body.data).toMatchObject({ status: 'running', lastError: null });
  });

  it('bot ishga tushmasa (polling xato): status error', async () => {
    await put({ token: VALID_TOKEN });
    fake.failStart = new Error('409 Conflict');
    await telegramManager.reload();
    const res = await request(app).get(`${API}/config`).set(bearer(sa));
    expect(res.body.data.status).toBe('error');
    expect(res.body.data.lastError).toBeTruthy();
  });
});
