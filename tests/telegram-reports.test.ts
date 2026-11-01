import type { Types } from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AttendanceRecord } from '../src/models/AttendanceRecord';
import { School } from '../src/models/School';
import { Student } from '../src/models/Student';
import { TelegramBotConfig } from '../src/models/TelegramBotConfig';
import { TelegramOutbox } from '../src/models/TelegramOutbox';
import { User } from '../src/models/User';
import { settingsStore } from '../src/modules/settings/settings.store';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
import { handleIncoming, HELP_TEXT } from '../src/modules/telegram/telegram.bot';
import { encryptToken } from '../src/modules/telegram/telegram.crypto';
import { BOT_COMMANDS, telegramManager } from '../src/modules/telegram/telegram.manager';
import { splitMessage } from '../src/modules/telegram/telegram.outbox';
import { runDailyReports, runWeeklyReports } from '../src/modules/telegram/telegram.report';
import { clock } from '../src/utils/clock';
import {
  makeBehaviorType,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeUser,
  makeYear,
  Score,
  useTestDb,
} from './helpers';
import { FakeTelegram, uninstallTelegram, VALID_TOKEN } from './helpers/telegram';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
// 2026-11-04 = chorshanba; 11:00Z = Toshkent 16:00
const WED = '2026-11-04';
const DAILY = new Date('2026-11-04T11:00:00Z');
// 2026-11-07 = shanba (oxirgi ish kuni); 12:00Z = Toshkent 17:00
const WEEKLY = new Date('2026-11-07T12:00:00Z');

let fake: FakeTelegram;
let school: Doc;
let year: Doc;
let other: Doc;
let admin1: Doc, admin2: Doc, teacher: Doc, root: Doc;
let st: Record<AttendanceCategory, Doc>;
const cls: Record<string, Doc> = {};
const stu: Record<string, Doc> = {};

const link = (id: string, chatId: number) =>
  User.updateOne({ _id: id }, { 'telegram.chatId': chatId, 'telegram.linkedAt': new Date() });
const rows = async () => TelegramOutbox.find().sort({ chatId: 1, _id: 1 });
const textOf = async (chatId: number) =>
  (await rows())
    .filter((r) => r.chatId === chatId)
    .map((r) => r.text)
    .join('\n');
const setTg = (values: object) =>
  settingsStore.set('school', school.id, 'telegram', values, admin1.id);
const say = (chatId: number, text: string) =>
  handleIncoming({ chatId, chatType: 'private', text, username: null });

async function rec(student: string, date: string, category: AttendanceCategory, lessonNo = 0) {
  const s = stu[student]!;
  const doc = await Student.findById(s.id);
  await AttendanceRecord.create({
    schoolId: school.id,
    studentId: s._id,
    classId: doc!.classId,
    academicYearId: year.id,
    date,
    lessonNo,
    statusId: st[category]._id,
    category,
    markedBy: teacher._id,
    updatedBy: teacher._id,
  });
}

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

async function addStudents(className: string, names: string[]) {
  for (const n of names) stu[n] = await makeStudent(school.id, cls[className]!.id, n);
}

