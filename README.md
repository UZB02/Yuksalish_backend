# Yuksalish Backend

"O'quvchilar intizomi reytingi" tizimining backend API si: Node.js + Express + MongoDB (Mongoose) + TypeScript. Ko'p maktabli (multi-tenant). To'liq texnik topshiriq: [../docs/TZ.md](../docs/TZ.md).

Frontend alohida loyihada: [../Yuksalish_Front](../Yuksalish_Front).

## Tuzilma

```
src/
  config/        env.ts (zod bilan validatsiya), db.ts
  core/          errors, asyncHandler, response, pagination, logger, validators
  middlewares/   authenticate, authorize(+requirePermission), tenant, validate, errorHandler, rateLimiters ...
  modules/       auth | schools | school-admins | teachers | academic-years | classes |
                 students (+ Excel import) | behavior-types | settings | scores | ratings |
                 public | dashboard | meta | users | audit | health
                 (routes -> controller -> service -> model)
  models/        User, School, RefreshToken, AuditLog, AcademicYear, Class, Student, ImportSession,
                 BehaviorType, Setting, Score, Rating
  constants/     roles, permissions (ruxsatlar katalogi)
  jobs/          rejalashtirilgan vazifalar (kechasi reytingni qayta hisoblash)
  docs/          Swagger (OpenAPI) tavsifi
scripts/         seed.ts, seed-demo.ts
tests/           vitest + supertest + mongodb-memory-server
```

## Ishga tushirish

Talab: Node.js >= 20, MongoDB (lokal xizmat yoki Docker).

```bash
npm install
cp .env.example .env              # JWT_ACCESS_SECRET va boshqalarni to'g'rilang
docker compose -f docker-compose.dev.yml up -d   # yoki o'z MongoDB ingiz (MONGODB_URI .env da)
npm run seed                      # superadmin + standart xulq turlari (qayta ishga tushirsa dublikat qilmaydi)
npm run dev                       # http://localhost:4000/api/v1 , Swagger: /api/docs
```

Productionga joylash (Docker + Caddy, AlmaLinux 10): [docs/DEPLOY.md](docs/DEPLOY.md).

## Skriptlar

