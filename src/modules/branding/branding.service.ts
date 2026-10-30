import crypto from 'crypto';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { BrandingAsset } from '../../models/BrandingAsset';
import { School } from '../../models/School';
import { isId } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { settingsStore } from '../settings/settings.store';
import { PLATFORM_VARIANTS, processLogo } from './branding.process';

export const DEFAULT_APP_NAME = 'Yuksalish EDU';
const KEY = 'branding';
const API = '/api/v1/branding';

interface PlatformConfig {
  appName: string;
  shortName: string;
  logoHash: string | null;
}

const DEFAULTS: PlatformConfig = {
  appName: DEFAULT_APP_NAME,
  shortName: DEFAULT_APP_NAME,
  logoHash: null,
};

async function loadConfig(): Promise<PlatformConfig> {
  const v = await settingsStore.get<Partial<PlatformConfig>>('global', null, KEY);
  return { ...DEFAULTS, ...(v ?? {}) };
}

const versionOf = (c: PlatformConfig): string =>
  crypto
    .createHash('sha1')
    .update(`${c.appName}|${c.shortName}|${c.logoHash ?? ''}`)
    .digest('hex')
    .slice(0, 12);

function toPublic(c: PlatformConfig) {
  const version = versionOf(c);
  const url = (variant: string) => `${API}/logo/${variant}?v=${version}`;
  return {
    appName: c.appName,
    shortName: c.shortName,
    logoUrl: c.logoHash ? url('logo') : null,
    icons: c.logoHash
      ? {
          favicon: url('favicon'),
          icon192: url('icon192'),
          icon512: url('icon512'),
          maskable512: url('maskable512'),
          apple180: url('apple180'),
        }
      : null,
    version,
  };
}

