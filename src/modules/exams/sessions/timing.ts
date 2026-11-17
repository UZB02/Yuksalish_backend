import type { ISessionParticipant } from '../../../models/ExamSession';

/**
 * Vaqt qoidalari (E4 da exam-client ham shularni ishlatadi; E3 da testlangan):
 *  - umumiy tugash = scheduledStart + durationMin;
 *  - odatda kechikkan o'quvchi faqat QOLGAN vaqtni oladi: deadline = umumiy tugash (+ extraMinutes);
 *  - superadmin yoki sessiya nazoratchisi `fullTimeGranted` bersa: deadline = o'quvchi boshlagan vaqt + davomiylik
 *    (+ extraMinutes) va u umumiy tugashdan keyin ham kira oladi;
 *  - kirish oynasi: scheduledStart <= now < umumiy tugash (fullTimeGranted bo'lsa: scheduledStart dan keyin istalgan payt).
 */
interface TimingSession {
  scheduledStart: Date;
  durationMin: number;
}
type TimingParticipant = Pick<ISessionParticipant, 'fullTimeGranted' | 'extraMinutes'>;

const MIN = 60_000;

export const commonEnd = (s: TimingSession): Date =>
  new Date(s.scheduledStart.getTime() + s.durationMin * MIN);

export function canEnter(s: TimingSession, p: TimingParticipant, now: Date): boolean {
  if (now < s.scheduledStart) return false;
  return p.fullTimeGranted || now < commonEnd(s);
}

export function participantDeadline(s: TimingSession, p: TimingParticipant, startedAt: Date): Date {
  const extra = (p.extraMinutes ?? 0) * MIN;
  if (p.fullTimeGranted) return new Date(startedAt.getTime() + s.durationMin * MIN + extra);
  return new Date(commonEnd(s).getTime() + extra);
}

// ---------------------------------------------------------------------------------------------
// per_block (blokma-blok) vaqt qoidalari. Hammasi sof funksiyalar; holat urinishda saqlanadi.
//
//  - Imtihon umumiy oynasi: scheduledStart + (bloklar davomiyliklari yig'indisi). `durationMin` shu yig'indi.
//  - Qattiq (hard) deadline = participantDeadline (kechikkan o'quvchi: umumiy tugash; to'liq vaqt berilgan:
//    boshlagan vaqti + yig'indi; + individual extraMinutes). Hech bir blok shundan keyin davom etmaydi.
//  - Blok i boshlanganda: deadline_i = min(boshlanish + (davomiylik_i + extraMin_i), hard).
//  - Blok tugaydi: (a) vaqti tugaganda (deadline_i + 5 s grace dan keyin; keyingi blok deadline_i dan boshlanadi,
//    ya'ni o'quvchi ulanmagan bo'lsa ham vaqt o'tadi) yoki (b) o'quvchi "Blokni yakunlash" bosganda (keyingi blok
//    shu paytdan boshlanadi). Orqaga qaytish YO'Q: yopilgan blokka javob yozilmaydi.
//  - Oxirgi blok tugasa urinish topshiriladi.
//  - attempt.deadline = urinish davom etishi mumkin bo'lgan eng kech payt:
//    min(hard, joriy blok deadline + qolgan bloklar davomiyliklari). Sweeper shu maydon bilan ishlaydi.
// ---------------------------------------------------------------------------------------------
export interface BlockStateLike {
  blockId: string;
  durationMin: number;
  startedAt: Date | null;
  deadline: Date | null;
  extraMin: number;
  closedAt: Date | null;
}

const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

export function initBlockState(
  blocks: { blockId: string; durationMin: number }[],
  now: Date,
  hard: Date,
): BlockStateLike[] {
  const st: BlockStateLike[] = blocks.map((b) => ({
    blockId: b.blockId,
    durationMin: b.durationMin,
    startedAt: null,
    deadline: null,
    extraMin: 0,
    closedAt: null,
  }));
  if (st[0]) openBlock(st[0], now, hard);
  return st;
}

function openBlock(b: BlockStateLike, at: Date, hard: Date) {
  b.startedAt = at;
  b.closedAt = null;
  b.deadline = minDate(new Date(at.getTime() + (b.durationMin + b.extraMin) * MIN), hard);
}

/** Urinishning davom etish chegarasi (sweeper uchun) */
export function projectedDeadline(st: BlockStateLike[], idx: number, hard: Date): Date {
  const cur = st[idx];
  if (!cur?.deadline) return hard;
  const rest = st.slice(idx + 1).reduce((n, b) => n + b.durationMin * MIN, 0);
  return minDate(new Date(cur.deadline.getTime() + rest), hard);
}

export interface BlockAdvance {
  state: BlockStateLike[];
  index: number;
  /** Oxirgi blok ham tugadi: urinish topshirilishi kerak */
  finished: boolean;
  finishedAt: Date | null;
  changed: boolean;
}

/** Vaqti tugagan bloklarni (grace dan keyin) ketma-ket yopadi; keyingi blok oldingi deadline dan boshlanadi */
export function advanceExpired(
  st: BlockStateLike[],
  idx: number,
  now: Date,
  hard: Date,
  graceMs: number,
): BlockAdvance {
  const state = st.map((b) => ({ ...b }));
  let i = idx;
  let changed = false;
  for (;;) {
    const cur = state[i];
    if (!cur || !cur.deadline) break;
    if (now.getTime() <= cur.deadline.getTime() + graceMs) break;
    cur.closedAt = cur.deadline;
    changed = true;
    if (i >= state.length - 1)
      return { state, index: i, finished: true, finishedAt: cur.deadline, changed };
    i++;
    openBlock(state[i]!, cur.deadline, hard);
  }
  return { state, index: i, finished: false, finishedAt: null, changed };
}

/** O'quvchi joriy blokni yakunladi: keyingi blok hozirdan boshlanadi (oxirgi blok bo'lsa finished) */
export function finishCurrentBlock(
  st: BlockStateLike[],
  idx: number,
  now: Date,
  hard: Date,
): BlockAdvance {
  const state = st.map((b) => ({ ...b }));
  const cur = state[idx];
  if (!cur) return { state, index: idx, finished: true, finishedAt: now, changed: false };
  cur.closedAt = now;
  if (idx >= state.length - 1) {
    return { state, index: idx, finished: true, finishedAt: now, changed: true };
  }
  openBlock(state[idx + 1]!, now, hard);
  return { state, index: idx + 1, finished: false, finishedAt: null, changed: true };
}

/**
 * Hammaga +N daqiqa (extend): JORIY ochiq blokka N qo'shiladi (keyingi bloklar o'z davomiyligini oladi), shuning
 * uchun har o'quvchi aynan N daqiqa ko'p oladi. hard deadline ni chaqiruvchi yangi sessiya davomiyligidan qayta hisoblaydi.
 */
export function extendCurrentBlock(
  st: BlockStateLike[],
  idx: number,
  minutes: number,
  hard: Date,
): BlockStateLike[] {
  const state = st.map((b) => ({ ...b }));
  const cur = state[idx];
  if (cur && cur.startedAt && !cur.closedAt) {
    cur.extraMin += minutes;
    cur.deadline = minDate(
      new Date(cur.startedAt.getTime() + (cur.durationMin + cur.extraMin) * MIN),
      hard,
    );
  }
  return state;
}

/** Hard deadline o'zgarganda (qayta ochish) joriy blok deadline ini qayta hisoblash */
export function reclampCurrentBlock(
  st: BlockStateLike[],
  idx: number,
  hard: Date,
): BlockStateLike[] {
  return extendCurrentBlock(st, idx, 0, hard);
}
