import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { AuditLog } from '../src/models/AuditLog';
import { PasswordResetCode } from '../src/models/PasswordResetCode';
import { RefreshToken } from '../src/models/RefreshToken';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { passwordResetService } from '../src/modules/auth/password-reset.service';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { clock } from '../src/utils/clock';
import { app, bearer, login, makeSchool, makeUser, PASSWORD, useTestDb } from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

const API = '/api/v1/auth/password-reset';
const NEW_PASSWORD = 'NewPassw0rd9';
const CHAT = 555001;

let fake: FakeTelegram;
let sa: string;
let school: Awaited<ReturnType<typeof makeSchool>>;
let tchId: string;

const link = (id: string, chatId = CHAT) =>
  User.updateOne(
    { _id: id },
    { $set: { 'telegram.chatId': chatId, 'telegram.linkedAt': new Date() } },
  );
const enableBot = async () => {
  await request(app).put('/api/v1/telegram/config').set(bearer(sa)).send({ token: VALID_TOKEN });
};
const requestCode = async (username = 'tch') => {
  const res = await request(app).post(`${API}/request`).send({ username });
  await passwordResetService.flush();
  return res;
};
const lastCode = () => {
  const m = fake.sent[fake.sent.length - 1]?.text.match(/<b>(\d{6})<\/b>/);
  return m ? m[1] : '';
};
const verify = (code: string, username = 'tch') =>
  request(app).post(`${API}/verify`).send({ username, code });
const complete = (resetToken: string, password = NEW_PASSWORD) =>
  request(app).post(`${API}/complete`).send({ resetToken, password });
const wrongCode = () => (lastCode() === '000000' ? '111111' : '000000');
const tokenFor = async (username = 'tch') => {
  await requestCode(username);
  const res = await verify(lastCode(), username);
  return res.body.data.resetToken as string;
};

beforeEach(async () => {
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  school = await makeSchool('s1');
  await makeUser({ username: 'sa', role: 'superadmin' });
  tchId = (await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id })).id;
  sa = (await login('sa')).token;
  await enableBot();
  await link(tchId);
});
afterAll(uninstallTelegram);

describe('POST /auth/password-reset/request', () => {
  it('ulangan foydalanuvchi: kod yaratiladi va botga 6 xonali kod yuboriladi', async () => {
    const res = await requestCode();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true });
    expect(await PasswordResetCode.countDocuments({})).toBe(1);
    const msg = fake.sent.at(-1)!;
    expect(msg.chatId).toBe(CHAT);
    expect(msg.text).toMatch(/Yuksalish EDU: parolni tiklash kodi: <b>\d{6}<\/b>/);
    expect(msg.opts?.parseMode).toBe('HTML');
    // Ochiq kod bazada saqlanmaydi
    const doc = await PasswordResetCode.findOne({});
    expect(doc!.codeHash).not.toContain(lastCode());
  });

  it('mavjud bo`lmagan / nofaol / ulanmagan / bot to`xtagan: bir xil javob, kod ham xabar yo`q', async () => {
    const baseline = (await requestCode()).body;
    await PasswordResetCode.deleteMany({});
    fake.sent.length = 0;

    await makeUser({ username: 'inactive', role: 'teacher', schoolId: school.id, isActive: false });
    const inactive = await User.findOne({ username: 'inactive' });
    await link(inactive!.id, 555002);
    await makeUser({ username: 'unlinked', role: 'teacher', schoolId: school.id });

    const bodies = [];
    for (const u of ['nobody', 'inactive', 'unlinked']) {
      const res = await requestCode(u);
      expect(res.status).toBe(200);
      bodies.push(res.body);
    }
    await telegramManager.stop();
    const down = await requestCode('tch');
    expect(down.status).toBe(200);
    bodies.push(down.body);

    for (const b of bodies) expect(b).toEqual(baseline);
    expect(await PasswordResetCode.countDocuments({})).toBe(0);
    expect(fake.sent).toHaveLength(0);
  });

  it('maktab nofaol bo`lsa kod yuborilmaydi', async () => {
    school.isActive = false;
    await school.save();
    expect((await requestCode()).status).toBe(200);
    expect(await PasswordResetCode.countDocuments({})).toBe(0);
  });

  it('qayta yuborish: 60 soniya ichida yangi kod yaratilmaydi, undan keyin eskisi bekor bo`ladi', async () => {
    await requestCode();
    const first = lastCode();
    await requestCode();
    expect(fake.sent).toHaveLength(1);

    clock.set(() => new Date(Date.now() + 61_000));
    await requestCode();
    expect(fake.sent).toHaveLength(2);
    expect(await PasswordResetCode.countDocuments({})).toBe(1);
    const second = lastCode();
    if (second !== first) {
      expect((await verify(first)).status).toBe(400);
    }
    expect((await verify(second)).status).toBe(200);
  });

  it('bot darhol yubora olmasa outbox navbatiga tushadi', async () => {
    fake.sendErrors.push(new Error('boom'));
    await requestCode();
    expect(fake.sent).toHaveLength(0);
    const rows = await TelegramOutbox.find({ kind: 'password_reset_code' });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toMatch(/<b>\d{6}<\/b>/);
  });

  it('login normallashadi (bosh/kichik harf, bo`shliq)', async () => {
    const res = await request(app).post(`${API}/request`).send({ username: '  TCH ' });
    await passwordResetService.flush();
    expect(res.status).toBe(200);
    expect(fake.sent).toHaveLength(1);
  });

  it('superadmin ham tiklay oladi', async () => {
    const sad = await User.findOne({ username: 'sa' });
    await link(sad!.id, 555009);
    await requestCode('sa');
    expect(fake.sent.at(-1)!.chatId).toBe(555009);
  });
});

