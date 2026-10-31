import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError, type ErrorDetail } from '../../core/errors';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel, type ClassDoc } from '../../models/Class';
import { ClassSubject } from '../../models/ClassSubject';
import { Subject } from '../../models/Subject';
import { User } from '../../models/User';
import { isId, uniq } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';

export interface ClassSubjectDto {
  subjectId: string;
  subject: { id: string; name: string } | null;
  teacherId: string;
  teacher: { id: string; fullName: string } | null;
}

/**
 * Sinf+fan+o'qituvchi biriktirishlari.
 *
 * Sinfga kirish huquqi (o'quvchilar, davomat, ...) hozirgidek `Class.teacherIds` orqali beriladi.
 * Invariant: fanga biriktirilgan o'qituvchi har doim shu sinf `teacherIds` ichida bo'ladi
 * (biriktirilganda avtomatik qo'shiladi; sinfdan chiqarilganda uning biriktirishlari ham o'chadi).
 * Biriktirish olib tashlansa o'qituvchi `teacherIds` da qoladi (uni alohida chiqarish mumkin).
 * Bir sinfda bir fanning bir nechta o'qituvchisi bo'lishi mumkin (har bir juftlik alohida kurs).
 */

/** {classId -> biriktirishlar} (fan va o'qituvchi nomlari bilan) */
export async function loadClassSubjects(classIds: Types.ObjectId[]) {
  const out = new Map<string, ClassSubjectDto[]>();
  if (!classIds.length) return out;
  const rows = await ClassSubject.find({ classId: { $in: classIds } }).lean();
  if (!rows.length) return out;
  const [subjects, teachers] = await Promise.all([
    Subject.find({ _id: { $in: uniq(rows.map((r) => String(r.subjectId))) } })
      .select('name order')
      .lean(),
    User.find({ _id: { $in: uniq(rows.map((r) => String(r.teacherId))) } })
      .select('fullName')
      .lean(),
  ]);
  const sMap = new Map(subjects.map((s) => [String(s._id), s]));
  const tMap = new Map(teachers.map((t) => [String(t._id), t.fullName]));
  const sorted = [...rows].sort(
    (a, b) =>
      (sMap.get(String(a.subjectId))?.order ?? 0) - (sMap.get(String(b.subjectId))?.order ?? 0) ||
      (sMap.get(String(a.subjectId))?.name ?? '').localeCompare(
        sMap.get(String(b.subjectId))?.name ?? '',
        'uz',
      ) ||
      (tMap.get(String(a.teacherId)) ?? '').localeCompare(
        tMap.get(String(b.teacherId)) ?? '',
        'uz',
      ),
  );
  for (const r of sorted) {
    const key = String(r.classId);
    const sid = String(r.subjectId);
    const tid = String(r.teacherId);
    const list = out.get(key) ?? [];
    list.push({
      subjectId: sid,
      subject: sMap.has(sid) ? { id: sid, name: sMap.get(sid)?.name as string } : null,
      teacherId: tid,
      teacher: tMap.has(tid) ? { id: tid, fullName: tMap.get(tid) as string } : null,
    });
    out.set(key, list);
  }
  return out;
}

/** Sinf `teacherIds` dan chiqqan o'qituvchilarning biriktirishlarini o'chiradi */
export async function pruneAssignments(classId: Types.ObjectId, teacherIds: Types.ObjectId[]) {
  await ClassSubject.deleteMany({ classId, teacherId: { $nin: teacherIds } });
}

/** O'qituvchining berilgan sinflardagi biriktirishlarini o'chiradi */
export async function removeTeacherAssignments(classIds: string[], teacherId: Types.ObjectId) {
  if (!classIds.length) return;
  await ClassSubject.deleteMany({ classId: { $in: classIds }, teacherId });
}

const pairKey = (subjectId: string, teacherId: string) => `${subjectId}:${teacherId}`;

/**
 * Sinfning fan-o'qituvchi ro'yxatini to'liq almashtiradi.
 * Tekshiruvlar: fan global yoki shu maktabniki va faol; o'qituvchi shu maktabning faol o'qituvchisi;
 * aynan bir xil (fan, o'qituvchi) juftligi bir marta. Bir fanga bir nechta o'qituvchi biriktirish mumkin
 * (har bir juftlik alohida kurs). O'zgarmagan (avvalgi) biriktirish nofaol fan/o'qituvchi bilan ham saqlanadi.
 */
