import { logger } from '../../core/logger';
import { School } from '../../models/School';
import { User } from '../../models/User';
import { addDaysStr, tashkentDate } from '../../utils/clock';
import { isoWeekday } from '../../utils/dates';
import { dateLongUz, dayMonthUz, escapeHtml as esc, hhmmTashkent } from './telegram.format';
import { telegramManager } from './telegram.manager';
import { telegramNotify, type EnqueueItem } from './telegram.outbox';
import {
  loadClassRatingExtremes,
  loadDayAttendance,
  loadDiscipline,
  loadRangeAttendanceRate,
  type DayAttendance,
} from './telegram.report.data';
import { getTelegramSettings } from './telegram.schedule';
import { REPORT_SCOPE_ALL } from './telegram.superadmin';

const MAX_LISTED_CLASSES = 15;

/** 92.4 -> "92,4"; 78 -> "78" */
export function fmtPct(n: number): string {
  const r = Math.round(n * 10) / 10;
  return String(r).replace('.', ',');
}

const isoWeekKey = (date: string): string => {
  // ISO hafta: payshanba joylashgan yil bo'yicha
  const d = new Date(`${date}T00:00:00Z`);
  const thu = new Date(d.getTime() + (4 - isoWeekday(date)) * 86_400_000);
  const jan1 = Date.UTC(thu.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thu.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const mondayOf = (date: string): string => addDaysStr(date, -(isoWeekday(date) - 1));

// ---------- Matn quruvchilar ----------

function absentLines(a: DayAttendance): string[] {
  if (!a.absentByClass.length) return [];
  return [
    '',
    '<b>Kelmaganlar:</b>',
    ...a.absentByClass.map(
      (g) =>
        `${esc(g.className)}: ` +
        g.students.map((s) => esc(s.fullName) + (s.excused ? ' (sababli)' : '')).join(', '),
    ),
  ];
}

/** Kunlik hisobot (HTML). Davomat umuman olinmagan bo'lsa qisqa eslatma */
export async function buildDailyReport(
  schoolId: string,
  schoolName: string,
  date: string,
  opts: { absentNames: boolean },
): Promise<string> {
  const head = [`📊 <b>Kunlik hisobot — ${dateLongUz(date)}</b>`, esc(schoolName)];
  const a = await loadDayAttendance(schoolId, date);
  if (!a.takenAny) return [...head, '', 'Bugun davomat olinmagan.'].join('\n');

  const lines = [...head, ''];
  lines.push(
    `<b>Davomat: ${a.rate === null ? '—' : fmtPct(a.rate) + '%'}</b> (${a.present + a.late + a.partial} / ${a.marked})`,
  );
  const absent = a.absentExcused + a.absentUnexcused;
  lines.push(
    `✅ Kelgan: ${a.present}   ⏰ Kechikkan: ${a.late}   ❌ Kelmagan: ${absent}` +
      (a.absentExcused ? ` (sababli ${a.absentExcused})` : ''),
  );
  if (a.partial) lines.push(`◐ Qisman (ba'zi darslarda yo'q): ${a.partial}`);
  if (a.unmarkedClasses.length) {
    const shown = a.unmarkedClasses.slice(0, MAX_LISTED_CLASSES).map(esc).join(', ');
    const more = a.unmarkedClasses.length - MAX_LISTED_CLASSES;
    lines.push(
      `Davomat olinmagan sinflar: ${a.unmarkedClasses.length} — ${shown}${more > 0 ? ` va yana ${more} ta` : ''}`,
    );
  }
  const low = a.classes
    .filter((c) => c.rate !== null && c.rate < 100)
    .sort(
      (x, y) =>
        (x.rate as number) - (y.rate as number) ||
        x.name.localeCompare(y.name, 'uz', { numeric: true }),
    )
    .slice(0, 3);
  if (low.length) {
    lines.push('', '<b>Eng past davomat:</b>');
    low.forEach((c, i) => lines.push(`${i + 1}. ${esc(c.name)} — ${fmtPct(c.rate as number)}%`));
  }
  const disc = await loadDiscipline(schoolId, date, date);
  if (disc.total > 0) {
    lines.push(
      '',
      `Xulq: bugun ${disc.total} ta qayd (salbiy: ${disc.negative}, ijobiy: ${disc.positive})`,
    );
  }
  if (opts.absentNames) lines.push(...absentLines(a));
  return lines.join('\n');
}

/** Haftalik hisobot (Dushanba..date). Ma'lumoti yo'q bo'limlar tushiriladi */
export async function buildWeeklyReport(
  schoolId: string,
  schoolName: string,
  date: string,
): Promise<string> {
  const from = mondayOf(date);
  const lines = [
    `📈 <b>Haftalik hisobot — ${dayMonthUz(from)} – ${dayMonthUz(date)}</b>`,
    esc(schoolName),
    '',
  ];
  const [cur, prev] = await Promise.all([
    loadRangeAttendanceRate(schoolId, from, date),
    loadRangeAttendanceRate(schoolId, addDaysStr(from, -7), addDaysStr(date, -7)),
  ]);
  if (cur.rate === null) {
    lines.push('Bu hafta davomat olinmagan.');
  } else {
    let delta = '';
    if (prev.rate !== null) {
      const d = Math.round((cur.rate - prev.rate) * 10) / 10;
      delta =
        d === 0
          ? ' · o‘tgan haftadek'
          : ` · ${d > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(d))} pp o‘tgan haftaga nisbatan`;
    }
    lines.push(`<b>Davomat: ${fmtPct(cur.rate)}%</b>${delta}`);
  }

  const rating = await loadClassRatingExtremes(schoolId);
  if (rating) {
    lines.push('', `<b>Sinflar reytingi</b> (${esc(rating.periodLabel)})`, 'Eng yuqori:');
    rating.top.forEach((r) => lines.push(`${r.rank}. ${esc(r.name)} — ${fmtPct(r.score)}`));
    if (rating.bottom.length) {
      lines.push('Eng past:');
      rating.bottom.forEach((r) => lines.push(`${r.rank}. ${esc(r.name)} — ${fmtPct(r.score)}`));
    }
  }

  const disc = await loadDiscipline(schoolId, from, date);
  if (disc.total > 0) {
    lines.push(
      '',
      `<b>Xulq:</b> ${disc.total} ta qayd (salbiy: ${disc.negative}, ijobiy: ${disc.positive})`,
    );
    if (disc.topNegativeTypes.length) {
      lines.push('Ko‘p uchragan qoidabuzarliklar:');
      disc.topNegativeTypes.forEach((t, i) =>
        lines.push(`${i + 1}. ${esc(t.name)} — ${t.count} ta`),
      );
    }
    if (disc.topStudents.length) {
      lines.push('Eng ko‘p salbiy qayd:');
      disc.topStudents.forEach((s, i) =>
        lines.push(`${i + 1}. ${esc(s.fullName)} (${esc(s.className)}) — ${s.count} ta`),
      );
    }
  }
  return lines.join('\n');
}

/** Superadmin uchun: barcha faol maktablar bo'yicha qisqa kunlik xulosa (maktab — bir qator) */
export async function buildSuperadminSummary(date: string): Promise<string> {
  const schools = await School.find({ isActive: true }).select('name').sort({ name: 1 }).lean();
  const lines = [`📊 <b>Kunlik xulosa — ${dateLongUz(date)}</b>`, ''];
  for (const s of schools) {
    const a = await loadDayAttendance(String(s._id), date);
    lines.push(
      a.takenAny
        ? `${esc(s.name)}: ${a.rate === null ? '—' : fmtPct(a.rate) + '%'} (${a.present + a.late + a.partial} / ${a.marked})` +
            (a.unmarkedClasses.length ? ` · olinmagan sinflar: ${a.unmarkedClasses.length}` : '')
        : `${esc(s.name)}: davomat olinmagan`,
    );
  }
  if (!schools.length) lines.push('Faol maktab yo‘q.');
  return lines.join('\n');
}

/** Superadmin uchun /haftalik: har bir faol maktab bo'yicha shu haftaning davomati va xulq qaydlari (bir qatordan) */
export async function buildSuperadminWeeklySummary(date: string): Promise<string> {
  const from = mondayOf(date);
  const schools = await School.find({ isActive: true }).select('name').sort({ name: 1 }).lean();
  const lines = [`📈 <b>Haftalik xulosa — ${dayMonthUz(from)} – ${dayMonthUz(date)}</b>`, ''];
  for (const s of schools) {
    const schoolId = String(s._id);
    const [cur, prev, disc] = await Promise.all([
      loadRangeAttendanceRate(schoolId, from, date),
      loadRangeAttendanceRate(schoolId, addDaysStr(from, -7), addDaysStr(date, -7)),
      loadDiscipline(schoolId, from, date),
    ]);
    if (cur.rate === null) {
      lines.push(`${esc(s.name)}: davomat olinmagan`);
      continue;
    }
    let delta = '';
    if (prev.rate !== null) {
      const d = Math.round((cur.rate - prev.rate) * 10) / 10;
      if (d !== 0) delta = ` (${d > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(d))} pp)`;
    }
    lines.push(
      `${esc(s.name)}: ${fmtPct(cur.rate)}%${delta}` +
        (disc.total > 0 ? ` · xulq: ${disc.total} ta qayd (salbiy: ${disc.negative})` : ''),
    );
  }
  if (!schools.length) lines.push('Faol maktab yo‘q.');
  return lines.join('\n');
}

// ---------- Cron ishga tushiruvchilar ----------

export interface ReportRunResult {
  schools: number;
  sent: number;
}

/** Rahbariyat: maktabning faol, Telegram ulangan school_admin lari */
async function leadershipOf(schoolId: string): Promise<string[]> {
  const users = await User.find({
    schoolId,
    role: 'school_admin',
    isActive: true,
    'telegram.chatId': { $ne: null },
  })
    .select('_id')
    .lean();
  return users.map((u) => String(u._id));
}

/**
 * Rejali hisobotni olishni tanlagan superadminlar: faol, Telegram ulangan va reportScope 'all' yoki shu maktab.
 * Maydoni yo'q (eski) hujjatlar mos kelmaydi: default o'chiq.
 */
async function subscribedSuperadmins(schoolId: string): Promise<string[]> {
  const users = await User.find({
    role: 'superadmin',
    isActive: true,
    'telegram.chatId': { $ne: null },
    'telegram.reportScope': { $in: [REPORT_SCOPE_ALL, schoolId] },
  })
    .select('_id')
    .lean();
  return users.map((u) => String(u._id));
}

/** Rejali xabarlar qabul qiluvchilari: maktab rahbariyati + tanlagan superadminlar (takrorsiz) */
export async function reportRecipients(schoolId: string): Promise<string[]> {
  return [
    ...new Set([...(await leadershipOf(schoolId)), ...(await subscribedSuperadmins(schoolId))]),
  ];
}

type Kind = 'daily' | 'weekly';

async function runReports(kind: Kind, now: Date): Promise<ReportRunResult> {
  const result: ReportRunResult = { schools: 0, sent: 0 };
  if (!telegramManager.isRunning()) return result;
  const hhmm = hhmmTashkent(now);
  const date = tashkentDate(now);
  const weekday = isoWeekday(date);
  const schools = await School.find({ isActive: true }).select('name').lean();
  for (const school of schools) {
    const schoolId = String(school._id);
    try {
      const s = await getTelegramSettings(schoolId);
      const due =
        kind === 'daily'
          ? s.notify.dailyReport && s.dailyReportTime === hhmm && s.workdays.includes(weekday)
          : s.notify.weeklyReport && s.weeklyReportTime === hhmm && s.weeklyReportDay === weekday;
      if (!due) continue;
      result.schools++;
      const userIds = await reportRecipients(schoolId);
      if (!userIds.length) {
        logger.warn(
          { schoolId, hhmm, kind },
          'Telegram hisobot vaqti keldi, lekin qabul qiluvchi yo‘q',
        );
        continue;
      }
      const text =
        kind === 'daily'
          ? await buildDailyReport(schoolId, school.name, date, {
              absentNames: s.dailyReportAbsentNames,
            })
          : await buildWeeklyReport(schoolId, school.name, date);
      const period = kind === 'daily' ? date : isoWeekKey(date);
      const items: EnqueueItem[] = userIds.map((userId) => ({
        userId,
        kind: `${kind}Report`,
        parseMode: 'HTML',
        dedupeKey: `${kind}:${schoolId}:${userId}:${period}`,
        text,
      }));
      const enqueued = await telegramNotify.enqueueMany(items);
      result.sent += enqueued;
      logger.info(
        { schoolId, hhmm, kind, recipients: userIds.length, enqueued },
        'Telegram rejali hisobot navbatga qo‘yildi',
      );
    } catch (err) {
      logger.error({ err, schoolId }, `Telegram ${kind} hisobotini yuborishda xato`);
    }
  }
  return result;
}

/**
 * Kunlik hisobot: dailyReportTime hozirgi Toshkent vaqtiga teng, bugun ish kuni va `notify.dailyReport` yoqilgan
 * maktablarning ulangan school_admin lariga. dedupeKey `daily:<maktab>:<foydalanuvchi>:<sana>`.
 * Shuningdek, /sozlamalar orqali shu maktabni (yoki barcha maktablarni) tanlagan faol superadminlarga:
 * qachon va yuborilish-yuborilmasligini maktabning o'z sozlamasi hal qiladi, matn bir xil.
 */
export const runDailyReports = (now: Date = new Date()): Promise<ReportRunResult> =>
  runReports('daily', now);

/** Haftalik hisobot: weeklyReportDay kunida weeklyReportTime da; dedupeKey `weekly:<maktab>:<foydalanuvchi>:<ISO hafta>` */
export const runWeeklyReports = (now: Date = new Date()): Promise<ReportRunResult> =>
  runReports('weekly', now);

// ---------- Buyruqlar ----------

export const REPORT_COMMANDS = ['hisobot', 'haftalik'] as const;
export type ReportCommand = (typeof REPORT_COMMANDS)[number];

/** /hisobot va /haftalik javobi (faqat school_admin va superadmin; o'qituvchi bot.ts da rad etiladi) */
export async function reportCommandReply(
  user: { role: string; schoolId: string | null },
  cmd: ReportCommand,
  today: string,
): Promise<string> {
  if (user.role === 'superadmin') {
    return cmd === 'hisobot' ? buildSuperadminSummary(today) : buildSuperadminWeeklySummary(today);
  }
  if (!user.schoolId) return 'Hisobingiz maktabga bog‘lanmagan.';
  const school = await School.findById(user.schoolId).select('name').lean();
  if (!school) return 'Maktab topilmadi.';
  if (cmd === 'hisobot') {
    const s = await getTelegramSettings(user.schoolId);
    return buildDailyReport(user.schoolId, school.name, today, {
      absentNames: s.dailyReportAbsentNames,
    });
  }
  return buildWeeklyReport(user.schoolId, school.name, today);
}
