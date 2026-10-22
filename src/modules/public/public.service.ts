import crypto from 'crypto';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { buildMeta, skipOf } from '../../core/pagination';
import { Photo } from '../../models/Photo';
import { School } from '../../models/School';
import { Student } from '../../models/Student';
import { escapeRegex, isId } from '../../utils/helpers';
import { rankChange } from '../ratings/rating.calc';
import {
  findClassRatings,
  findSchoolRatings,
  findStudentRatings,
  getSchoolsSnapshot,
  getSnapshot,
} from '../ratings/ratings.service';
import type { PublicSettings } from '../settings/public.settings';
import { settingsService } from '../settings/settings.service';

/**
 * PUBLIC javoblarda faqat shu yerda sanalgan maydonlar chiqadi. Hech qachon: izoh, xulq turi,
 * o'qituvchi, telefon, studentCode, tug'ilgan sana, jins, eski photoUrl, ichki schoolId/userId.
 * Rasm faqat `showPhotos` yoqilganda va faqat faol o'quvchilar uchun, opaque `photoUrl` sifatida chiqadi.
 * O'qituvchi rasmlari hech qachon chiqmaydi.
 */
const NOT_FOUND = () => AppError.notFound('Reyting topilmadi');

/** O'quvchi uchun barqaror, lekin ichki id ni oshkor qilmaydigan kalit */
export const studentKey = (id: string): string =>
  crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`student:${id}`)
    .digest('base64url')
    .slice(0, 22);

const periodOut = (p: { type: string; from: string | null; to: string | null; label: string }) => ({
  type: p.type,
  from: p.from,
  to: p.to,
  label: p.label,
});

/** Maktab topilmasa, nofaol yoki public o'chiq bo'lsa — bir xil 404 */
async function resolveSchool(slug: string) {
  const school = await School.findOne({ slug: slug.toLowerCase(), isActive: true }).lean();
  if (!school) throw NOT_FOUND();
  const id = String(school._id);
  const settings = await settingsService.getEffectivePublic(id);
  if (!settings.enabled) throw NOT_FOUND();
  return { school, id, settings };
}