beforeEach(async () => {
  clock.set(() => DAILY);
  fake = new FakeTelegram();
  fake.install();
  await telegramManager.reload();
  school = await makeSchool('rep');
  other = await makeSchool('rep2');
  year = await makeYear(school.id);
  await makeYear(other.id);
  admin1 = await makeUser({ username: 'rp_a1', role: 'school_admin', schoolId: school.id });
  admin2 = await makeUser({ username: 'rp_a2', role: 'school_admin', schoolId: school.id });
  teacher = await makeUser({ username: 'rp_t', role: 'teacher', schoolId: school.id });
  root = await makeUser({ username: 'rp_root', role: 'superadmin' });
  st = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus("Sababli yo'q", 'absent_excused'),
    absent_unexcused: await makeStatus("Sababsiz yo'q", 'absent_unexcused'),
  };
  for (const n of ['5-A', '5-B', '7-A', '9-V', '10-A']) {
    cls[n] = await makeClass(school.id, year.id, n, [teacher.id]);
  }
  await addStudents('5-A', ['Aliyev Bobur', 'Bekov Sardor', 'Valiyev Anvar', 'Gafurov Jasur']);
  await addStudents('5-B', ['Karimova Dilnoza <b>', 'Nazarov Umid', 'Orif Said', 'Polat Ravshan']);
  await addStudents('7-A', [
    'Tursunov Ali',
    'Umarov Vali',
    'Yusupov Hasan',
    'Zokirov Nodir',
    'Abdullaev Jamol',
  ]);
  await addStudents('9-V', ['Ergashev Ilhom', 'Fayzullaev Sherzod']);
  await addStudents('10-A', ['Hasanov Akmal', 'Ibragimov Bahrom', 'Jalilov Dilshod']);
  // 5-A: hammasi keldi
  for (const n of ['Aliyev Bobur', 'Bekov Sardor', 'Valiyev Anvar', 'Gafurov Jasur']) {
    await rec(n, WED, 'present');
  }
  // 5-B: 3 keldi, 1 sababli yo'q (75%)
  for (const n of ['Nazarov Umid', 'Orif Said', 'Polat Ravshan']) await rec(n, WED, 'present');
  await rec('Karimova Dilnoza <b>', WED, 'absent_excused');
  // 7-A: 3 keldi, 1 kechikdi, 1 sababsiz yo'q (4/5 = 80%)
  for (const n of ['Tursunov Ali', 'Umarov Vali', 'Yusupov Hasan']) await rec(n, WED, 'present');
  await rec('Zokirov Nodir', WED, 'late');
  await rec('Abdullaev Jamol', WED, 'absent_unexcused');
  // 10-A: 2 ta belgilangan, 1 ta yo'q -> "olinmagan"; 9-V: umuman olinmagan
  await rec('Hasanov Akmal', WED, 'present');
  await rec('Ibragimov Bahrom', WED, 'present');
  await link(admin1.id, 201);
  await link(admin2.id, 202);
  await link(teacher.id, 301);
  await link(root.id, 900);
});
afterAll(uninstallTelegram);

