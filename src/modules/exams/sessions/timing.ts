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