export async function setClassSubjects(
  ctx: Ctx,
  schoolId: string,
  cls: ClassDoc,
  items: { subjectId: string; teacherId: string }[],
): Promise<void> {
  const errs: ErrorDetail[] = [];
  const seenPairs = new Set<string>();
  items.forEach((it, idx) => {
    const k = pairKey(it.subjectId, it.teacherId);
    if (seenPairs.has(k)) {
      errs.push({
        path: `subjects.${idx}`,
        message: "Bu fan shu o'qituvchiga sinfda allaqachon biriktirilgan",
      });
    }
    seenPairs.add(k);
  });
  const existing = await ClassSubject.find({ classId: cls._id });
  const prevPairs = new Set(existing.map((e) => pairKey(String(e.subjectId), String(e.teacherId))));
  const prevSubjects = new Set(existing.map((e) => String(e.subjectId)));

  const subjectIds = items.map((i) => i.subjectId);
  const ids = uniq([...subjectIds, ...items.map((i) => i.teacherId)]);
  if (ids.some((i) => !isId(i)))
    errs.push({ path: 'subjects', message: "Identifikator noto'g'ri" });
  if (errs.length) throw AppError.validation("Fanlar ro'yxati noto'g'ri", errs);

  const [subjects, teachers] = await Promise.all([
    Subject.find({ _id: { $in: uniq(subjectIds) }, $or: [{ schoolId: null }, { schoolId }] }),
    User.find({
      _id: { $in: uniq(items.map((i) => i.teacherId)) },
      schoolId,
      role: 'teacher',
    }).select('isActive'),
  ]);
  const sMap = new Map(subjects.map((s) => [s.id as string, s]));
  const tMap = new Map(teachers.map((t) => [t.id as string, t]));
  items.forEach((it, idx) => {
    const unchanged = prevPairs.has(pairKey(it.subjectId, it.teacherId));
    const s = sMap.get(it.subjectId);
    if (!s) errs.push({ path: `subjects.${idx}.subjectId`, message: 'Fan topilmadi' });
    else if (!s.isActive && !prevSubjects.has(it.subjectId)) {
      errs.push({ path: `subjects.${idx}.subjectId`, message: 'Fan faol emas' });
    }
    const t = tMap.get(it.teacherId);
    if (!t) {
      errs.push({
        path: `subjects.${idx}.teacherId`,
        message: "O'qituvchi topilmadi (shu maktabning o'qituvchisi bo'lishi kerak)",
      });
    } else if (!t.isActive && !unchanged) {
      errs.push({ path: `subjects.${idx}.teacherId`, message: "O'qituvchi faol emas" });
    }
  });
  if (errs.length) throw AppError.validation("Fanlar ro'yxati noto'g'ri", errs);

  const removed = existing.filter(
    (e) => !seenPairs.has(pairKey(String(e.subjectId), String(e.teacherId))),
  );
  const added = items.filter((i) => !prevPairs.has(pairKey(i.subjectId, i.teacherId)));

  if (removed.length) {
    await ClassSubject.deleteMany({ _id: { $in: removed.map((r) => r._id) } });
  }
  for (const it of added) {
    await ClassSubject.updateOne(
      { classId: cls._id, subjectId: it.subjectId, teacherId: it.teacherId },
      { $setOnInsert: { schoolId, academicYearId: cls.academicYearId } },
      { upsert: true },
    );
  }
  // Biriktirilgan o'qituvchilar sinfga kirish huquqini oladi
  const teacherIds = uniq(items.map((i) => i.teacherId));
  if (teacherIds.length) {
    await ClassModel.updateOne(
      { _id: cls._id },
      { $addToSet: { teacherIds: { $each: teacherIds } } },
    );
    cls.teacherIds = uniq([...cls.teacherIds.map(String), ...teacherIds]).map(
      (t) => new Types.ObjectId(t),
    );
  }
  if (removed.length || added.length) {
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'class.subjects',
      entity: 'class',
      entityId: cls.id,
      before: {
        subjects: existing.map((e) => ({
          subjectId: String(e.subjectId),
          teacherId: String(e.teacherId),
        })),
      },
      after: { subjects: items },
      ip: ctx.ip,
    });
  }
}

/** Faol o'quv yilidagi (arxivlanmagan) sinflar bo'yicha o'qituvchilarning biriktirishlari */
export async function assignmentsOfTeachers(schoolId: string, teacherIds: string[]) {
  const map = new Map<
    string,
    { classId: string; className: string; subjectId: string; subjectName: string }[]
  >();
  if (!teacherIds.length) return map;
  const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
  if (!year) return map;
  const rows = await ClassSubject.find({
    schoolId,
    academicYearId: year._id,
    teacherId: { $in: teacherIds },
  }).lean();
  if (!rows.length) return map;
  const [classes, subjects] = await Promise.all([
    ClassModel.find({ _id: { $in: uniq(rows.map((r) => String(r.classId))) }, isArchived: false })
      .select('name grade')
      .lean(),
    Subject.find({ _id: { $in: uniq(rows.map((r) => String(r.subjectId))) } })
      .select('name')
      .lean(),
  ]);
  const cMap = new Map(classes.map((c) => [String(c._id), c]));
  const sMap = new Map(subjects.map((s) => [String(s._id), s.name]));
  const sorted = rows
    .filter((r) => cMap.has(String(r.classId)))
    .sort(
      (a, b) =>
        (cMap.get(String(a.classId))?.grade ?? 0) - (cMap.get(String(b.classId))?.grade ?? 0) ||
        (cMap.get(String(a.classId))?.name ?? '').localeCompare(
          cMap.get(String(b.classId))?.name ?? '',
          'uz',
        ) ||
        (sMap.get(String(a.subjectId)) ?? '').localeCompare(
          sMap.get(String(b.subjectId)) ?? '',
          'uz',
        ),
    );
  for (const r of sorted) {
    const key = String(r.teacherId);
    const list = map.get(key) ?? [];
    list.push({
      classId: String(r.classId),
      className: cMap.get(String(r.classId))?.name ?? '',
      subjectId: String(r.subjectId),
      subjectName: sMap.get(String(r.subjectId)) ?? '',
    });
    map.set(key, list);
  }
  return map;
}
