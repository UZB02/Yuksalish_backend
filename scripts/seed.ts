import { connectDb, disconnectDb, ensureIndexes } from '../src/config/db';
import { logger } from '../src/core/logger';
import { passwordSchema, usernameSchema } from '../src/core/validators';
import { User } from '../src/models/User';
import { ensureDefaultBehaviorTypes } from '../src/modules/behavior-types/behavior-types.defaults';
import { BehaviorType } from '../src/models/BehaviorType';
import { Subject } from '../src/models/Subject';
import { ensureDefaultSubjects } from '../src/modules/subjects/subjects.defaults';
import { AttendanceStatus } from '../src/models/AttendanceStatus';
import { ensureDefaultAttendanceStatuses } from '../src/modules/attendance-statuses/attendance-statuses.defaults';
import { hashPassword } from '../src/utils/password';
import { seedPasswordProblem } from '../src/config/env-guard';

// Superadminni .env dagi SEED_SUPERADMIN_* qiymatlaridan yaratadi (qayta ishga tushirsa dublikat qilmaydi)
async function seed() {
  const username = usernameSchema.safeParse(process.env.SEED_SUPERADMIN_USERNAME);
  if (!username.success) {
    throw new Error("SEED_SUPERADMIN_USERNAME .env da to'g'ri berilishi kerak");
  }
  const fullName = process.env.SEED_SUPERADMIN_FULLNAME?.trim() || 'Super Admin';

  await connectDb(undefined, { autoIndex: false, maxPoolSize: 1 });
  await ensureIndexes();
  await User.init(); // unique indekslar tayyor bo'lsin

  if (await User.exists({ username: username.data })) {
    // Parol faqat yaratish uchun kerak: prodda u .env dan o'chirilgan bo'ladi, standart ma'lumotlar baribir qo'shiladi
    logger.info(`Superadmin "${username.data}" allaqachon mavjud — o'tkazib yuborildi`);
  } else {
    const password = passwordSchema.safeParse(process.env.SEED_SUPERADMIN_PASSWORD);
    if (!password.success) {
      throw new Error(
        "Superadmin yaratish uchun SEED_SUPERADMIN_PASSWORD (kamida 8 belgi, harf+raqam) .env da berilishi kerak",
      );
    }
    const weak = seedPasswordProblem(process.env.NODE_ENV, process.env.SEED_SUPERADMIN_PASSWORD);
    if (weak) throw new Error(weak);
    await User.create({
      role: 'superadmin',
      schoolId: null,
      fullName,
      username: username.data,
      passwordHash: await hashPassword(password.data),
    });
    logger.info(`Superadmin "${username.data}" yaratildi`);
  }
  await BehaviorType.init();
  const types = await ensureDefaultBehaviorTypes();
  await AttendanceStatus.init();
  const statuses = await ensureDefaultAttendanceStatuses();
  logger.info(`Standart davomat holatlari: ${statuses} ta yangi yaratildi`);
  logger.info(`Standart xulq turlari: ${types} ta yangi yaratildi`);
  await Subject.init();
  const subjects = await ensureDefaultSubjects();
  logger.info(`Standart fanlar: ${subjects} ta yangi yaratildi`);
  await disconnectDb();
}

seed().catch((err) => {
  logger.error({ err }, 'Seed bajarilmadi');
  process.exit(1);
});
