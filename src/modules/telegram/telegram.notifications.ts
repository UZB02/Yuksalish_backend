import { logger } from '../../core/logger';
import { Subject } from '../../models/Subject';
import { todayTashkent } from '../../utils/clock';
import { uniq } from '../../utils/helpers';
import type { OverrideDto } from '../timetable/overrides.service';
import { dayMonthUz, escapeHtml as esc, weekdayShortUz } from './telegram.format';
import { telegramManager } from './telegram.manager';
import { telegramNotify, type EnqueueItem } from './telegram.outbox';
import { getTelegramSettings } from './telegram.schedule';

type Action = 'created' | 'deleted';

const slotText = (d: OverrideDto) => `${dayMonthUz(d.date)} ${d.lessonNo}-soat`;
const subjectOf = (d: OverrideDto) => d.subject?.name ?? d.originalSubject?.name ?? '?';

/** Bitta almashtirish uchun: o'qituvchi id -> matn (HTML-xavfsiz) */
function singleMessages(d: OverrideDto, action: Action): Map<string, string> {
  const out = new Map<string, string>();
  const cls = esc(d.class.name);
  const slot = slotText(d);
  const subj = esc(subjectOf(d));
  const orig = d.originalTeacher;
  const cur = d.teacher;

  if (action === 'deleted') {
    const text = (extra = '') => `↩️ ${slot} · ${cls} · ${subj}: ${extra}`.trimEnd();
    if (d.type === 'extra') {
      if (cur) out.set(cur.id, text("qo'shimcha dars bekor qilindi"));
      return out;
    }
    const msg = text('almashtirish bekor qilindi, dars odatdagidek');
    const recipients = d.type === 'cancel' ? [orig] : [orig, cur];
    for (const t of recipients) if (t) out.set(t.id, msg);
    return out;
  }

  switch (d.type) {
    case 'substitute':
      if (cur && orig) {
        out.set(
          cur.id,
          `🔁 Siz ${slot} ${cls} sinfida ${subj} darsiga ${esc(orig.fullName)} o'rniga kirasiz`,
        );
        out.set(orig.id, `🔁 ${slot} ${cls} ${subj} darsingizga ${esc(cur.fullName)} kiradi`);
      }
      break;
    case 'cancel':
      if (orig) {
        const why = d.reason ? ` Sabab: ${esc(d.reason)}.` : '';
        out.set(orig.id, `❌ ${slot} ${cls} ${subj} darsingiz bekor qilindi.${why}`);
      }
      break;
    case 'replace':
      if (cur) {
        const was = d.originalSubject ? `, jadvaldagi fan: ${esc(d.originalSubject.name)}` : '';
        if (orig && orig.id !== cur.id) {
          out.set(
            cur.id,
            `🔄 Siz ${slot} ${cls} sinfida ${subj} darsiga kirasiz (dars o'zgardi${was})`,
          );
          out.set(
            orig.id,
            `🔄 ${slot} ${cls} darsingiz o'zgardi: endi ${esc(cur.fullName)} ${subj} o'tadi`,
          );
        } else {
          out.set(cur.id, `🔄 ${slot} ${cls} darsingiz o'zgardi: endi ${subj}${was}`);
        }
      }
      break;
    case 'extra':
      if (cur) out.set(cur.id, `➕ Qo'shimcha dars: ${slot} · ${cls} · ${subj}`);
      break;
  }
  return out;
}

