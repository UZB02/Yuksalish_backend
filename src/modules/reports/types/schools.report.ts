import type { Types } from 'mongoose';
import { AttendanceRecord } from '../../../models/AttendanceRecord';
import { ClassModel } from '../../../models/Class';
import { School } from '../../../models/School';
import { Score } from '../../../models/Score';
import { Student } from '../../../models/Student';
import { User } from '../../../models/User';
import type { AuthUser } from '../../../types/express';
import { AcademicYear } from '../../../models/AcademicYear';
import { computeLive, loadDayRows } from '../../ratings/ratings.service';
import { settingsService } from '../../settings/settings.service';
import { mean, metaOf, oid } from '../reports.data';
import { fmtNum, type ReportLayout } from '../reports.layout';
import { assertRowLimit, reportQuery } from '../reports.params';
import { round2 } from '../../../utils/dayScore';

export const schoolsQuery = reportQuery({});

/** Maktablar solishtiruvi (faqat superadmin). Har bir maktab o'z sozlamalari bilan hisoblanadi. */
export async function buildSchoolsReport(_actor: AuthUser, q: { from: string; to: string }) {
  const schools = await School.find({}).sort({ name: 1 }).lean();
  assertRowLimit(schools.length);
  const range = { $gte: q.from, $lte: q.to };

  const rows = [];
  for (const s of schools) {
    const id = String(s._id);
    const [pub, scoring, students, teachers, year] = await Promise.all([
      settingsService.getEffectivePublic(id),
      settingsService.getEffectiveScoring(id),
      Student.countDocuments({ schoolId: id, isDeleted: false, status: 'active' }),
      User.countDocuments({ schoolId: id, role: 'teacher', isActive: true }),
      AcademicYear.findOne({ schoolId: id, isActive: true }).select('_id').lean(),
    ]);
    const classes = year
      ? await ClassModel.countDocuments({
          schoolId: id,
          academicYearId: year._id,
          isArchived: false,
        })
      : 0;
    const [dayRows, scoreTeachers, attTeachers, attAgg, live] = await Promise.all([
      loadDayRows(id, q, scoring),
      Score.distinct('teacherId', { schoolId: oid(id), isDeleted: false, date: range }) as Promise<
        Types.ObjectId[]
      >,
      AttendanceRecord.distinct('markedBy', {
        schoolId: oid(id),
        isDeleted: false,
        date: range,
      }) as Promise<Types.ObjectId[]>,
      AttendanceRecord.aggregate<{ _id: string; n: number }>([
        { $match: { schoolId: oid(id), isDeleted: false, date: range } },
        { $group: { _id: '$category', n: { $sum: 1 } } },
      ]),
      computeLive(id, q.from, q.to),
    ]);
    const attTotal = attAgg.reduce((a, r) => a + r.n, 0);
    const attOk = attAgg
      .filter((r) => r._id === 'present' || r._id === 'late')
      .reduce((a, r) => a + r.n, 0);
    const eligible = live.data.students.filter((r) => r.eligible);
    rows.push({
      schoolId: id,
      name: s.name,
      slug: s.slug,
      enabled: pub.enabled,
      students,
      classes,
      teachers,
      scoresCount: dayRows.reduce((a, d) => a + d.n, 0),
      avgScore: mean(dayRows.map((d) => d.day)),
      ratingScore: eligible.length ? mean(eligible.map((r) => r.score)) : null,
      attendanceRate: attTotal > 0 ? round2((attOk / attTotal) * 100) : null,
      activeTeachers: new Set([...scoreTeachers, ...attTeachers].map(String)).size,
    });
  }
  return { meta: metaOf(null, 'schools', q, null), schools: rows };
}

export type SchoolsReport = Awaited<ReturnType<typeof buildSchoolsReport>>;

export function schoolsLayout(d: SchoolsReport): ReportLayout {
  return {
    title: 'Maktablar hisoboti',
    fileBase: 'maktablar',
    orientation: 'landscape',
    meta: d.meta,
    kpis: [
      { label: 'Maktablar', value: d.schools.length },
      { label: "O'quvchilar", value: d.schools.reduce((s, x) => s + x.students, 0) },
      { label: 'Baholar', value: d.schools.reduce((s, x) => s + x.scoresCount, 0) },
      {
        label: 'Maktablar bo‘yicha o‘rtacha',
        value: fmtNum(
          mean(d.schools.map((x) => x.avgScore).filter((v): v is number => v !== null)),
        ),
      },
    ],
    tables: [
      {
        title: 'Maktablar',
        columns: [
          { header: 'Maktab', key: 'name', width: 28 },
          { header: 'Slug', key: 'slug', width: 16 },
          { header: 'Ochiq reyting', key: 'enabledText', width: 12 },
          { header: "O'quvchilar", key: 'students', width: 11, type: 'int', align: 'right' },
          { header: 'Sinflar', key: 'classes', width: 8, type: 'int', align: 'right' },
          { header: "O'qituvchilar", key: 'teachers', width: 12, type: 'int', align: 'right' },
          {
            header: 'Faol o‘qituvchilar',
            key: 'activeTeachers',
            width: 13,
            type: 'int',
            align: 'right',
          },
          { header: 'Baholar', key: 'scoresCount', width: 9, type: 'int', align: 'right' },
          { header: "O'rtacha ball", key: 'avgScore', width: 12, type: 'number', align: 'right' },
          { header: 'Reyting bali', key: 'ratingScore', width: 12, type: 'number', align: 'right' },
          {
            header: 'Davomat, %',
            key: 'attendanceRate',
            width: 11,
            type: 'percent',
            align: 'right',
          },
        ],
        rows: d.schools.map((s) => ({ ...s, enabledText: s.enabled ? 'Ha' : "Yo'q" })),
      },
    ],
  };
}
