import { logger } from '../../core/logger';
import { ClassModel } from '../../models/Class';
import { ExamSession, type ExamSessionDoc } from '../../models/ExamSession';
import { School } from '../../models/School';
import { Subject } from '../../models/Subject';
import { blockQuestionCount, normalizeBlocks } from '../exams/blocks/blocks.core';
import { clock } from '../../utils/clock';
import { buildRows, loadAttempts, sortRanked } from '../exams/results/results.core';
import { fmtTashkent } from '../exams/sessions/sessions.pdf';
import { escapeHtml as esc } from './telegram.format';
import { telegramManager } from './telegram.manager';
import { telegramNotify, type EnqueueItem } from './telegram.outbox';
import { fmtPct, reportRecipients } from './telegram.report';
import { getTelegramSettings } from './telegram.schedule';

const MEDALS = ['🥇', '🥈', '🥉'];
const REMINDER_WINDOW_MS = 30 * 60_000;

const classNames = async (s: Pick<ExamSessionDoc, 'classIds'>): Promise<string[]> =>
  s.classIds.length
    ? (
        await ClassModel.find({ _id: { $in: s.classIds } })
          .select('name')
          .sort({ name: 1 })
          .lean()
      ).map((c) => c.name)
    : [];

/** Imtihon yopilganda rahbariyatga xulosa (HTML): nom, sinflar, topshirgan/jami, o'rtacha %, top 3 */
export function buildExamClosedMessage(input: {
  schoolName: string;
  title: string;
  classes: string[];
  submitted: number;
  total: number;
  averagePercent: number | null;
  top: { name: string; percent: number }[];
}): string {
  const lines = [
    `📝 <b>Imtihon yakunlandi</b> · ${esc(input.schoolName)}`,
    esc(input.title) + (input.classes.length ? ` (${esc(input.classes.join(', '))})` : ''),
    `Topshirdi: <b>${input.submitted}/${input.total}</b>` +
      (input.averagePercent !== null ? ` · o'rtacha: <b>${fmtPct(input.averagePercent)}</b>` : ''),
  ];
  input.top.forEach((t, i) =>
    lines.push(`${MEDALS[i] ?? `${i + 1}.`} ${esc(t.name)} — ${fmtPct(t.percent)}`),
  );
  return lines.join('\n');
}

/**
 * Imtihon yopilganda (qo'lda yoki avtomatik): (a) rahbariyatga xulosa, (b) tekshirilmagan esse bo'lsa
 * tekshiruvchilarga (yaratuvchi + nazoratchilar) eslatma. `notify.examResults` o'chiq yoki bot ishlamasa hech narsa.
 * dedupeKey: exam:<sessionId>:closed:<userId> va exam:<sessionId>:essays:<userId>. Hech qachon tashlamaydi.
 */
export async function notifyExamClosed(sessionId: string): Promise<number> {
  try {
    if (!telegramManager.isRunning()) return 0;
    const session = await ExamSession.findById(sessionId).select('+questionPool');
    if (!session) return 0;
    const schoolId = String(session.schoolId);
    const settings = await getTelegramSettings(schoolId);
    if (!settings.notify.examResults) return 0;
    const school = await School.findById(schoolId).select('name').lean();
    if (!school) return 0;
    const attempts = await loadAttempts(session);
    const { rows, summary } = buildRows(session, attempts);
    const top = sortRanked(rows)
      .filter((r) => r.rank !== null)
      .slice(0, 3)
      .map((r) => ({ name: r.fullName, percent: r.percent! }));
    const text = buildExamClosedMessage({
      schoolName: school.name,
      title: session.title,
      classes: await classNames(session),
      submitted: summary.submitted,
      total: summary.participants,
      averagePercent: summary.averagePercent,
      top,
    });
    const items: EnqueueItem[] = (await reportRecipients(schoolId)).map((userId) => ({
      userId,
      kind: 'examResults',
      parseMode: 'HTML',
      dedupeKey: `exam:${sessionId}:closed:${userId}`,
      text,
    }));
    if (summary.essayPending > 0) {
      const graders = new Set([String(session.createdBy), ...session.supervisorIds.map(String)]);
      for (const userId of graders) {
        items.push({
          userId,
          kind: 'examEssays',
          parseMode: 'HTML',
          dedupeKey: `exam:${sessionId}:essays:${userId}`,
          text: `✍️ <b>${esc(session.title)}</b>: ${summary.essayPending} ta esse tekshirilishi kerak.`,
        });
      }
    }
    return await telegramNotify.enqueueMany(items);
  } catch (err) {
    logger.error({ err, sessionId }, 'Imtihon yakuni Telegram xabarini navbatga qo‘yishda xato');
    return 0;
  }
}

