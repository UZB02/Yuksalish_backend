import { Types } from 'mongoose';
import { AcademicYear } from '../../models/AcademicYear';
import { ClassModel } from '../../models/Class';
import { School } from '../../models/School';
import { Score } from '../../models/Score';
import { Student } from '../../models/Student';
import { todayTashkent } from '../../utils/clock';
import { attendanceStats } from '../attendance/attendance.stats';
import { User } from '../../models/User';
import type { AuthUser } from '../../types/express';

export const dashboardService = {
  /**
   * Maktab (schoolId bor) yoki global (superadmin, schoolId yo'q) hisob.
   * O'qituvchi uchun faqat o'ziga biriktirilgan sinflar doirasida.
   */
  async summary(actor: AuthUser, schoolId?: string) {
    const schoolFilter = schoolId ? { schoolId: new Types.ObjectId(schoolId) } : {};

    // Sinflar: faol o'quv yilidagi arxivlanmagan sinflar
    const years = await AcademicYear.find({ ...schoolFilter, isActive: true }).select('_id');
    const classFilter: Record<string, unknown> = {
      ...schoolFilter,
      isArchived: false,
      academicYearId: { $in: years.map((y) => y._id) },
    };
    if (actor.role === 'teacher') classFilter.teacherIds = new Types.ObjectId(actor.id);

    const classes = await ClassModel.find(classFilter).select('teacherIds');
    const classIds = classes.map((c) => c._id);

    const studentsPromise = Student.countDocuments({
      ...schoolFilter,
      isDeleted: false,
      status: 'active',
      classId: { $in: classIds },
    });

    let teachers: number;
    if (actor.role === 'teacher') {
      teachers = new Set(classes.flatMap((c) => c.teacherIds.map(String))).size;
    } else {
      teachers = await User.countDocuments({ ...schoolFilter, role: 'teacher', isActive: true });
    }

    // Bugungi baholar (o'qituvchi uchun — o'z sinflari doirasida)
    const todayFilter = {
      ...schoolFilter,
      date: todayTashkent(),
      isDeleted: false,
      classId: { $in: classIds },
    };
    const [scoresToday, scoredClasses] = await Promise.all([
      Score.countDocuments(todayFilter),
      Score.distinct('classId', todayFilter),
    ]);

    const attendanceToday = await attendanceStats.dashboardToday(actor, schoolId);

    const data: {
      students: number;
      classes: number;
      teachers: number;
      scoresToday: number;
      unscoredClassesToday: number;
      attendanceToday: Awaited<ReturnType<typeof attendanceStats.dashboardToday>>;
      schools?: number;
    } = {
      students: await studentsPromise,
      classes: classes.length,
      teachers,
      scoresToday,
      unscoredClassesToday: classes.length - scoredClasses.length,
      attendanceToday,
    };
    if (actor.role === 'superadmin' && !schoolId) data.schools = await School.countDocuments({});
    return data;
  },
};
