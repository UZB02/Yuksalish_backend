import type { Ctx } from '../../core/context';
import { settingsHooks } from '../../core/hooks';
import { AppError } from '../../core/errors';
import { School } from '../../models/School';
import { isId } from '../../utils/helpers';
import { auditService } from '../audit/audit.service';
import { PUBLIC_KEY, type PublicSettings } from './public.settings';
import { RATING_KEY, type RatingSettings } from './rating.settings';
import { SETTING_DEFS, mergeLayers, type SettingDef } from './registry';
import { SCORING_KEY, type ScoringSettings } from './scoring.settings';
import { settingsStore } from './settings.store';

type Obj = Record<string, unknown>;

export function getDef(key: string): SettingDef {
  const def = SETTING_DEFS[key];
  if (!def) throw AppError.notFound('Sozlama topilmadi');
  return def;
}

/** Ikki sozlama qiymati orasida o'zgargan kalitlar */
function diffKeys(a: Obj | null, b: Obj | null): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

export const settingsService = {
  /** Maktab uchun amaldagi sozlama (schoolId yo'q bo'lsa — global) */
  async getEffective<T>(key: string, schoolId?: string | null): Promise<T> {
    const def = getDef(key);
    const global = await settingsStore.get<Obj>('global', null, key);
    const override = schoolId ? await settingsStore.get<Obj>('school', schoolId, key) : null;
    return mergeLayers(def.defaults, global, override) as T;
  },

  getEffectiveScoring: (schoolId?: string | null) =>
    settingsService.getEffective<ScoringSettings>(SCORING_KEY, schoolId),
  getEffectiveRating: (schoolId?: string | null) =>
    settingsService.getEffective<RatingSettings>(RATING_KEY, schoolId),
  getEffectivePublic: (schoolId?: string | null) =>
    settingsService.getEffective<PublicSettings>(PUBLIC_KEY, schoolId),
  /** Faqat global qatlam (umumiy reyting uchun) */
  getGlobal: <T>(key: string) => settingsService.getEffective<T>(key, null),

  async get(key: string, schoolId: string | undefined, includeOverride: boolean) {
    const def = getDef(key);
    const globalStored = await settingsStore.get<Obj>('global', null, key);
    const override = schoolId ? await settingsStore.get<Obj>('school', schoolId, key) : null;
    return {
      effective: mergeLayers(def.defaults, globalStored, override),
      global: mergeLayers(def.defaults, globalStored),
      override: includeOverride ? (override ?? null) : null,
    };
  },

  async put(
    ctx: Ctx,
    key: string,
    input: { scope: 'global' | 'school'; schoolId?: string; values: Obj | null },
  ) {
    const def = getDef(key);
    const values = input.values && def.normalize ? def.normalize(input.values) : input.values;
    def.validateScope?.(input.scope, values);
    let changed: string[];

    if (input.scope === 'school') {
      if (!input.schoolId || !isId(input.schoolId)) {
        throw AppError.validation("Maktab ko'rsatilmagan", [
          { path: 'schoolId', message: 'scope=school uchun schoolId majburiy' },
        ]);
      }
      if (!(await School.exists({ _id: input.schoolId })))
        throw AppError.notFound('Maktab topilmadi');

      const globalStored = await settingsStore.get<Obj>('global', null, key);
      const before = await settingsStore.get<Obj>('school', input.schoolId, key);
      if (values) {
        def.validateMerged(mergeLayers(def.defaults, globalStored, values));
        await settingsStore.set('school', input.schoolId, key, values, ctx.actor.id);
      } else {
        await settingsStore.remove('school', input.schoolId, key);
      }
      changed = diffKeys(before, values);
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: input.schoolId,
        action: 'settings.update',
        entity: 'settings',
        entityId: key,
        before: { scope: 'school', values: before },
        after: { scope: 'school', values },
        ip: ctx.ip,
      });
    } else {
      const next = values ?? {}; // global uchun null = standartga qaytarish
      def.validateMerged(mergeLayers(def.defaults, next));
      // Global o'zgarish mavjud maktab override lari bilan ziddiyatga tushmasin
      for (const o of await settingsStore.listSchoolOverrides<Obj>(key)) {
        try {
          def.validateMerged(mergeLayers(def.defaults, next, o.value));
        } catch (e) {
          if (e instanceof AppError) {
            throw AppError.validation('Sozlamalar maktab override i bilan ziddiyatda', [
              ...(e.details ?? []),
              { path: 'values', message: `Maktab ${o.schoolId} override i bilan mos kelmaydi` },
            ]);
          }
          throw e;
        }
      }
      const before = await settingsStore.get<Obj>('global', null, key);
      await settingsStore.set('global', null, key, next, ctx.actor.id);
      changed = diffKeys(before, next);
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: null,
        action: 'settings.update',
        entity: 'settings',
        entityId: key,
        before: { scope: 'global', values: before },
        after: { scope: 'global', values: next },
        ip: ctx.ip,
      });
    }
    // Reyting keshi/snapshoti bekor qilinadi va qayta hisoblanadi (tinglovchilar)
    await settingsHooks.emit({
      key,
      scope: input.scope,
      schoolId: input.scope === 'school' ? (input.schoolId ?? null) : null,
      changed,
    });
    return this.get(key, input.scope === 'school' ? input.schoolId : undefined, true);
  },
};