const subjectNames = async (ids: string[]): Promise<Map<string, string>> =>
  new Map(
    (
      await Subject.find({ _id: { $in: ids } })
        .select('name')
        .lean()
    ).map((s) => [String(s._id), s.name]),
  );

const deadlineText = (d: Date | null | undefined) => (d ? fmtTashkent(d) : 'belgilanmagan');

/**
 * Blokka o'qituvchi biriktirilganda xabar: «Siz «{imtihon}» imtihonining {fan} fani bo'yicha biriktirildingiz.
 * Savollar soni: N. Muddat: {sana}.» dedupe: exam:<id>:contrib:<blockId>:<userId>:assigned. `notify.examReminders`
 * o'chiq bo'lsa yoki bot ishlamasa hech narsa. Hech qachon tashlamaydi (chaqiruvchi `void` qiladi).
 */
export async function notifyBlockAssignments(
  sessionId: string,
  assignments: { blockId: string; userIds: string[] }[],
): Promise<number> {
  try {
    if (!assignments.length || !telegramManager.isRunning()) return 0;
    const s = await ExamSession.findById(sessionId).select('schoolId title blocks contribDeadline');
    if (!s) return 0;
    const settings = await getTelegramSettings(String(s.schoolId));
    if (!settings.notify.examReminders) return 0;
    const blocks = new Map(normalizeBlocks(s).map((b) => [b.blockId, b]));
    const names = await subjectNames([...blocks.values()].map((b) => b.subjectId ?? ''));
    const items: EnqueueItem[] = [];
    for (const a of assignments) {
      const b = blocks.get(a.blockId);
      if (!b) continue;
      const text =
        `📝 Siz «${esc(s.title)}» imtihoni uchun ${esc(names.get(b.subjectId ?? '') ?? b.title)} fanidan savollar tayyorlashga biriktirildingiz.` +
        ` Savollar soni: ${b.targetCount || blockQuestionCount(b)}. Muddat: ${esc(deadlineText(s.contribDeadline))}.`;
      for (const userId of a.userIds) {
        items.push({
          userId,
          kind: 'examBlock',
          parseMode: 'HTML',
          dedupeKey: `exam:${sessionId}:contrib:${a.blockId}:${userId}:assigned`,
          text,
        });
      }
    }
    return await telegramNotify.enqueueMany(items);
  } catch (err) {
    logger.error({ err, sessionId }, 'Blok biriktirish xabarini navbatga qo‘yishda xato');
    return 0;
  }
}

/**
 * Imtihonning barcha fanlari "tayyor" bo'lganda tuzuvchiga xabar (bir marta: dedupe exam:<id>:allready:<userId>).
 * `notify.examReminders` o'chiq yoki bot ishlamasa hech narsa.
 */
export async function notifyAllBlocksReady(sessionId: string): Promise<number> {
  try {
    if (!telegramManager.isRunning()) return 0;
    const s = await ExamSession.findById(sessionId).select(
      'schoolId title blocks status createdBy',
    );
    if (!s || s.status !== 'draft') return 0;
    const blocks = normalizeBlocks(s).filter((b) => !b.legacy);
    if (!blocks.length || !blocks.every((b) => b.status === 'ready')) return 0;
    const settings = await getTelegramSettings(String(s.schoolId));
    if (!settings.notify.examReminders) return 0;
    return await telegramNotify.enqueueMany([
      {
        userId: String(s.createdBy),
        kind: 'examBlock',
        parseMode: 'HTML',
        dedupeKey: `exam:${sessionId}:allready:${String(s.createdBy)}`,
        text: `✅ «${esc(s.title)}» imtihoni: barcha fanlar uchun savollar tayyor. Imtihonni rejalashtirishingiz mumkin.`,
      },
    ]);
  } catch (err) {
    logger.error({ err, sessionId }, 'Imtihon tayyorligi xabarini navbatga qo‘yishda xato');
    return 0;
  }
}