describe('kunlik hisobot', () => {
  it('foizlar, kelgan/kechikkan/kelmagan, olinmagan sinflar, eng past sinflar, kelmaganlar', async () => {
    await startBot();
    const r = await runDailyReports(DAILY);
    expect(r.sent).toBe(2);
    const text = await textOf(201);
    expect(text).toBe(
      [
        '📊 <b>Kunlik hisobot — 4-noyabr (chorshanba)</b>',
        'Maktab rep',
        '',
        '<b>Davomat: 86,7%</b> (13 / 15)',
        '✅ Kelgan: 12   ⏰ Kechikkan: 1   ❌ Kelmagan: 2 (sababli 1)',
        'Davomat olinmagan sinflar: 2 — 9-V, 10-A',
        '',
        '<b>Eng past davomat:</b>',
        '1. 5-B — 75%',
        '2. 7-A — 80%',
        '',
        '<b>Kelmaganlar:</b>',
        '5-B: Karimova Dilnoza &lt;b&gt; (sababli)',
        '7-A: Abdullaev Jamol',
      ].join('\n'),
    );
    expect(await textOf(202)).toBe(text);
    expect(await textOf(301)).toBe(''); // o'qituvchiga yuborilmaydi
    expect(await textOf(900)).toBe(''); // superadminga rejali hisobot yo'q
    expect((await rows())[0]!.parseMode).toBe('HTML');
  });

  it("dailyReportAbsentNames o'chiq bo'lsa ismlar ko'rsatilmaydi", async () => {
    await startBot();
    await setTg({ dailyReportAbsentNames: false });
    await runDailyReports(DAILY);
    const text = await textOf(201);
    expect(text).not.toContain('Kelmaganlar');
    expect(text).not.toContain('Abdullaev');
    expect(text).toContain('Davomat: 86,7%');
  });

  it("xulq qaydlari bugun bo'lsa bitta qator qo'shiladi", async () => {
    await startBot();
    const neg = await makeBehaviorType('Janjal', 'negative');
    const pos = await makeBehaviorType('Faol', 'positive');
    const mk = (s: string, bt: Doc, value: number) =>
      Score.create({
        schoolId: school.id,
        studentId: stu[s]!._id,
        classId: cls['7-A']!._id,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: bt._id,
        value,
        date: WED,
      });
    await mk('Tursunov Ali', neg, 40);
    await mk('Umarov Vali', neg, 50);
    await mk('Yusupov Hasan', pos, 100);
    await runDailyReports(DAILY);
    expect(await textOf(201)).toContain('Xulq: bugun 3 ta qayd (salbiy: 2, ijobiy: 1)');
  });

  it("dars rejimi: hamma darsda yo'q = kelmagan, qisman = kelgan hisobida alohida qator", async () => {
    await startBot();
    await settingsStore.set('school', school.id, 'attendance', { mode: 'lesson' }, admin1.id);
    await AttendanceRecord.deleteMany({});
    const D = '2026-11-03';
    for (const l of [1, 2, 3]) await rec('Aliyev Bobur', D, 'absent_unexcused', l); // to'liq yo'q
    await rec('Bekov Sardor', D, 'present', 1); // qisman
    await rec('Bekov Sardor', D, 'absent_unexcused', 2);
    await rec('Valiyev Anvar', D, 'present', 1);
    await rec('Valiyev Anvar', D, 'late', 2); // kechikkan
    await rec('Gafurov Jasur', D, 'present', 1);
    await runDailyReports(new Date('2026-11-03T11:00:00Z'));
    const text = await textOf(201);
    expect(text).toContain('<b>Davomat: 75%</b> (3 / 4)');
    expect(text).toContain('✅ Kelgan: 1   ⏰ Kechikkan: 1   ❌ Kelmagan: 1');
    expect(text).toContain("◐ Qisman (ba'zi darslarda yo'q): 1");
    expect(text).toContain('5-A: Aliyev Bobur');
    expect(text).not.toContain('Bekov');
  });

  it('davomat umuman olinmagan kun uchun qisqa xabar (nol foiz emas)', async () => {
    await startBot();
    await AttendanceRecord.deleteMany({});
    await runDailyReports(DAILY);
    expect(await textOf(201)).toBe(
      '📊 <b>Kunlik hisobot — 4-noyabr (chorshanba)</b>\nMaktab rep\n\nBugun davomat olinmagan.',
    );
  });

  it('maktab nomi HTML-escape qilinadi', async () => {
    await startBot();
    await School.updateOne({ _id: school.id }, { name: 'A & <B>' });
    await runDailyReports(DAILY);
    expect(await textOf(201)).toContain('\nA &amp; &lt;B&gt;\n');
  });

  it("vaqt, ish kuni, yoqilgan/o'chirilgan va bot holati bo'yicha yuborilmaydi; maktab vaqti hisobga olinadi", async () => {
    expect((await runDailyReports(DAILY)).sent).toBe(0); // bot yo'q
    await startBot();
    expect((await runDailyReports(new Date('2026-11-04T11:01:00Z'))).sent).toBe(0);
    expect((await runDailyReports(new Date('2026-11-04T10:59:00Z'))).sent).toBe(0);
    expect((await runDailyReports(new Date('2026-11-08T11:00:00Z'))).sent).toBe(0); // yakshanba
    await setTg({ notify: { dailyReport: false } });
    expect((await runDailyReports(DAILY)).sent).toBe(0);
    await setTg({ dailyReportTime: '18:30', workdays: [1, 2, 4] }); // chorshanba ish kuni emas
    expect((await runDailyReports(new Date('2026-11-04T13:30:00Z'))).sent).toBe(0);
    await setTg({ dailyReportTime: '18:30', workdays: [1, 2, 3] });
    expect((await runDailyReports(DAILY)).sent).toBe(0);
    expect((await runDailyReports(new Date('2026-11-04T13:30:00Z'))).sent).toBe(2);
    expect(await TelegramOutbox.countDocuments()).toBe(2);
  });

  it('faol bo‘lmagan, ulanmagan va boshqa maktab foydalanuvchilariga yuborilmaydi', async () => {
    await startBot();
    await User.updateOne({ _id: admin2.id }, { isActive: false });
    await makeUser({ username: 'rp_a3', role: 'school_admin', schoolId: school.id }); // ulanmagan
    const o = await makeUser({ username: 'rp_o', role: 'school_admin', schoolId: other.id });
    await link(o.id, 777);
    const r = await runDailyReports(DAILY);
    expect(r.sent).toBe(2); // 201 va boshqa maktab adminiga o'z maktabi hisoboti
    expect(await textOf(201)).toContain('Maktab rep');
    expect(await textOf(202)).toBe('');
    expect(await textOf(777)).toContain('Maktab rep2');
    expect(await textOf(777)).not.toContain('Maktab rep\n');
  });

  it('takroriy chaqiruv ikki marta yubormaydi (dedupeKey)', async () => {
    await startBot();
    await runDailyReports(DAILY);
    await runDailyReports(DAILY);
    expect(await TelegramOutbox.countDocuments()).toBe(2);
    expect((await rows()).map((r) => r.dedupeKey)).toContain(
      `daily:${school.id}:${admin1.id}:${WED}`,
    );
  });

  it("uzun hisobot qator chegarasida bo'linadi, kalitlar #n bilan", async () => {
    await startBot();
    for (let i = 0; i < 70; i++) {
      const cc = await makeClass(school.id, year.id, `8-${String(i).padStart(2, '0')}`);
      for (let j = 0; j < 3; j++) {
        const key = `y${i}_${j}`;
        stu[key] = await makeStudent(
          school.id,
          cc.id,
          `Sinfdosh${String(i).padStart(2, '0')}${j} Qwertyuiopasdfghjkl`,
        );
        await rec(key, WED, 'absent_unexcused');
      }
    }
    await runDailyReports(DAILY);
    const mine = (await rows()).filter((r) => r.chatId === 201);
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((r) => r.text.length <= 4096)).toBe(true);
    expect(mine.map((r) => r.dedupeKey)).toEqual(
      mine.map((_, i) => `daily:${school.id}:${admin1.id}:${WED}#${i + 1}`),
    );
    // Hech bir sinf qatori o'rtasidan kesilmagan: bo'laklar to'liq qatorlardan iborat
    const all = mine.map((r) => r.text).join('\n');
    expect(all).toContain('Sinfdosh690 Qwertyuiopasdfghjkl, Sinfdosh691 Qwertyuiopasdfghjkl');
    for (const r of mine) {
      for (const line of r.text.split('\n')) {
        if (/^8-\d\d: /.test(line)) expect(line.split(', ')).toHaveLength(3);
      }
    }
    expect(splitMessage('a\n'.repeat(3000)).every((p) => p.length <= 4096)).toBe(true);
  });
});

