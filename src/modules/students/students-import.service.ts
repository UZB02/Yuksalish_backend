import type { AnyBulkWriteOperation } from 'mongodb';
import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel } from '../../models/Class';
import { ImportSession, type ImportRow } from '../../models/ImportSession';
import { Student, type IStudent } from '../../models/Student';
import { parseDateOnly } from '../../utils/dates';
import { isId } from '../../utils/helpers';
import { classKeyOf, cleanText, nameKeyOf } from '../../utils/text';
import { auditService } from '../audit/audit.service';
import { ratingEvents } from '../ratings/ratings.events';
import {
  assertSafeXlsx,
  asText,
  buildErrorsFile,
  parseBirthDate,
  parseGender,
  parseStudentsSheet,
  type RawRow,
} from './students.excel';

const SESSION_TTL_MS = 30 * 60_000;
const PHONE_RE = /^\+?[0-9\s()-]{7,20}$/;

interface DupKeys {
  code: string | null;
  nameKey: string;
  birthDate: string | null;
}

/** Ikki yozuv dublikat bo'lishi uchun umumiy kalitlar (students.service dagi qoida bilan bir xil) */
function keysOf(k: DupKeys): string[] {
  const keys: string[] = [];
  if (k.code) keys.push(`c:${k.code}`);
  if (k.birthDate || !k.code) keys.push(`n:${k.nameKey}|${k.birthDate ?? ''}`);
  return keys;
}

function validateRow(
  raw: RawRow,
  classByKey: Map<string, { id: string; name: string }> | null,
  fixed: { id: string; name: string } | null,
): ImportRow {
  const errors: string[] = [];
  const c = raw.cells;

  const fullName = asText(c.fullName, 150);
  if (fullName.length < 2) errors.push('F.I.Sh. kiritilmagan yoki juda qisqa');
  else if (fullName.length > 100) errors.push('F.I.Sh. 100 belgidan oshmasligi kerak');
  else if (/^[=+\-@]/.test(fullName)) errors.push("F.I.Sh. noto'g'ri belgi bilan boshlanadi");

  const className = asText(c.className, 50);
  let resolved: string | null = null;
  if (fixed) resolved = fixed.id;
  else if (!className) errors.push('Sinf kiritilmagan');
  else {
    const found = classByKey?.get(classKeyOf(className));
    if (found) resolved = found.id;
    else errors.push(`Sinf topilmadi: ${className}`);
  }

  const birth = parseBirthDate(c.birthDate);
  if (birth.error) errors.push(birth.error);
  const gender = parseGender(c.gender);
  if (gender.error) errors.push(gender.error);

  const code = asText(c.studentCode, 80);
  if (code.length > 50) errors.push('ID 50 belgidan oshmasligi kerak');
  const phone = asText(c.parentPhone, 40);
  if (phone && !PHONE_RE.test(phone)) errors.push("Ota-ona telefoni formati noto'g'ri");

  return {
    row: raw.row,
    status: errors.length ? 'invalid' : 'valid',
    data: {
      fullName,
      className: fixed?.name ?? className,
      birthDate: birth.value,
      gender: gender.value,
      studentCode: code || null,
      parentPhone: phone || null,
    },
    resolvedClassId: errors.length ? null : resolved,
    duplicateOfStudentId: null,
    errors,
  };
}

const sessionOf = async (schoolId: string, userId: string, importId: string) => {
  const notFound = AppError.notFound('Import sessiyasi topilmadi yoki muddati tugagan');
  if (!isId(importId)) throw notFound;
  return { notFound, filter: { _id: importId, schoolId, userId } };
};