/** Ko'chirish (cancel + extra juftligi): o'qituvchi id -> matn */
function moveMessages(
  cancel: OverrideDto,
  extra: OverrideDto,
  action: Action,
): Map<string, string> {
  const out = new Map<string, string>();
  const subj = esc(subjectOf(extra));
  const head = `${esc(cancel.class.name)} · ${subj}`;
  const text =
    action === 'created'
      ? `🔀 ${head}: ${slotText(cancel)} → ${slotText(extra)} ko'chirildi`
      : `↩️ ${head}: ko'chirish bekor qilindi, dars odatdagidek (${slotText(cancel)})`;
  const src = cancel.originalTeacher;
  const dst = extra.teacher;
  if (src) {
    const other =
      action === 'created' && dst && dst.id !== src.id
        ? ` Dars o'qituvchisi: ${esc(dst.fullName)}.`
        : '';
    out.set(src.id, text + other);
  }
  if (dst && !out.has(dst.id)) out.set(dst.id, text);
  return out;
}

/**
 * Almashtirish/bekor/ko'chirish yaratilgandan yoki o'chirilgandan keyin tegishli o'qituvchilarga xabar.
 * Faqat bugun va kelajak sanalari; `notify.substitutions` o'chiq bo'lsa yoki bot ishlamasa — hech narsa.
 * Hech qachon tashlamaydi (asosiy amal buzilmasin).
 */
export async function notifyOverrideChange(
  schoolId: string,
  dtos: OverrideDto[],
  action: Action,
): Promise<void> {
  try {
    if (!dtos.length || !telegramManager.isRunning()) return;
    const today = todayTashkent();
    const settings = await getTelegramSettings(schoolId);
    if (!settings.notify.substitutions) return;

    const items: EnqueueItem[] = [];
    const add = (messages: Map<string, string>, key: string) => {
      for (const [userId, text] of messages) {
        items.push({
          userId,
          text,
          kind: 'override',
          parseMode: 'HTML',
          dedupeKey: `${key}:${action}:${userId}`,
        });
      }
    };

    const moves = new Map<string, OverrideDto[]>();
    for (const d of dtos) {
      if (d.moveGroupId) moves.set(d.moveGroupId, [...(moves.get(d.moveGroupId) ?? []), d]);
    }
    for (const [groupId, pair] of moves) {
      const cancel = pair.find((x) => x.type === 'cancel');
      const extra = pair.find((x) => x.type === 'extra');
      if (!cancel || !extra) continue;
      if (cancel.date < today && extra.date < today) continue;
      add(moveMessages(cancel, extra, action), `ovmove:${groupId}`);
    }
    for (const d of dtos) {
      if (d.moveGroupId || d.date < today) continue;
      add(singleMessages(d, action), `ov:${d.id}`);
    }
    await telegramNotify.enqueueMany(items);
  } catch (err) {
    logger.error({ err }, 'Almashtirish xabarini yuborishda xato');
  }
}

/** Faollashtirishdan oldin/keyin: sinfning dars yozuvlari (hafta kuni x soat x fan x o'qituvchi) */
export interface VersionEntryLite {
  weekday: number;
  lessonNo: number;
  subjectId: string;
  teacherId: string;
}

export interface VersionChange {
  versionId: string;
  className: string;
  validFrom: string;
  before: VersionEntryLite[];
  after: VersionEntryLite[];
}

const key = (e: VersionEntryLite) => `${e.weekday}|${e.lessonNo}|${e.subjectId}`;

/** O'qituvchi -> o'zgarishlar (+ qo'shildi, − olib tashlandi) bitta sinf uchun */
export function diffByTeacher(
  before: VersionEntryLite[],
  after: VersionEntryLite[],
): Map<string, { added: VersionEntryLite[]; removed: VersionEntryLite[] }> {
  const out = new Map<string, { added: VersionEntryLite[]; removed: VersionEntryLite[] }>();
  const slot = (t: string) => {
    let v = out.get(t);
    if (!v) out.set(t, (v = { added: [], removed: [] }));
    return v;
  };
  const sets = (list: VersionEntryLite[]) => {
    const m = new Map<string, Set<string>>();
    for (const e of list) {
      const s = m.get(e.teacherId) ?? new Set<string>();
      s.add(key(e));
      m.set(e.teacherId, s);
    }
    return m;
  };
  const b = sets(before);
  const a = sets(after);
  const byKey = (list: VersionEntryLite[]) =>
    new Map(list.map((e) => [`${e.teacherId}#${key(e)}`, e]));
  const bk = byKey(before);
  const ak = byKey(after);
  for (const [t, keys] of a) {
    for (const k of keys)
      if (!b.get(t)?.has(k)) slot(t).added.push(ak.get(`${t}#${k}`) as VersionEntryLite);
  }
  for (const [t, keys] of b) {
    for (const k of keys)
      if (!a.get(t)?.has(k)) slot(t).removed.push(bk.get(`${t}#${k}`) as VersionEntryLite);
  }
  return out;
}