describe('haftalik hisobot', () => {
  beforeEach(async () => {
    clock.set(() => WEEKLY);
    // O'tgan hafta (26-31 oktyabr): 6 kishi keldi -> 100%
    for (const n of [
      'Aliyev Bobur',
      'Bekov Sardor',
      'Valiyev Anvar',
      'Gafurov Jasur',
      'Nazarov Umid',
      'Orif Said',
    ]) {
      await rec(n, '2026-10-28', 'present');
    }
    // Reyting: faqat 1-noyabr ballari (neutral tur), minScoresCount=1
    await settingsStore.set('school', school.id, 'rating', { minScoresCount: 1 }, admin1.id);
    const base: Record<string, number> = { '5-A': 95, '5-B': 85, '7-A': 70, '10-A': 60, '9-V': 50 };
    const neutral = await makeBehaviorType('Oddiy', 'neutral');
    const t2 = await makeUser({ username: 'rp_t2', role: 'teacher', schoolId: school.id });
    for (const s of await Student.find({ schoolId: school.id })) {
      const name = Object.entries(cls).find(([, c]) => String(c._id) === String(s.classId))![0];
      await Score.create({
        schoolId: school.id,
        studentId: s._id,
        classId: s.classId,
        teacherId: t2._id,
        academicYearId: year.id,
        behaviorTypeId: neutral._id,
        value: base[name]!,
        date: '2026-11-01',
      });
    }
    // Xulq qaydlari (haftada): Tursunov 3 salbiy, Nazarov 1, Aliyev 1, Umarov 1 ijobiy
    const kech = await makeBehaviorType('Kechikish', 'negative');
    const janjal = await makeBehaviorType('Janjal', 'negative');
    const faol = await makeBehaviorType('Faol', 'positive');
    const mk = async (n: string, bt: Doc, date: string, value: number) => {
      const s = await Student.findById(stu[n]!.id);
      await Score.create({
        schoolId: school.id,
        studentId: s!._id,
        classId: s!.classId,
        teacherId: teacher._id,
        academicYearId: year.id,
        behaviorTypeId: bt._id,
        value,
        date,
      });
    };
    await mk('Tursunov Ali', kech, '2026-11-02', 70);
    await mk('Tursunov Ali', kech, '2026-11-03', 70);
    await mk('Tursunov Ali', janjal, '2026-11-04', 70);
    await mk('Nazarov Umid', kech, '2026-11-04', 85);
    await mk('Aliyev Bobur', janjal, '2026-11-03', 95);
    await mk('Umarov Vali', faol, '2026-11-05', 70);
  });

  it('davomat o‘zgarishi, reyting top/bottom va xulq xulosasi', async () => {
    await startBot();
    const r = await runWeeklyReports(WEEKLY);
    expect(r.sent).toBe(2);
    const text = await textOf(201);
    expect(text).toContain('📈 <b>Haftalik hisobot — 2-noyabr – 7-noyabr</b>');
    expect(text).toContain('<b>Davomat: 86,7%</b> · ▼ 13,3 pp o‘tgan haftaga nisbatan');
    expect(text).toMatch(/<b>Sinflar reytingi<\/b> \(2026-yil noyabr\)/);
    expect(text).toContain('Eng yuqori:\n1. 5-A — 95\n2. 5-B — 85\n3. 7-A — 70');
    expect(text).toContain('Eng past:\n5. 9-V — 50\n4. 10-A — 60');
    expect(text).toContain('<b>Xulq:</b> 6 ta qayd (salbiy: 5, ijobiy: 1)');
    expect(text).toContain(
      'Ko‘p uchragan qoidabuzarliklar:\n1. Kechikish — 3 ta\n2. Janjal — 2 ta',
    );
    expect(text).toContain(
      'Eng ko‘p salbiy qayd:\n1. Tursunov Ali (7-A) — 3 ta\n2. Nazarov Umid (5-B) — 1 ta\n3. Aliyev Bobur (5-A) — 1 ta',
    );
    expect((await rows())[0]!.parseMode).toBe('HTML');
  });

  it('hafta kuni, vaqti, yoqilgan holati va dedupe', async () => {
    expect((await runWeeklyReports(WEEKLY)).sent).toBe(0); // bot yo'q
    await startBot();
    expect((await runWeeklyReports(DAILY)).sent).toBe(0); // chorshanba
    expect((await runWeeklyReports(new Date('2026-11-07T12:01:00Z'))).sent).toBe(0);
    await setTg({ notify: { weeklyReport: false } });
    expect((await runWeeklyReports(WEEKLY)).sent).toBe(0);
    await setTg({ weeklyReportDay: 5, weeklyReportTime: '09:00' });
    expect((await runWeeklyReports(new Date('2026-11-06T04:00:00Z'))).sent).toBe(2);
    await runWeeklyReports(new Date('2026-11-06T04:00:00Z'));
    expect(await TelegramOutbox.countDocuments()).toBe(2);
    expect((await rows())[0]!.dedupeKey).toBe(`weekly:${school.id}:${admin1.id}:2026-W45`);
    // Keyingi hafta — yangi kalit
    await runWeeklyReports(new Date('2026-11-13T04:00:00Z'));
    expect(await TelegramOutbox.countDocuments()).toBe(4);
  });

  it("o'tgan hafta davomati bo'lmasa farq ko'rsatilmaydi", async () => {
    await startBot();
    await AttendanceRecord.deleteMany({ date: '2026-10-28' });
    await runWeeklyReports(WEEKLY);
    expect(await textOf(201)).toContain('<b>Davomat: 86,7%</b>\n');
  });
});