export const studentsImportService = {
  async preview(
    ctx: Ctx,
    schoolId: string,
    file: { buffer: Buffer; originalname: string },
    classId?: string,
  ) {
    await assertSafeXlsx(file.buffer);

    let fixed: { id: string; name: string } | null = null;
    if (classId) {
      const cls = isId(classId)
        ? await ClassModel.findOne({ _id: classId, schoolId }).select('name')
        : null;
      if (!cls)
        throw AppError.validation('Sinf topilmadi', [
          { path: 'classId', message: 'Sinf topilmadi' },
        ]);
      fixed = { id: cls.id, name: cls.name };
    }

    const sheet = await parseStudentsSheet(file.buffer);
    let classByKey: Map<string, { id: string; name: string }> | null = null;
    if (!fixed) {
      if (!sheet.hasClassColumn) {
        throw AppError.validation("Faylda 'Sinf' ustuni topilmadi", [
          { path: 'file', message: "'Sinf' ustuni bo'lishi yoki classId yuborilishi kerak" },
        ]);
      }
      const year = await AcademicYear.findOne({ schoolId, isActive: true }).select('_id');
      if (!year) {
        throw AppError.validation("Faol o'quv yili yo'q", [
          { path: 'file', message: "Faol o'quv yili topilmadi" },
        ]);
      }
      const classes = await ClassModel.find({
        schoolId,
        academicYearId: year._id,
        isArchived: false,
      }).select('name');
      classByKey = new Map(
        classes.map((c) => [classKeyOf(c.name), { id: c.id as string, name: c.name }]),
      );
    }

    const rows = sheet.rows.map((r) => validateRow(r, classByKey, fixed));

    // Bazadagi mavjud o'quvchilar
    const candidates = rows.filter((r) => r.status === 'valid');
    const codes = candidates.map((r) => r.data.studentCode).filter((x): x is string => !!x);
    const nameKeys = candidates.map((r) => nameKeyOf(r.data.fullName));
    const existing = candidates.length
      ? await Student.find({
          schoolId,
          isDeleted: false,
          $or: [{ studentCode: { $in: codes } }, { nameKey: { $in: nameKeys } }],
        }).select('studentCode nameKey birthDate')
      : [];
    const dbKeys = new Map<string, string>();
    for (const s of existing) {
      for (const k of keysOf({
        code: s.studentCode,
        nameKey: s.nameKey,
        birthDate: s.birthDate ? s.birthDate.toISOString().slice(0, 10) : null,
      })) {
        if (!dbKeys.has(k)) dbKeys.set(k, s.id);
      }
    }

    const seen = new Map<string, number>();
    for (const r of candidates) {
      const keys = keysOf({
        code: r.data.studentCode,
        nameKey: nameKeyOf(r.data.fullName),
        birthDate: r.data.birthDate,
      });
      const firstRow = keys.map((k) => seen.get(k)).find((x) => x !== undefined);
      const dbId = keys.map((k) => dbKeys.get(k)).find((x) => x !== undefined);
      if (firstRow !== undefined) {
        r.status = 'duplicate';
        r.errors.push(`Faylda ${firstRow}-qator bilan takrorlangan`);
      } else if (dbId) {
        r.status = 'duplicate';
        r.duplicateOfStudentId = dbId;
        r.errors.push("Bu o'quvchi bazada allaqachon mavjud");
      }
      for (const k of keys) if (!seen.has(k)) seen.set(k, r.row);
    }

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await ImportSession.create({
      schoolId,
      userId: ctx.actor.id,
      fileName: file.originalname.slice(0, 200),
      rows,
      expiresAt,
    });

    const count = (s: ImportRow['status']) => rows.filter((r) => r.status === s).length;
    return {
      importId: session.id as string,
      expiresAt,
      summary: {
        total: rows.length,
        valid: count('valid'),
        invalid: count('invalid'),
        duplicates: count('duplicate'),
      },
      rows,
    };
  },

  async confirm(
    ctx: Ctx,
    schoolId: string,
    input: { importId: string; onDuplicate: 'skip' | 'update' },
  ) {
    const { notFound, filter } = await sessionOf(schoolId, ctx.actor.id, input.importId);
    const session = await ImportSession.findOneAndUpdate(
      { ...filter, consumed: false, expiresAt: { $gt: new Date() } },
      { consumed: true },
    );
    if (!session) {
      if (await ImportSession.exists({ ...filter, consumed: true })) {
        throw AppError.conflict('Bu import allaqachon tasdiqlangan');
      }
      throw notFound;
    }

    try {
      const rows = session.rows as ImportRow[];
      const now = new Date();
      const inserts: AnyBulkWriteOperation<IStudent>[] = [];
      const updates: AnyBulkWriteOperation<IStudent>[] = [];
      let skipped = 0;
      let failed = 0;

      for (const r of rows) {
        const nameKey = nameKeyOf(r.data.fullName);
        const birthDate = r.data.birthDate ? parseDateOnly(r.data.birthDate) : null;
        if (r.status === 'invalid') failed++;
        else if (r.status === 'duplicate') {
          if (input.onDuplicate === 'update' && r.duplicateOfStudentId) {
            const set: Record<string, unknown> = { fullName: cleanText(r.data.fullName), nameKey };
            if (birthDate) set.birthDate = birthDate;
            if (r.data.gender) set.gender = r.data.gender;
            if (r.data.studentCode) set.studentCode = r.data.studentCode;
            if (r.data.parentPhone) set.parentPhone = r.data.parentPhone;
            updates.push({
              updateOne: {
                filter: {
                  _id: new Types.ObjectId(r.duplicateOfStudentId),
                  schoolId: new Types.ObjectId(schoolId),
                  isDeleted: false,
                },
                update: { $set: set },
              },
            });
          } else skipped++;
        } else if (r.resolvedClassId) {
          const classId = new Types.ObjectId(r.resolvedClassId);
          inserts.push({
            insertOne: {
              document: {
                schoolId: new Types.ObjectId(schoolId),
                fullName: cleanText(r.data.fullName),
                nameKey,
                studentCode: r.data.studentCode,
                birthDate,
                gender: r.data.gender,
                classId,
                parentPhone: r.data.parentPhone,
                photoUrl: null,
                status: 'active',
                classHistory: [{ classId, from: now, to: null }],
                isDeleted: false,
              } as IStudent,
            },
          });
        } else failed++;
      }

      const run = async (ops: AnyBulkWriteOperation<IStudent>[]) => {
        if (!ops.length) return 0;
        try {
          await Student.bulkWrite(ops, { ordered: false });
          return 0;
        } catch (e) {
          const errs = (e as { writeErrors?: unknown[] }).writeErrors;
          if (!errs) throw e;
          return errs.length;
        }
      };
      const insertFailed = await run(inserts);
      const updateFailed = await run(updates);
      failed += insertFailed + updateFailed;

      const result = {
        created: inserts.length - insertFailed,
        updated: updates.length - updateFailed,
        skipped,
        failed,
      };
      await auditService.log({
        userId: ctx.actor.id,
        schoolId,
        action: 'students.import',
        entity: 'student',
        entityId: session.id,
        after: { ...result, onDuplicate: input.onDuplicate, fileName: session.fileName },
        ip: ctx.ip,
      });
      void ratingEvents.dataChanged(schoolId);
      return result;
    } catch (e) {
      // Kutilmagan xato: sessiyani qayta ishlatish mumkin bo'lsin
      await ImportSession.updateOne({ _id: session._id }, { consumed: false });
      throw e;
    }
  },

  async errorsFile(ctx: Ctx, schoolId: string, importId: string): Promise<Buffer> {
    const { notFound, filter } = await sessionOf(schoolId, ctx.actor.id, importId);
    const session = await ImportSession.findOne(filter);
    if (!session) throw notFound;
    return buildErrorsFile(session.rows as ImportRow[]);
  },
};