/** "Eslatma" tugmasi: bir fanga soatiga ko'pi bilan bir marta */
export const REMIND_COOLDOWN_MS = 3_600_000;

export interface RemindResult {
  /** `notify.examReminders` o'chiq: hech narsa yuborilmadi */
  disabled: boolean;
  /** Telegram bot ulanmagan/ishlamayapti */
  notConnected: boolean;
  /** Navbatga qo'yilgan xabarlar soni */
  sent: number;
  blocks: { blockId: string; subjectName: string; state: 'sent' | 'recent' }[];
}

/**
 * Ma'muriyat "Eslatma" tugmasi: tugallanmagan (o'qituvchi "tugatdim" demagan va tasdiqlanmagan), o'qituvchisi bor
 * fanlarning o'qituvchilariga HOZIR Telegram eslatmasi. Har fanga soatiga bir marta (blokdagi `remindedAt` atomik
 * band qilinadi, parallel bosishda ham bitta). `notify.examReminders` o'chiq yoki bot ishlamasa band qilinmaydi.
 * Matn HTML-escape qilinadi. Hech qachon tashlamaydi.
 */
export async function remindBlocksNow(
  sessionId: string,
  now: Date = clock.now(),
): Promise<RemindResult> {
  const empty: RemindResult = { disabled: false, notConnected: false, sent: 0, blocks: [] };
  try {
    const s = await ExamSession.findById(sessionId).select(
      'schoolId title blocks contribDeadline status',
    );
    if (!s || s.status !== 'draft') return empty;
    const settings = await getTelegramSettings(String(s.schoolId));
    if (!settings.notify.examReminders) return { ...empty, disabled: true };
    if (!telegramManager.isRunning()) return { ...empty, notConnected: true };
    const targets = normalizeBlocks(s).filter(
      (b) => !b.legacy && b.contributors.length > 0 && b.status !== 'ready',
    );
    if (!targets.length) return empty;
    const names = await subjectNames(targets.map((b) => b.subjectId ?? ''));
    const before = new Date(now.getTime() - REMIND_COOLDOWN_MS);
    const items: EnqueueItem[] = [];
    const blocks: RemindResult['blocks'] = [];
    for (const b of targets) {
      const subjectName = names.get(b.subjectId ?? '') ?? b.title;
      const claimed = await ExamSession.updateOne(
        {
          _id: s._id,
          status: 'draft',
          blocks: {
            $elemMatch: {
              blockId: b.blockId,
              status: { $ne: 'ready' },
              $or: [
                { remindedAt: null },
                { remindedAt: { $exists: false } },
                { remindedAt: { $lte: before } },
              ],
            },
          },
        },
        { $set: { 'blocks.$.remindedAt': now } },
      );
      if (!claimed.matchedCount) {
        blocks.push({ blockId: b.blockId, subjectName, state: 'recent' });
        continue;
      }
      blocks.push({ blockId: b.blockId, subjectName, state: 'sent' });
      const text =
        `🔔 <b>Eslatma: imtihon savollari</b>
«${esc(s.title)}» · ${esc(subjectName)}: ` +
        `${blockQuestionCount(b)}/${b.targetCount} ta savol.
` +
        `Muddat: ${esc(deadlineText(s.contribDeadline))}
` +
        `Savollar tayyor bo'lgach «Tugatdim» tugmasini bosing.`;
      for (const userId of b.contributors) {
        items.push({
          userId,
          kind: 'examBlock',
          parseMode: 'HTML',
          dedupeKey: `exam:${sessionId}:contrib:${b.blockId}:${userId}:remind:${now.getTime()}`,
          text,
        });
      }
    }
    const sent = items.length ? await telegramNotify.enqueueMany(items) : 0;
    return { ...empty, sent, blocks };
  } catch (err) {
    logger.error({ err, sessionId }, 'Eslatma xabarini navbatga qo‘yishda xato');
    return empty;
  }
}

const CONTRIB_REMINDER_MS = 24 * 3_600_000;

/**
 * Savol topshirish muddatidan 1 kun oldin (va muddatgacha) maqsadga yetmagan blok o'qituvchilariga eslatma.
 * Faqat qoralama imtihon, blok "tayyor" emas va savollar < maqsad. dedupe: exam:<id>:contrib:<blockId>:<userId>:reminder.
 */
