import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ClassModel } from '../src/models/Class';
import { LessonOverride } from '../src/models/LessonOverride';
import { Subject } from '../src/models/Subject';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { User } from '../src/models/User';
import { settingsStore } from '../src/modules/settings/settings.store';
import { handleIncoming, HELP_TEXT } from '../src/modules/telegram/telegram.bot';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { runMorningDigests } from '../src/modules/telegram/telegram.digest';
import { telegramManager } from '../src/modules/telegram/telegram.manager';
import { processOutboxOnce } from '../src/modules/telegram/telegram.outbox';
import { rechainAllClasses } from '../src/modules/timetable/timetable.chain';
import { clock } from '../src/utils/clock';
import {
  app,
  assignSubject,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

type Doc = { id: string };
const API = '/api/v1/timetable';
// 2026-11-04 = chorshanba (3). 02:30Z = Toshkent 07:30
const WED = '2026-11-04';
const THU = '2026-11-05';
const MORNING = new Date('2026-11-04T02:30:00Z');

let fake: FakeTelegram;
let school: Doc;
let c1: Awaited<ReturnType<typeof makeClass>>;
let c2: Awaited<ReturnType<typeof makeClass>>;
let math: Doc, phys: Doc, eng: Doc;
let t1: Doc, t2: Doc, t3: Doc, adminUser: Doc;
let admin: string;

const e = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  groupKey: null,
  room: null,
});
const post = (path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(bearer(admin)).send(body);
const put = (path: string, body: object) =>
  request(app).put(`${API}${path}`).set(bearer(admin)).send(body);
const del = (path: string) => request(app).delete(`${API}${path}`).set(bearer(admin));
const link = (id: string, chatId: number) =>
  User.updateOne({ _id: id }, { 'telegram.chatId': chatId, 'telegram.linkedAt': new Date() });
const rows = async () => TelegramOutbox.find().sort({ chatId: 1, _id: 1 });
const textOf = async (chatId: number) =>
  (await rows()).filter((r) => r.chatId === chatId).map((r) => r.text);
const setTg = (values: object) => settingsStore.set('school', school.id, 'telegram', values, t1.id);

async function version(classId: string, entries: object[]) {
  await TimetableVersion.create({
    schoolId: school.id,
    academicYearId: (await ClassModel.findById(classId))!.academicYearId,
    classId,
    status: 'active',
    validFrom: '2026-09-01',
    activatedAt: new Date(),
    entries,
  });
}

beforeEach(async () => {
  clock.set(() => new Date('2026-11-04T02:30:00Z'));
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  school = await makeSchool('tgt');
  const other = await makeSchool('tgt2');
  const year = await makeYear(school.id);
  await makeYear(other.id);
  t1 = await makeUser({ username: 'tt_t1', role: 'teacher', schoolId: school.id });
  t2 = await makeUser({ username: 'tt_t2', role: 'teacher', schoolId: school.id });
  t3 = await makeUser({ username: 'tt_t3', role: 'teacher', schoolId: school.id });
  math = await makeSubject('Matematika');
  phys = await makeSubject('Fizika');
  eng = await makeSubject('Ingliz tili');
  c1 = await makeClass(school.id, year.id, '5-A', [t1.id]);
  c2 = await makeClass(school.id, year.id, '6-A', [t2.id]);
  await assignSubject(school.id, c1, math.id, t1.id);
  await assignSubject(school.id, c2, phys.id, t2.id);
  // 5-A: chor 1 mat/t1, chor 2 fizika/t2 ; 6-A: chor 1 fizika/t2, chor 3 mat/t1
  await version(c1.id, [e(3, 1, math.id, t1.id), e(3, 2, phys.id, t2.id)]);
  await version(c2.id, [e(3, 1, phys.id, t2.id), e(3, 3, math.id, t1.id)]);
  adminUser = await makeUser({
    username: 'tt_admin',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['timetable.view', 'timetable.substitute', 'timetable.manage'],
  });
  admin = (await login('tt_admin')).token;
});
afterAll(uninstallTelegram);

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
async function linkAll() {
  await link(t1.id, 101);
  await link(t2.id, 102);
  await link(t3.id, 103);
}

describe('ertalabki jadval', () => {
  it("vaqti kelganda darsi bor ulangan o'qituvchilarga yuboriladi; darsi yo'qqa yo'q", async () => {
    await startBot();
    await linkAll(); // t3 ning darsi yo'q
    const r = await runMorningDigests(MORNING);
    expect(r.sent).toBe(2);
    expect(await textOf(103)).toEqual([]);
    expect(await textOf(101)).toEqual([
      [
        '📅 Chorshanba, 4-noyabr',
        '📚 Bugun 2 ta dars',
        '',
        '📘 <b>Matematika</b>',
        '1-soat ─ 5-A',
        '3-soat ─ 6-A',
        '',
        'Yaxshi kun tilaymiz! 🌤',
      ].join('\n'),
    ]);
    expect((await rows())[0]!.parseMode).toBe('HTML');
    expect(await textOf(102)).toEqual([
      [
        '📅 Chorshanba, 4-noyabr',
        '📚 Bugun 2 ta dars',
        '',
        '📘 <b>Fizika</b>',
        '1-soat ─ 6-A',
        '2-soat ─ 5-A',
        '',
        'Yaxshi kun tilaymiz! 🌤',
      ].join('\n'),
    ]);
  });

  it('bot ishlamasa, vaqt mos kelmasa, ish kuni emas yoki o‘chirilgan bo‘lsa yuborilmaydi', async () => {
    await linkAll();
    expect((await runMorningDigests(MORNING)).sent).toBe(0); // bot yo'q
    await startBot();
    expect((await runMorningDigests(new Date('2026-11-04T02:31:00Z'))).sent).toBe(0);
    expect((await runMorningDigests(new Date('2026-11-04T02:29:00Z'))).sent).toBe(0);
    expect((await runMorningDigests(new Date('2026-11-08T02:30:00Z'))).sent).toBe(0); // yakshanba
    await setTg({ notify: { morningSchedule: false } });
    expect((await runMorningDigests(MORNING)).sent).toBe(0);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it('maktab sozlamasidagi vaqt va ish kunlari hisobga olinadi', async () => {
    await startBot();
    await linkAll();
    await setTg({ morningTime: '08:15', workdays: [1, 2, 4] }); // chorshanba ish kuni emas
    expect((await runMorningDigests(new Date('2026-11-04T03:15:00Z'))).sent).toBe(0);
    await setTg({ morningTime: '08:15', workdays: [1, 2, 3] });
    expect((await runMorningDigests(MORNING)).sent).toBe(0);
    expect((await runMorningDigests(new Date('2026-11-04T03:15:00Z'))).sent).toBe(2);
  });

  it('takroriy tik xabarni ikki marta yubormaydi (dedupeKey)', async () => {
    await startBot();
    await linkAll();
    await runMorningDigests(MORNING);
    await runMorningDigests(MORNING);
    expect(await TelegramOutbox.countDocuments()).toBe(2);
    const keys = (await rows()).map((r) => r.dedupeKey);
    expect(keys).toContain(`morning:${t1.id}:${WED}`);
  });

  it('almashtirish va bekor qilingan darslar belgilanadi; HTML escape qilinadi', async () => {
    await startBot();
    await linkAll();
    await Subject.updateOne({ _id: math.id }, { name: 'Mat <b>&' });
    const base = { schoolId: school.id, date: WED, groupKey: null };
    await LessonOverride.create({
      ...base,
      classId: c1.id,
      lessonNo: 1,
      type: 'substitute',
      targetTeacherId: t1.id,
      teacherId: t3.id,
    });
    await LessonOverride.create({
      ...base,
      classId: c1.id,
      lessonNo: 2,
      type: 'cancel',
      targetTeacherId: t2.id,
    });
    await runMorningDigests(MORNING);
    expect(await textOf(103)).toEqual([
      "📅 Chorshanba, 4-noyabr\n📚 Bugun 1 ta dars\n\n📘 <b>Mat &lt;b&gt;&amp;</b>\n1-soat ─ 5-A  🔁 Test tt_t1 o'rniga\n\nYaxshi kun tilaymiz! 🌤",
    ]);
    const t1text = (await textOf(101))[0]!;
    expect(t1text).toContain(
      '📘 <b>Mat &lt;b&gt;&amp;</b>\n1-soat ─ 5-A  🔁 Test tt_t3 kiradi\n3-soat ─ 6-A',
    );
    const t2text = (await textOf(102))[0]!;
    expect(t2text).toContain('📚 Bugun 1 ta dars (1 tasi bekor qilingan)');
    expect(t2text).toContain('📘 <b>Fizika</b>\n1-soat ─ 6-A\n2-soat ─ 5-A  ❌ bekor qilindi');
  });

  it('faqat bekor qilingan darsi bor o‘qituvchiga ham yuboriladi', async () => {
    await startBot();
    await link(t2.id, 102);
    const base = { schoolId: school.id, date: WED, groupKey: null, type: 'cancel' as const };
    await LessonOverride.create({
      ...base,
      classId: c2.id,
      lessonNo: 1,
      targetTeacherId: t2.id,
    });
    await LessonOverride.create({
      ...base,
      classId: c1.id,
      lessonNo: 2,
      targetTeacherId: t2.id,
    });
    await runMorningDigests(MORNING);
    const [m] = await textOf(102);
    expect(m).toContain('📚 Bugun 0 ta dars (2 tasi bekor qilingan)');
    expect(m).toContain('1-soat ─ 6-A  ❌ bekor qilindi');
    expect(m).toContain('2-soat ─ 5-A  ❌ bekor qilindi');
  });

  it('bir necha fan: fan bo‘yicha guruhlanadi, guruhlar birinchi soat bo‘yicha tartiblanadi', async () => {
    await startBot();
    await link(t1.id, 101);
    // t1: 1-soat Matematika(5-A), 2-soat Fizika (5-A), 3-soat Matematika (6-A), 4-soat Fizika (6-A)
    await TimetableVersion.deleteMany({});
    await version(c1.id, [e(3, 1, math.id, t1.id), e(3, 2, phys.id, t1.id)]);
    await version(c2.id, [e(3, 3, math.id, t1.id), e(3, 4, phys.id, t1.id)]);
    await runMorningDigests(MORNING);
    const m = (await textOf(101))[0]!;
    expect(m).toContain('📚 Bugun 4 ta dars');
    expect(m).toContain(
      '📘 <b>Matematika</b>\n1-soat ─ 5-A\n3-soat ─ 6-A\n\n📘 <b>Fizika</b>\n2-soat ─ 5-A\n4-soat ─ 6-A',
    );
    expect(m.match(/📘/g)).toHaveLength(2);
  });

  it('almashtirilgan dars yangi fan guruhida, asl o‘qituvchida eski fan ostida', async () => {
    await startBot();
    await linkAll();
    await LessonOverride.create({
      schoolId: school.id,
      date: WED,
      groupKey: null,
      classId: c1.id,
      lessonNo: 1,
      type: 'replace',
      subjectId: eng.id,
      teacherId: t3.id,
      targetTeacherId: t1.id,
    });
    await runMorningDigests(MORNING);
    expect((await textOf(103))[0]).toContain(
      "📘 <b>Ingliz tili</b>\n1-soat ─ 5-A  🔄 Matematika o'rniga",
    );
    expect((await textOf(101))[0]).toContain(
      '📘 <b>Matematika</b>\n1-soat ─ 5-A  🔁 Test tt_t3 kiradi',
    );
  });

  it('outbox orqali haqiqatan yuboriladi (HTML parse mode)', async () => {
    await startBot();
    await link(t1.id, 101);
    await runMorningDigests(MORNING);
    await processOutboxOnce();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.opts?.parseMode).toBe('HTML');
  });
});

describe('almashtirish xabarlari (override hooklari)', () => {
  beforeEach(async () => {
    await startBot();
    await linkAll();
  });

  it('substitute: almashtiruvchiga va asl o‘qituvchiga', async () => {
    const r = await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'substitute',
      teacherId: t3.id,
    });
    expect(r.status).toBe(201);
    expect(await textOf(103)).toEqual([
      "🔁 Siz 4-noyabr 1-soat 5-A sinfida Matematika darsiga Test tt_t1 o'rniga kirasiz",
    ]);
    expect(await textOf(101)).toEqual([
      '🔁 4-noyabr 1-soat 5-A Matematika darsingizga Test tt_t3 kiradi',
    ]);
    expect(await textOf(102)).toEqual([]);
    expect((await rows())[0]!.dedupeKey).toContain(`ov:${r.body.data.id}:created:`);
  });

  it('cancel: asl o‘qituvchiga, sabab bilan', async () => {
    await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'cancel',
      reason: 'Kasal <3',
    });
    expect(await textOf(101)).toEqual([
      '❌ 4-noyabr 1-soat 5-A Matematika darsingiz bekor qilindi. Sabab: Kasal &lt;3.',
    ]);
    expect(await TelegramOutbox.countDocuments()).toBe(1);
  });

  it('replace va extra', async () => {
    await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'replace',
      subjectId: eng.id,
      teacherId: t3.id,
    });
    expect(await textOf(103)).toEqual([
      "🔄 Siz 4-noyabr 1-soat 5-A sinfida Ingliz tili darsiga kirasiz (dars o'zgardi, jadvaldagi fan: Matematika)",
    ]);
    expect((await textOf(101))[0]).toContain(
      "darsingiz o'zgardi: endi Test tt_t3 Ingliz tili o'tadi",
    );
    const r = await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 4,
      type: 'extra',
      subjectId: eng.id,
      teacherId: t3.id,
    });
    expect(r.status).toBe(201);
    expect((await textOf(103))[1]).toBe("➕ Qo'shimcha dars: 4-noyabr 4-soat · 5-A · Ingliz tili");
  });

  it('ko‘chirish: o‘qituvchiga bitta jamlangan xabar', async () => {
    const r = await post('/overrides/move', {
      classId: c1.id,
      from: { date: WED, lessonNo: 1 },
      to: { date: THU, lessonNo: 2 },
    });
    expect(r.status).toBe(201);
    expect(await textOf(101)).toEqual([
      "🔀 5-A · Matematika: 4-noyabr 1-soat → 5-noyabr 2-soat ko'chirildi",
    ]);
    expect(await TelegramOutbox.countDocuments()).toBe(1);
  });

  it("o'chirish: almashtirish bekor, ko'chirish bekor", async () => {
    const r = await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'substitute',
      teacherId: t3.id,
    });
    await TelegramOutbox.deleteMany({});
    expect((await del(`/overrides/${r.body.data.id}`)).status).toBeLessThan(300);
    expect(await textOf(103)).toEqual([
      '↩️ 4-noyabr 1-soat · 5-A · Matematika: almashtirish bekor qilindi, dars odatdagidek',
    ]);
    expect(await textOf(101)).toEqual(await textOf(103));

    await TelegramOutbox.deleteMany({});
    const m = await post('/overrides/move', {
      classId: c1.id,
      from: { date: WED, lessonNo: 1 },
      to: { date: THU, lessonNo: 2 },
    });
    await TelegramOutbox.deleteMany({});
    await del(`/overrides/${m.body.data.items[1].id}`);
    expect(await textOf(101)).toEqual([
      "↩️ 5-A · Matematika: ko'chirish bekor qilindi, dars odatdagidek (4-noyabr 1-soat)",
    ]);
  });

  it("o'tgan sana, o‘chirilgan sozlama va ulanmagan o‘qituvchi uchun xabar yo‘q", async () => {
    clock.set(() => new Date('2026-11-05T05:00:00Z')); // payshanba: chorshanba o'tgan
    const past = await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'substitute',
      teacherId: t3.id,
    });
    expect(past.status).toBe(201);
    expect(await TelegramOutbox.countDocuments()).toBe(0);

    clock.set(() => new Date('2026-11-04T05:00:00Z'));
    await setTg({ notify: { substitutions: false } });
    await post('/overrides', { classId: c2.id, date: WED, lessonNo: 1, type: 'cancel' });
    expect(await TelegramOutbox.countDocuments()).toBe(0);

    await setTg({ notify: { substitutions: true } });
    await User.updateOne({ _id: t2.id }, { 'telegram.chatId': null });
    await post('/overrides', { classId: c2.id, date: WED, lessonNo: 1, type: 'cancel' });
    await post('/overrides', { classId: c2.id, date: WED, lessonNo: 3, type: 'cancel' });
    expect(await textOf(101)).toHaveLength(1); // 6-A 3-soat t1 ning darsi
    expect(await textOf(102)).toEqual([]);
  });

  it('bot ishlamasa override baribir saqlanadi', async () => {
    await telegramManager.stop();
    const r = await post('/overrides', {
      classId: c1.id,
      date: WED,
      lessonNo: 1,
      type: 'cancel',
    });
    expect(r.status).toBe(201);
    expect(await LessonOverride.countDocuments()).toBe(1);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });
});

