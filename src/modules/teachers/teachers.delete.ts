import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import { AttendanceRecord } from '../../models/AttendanceRecord';
import { AuditLog } from '../../models/AuditLog';
import { ClassModel } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { ImportSession } from '../../models/ImportSession';
import { LessonOverride } from '../../models/LessonOverride';
import { RefreshToken } from '../../models/RefreshToken';
import { Score } from '../../models/Score';
import { SubjectGrade } from '../../models/SubjectGrade';
import { TelegramLinkToken } from '../../models/TelegramLinkToken';
import { TelegramOutbox } from '../../models/TelegramOutbox';
import { TimetableVersion } from '../../models/TimetableVersion';
import { User } from '../../models/User';
import { auditService } from '../audit/audit.service';
import { photosService } from '../photos/photos.service';
import { clearChatCommands } from '../telegram/telegram.commands';
import { userManagement } from '../users/user-management.service';

export const TEACHER_HAS_HISTORY_MESSAGE =
  "O'qituvchining tarixi bor (baholar, davomat yoki dars jadvali). Uni faqat nofaol qilish mumkin.";

export interface TeacherUsage {
  scores: number;
  subjectGrades: number;
  attendance: number;
  timetableEntries: number;
  lessonOverrides: number;
  auditActions: number;
}

export interface TeacherUsageResult {
  deletable: boolean;
  counts: TeacherUsage;
}

/**
 * O'qituvchi id'si bog'langan TARIX (o'chirishni to'sadi):
 * - Score.teacherId (o'chirilgan/soft-delete ham)
 * - SubjectGrade.teacherId
 * - AttendanceRecord.teacherId | markedBy | updatedBy
 * - TimetableVersion.entries[].teacherId (har qanday status: draft/active/superseded/replaced) — yozuvlar soni
 * - LessonOverride.teacherId | targetTeacherId | createdBy
 * - AuditLog.userId (faqat o'qituvchi O'ZI bajargan amallar; admin uni yaratgan/tahrirlagan yozuvlar sanalmaydi)
 * Tarix hisoblanmaydi (o'chirishda tozalanadi): ClassSubject, Class.teacherIds/homeroomTeacherId,
 * RefreshToken, Telegram (ulanish/token/outbox), Photo, ImportSession.
 */
async function computeUsage(schoolId: string, id: string): Promise<TeacherUsage> {
  const oid = new Types.ObjectId(id);
  const sid = new Types.ObjectId(schoolId);
  const [scores, subjectGrades, attendance, tt, lessonOverrides, auditActions] = await Promise.all([
    Score.countDocuments({ teacherId: oid }),
    SubjectGrade.countDocuments({ teacherId: oid }),
    AttendanceRecord.countDocuments({
      $or: [{ teacherId: oid }, { markedBy: oid }, { updatedBy: oid }],
    }),
    TimetableVersion.aggregate<{ n: number }>([
      { $match: { schoolId: sid, 'entries.teacherId': oid } },
      { $unwind: '$entries' },
      { $match: { 'entries.teacherId': oid } },
      { $count: 'n' },
    ]),
    LessonOverride.countDocuments({
      $or: [{ teacherId: oid }, { targetTeacherId: oid }, { createdBy: oid }],
    }),
    AuditLog.countDocuments({ userId: oid }),
  ]);
  return {
    scores,
    subjectGrades,
    attendance,
    timetableEntries: tt[0]?.n ?? 0,
    lessonOverrides,
    auditActions,
  };
}

const total = (c: TeacherUsage) => Object.values(c).reduce((a, b) => a + b, 0);

export const teacherDeletion = {
  async usage(schoolId: string, id: string): Promise<TeacherUsageResult> {
    await userManagement.get('teacher', id, { schoolId });
    const counts = await computeUsage(schoolId, id);
    return { deletable: total(counts) === 0, counts };
  },

  async remove(ctx: Ctx, schoolId: string, id: string) {
    if (ctx.actor.id === id) throw AppError.forbidden("O'zingizni o'chira olmaysiz");
    const user = await userManagement.get('teacher', id, { schoolId });

    const blocked = (counts: TeacherUsage) =>
      AppError.conflict(
        TEACHER_HAS_HISTORY_MESSAGE,
        Object.entries(counts).map(([path, n]) => ({ path, message: String(n) })),
      );
    const first = await computeUsage(schoolId, id);
    if (total(first) > 0) throw blocked(first);

    // Tranzaksiya yo'q: o'chirishdan oldin yana bir bor tekshiramiz (poyga xavfini kamaytiradi)
    const withChat = await User.findById(id).select('+telegram.chatId');
    const chatId = withChat?.telegram?.chatId ?? null;
    const recheck = await computeUsage(schoolId, id);
    if (total(recheck) > 0) throw blocked(recheck);

    const before = {
      fullName: user.fullName,
      username: user.username,
      phone: user.phone,
      isActive: user.isActive,
      permissions: user.permissions,
      schoolId,
    };

    await Promise.all([
      ClassSubject.deleteMany({ teacherId: id }),
      ClassModel.updateMany({ teacherIds: id }, { $pull: { teacherIds: user._id } }),
      ClassModel.updateMany({ homeroomTeacherId: id }, { $set: { homeroomTeacherId: null } }),
      RefreshToken.deleteMany({ userId: id }),
      TelegramLinkToken.deleteMany({ userId: id }),
      TelegramOutbox.deleteMany({ userId: id }),
      ImportSession.deleteMany({ userId: id }),
      photosService.purgeOwner('user', id),
    ]);
    if (chatId !== null) await clearChatCommands(chatId); // hech qachon tashlamaydi

    await User.deleteOne({ _id: id });
    logger.info({ teacherId: id }, "O'qituvchi o'chirildi");

    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'teacher.delete',
      entity: 'user',
      entityId: id,
      before,
      ip: ctx.ip,
    });
    return { deleted: true };
  },
};