describe('POST /auth/password-reset/verify', () => {
  it('noto`g`ri kod, noma`lum foydalanuvchi, muddati o`tgan: bir xil umumiy xato', async () => {
    await requestCode();
    const wrong = await verify(wrongCode());
    const unknown = await verify('123456', 'nobody');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe("Kod noto'g'ri yoki muddati o'tgan");
    expect(unknown.body.error.message).toBe(wrong.body.error.message);

    const code = lastCode();
    clock.set(() => new Date(Date.now() + 11 * 60_000));
    const expired = await verify(code);
    expect(expired.status).toBe(400);
    expect(expired.body.error.message).toBe(wrong.body.error.message);
  });

  it('format noto`g`ri kod: 400', async () => {
    expect((await verify('12ab56')).status).toBe(400);
    expect((await verify('12345')).status).toBe(400);
  });

  it('5 ta xato urinishdan so`ng kod bekor qilinadi (to`g`ri kod ham o`tmaydi)', async () => {
    await requestCode();
    const code = lastCode();
    const bad = wrongCode();
    for (let i = 0; i < 4; i++) {
      const r = await verify(bad);
      expect(r.body.error.message).toBe("Kod noto'g'ri yoki muddati o'tgan");
    }
    const fifth = await verify(bad);
    expect(fifth.status).toBe(400);
    expect(fifth.body.error.message).toBe("Kod bekor qilindi, yangi kod so'rang");
    const after = await verify(code);
    expect(after.status).toBe(400);
    expect(after.body.data).toBeUndefined();
  });

  it('muvaffaqiyat: resetToken qaytadi, kod qayta ishlatib bo`lmaydi', async () => {
    await requestCode();
    const code = lastCode();
    const res = await verify(code);
    expect(res.status).toBe(200);
    expect(res.body.data.resetToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const doc = await PasswordResetCode.findOne({});
    expect(doc!.resetTokenHash).toBeTruthy();
    expect(doc!.resetTokenHash).not.toBe(res.body.data.resetToken);
    expect((await verify(code)).status).toBe(400);
  });
});

describe('POST /auth/password-reset/complete', () => {
  it('parolni yangilaydi, bloklashni tozalaydi, sessiyalarni bekor qiladi, auditga yozadi, botga tasdiq yuboradi', async () => {
    const old = await login('tch');
    expect(old.res.status).toBe(200);
    await User.updateOne(
      { username: 'tch' },
      { failedLoginCount: 3, lockUntil: new Date(Date.now() + 600_000) },
    );
    expect(await RefreshToken.countDocuments({ userId: tchId, revokedAt: null })).toBeGreaterThan(
      0,
    );

    const resetToken = await tokenFor();
    fake.sent.length = 0;
    const res = await complete(resetToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ reset: true });

    const user = await User.findById(tchId);
    expect(user!.failedLoginCount).toBe(0);
    expect(user!.lockUntil).toBeNull();
    expect(user!.passwordChangedAt).not.toBeNull();
    expect(await RefreshToken.countDocuments({ userId: tchId, revokedAt: null })).toBe(0);

    // Eski access token endi yaroqsiz, eski parol ishlamaydi, yangisi ishlaydi
    expect((await request(app).get('/api/v1/auth/me').set(bearer(old.token))).status).toBe(401);
    expect((await login('tch', PASSWORD)).res.status).toBe(401);
    expect((await login('tch', NEW_PASSWORD)).res.status).toBe(200);

    const audit = await AuditLog.find({ action: 'user.password_reset_self' });
    expect(audit).toHaveLength(1);
    expect(String(audit[0].userId)).toBe(tchId);
    expect(JSON.stringify(audit[0].toObject())).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(audit[0].toObject())).not.toContain(resetToken);

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].text).toMatch(
      /^✅ Parolingiz o'zgartirildi \(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\)\./,
    );
  });

  it('token bir martalik', async () => {
    const resetToken = await tokenFor();
    expect((await complete(resetToken)).status).toBe(200);
    const again = await complete(resetToken, 'AnotherPass7');
    expect(again.status).toBe(400);
    expect((await login('tch', 'AnotherPass7')).res.status).toBe(401);
  });

  it('token muddati o`tgan bo`lsa rad etiladi', async () => {
    const resetToken = await tokenFor();
    clock.set(() => new Date(Date.now() + 11 * 60_000));
    const res = await complete(resetToken);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('resetToken');
    expect((await login('tch', PASSWORD)).res.status).toBe(200);
  });

  it('yaroqsiz token va zaif parol; zaif parol tokenni sarflamaydi', async () => {
    expect((await complete('x'.repeat(43))).status).toBe(400);
    const resetToken = await tokenFor();
    expect((await complete(resetToken, 'short')).status).toBe(400);
    expect((await complete(resetToken, 'onlyletters')).status).toBe(400);
    expect((await complete(resetToken)).status).toBe(200);
  });

  it('nofaol bo`lib qolgan foydalanuvchi uchun rad etiladi', async () => {
    const resetToken = await tokenFor();
    await User.updateOne({ _id: tchId }, { isActive: false });
    expect((await complete(resetToken)).status).toBe(400);
    expect((await login('tch', PASSWORD)).res.status).toBe(403);
  });

  it('parallel ikki so`rovdan faqat bittasi o`tadi', async () => {
    const resetToken = await tokenFor();
    const [a, b] = await Promise.all([
      complete(resetToken, 'ParallelPass1'),
      complete(resetToken, 'ParallelPass2'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });
});

describe('GET /auth/password-reset/info', () => {
  it('bot ishlaganda username, aks holda available=false', async () => {
    const on = await request(app).get(`${API}/info`);
    expect(on.body.data).toEqual({ available: true, botUsername: 'yuksalish_test_bot' });
    await telegramManager.stop();
    const off = await request(app).get(`${API}/info`);
    expect(off.body.data).toEqual({ available: false, botUsername: null });
  });
});

describe('so`rovlar chegarasi', () => {
  it('request: IP bo`yicha 5 tadan keyin 429', async () => {
    const original = env.RATE_LIMIT_ENABLED;
    env.RATE_LIMIT_ENABLED = true;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push(
          (
            await request(app)
              .post(`${API}/request`)
              .send({ username: `ghost${i}` })
          ).status,
        );
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    } finally {
      env.RATE_LIMIT_ENABLED = original;
    }
  });
});