describe('jadval o‘zgarishi xabarlari', () => {
  beforeEach(async () => {
    await startBot();
    await linkAll();
  });

  async function draft(classId: string, entries: object[], validFrom = THU) {
    const c = await post(`/classes/${classId}/versions`, { validFrom });
    expect(c.status).toBe(201);
    const id = c.body.data.version.id as string;
    expect((await put(`/versions/${id}`, { entries })).status).toBe(200);
    return id;
  }

  it('faqat jadvali o‘zgargan o‘qituvchilarga farq yuboriladi; qoralama xabar yubormaydi', async () => {
    const id = await draft(c1.id, [
      e(3, 1, math.id, t1.id),
      e(4, 2, math.id, t1.id),
      e(3, 2, phys.id, t3.id),
    ]);
    expect(await TelegramOutbox.countDocuments()).toBe(0); // qoralama
    const r = await post(`/versions/${id}/activate`, { validFrom: THU });
    expect(r.status).toBe(200);
    const head =
      '🗓 <b>5-A</b> sinfi dars jadvali yangilandi (5-noyabrdan)\nSizning darslaringiz:\n';
    expect(await textOf(101)).toEqual([head + '+ Pa 2-soat Matematika']);
    expect(await textOf(102)).toEqual([head + '− Ch 2-soat Fizika']);
    expect(await textOf(103)).toEqual([head + '+ Ch 2-soat Fizika']);
    expect((await rows()).every((x) => x.dedupeKey === `tt:${id}:${String(x.userId)}`)).toBe(true);
  });

  it('o‘zgarmagan jadval hech kimga xabar bermaydi; sozlama o‘chiq bo‘lsa ham', async () => {
    const same = await draft(c1.id, [e(3, 1, math.id, t1.id), e(3, 2, phys.id, t2.id)]);
    expect((await post(`/versions/${same}/activate`, { validFrom: THU })).status).toBe(200);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
    await setTg({ notify: { timetableChanges: false } });
    const other = await draft(c2.id, [e(3, 1, phys.id, t3.id)], '2026-11-06');
    expect((await post(`/versions/${other}/activate`, { validFrom: '2026-11-06' })).status).toBe(
      200,
    );
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });

  it('ommaviy faollashtirishda o‘qituvchiga bitta jamlangan xabar', async () => {
    const a = await draft(c1.id, [e(3, 1, math.id, t3.id), e(3, 2, phys.id, t2.id)]);
    const b = await draft(c2.id, [e(3, 1, phys.id, t2.id), e(3, 3, math.id, t3.id)]);
    const r = await post('/activate-bulk', { versionIds: [a, b], validFrom: THU });
    expect(r.status).toBe(200);
    const t3msgs = await textOf(103);
    expect(t3msgs).toHaveLength(1);
    expect(t3msgs[0]).toContain('<b>5-A</b>');
    expect(t3msgs[0]).toContain('<b>6-A</b>');
    expect(t3msgs[0]).toContain('+ Ch 1-soat Matematika');
    expect(t3msgs[0]).toContain('+ Ch 3-soat Matematika');
    expect(await textOf(101)).toHaveLength(1);
  });

  it('ishga tushishdagi rechain migratsiyasi xabar yubormaydi', async () => {
    await TimetableVersion.create({
      schoolId: school.id,
      academicYearId: c1.academicYearId,
      classId: c1.id,
      status: 'active',
      validFrom: '2026-10-01',
      activatedAt: new Date(),
      entries: [e(3, 5, eng.id, t3.id)],
    });
    const res = await rechainAllClasses();
    expect(res.classes).toBeGreaterThan(0);
    expect(await TelegramOutbox.countDocuments()).toBe(0);
  });
});