| Komanda             | Vazifasi                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`       | dev server (`tsx watch`)                                                                 |
| `npm run build`     | production build (`dist/`)                                                               |
| `npm start`         | production server                                                                        |
| `npm run typecheck` | `tsc --noEmit`                                                                           |
| `npm run lint`      | ESLint                                                                                   |
| `npm test`          | testlar (birinchi marta mongod yuklab oladi)                                             |
| `npm run seed`      | superadmin (`SEED_SUPERADMIN_*`) + standart xulq turlari                                 |
| `npm run seed:demo` | 2 demo maktab: o'quv yili, sinflar, o'quvchilar, o'qituvchilar, baholar (loginlar logda) |
| `npm run format`    | Prettier                                                                                 |

## API shartnomasi (qisqacha)

- Base URL `/api/v1`, port 4000. Muvaffaqiyat: `{ success: true, data, meta? }`, xato: `{ success: false, error: { code, message, details? } }`.
- Auth: `POST /auth/login | refresh | logout | logout-all`, `GET /auth/me`, `PATCH /auth/password`. Access token — `Authorization: Bearer`, refresh token — httpOnly cookie `refreshToken` (path `/api/v1/auth`). Frontend so'rovlarida `withCredentials: true` kerak.
- Maktab-doirali endpointlar: maktab admini/o'qituvchi uchun maktab tokendan olinadi; superadmin `X-School-Id` sarlavhasini yuboradi.
- Ruxsatlar katalogi: `GET /meta/permissions`.
- To'liq tavsif: Swagger UI `/api/docs`.

## Reyting va ochiq (public) API

- **Hisoblash**: har bir kun uchun o'quvchining kunlik bali (`dailyAggregation`), davr bo'yicha o'rtacha yoki yig'indi; kamida `minScoresCount` ta baholangan kun bo'lsa reytingga kiradi. Sinf = eligible o'quvchilar o'rtachasi, maktab = barcha eligible o'quvchilar o'rtachasi. Sinf sifatida o'quvchining **hozirgi** sinfi olinadi. Natija `ratings` kolleksiyasida snapshot sifatida saqlanadi (atomik almashtiriladi).
- **Qayta hisoblash**: baho/o'quvchi/sozlama o'zgarganda (refreshMode=`realtime` bo'lsa ~5 s debounce bilan), har kuni 02:00 (Asia/Tashkent, `JOBS_ENABLED=true`), `POST /api/v1/ratings/recalculate`, yoki o'qishda snapshot bo'lmasa (lazy).
- **Sozlamalar**: `GET/PUT /api/v1/settings/{scoring|rating|public}` (global + maktab override; yozish faqat superadmin).
- **Public API** (autentifikatsiyasiz, faqat GET, `Cache-Control: public, max-age=30`, ETag, alohida rate limit `PUBLIC_RATE_LIMIT_PER_MIN`, CORS `PUBLIC_CORS_ORIGINS`):
  `GET /api/v1/public/schools`, `/public/:slug/config`, `/public/:slug/rating/classes`, `/public/:slug/rating/students`, `/public/global/rating`.
  Izoh, xulq turi, o'qituvchi, telefon, studentCode, tug'ilgan sana, jins, photoUrl va ichki id lar hech qachon chiqmaydi. Yoqilmagan maktab / noma'lum slug / o'chiq bo'lim — bir xil 404.

## Muhit o'zgaruvchilari

Hammasi [.env.example](.env.example) da izohlangan. Asosiylari: `MONGODB_URI`, `JWT_ACCESS_SECRET`, `CORS_ORIGINS`, `PUBLIC_CORS_ORIGINS`, `PUBLIC_RATE_LIMIT_PER_MIN`, `JOBS_ENABLED`, `RATING_DEBOUNCE_MS`, `SEED_SUPERADMIN_*`.

## Demo ma'lumot

`npm run seed:demo` ikkita maktab (`demo-maktab`, `demo-maktab-2`), baholar, yoqilgan ochiq reyting va umumiy reytingni yaratadi. Demo parol faqat dev uchun, productionda ishlatmang.

## Davomat

- **Rejim**: `GET/PUT /api/v1/settings/attendance` — kunlik (`lessonNo=0`) yoki dars bo'yicha (`lessonsPerDay` 1–12), ish kunlari (ISO, 1 = dushanba), tahrir oynasi, orqaga sana, izoh majburiy kategoriyalar, `ratingImpact`. Superadmin (global/maktab) yoki `attendance.settings` li maktab admini (faqat o'z maktabi) o'zgartiradi.
- **Holatlar**: `/api/v1/attendance-statuses` (superadmin; kategoriya: present | late | absent_excused | absent_unexcused). `npm run seed` 4 ta standart holatni yaratadi.
- **Olish**: `GET /classes/:id/attendance-sheet`, `POST /attendance/bulk` (upsert), `PATCH|DELETE /attendance/:id`. Tarix: `GET /attendance`; statistika: `GET /attendance/summary`, `GET /students/:id/attendance-summary`; bugungi jarayon: `GET /attendance/today-progress`; dashboardda `attendanceToday`.
- **Ruxsatlar**: `attendance.take` (o'qituvchida doim), `attendance.edit`, `attendance.view`, `attendance.settings`.
- **Reytingga ta'sir** (standart o'chiq): `ratingImpact.enabled` bo'lsa davr ichidagi kechikish/sababli/sababsiz yo'qlar soniga qarab ball jarima bilan kamaytiriladi (0 dan past tushmaydi). Ochiq (public) API da davomat tafsilotlari chiqmaydi. `npm run seed:demo` 14 kunlik davomatni (demo-maktab — kunlik, demo-maktab-2 — dars rejimi) yaratadi.

## Hisobotlar va audit log

- **Hisobotlar** (`/api/v1/reports`): `class`, `student/:id`, `teachers`, `school`, `behavior`, `schools` (faqat superadmin). Davr `from` va `to` (YYYY-MM-DD) majburiy, <= 366 kun, kelajakka chiqmaydi. Ko'rish — `reports.view`; o'qituvchi faqat o'z sinflari doirasida sinf/o'quvchi hisobotlarini ko'radi. `ratingScore`/`rank` — reyting dvigatelining shu davr uchun jonli hisobi (davomat jarimasi bilan).
- **Eksport**: `GET /reports/<tur>/export?...&format=xlsx|pdf` (`reports.export` + `reports.view`). Excel — exceljs (formulasiz, formula-injeksiya himoyasi bilan), PDF — pdfkit (headless brauzer yo'q). Bir hisobotda ko'pi bilan `REPORTS_MAX_ROWS` (default 5000) qator.
- **PDF shrifti**: Unicode (o'zbek lotin, `ʻ`/`ʼ`, kirill) uchun **DejaVu Sans** (`assets/fonts/`, litsenziya: `LICENSE-DejaVu.txt` — Bitstream Vera/DejaVu, erkin foydalanish va tarqatish). Docker image ga `assets/` nusxalanadi (Dockerfile). Shrift topilmasa PDF yaratilmaydi (xato qaytadi).
- **Audit log** (`GET /api/v1/audit-logs`, `/audit-logs/filters`): `audit.view` kerak; school_admin faqat o'z maktabi, superadmin hammasi. Faqat o'qiladi (o'zgartirish/o'chirish endpointi yo'q). `before`/`after` dan parol/token kalitlari o'qishda ham olib tashlanadi. `AUDIT_RETENTION_DAYS` berilsa, eski yozuvlar TTL indeks bilan o'chiriladi (bo'sh = abadiy; indeks server ishga tushganda yaratiladi).
- `npm audit`: exceljs tranzitiv `uuid` zaifligi `package.json` dagi `overrides.uuid ^11.1.1` bilan yopilgan.