/** Statik (logo yuklanmagan) ikonkalar: admin `public/` dagi fayllar */
const STATIC_ICONS = [
  { src: '/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
  { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
  { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
  { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

export const schoolLogoPath = {
  /** Admin DTO: id bo'yicha, maktab ochiq saytda yoqilgan bo'lishi shart emas */
  admin: (id: string, hash: string) => `${API}/schools/${id}/logo?v=${hash}`,
  /** Ochiq sayt DTO: slug bo'yicha */
  public: (slug: string, hash: string) => `/api/v1/public/schools/${slug}/logo?v=${hash}`,
};

async function findSchool(id: string) {
  const school = isId(id) ? await School.findById(id) : null;
  if (!school) throw AppError.notFound('Maktab topilmadi');
  return school;
}

async function replaceAssets(
  owner: { ownerType: 'platform' | 'school'; schoolId: string | null },
  variants: Record<string, Buffer>,
  hash: string,
) {
  await BrandingAsset.deleteMany({ ownerType: owner.ownerType, schoolId: owner.schoolId });
  await BrandingAsset.insertMany(
    Object.entries(variants).map(([variant, data]) => ({
      ...owner,
      variant,
      data,
      contentType: 'image/png',
      hash,
    })),
  );
}

export const brandingService = {
  async get() {
    return toPublic(await loadConfig());
  },

  async update(ctx: Ctx, input: { appName: string; shortName: string }) {
    const before = await loadConfig();
    const next: PlatformConfig = { ...before, ...input };
    await settingsStore.set('global', null, KEY, next, ctx.actor.id);
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: null,
      action: 'branding.updated',
      entity: 'branding',
      entityId: KEY,
      before: { appName: before.appName, shortName: before.shortName },
      after: { appName: next.appName, shortName: next.shortName },
      ip: ctx.ip,
    });
    return toPublic(next);
  },

  async setLogo(ctx: Ctx, buf: Buffer) {
    const p = await processLogo(buf);
    const before = await loadConfig();
    await replaceAssets({ ownerType: 'platform', schoolId: null }, p.variants, p.hash);
    const next = { ...before, logoHash: p.hash };
    await settingsStore.set('global', null, KEY, next, ctx.actor.id);
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: null,
      action: 'branding.logo_updated',
      entity: 'branding',
      entityId: KEY,
      before: { logo: before.logoHash },
      after: { logo: p.hash },
      ip: ctx.ip,
    });
    return toPublic(next);
  },

  async deleteLogo(ctx: Ctx) {
    const before = await loadConfig();
    await BrandingAsset.deleteMany({ ownerType: 'platform' });
    const next = { ...before, logoHash: null };
    await settingsStore.set('global', null, KEY, next, ctx.actor.id);
    if (before.logoHash) {
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: null,
        action: 'branding.logo_deleted',
        entity: 'branding',
        entityId: KEY,
        before: { logo: before.logoHash },
        after: { logo: null },
        ip: ctx.ip,
      });
    }
    return toPublic(next);
  },

  /** Platforma logosi variantini beradi; versiya mos kelsa immutable keshlanadi */
  async platformVariant(variant: string, v: unknown) {
    if (!(PLATFORM_VARIANTS as readonly string[]).includes(variant)) {
      throw AppError.notFound('Logo topilmadi');
    }
    const c = await loadConfig();
    if (!c.logoHash) throw AppError.notFound('Logo topilmadi');
    const asset = await BrandingAsset.findOne({
      ownerType: 'platform',
      schoolId: null,
      variant,
    }).select('+data');
    if (!asset) throw AppError.notFound('Logo topilmadi');
    return { asset, immutable: typeof v === 'string' && v === versionOf(c) };
  },

  /** Admin DTO uchun id bo'yicha maktab logosi */
  async schoolLogoById(id: string, v: unknown) {
    const school = isId(id) ? await School.findById(id).select('logoHash').lean() : null;
    return this.schoolAsset(school?.logoHash ?? null, id, v);
  },

  async schoolAsset(logoHash: string | null, schoolId: string, v: unknown) {
    if (!logoHash) throw AppError.notFound('Logo topilmadi');
    const asset = await BrandingAsset.findOne({
      ownerType: 'school',
      schoolId,
      variant: 'logo',
    }).select('+data');
    if (!asset) throw AppError.notFound('Logo topilmadi');
    return { asset, immutable: typeof v === 'string' && v === logoHash };
  },

  async setSchoolLogo(ctx: Ctx, schoolId: string, buf: Buffer) {
    const school = await findSchool(schoolId);
    const p = await processLogo(buf);
    const before = school.logoHash;
    // Maktab uchun faqat `logo` va `doc` variantlari kerak
    await replaceAssets(
      { ownerType: 'school', schoolId },
      { logo: p.variants.logo, doc: p.variants.doc },
      p.hash,
    );
    school.logoHash = p.hash;
    await school.save();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'school.logo_updated',
      entity: 'school',
      entityId: schoolId,
      before: { logo: before },
      after: { logo: p.hash },
      ip: ctx.ip,
    });
    return school;
  },

  async deleteSchoolLogo(ctx: Ctx, schoolId: string) {
    const school = await findSchool(schoolId);
    const before = school.logoHash;
    await BrandingAsset.deleteMany({ ownerType: 'school', schoolId });
    school.logoHash = null;
    await school.save();
    if (before) {
      await auditService.log({
        userId: ctx.actor.id,
        schoolId,
        action: 'school.logo_deleted',
        entity: 'school',
        entityId: schoolId,
        before: { logo: before },
        after: { logo: null },
        ip: ctx.ip,
      });
    }
    return school;
  },

  /**
   * Eksport (PDF/Excel) sarlavhasi uchun kichik PNG: maktab logosi, bo'lmasa platforma logosi,
   * bo'lmasa null. Xato hujjat yaratishni to'xtatmaydi.
   */
  async exportLogo(schoolId: string | null): Promise<Buffer | null> {
    try {
      if (schoolId) {
        const a = await BrandingAsset.findOne({
          ownerType: 'school',
          schoolId,
          variant: 'doc',
        }).select('+data');
        if (a) return a.data;
      }
      const p = await BrandingAsset.findOne({
        ownerType: 'platform',
        schoolId: null,
        variant: 'doc',
      }).select('+data');
      return p ? p.data : null;
    } catch {
      return null;
    }
  },

  /** Dinamik admin PWA manifesti (yagona manba) */
  async manifest() {
    const c = await loadConfig();
    const pub = toPublic(c);
    const icons = pub.icons
      ? [
          { src: pub.icons.icon192, sizes: '192x192', type: 'image/png' },
          { src: pub.icons.icon512, sizes: '512x512', type: 'image/png' },
          { src: pub.icons.maskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ]
      : STATIC_ICONS;
    return {
      id: '/',
      name: c.appName,
      short_name: c.shortName,
      description:
        "Maktab o'quvchilarining intizomi, davomati va baholarini yuritish uchun admin ilovasi.",
      lang: 'uz',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#4f46e5',
      background_color: '#ffffff',
      icons,
      // `/?go=` ni admin router roli bo'yicha ruxsat etilgan sahifaga aylantiradi
      shortcuts: [
        { name: 'Xulq bahosi', url: '/?go=scoring' },
        { name: 'Fan baholari', url: '/?go=grading' },
        { name: 'Davomat', url: '/?go=attendance' },
      ],
    };
  },
};