describe('o‘qituvchi buyruqlari', () => {
  const say = (chatId: number, text: string) =>
    handleIncoming({ chatId, chatType: 'private', text, username: null });

  beforeEach(async () => {
    await startBot();
    await linkAll();
    await link(adminUser.id, 900);
    clock.set(() => new Date('2026-11-03T05:00:00Z')); // seshanba
  });

  it('ulanmagan chat va rahbariyat', async () => {
    expect(await say(555, '/bugun')).toContain('ulanmagan');
    expect(await say(900, '/hafta')).toContain("faqat o'qituvchilar uchun");
  });

  it('/bugun: dars bo‘lmasa, dam olish kunida va dars kunida', async () => {
    expect(await say(101, '/bugun')).toBe('Bugun uchun darsingiz yo‘q.');
    clock.set(() => new Date('2026-11-08T05:00:00Z')); // yakshanba
    expect(await say(101, '/bugun')).toBe('Bugun dam olish kuni.');
    clock.set(() => new Date(MORNING));
    const r = await say(101, '/bugun');
    expect(r).toBe(
      '📅 Chorshanba, 4-noyabr\n📚 Bugun 2 ta dars\n\n📘 <b>Matematika</b>\n1-soat ─ 5-A\n3-soat ─ 6-A',
    );
    expect(r).not.toContain('Yaxshi kun');
  });

  it('/ertaga: ertangi kun, ertaga dam kuni bo‘lsa keyingi ish kuni', async () => {
    const r = await say(102, '/ertaga');
    expect(r).toContain('📅 Chorshanba, 4-noyabr\n📚 Ertaga 2 ta dars');
    expect(r).toContain('📘 <b>Fizika</b>\n1-soat ─ 6-A');
    expect(r).not.toContain('Yaxshi kun');
    clock.set(() => new Date('2026-11-07T05:00:00Z')); // shanba -> ertaga yakshanba
    expect(await say(102, '/ertaga')).toBe(
      'Ertaga dam olish kuni. Keyingi ish kuni — 9-noyabr (dushanba).\n\n9-noyabr (dushanba) uchun darsingiz yo‘q.',
    );
  });

  it('/hafta: dushanbadan oxirgi ish kunigacha, kunlar bo‘yicha', async () => {
    const r = await say(101, '/hafta@yuksalish_test_bot');
    expect(r).toContain('Hafta jadvali (2-noyabr – 7-noyabr)');
    // bitta fan: tepada bir marta
    expect(r).toContain('🗓 <b>Hafta jadvali (2-noyabr – 7-noyabr)</b>\n\n📘 <b>Matematika</b>\n');
    expect(r!.match(/📘/g)).toHaveLength(1);
    expect(r).toContain('<b>Chorshanba, 4-noyabr</b>\n1-soat ─ 5-A\n3-soat ─ 6-A');
    expect(r).toContain('<b>Dushanba, 2-noyabr</b>\ndars yo‘q');
    expect(r).toContain('<b>Seshanba, 3-noyabr</b> · bugun');
    expect(r).not.toContain('Yakshanba');
    await setTg({ workdays: [1, 2, 3, 4, 5] });
    expect(await say(101, '/hafta')).not.toContain('Shanba, 7-noyabr');
  });

  it('/hafta: bir necha fan bo‘lsa har kunda fan bo‘yicha guruhlanadi', async () => {
    await TimetableVersion.deleteMany({});
    await version(c1.id, [e(3, 1, math.id, t1.id), e(3, 2, phys.id, t1.id)]);
    await version(c2.id, [e(3, 3, math.id, t1.id)]);
    const r = await say(101, '/hafta');
    expect(r).toContain(
      '<b>Chorshanba, 4-noyabr</b>\n📘 <b>Matematika</b>\n1-soat ─ 5-A\n3-soat ─ 6-A\n\n📘 <b>Fizika</b>\n2-soat ─ 5-A',
    );
    expect(r).toContain('</b>' + String.fromCharCode(10, 10) + '<b>Dushanba, 2-noyabr</b>');
  });

  it('/help buyruqlar ro‘yxatini ko‘rsatadi', async () => {
    expect(HELP_TEXT).toContain('/bugun');
    expect(HELP_TEXT).toContain('/ertaga');
    expect(HELP_TEXT).toContain('/hafta');
    expect(await say(101, '/help')).toBe(HELP_TEXT);
  });
});