/**
 * Jadval versiyasi (yoki bir nechta, ommaviy faollashtirishda) faollashtirilgach: jadvali o'zgargan
 * o'qituvchilarga farq. Bir o'qituvchiga bitta xabar. dedupeKey `tt:<birinchi versiyaId>:<userId>`.
 */
export async function notifyTimetableChanges(
  schoolId: string,
  changes: VersionChange[],
): Promise<void> {
  try {
    if (!changes.length || !telegramManager.isRunning()) return;
    const settings = await getTelegramSettings(schoolId);
    if (!settings.notify.timetableChanges) return;

    const perClass = changes.map((c) => ({ c, diff: diffByTeacher(c.before, c.after) }));
    const subjectIds = uniq(
      perClass.flatMap(({ diff }) =>
        [...diff.values()].flatMap((v) => [...v.added, ...v.removed].map((e) => e.subjectId)),
      ),
    );
    if (!subjectIds.length) return;
    const subjects = await Subject.find({ _id: { $in: subjectIds } })
      .select('name')
      .lean();
    const sName = new Map(subjects.map((s) => [String(s._id), s.name]));
    const line = (sign: '+' | '−', e: VersionEntryLite) =>
      `${sign} ${weekdayShortUz(e.weekday)} ${e.lessonNo}-soat ${esc(sName.get(e.subjectId) ?? '?')}`;
    const sortE = (a: VersionEntryLite, b: VersionEntryLite) =>
      a.weekday - b.weekday || a.lessonNo - b.lessonNo;

    const teachers = uniq(perClass.flatMap(({ diff }) => [...diff.keys()]));
    const first = changes[0] as VersionChange;
    const items: EnqueueItem[] = [];
    for (const userId of teachers) {
      const blocks: { c: VersionChange; lines: string[] }[] = [];
      for (const { c, diff } of perClass) {
        const d = diff.get(userId);
        if (!d || (!d.added.length && !d.removed.length)) continue;
        blocks.push({
          c,
          lines: [
            ...d.added.sort(sortE).map((e) => line('+', e)),
            ...d.removed.sort(sortE).map((e) => line('−', e)),
          ],
        });
      }
      if (!blocks.length) continue;
      let text: string;
      const only = blocks[0] as (typeof blocks)[number];
      if (blocks.length === 1) {
        text = [
          `🗓 <b>${esc(only.c.className)}</b> sinfi dars jadvali yangilandi (${dayMonthUz(only.c.validFrom)}dan)`,
          'Sizning darslaringiz:',
          ...only.lines,
        ].join('\n');
      } else {
        text = [
          `🗓 Dars jadvali yangilandi (${dayMonthUz(only.c.validFrom)}dan)`,
          'Sizning darslaringiz:',
          ...blocks.flatMap((b) => ['', `<b>${esc(b.c.className)}</b>`, ...b.lines]),
        ].join('\n');
      }
      items.push({
        userId,
        text,
        kind: 'timetable',
        parseMode: 'HTML',
        dedupeKey: `tt:${first.versionId}:${userId}`,
      });
    }
    await telegramNotify.enqueueMany(items);
  } catch (err) {
    logger.error({ err }, 'Jadval o‘zgarishi xabarini yuborishda xato');
  }
}