export async function runBlockReminders(now: Date = clock.now()): Promise<number> {
  try {
    if (!telegramManager.isRunning()) return 0;
    const sessions = await ExamSession.find({
      status: 'draft',
      isDeleted: { $ne: true },
      contribDeadline: { $gt: now, $lte: new Date(now.getTime() + CONTRIB_REMINDER_MS) },
    }).select('schoolId title blocks contribDeadline');
    let sent = 0;
    for (const s of sessions) {
      const settings = await getTelegramSettings(String(s.schoolId));
      if (!settings.notify.examReminders) continue;
      const blocks = normalizeBlocks(s).filter(
        (b) =>
          !b.legacy &&
          b.status !== 'ready' &&
          b.contributors.length &&
          blockQuestionCount(b) < b.targetCount,
      );
      if (!blocks.length) continue;
      const names = await subjectNames(blocks.map((b) => b.subjectId ?? ''));
      const items: EnqueueItem[] = [];
      for (const b of blocks) {
        const text =
          `⏰ <b>Savol topshirish muddati yaqin</b>
«${esc(s.title)}» · ${esc(names.get(b.subjectId ?? '') ?? b.title)} fani: ` +
          `${blockQuestionCount(b)}/${b.targetCount} ta savol.
Muddat: ${esc(deadlineText(s.contribDeadline))}`;
        for (const userId of b.contributors) {
          items.push({
            userId,
            kind: 'examBlock',
            parseMode: 'HTML',
            dedupeKey: `exam:${String(s._id)}:contrib:${b.blockId}:${userId}:reminder`,
            text,
          });
        }
      }
      sent += await telegramNotify.enqueueMany(items);
    }
    return sent;
  } catch (err) {
    logger.error({ err }, 'Blok eslatmalarini navbatga qo‘yishda xato');
    return 0;
  }
}

/**
 * Nazoratchilarga imtihondan 30 daqiqa oldin eslatma (har daqiqalik vazifadan). Faqat [boshlanish-30 daq, boshlanish)
 * oralig'ida: kech yaratilgan imtihon uchun ham shu oynada bir marta yetkaziladi (dedupe: exam:<id>:reminder:<userId>).
 * `notify.examReminders` o'chiq bo'lsa hech narsa.
 */
export async function runExamReminders(now: Date = clock.now()): Promise<number> {
  try {
    if (!telegramManager.isRunning()) return 0;
    const sessions = await ExamSession.find({
      status: 'scheduled',
      isDeleted: { $ne: true },
      scheduledStart: { $gt: now, $lte: new Date(now.getTime() + REMINDER_WINDOW_MS) },
    }).select(
      'schoolId title code scheduledStart classIds supervisorIds createdBy scheduleVersion',
    );
    let sent = 0;
    for (const s of sessions) {
      const settings = await getTelegramSettings(String(s.schoolId));
      if (!settings.notify.examReminders) continue;
      const mins = Math.max(1, Math.round((s.scheduledStart.getTime() - now.getTime()) / 60_000));
      const classes = await classNames(s);
      const text =
        `⏰ <b>Imtihon ${mins} daqiqadan keyin</b>\n${esc(s.title)}` +
        (classes.length ? ` (${esc(classes.join(', '))})` : '') +
        `\nBoshlanishi: ${esc(fmtTashkent(s.scheduledStart))}` +
        (s.code ? `\nKod: <code>${esc(s.code)}</code>` : '');
      const users = new Set([String(s.createdBy), ...s.supervisorIds.map(String)]);
      sent += await telegramNotify.enqueueMany(
        [...users].map((userId) => ({
          userId,
          kind: 'examReminder',
          parseMode: 'HTML' as const,
          // Qoralamaga qaytarilib qayta rejalashtirilgan imtihon (scheduleVersion>0) yangi eslatma oladi;
          // 0 versiyada eski kalit formati saqlanadi (allaqachon yuborilganlar qayta ketmaydi)
          dedupeKey: s.scheduleVersion
            ? `exam:${String(s._id)}:reminder:v${s.scheduleVersion}:${userId}`
            : `exam:${String(s._id)}:reminder:${userId}`,
          text,
        })),
      );
    }
    return sent;
  } catch (err) {
    logger.error({ err }, 'Imtihon eslatmalarini navbatga qo‘yishda xato');
    return 0;
  }
}
