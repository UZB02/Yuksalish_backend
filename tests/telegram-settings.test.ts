import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { Setting } from '../src/models/Setting';
import { getTelegramSettings } from '../src/modules/telegram/telegram.schedule';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

const URL_ = '/api/v1/settings/telegram';
let school: { id: string }, other: { id: string };
let admin: string, adminNoPerm: string, adminOther: string, sa: string, teacher: string;

const put = (t: string, b: object) => request(app).put(URL_).set(bearer(t)).send(b);
const get = (t: string) => request(app).get(URL_).set(bearer(t));

beforeEach(async () => {
  school = await makeSchool('tg1');
  other = await makeSchool('tg2');
  await makeUser({ username: 'tg_sa', role: 'superadmin' });
  await makeUser({ username: 'tg_t', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'tg_a',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['attendance.settings'],
  });
  await makeUser({ username: 'tg_a0', role: 'school_admin', schoolId: school.id });
  await makeUser({
    username: 'tg_ao',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ['attendance.settings'],
  });
  sa = (await login('tg_sa')).token;
  teacher = (await login('tg_t')).token;
  admin = (await login('tg_a')).token;
  adminNoPerm = (await login('tg_a0')).token;
  adminOther = (await login('tg_ao')).token;
});

describe('Telegram sozlamalari', () => {
  it('standart qiymatlar; workdays/weeklyReportDay maktab ish haftasidan hosil bo‘ladi', async () => {
    const r = await get(admin);
    expect(r.status).toBe(200);
    expect(r.body.data.effective).toEqual({
      workdays: null,
      morningTime: '07:30',
      dailyReportTime: '16:00',
      weeklyReportDay: null,
      weeklyReportTime: '17:00',
      notify: {
        morningSchedule: true,
        substitutions: true,
        timetableChanges: true,
        dailyReport: true,
        weeklyReport: true,
      },
      dailyReportAbsentNames: true,
    });
    const s = await getTelegramSettings(school.id);
    expect(s.workdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.weeklyReportDay).toBe(6);
  });

  it('school_admin o‘z maktabi uchun saqlaydi; notify to‘liq obyekt bo‘ladi; ish kunlari tartiblanadi', async () => {
    const r = await put(admin, {
      scope: 'school',
      schoolId: school.id,
      values: { workdays: [5, 1, 3], morningTime: '07:00', notify: { dailyReport: false } },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.override.workdays).toEqual([1, 3, 5]);
    expect(r.body.data.effective.notify).toEqual({
      morningSchedule: true,
      substitutions: true,
      timetableChanges: true,
      dailyReport: false,
      weeklyReport: true,
    });
    const s = await getTelegramSettings(school.id);
    expect(s.workdays).toEqual([1, 3, 5]);
    expect(s.weeklyReportDay).toBe(5);
    expect(s.morningTime).toBe('07:00');
    expect((await getTelegramSettings(other.id)).morningTime).toBe('07:30');
  });

  it('tekshiruv: vaqt HH:MM, kunlar 1..7 va takrorsiz, haftalik kun ish kunlarida', async () => {
    const bad = async (values: object) =>
      (await put(admin, { scope: 'school', schoolId: school.id, values })).status;
    expect(await bad({ morningTime: '7:30' })).toBe(400);
    expect(await bad({ morningTime: '24:00' })).toBe(400);
    expect(await bad({ dailyReportTime: '16:60' })).toBe(400);
    expect(await bad({ workdays: [] })).toBe(400);
    expect(await bad({ workdays: [0, 1] })).toBe(400);
    expect(await bad({ workdays: [8] })).toBe(400);
    expect(await bad({ workdays: [1, 1] })).toBe(400);
    expect(await bad({ weeklyReportDay: 9 })).toBe(400);
    expect(await bad({ workdays: [1, 2], weeklyReportDay: 5 })).toBe(400);
    expect(await bad({ notify: { dailyReport: 'ha' } })).toBe(400);
    expect(await bad({ workdays: [1, 2], weeklyReportDay: 2, weeklyReportTime: '18:15' })).toBe(
      200,
    );
  });

  it('ruxsatlar: ruxsatsiz admin va o‘qituvchi yozolmaydi, boshqa maktabga yozish taqiqlanadi, superadmin hammasiga', async () => {
    const body = { scope: 'school', schoolId: school.id, values: { morningTime: '08:00' } };
    expect((await put(teacher, body)).status).toBe(403);
    expect((await put(adminNoPerm, body)).status).toBe(403);
    expect((await put(adminOther, body)).status).toBe(403);
    expect((await put(admin, { ...body, scope: 'global' })).status).toBe(403);
    expect((await put(sa, body)).status).toBe(200);
    expect((await put(sa, { scope: 'global', values: { morningTime: '07:45' } })).status).toBe(200);
    expect((await getTelegramSettings(other.id)).morningTime).toBe('07:45');
    expect((await getTelegramSettings(school.id)).morningTime).toBe('08:00');
    expect(await Setting.countDocuments({ key: 'telegram' })).toBe(2);
  });
});