export const publicService = {
  async schools() {
    const schools = await School.find({ isActive: true })
      .select('name slug logoUrl')
      .sort({ name: 1 })
      .lean();
    const out = [];
    for (const s of schools) {
      const p = await settingsService.getEffectivePublic(String(s._id));
      if (p.enabled) out.push({ name: s.name, slug: s.slug, logoUrl: s.logoUrl ?? null });
    }
    return { data: out };
  },

  async config(slug: string) {
    const { school, id, settings } = await resolveSchool(slug);
    const snap = await getSnapshot(id);
    return {
      data: {
        school: { name: school.name, slug: school.slug, logoUrl: school.logoUrl ?? null },
        title: settings.title,
        subtitle: settings.subtitle,
        primaryColor: settings.primaryColor,
        showClasses: settings.showClasses,
        showStudents: settings.showStudents,
        showScores: settings.showScores,
        showMedals: settings.showMedals,
        showTrend: settings.showTrend,
        showPhotos: settings.showPhotos,
        topStudents: settings.topStudents,
        autoRefreshSeconds: settings.autoRefreshSeconds,
        tvSlideSeconds: settings.tvSlideSeconds,
        period: periodOut(snap.period),
        calculatedAt: snap.calculatedAt,
        globalAvailable: settings.showScope === 'global' && (await globalEnabled()),
      },
    };
  },

  async classes(slug: string, q: { grade?: number }) {
    const { id, settings } = await resolveSchool(slug);
    if (!settings.showClasses) throw NOT_FOUND();
    const snap = await getSnapshot(id);
    const docs = await findClassRatings(id, snap.calcId, { grade: q.grade });
    return {
      data: {
        period: periodOut(snap.period),
        calculatedAt: snap.calculatedAt,
        items: docs.map((d) => ({
          rank: d.rank,
          ...(settings.showTrend ? { rankChange: rankChange(d.rank, d.previousRank) } : {}),
          classId: String(d.refId),
          className: d.name,
          grade: d.grade,
          ...(settings.showScores ? { score: d.score } : {}),
          ratedStudents: d.ratedStudents,
        })),
      },
    };
  },

  async students(
    slug: string,
    q: { classId?: string; grade?: number; search?: string; limit: number; page: number },
  ) {
    const { school, id, settings } = await resolveSchool(slug);
    if (!settings.showStudents) throw NOT_FOUND();
    const snap = await getSnapshot(id);
    const base = { classId: q.classId, grade: q.grade, includeIneligible: false };

    let docs;
    let total: number;
    if (settings.topStudents) {
      // Filtrdagi eng yaxshi N ta; qidiruv shu cheklov ichida
      const top = (
        await findStudentRatings(id, snap.calcId, { ...base, limit: settings.topStudents })
      ).docs;
      const filtered = q.search
        ? top.filter((d) => new RegExp(escapeRegex(q.search as string), 'i').test(d.name))
        : top;
      total = filtered.length;
      docs = filtered.slice(skipOf(q.page, q.limit), skipOf(q.page, q.limit) + q.limit);
    } else {
      const r = await findStudentRatings(id, snap.calcId, {
        ...base,
        search: q.search,
        skip: skipOf(q.page, q.limit),
        limit: q.limit,
      });
      docs = r.docs;
      total = r.total;
    }
    const photoOf = settings.showPhotos
      ? await publicPhotoIds(
          id,
          docs.map((d) => String(d.refId)),
        )
      : null;
    return {
      data: {
        period: periodOut(snap.period),
        calculatedAt: snap.calculatedAt,
        items: docs.map((d) => ({
          rank: d.rank,
          ...(settings.showTrend ? { rankChange: rankChange(d.rank, d.previousRank) } : {}),
          ...(photoOf
            ? {
                photoUrl: photoOf.has(String(d.refId))
                  ? `/api/v1/public/${school.slug}/photos/${photoOf.get(String(d.refId))}`
                  : null,
              }
            : {}),
          studentKey: studentKey(String(d.refId)),
          fullName: d.name,
          className: d.className,
          ...(settings.showScores ? { score: d.score } : {}),
        })),
      },
      meta: buildMeta(q.page, q.limit, total),
    };
  },

  /**
   * Ochiq rasm: faqat maktabda public va showStudents va showPhotos yoqilgan bo'lsa hamda rasm
   * shu maktabning FAOL o'quvchisiga tegishli bo'lsa; aks holda bir xil 404.
   */
  async photo(slug: string, photoId: string) {
    const { id, settings } = await resolveSchool(slug);
    if (!settings.showPhotos || !settings.showStudents || !isId(photoId)) throw NOT_FOUND();
    const student = await Student.findOne({
      schoolId: id,
      photoId,
      status: 'active',
      isDeleted: false,
    })
      .select('_id')
      .lean();
    if (!student) throw NOT_FOUND();
    const photo = await Photo.findOne({
      _id: photoId,
      schoolId: id,
      ownerType: 'student',
      ownerId: student._id,
    }).select('+data');
    if (!photo) throw NOT_FOUND();
    return photo;
  },

  /** Umumiy (maktablar) reyting — faqat platformada globalRatingEnabled bo'lsa */
  async globalRating() {
    const g = await settingsService.getGlobal<PublicSettings>('public');
    if (!g.globalRatingEnabled) throw NOT_FOUND();
    const snap = await getSchoolsSnapshot();
    const docs = (await findSchoolRatings(snap.calcId)).filter((d) => d.rank !== null);

    const schools = await School.find({ _id: { $in: docs.map((d) => d.refId) }, isActive: true })
      .select('name slug logoUrl')
      .lean();
    const byId = new Map(schools.map((s) => [String(s._id), s]));
    const included = [];
    for (const d of docs) {
      const s = byId.get(String(d.refId));
      if (!s) continue;
      const p = await settingsService.getEffectivePublic(String(s._id));
      if (p.enabled && p.includeInGlobal) included.push({ d, s });
    }
    // Ko'rinadigan maktablar ichida qayta raqamlanadi; oldingi o'rin ham shu to'plamda hisoblanadi
    const prevOrder = new Map(
      included
        .filter((x) => x.d.previousRank !== null)
        .sort((a, b) => (a.d.previousRank as number) - (b.d.previousRank as number))
        .map((x, i) => [String(x.d.refId), i + 1]),
    );
    return {
      data: {
        period: periodOut(snap.period),
        calculatedAt: snap.calculatedAt,
        items: included.map((x, i) => ({
          rank: i + 1,
          ...(g.showTrend
            ? {
                rankChange: prevOrder.has(String(x.d.refId))
                  ? (prevOrder.get(String(x.d.refId)) as number) - (i + 1)
                  : null,
              }
            : {}),
          schoolName: x.s.name,
          slug: x.s.slug,
          logoUrl: x.s.logoUrl ?? null,
          ...(g.showScores ? { score: x.d.score } : {}),
          ratedStudents: x.d.ratedStudents,
        })),
      },
    };
  },
};

/** {studentId -> photoId} faqat faol, rasmi bor o'quvchilar uchun */
async function publicPhotoIds(schoolId: string, studentIds: string[]) {
  const map = new Map<string, string>();
  if (!studentIds.length) return map;
  const rows = await Student.find({
    _id: { $in: studentIds },
    schoolId,
    status: 'active',
    isDeleted: false,
    photoId: { $ne: null },
  })
    .select('photoId')
    .lean();
  for (const r of rows) map.set(String(r._id), String(r.photoId));
  return map;
}

async function globalEnabled(): Promise<boolean> {
  return (await settingsService.getGlobal<PublicSettings>('public')).globalRatingEnabled;
}
