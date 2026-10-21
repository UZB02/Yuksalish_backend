// Birinchi ishga tushishda (bo'sh bazada) ilova uchun cheklangan huquqli foydalanuvchi yaratadi.
// API root emas, faqat "yuksalish" bazasiga readWrite huquqi bilan ulanadi.
const appUser = process.env.MONGO_APP_USER;
const appPassword = process.env.MONGO_APP_PASSWORD;
if (!appUser || !appPassword) {
  throw new Error('MONGO_APP_USER va MONGO_APP_PASSWORD berilishi kerak');
}

const appDb = db.getSiblingDB('yuksalish');
appDb.createUser({
  user: appUser,
  pwd: appPassword,
  roles: [{ role: 'readWrite', db: 'yuksalish' }],
});