describe('buyruqlar', () => {
  it("/hisobot school_admin uchun bugungi hisobot, o'qituvchiga rad", async () => {
    const r = await say(201, '/hisobot');
    expect(r).toContain('Kunlik hisobot — 4-noyabr (chorshanba)');
    expect(r).toContain('Davomat: 86,7%');
    expect(await say(301, '/hisobot')).toBe('Bu buyruq rahbariyat uchun.');
    expect(await say(301, '/haftalik')).toBe('Bu buyruq rahbariyat uchun.');
  });

  it('/haftalik hafta boshidan', async () => {
    const r = await say(201, '/haftalik');
    expect(r).toContain('Haftalik hisobot — 2-noyabr – 4-noyabr');
    expect(r).toContain('Davomat: 86,7%');
  });

  it("ulanmagan chat; superadmin ko'p maktabli qisqa xulosa oladi", async () => {
    expect(await say(555, '/hisobot')).toContain('hisobga ulanmagan');
    const r = (await say(900, '/hisobot'))!;
    expect(r).toContain('Kunlik xulosa — 4-noyabr (chorshanba)');
    expect(r).toContain('Maktab rep: 86,7% (13 / 15) · olinmagan sinflar: 2');
    expect(r).toContain('Maktab rep2: davomat olinmagan');
    expect(await say(900, '/haftalik')).toContain('admin paneldan');
  });

  it('/help rahbariyat buyruqlarini ko‘rsatadi; bot menyusida bor', async () => {
    expect(HELP_TEXT).toContain('/hisobot');
    expect(HELP_TEXT).toContain('/haftalik');
    expect(await say(201, '/help')).toBe(HELP_TEXT);
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(
      expect.arrayContaining(['hisobot', 'haftalik']),
    );
  });
});
