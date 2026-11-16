import fs from 'fs';
import mongoose from 'mongoose';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PURGE_EXEMPT,
  SCHOOL_PURGE_STEPS,
  assertSafeFilter,
  type PurgeStep,
} from '../src/modules/schools/schoolPurge';

/**
 * REGISTRY COMPLETENESS: maktabga (schoolId) yoki foydalanuvchiga (userId) bog'langan har qanday Mongoose
 * model maktabni butunlay o'chirish ro'yxatida (schoolPurge.ts) bo'lishi shart. Yangi modul modelini
 * qo'shib, ro'yxatga qo'shishni unutsangiz bu test YIQILADI.
 */
beforeAll(async () => {
  // src/models dagi barcha model fayllarini yuklaymiz (qo'lda ro'yxat yuritilmaydi)
  const dir = path.resolve(__dirname, '../src/models');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    await import(path.join(dir, f).split(path.sep).join('/'));
  }
});

interface SchemaLike {
  paths: Record<string, { path: string; schema?: SchemaLike }>;
}

const pathsOf = (schema: SchemaLike): string[] => {
  const out = Object.keys(schema.paths);
  // ichki sxemalar (subdocument massivlari) yo'llari
  for (const p of Object.values(schema.paths)) {
    const sub = p.schema;
    if (sub) out.push(...pathsOf(sub).map((s) => `${p.path}.${s}`));
  }
  return out;
};
const leaf = (p: string) => p.split('.').pop() as string;

describe('maktabni o‘chirish ro‘yxati to‘liqligi', () => {
  const registered = () => new Set(SCHOOL_PURGE_STEPS.map((s) => s.model.modelName));

  it('schoolId yoki userId yo‘li bor har bir model ro‘yxatda (yoki sababi bilan istisno)', () => {
    const reg = registered();
    const missing: string[] = [];
    for (const name of mongoose.modelNames()) {
      const paths = pathsOf(mongoose.model(name).schema as unknown as SchemaLike).map(leaf);
      const linked = paths.includes('schoolId') || paths.includes('userId');
      if (linked && !reg.has(name) && !PURGE_EXEMPT[name]) missing.push(name);
    }
    expect(missing, `Ro'yxatga qo'shilmagan modellar: ${missing.join(', ')}`).toEqual([]);
  });

  it('hech qaysi model e‘tiborsiz qolmaydi: har biri ro‘yxatda yoki istisnolarda (sababi bilan)', () => {
    const reg = registered();
    const unknown = mongoose.modelNames().filter((n) => !reg.has(n) && !PURGE_EXEMPT[n]);
    // Maktabga/foydalanuvchiga bog'lanmagan yangi model ham ongli qaror talab qiladi
    expect(
      unknown,
      `Yangi model: ro'yxatga yoki PURGE_EXEMPT ga (sabab bilan) qo'shing: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('istisnolar va ro‘yxat haqiqiy modellarga ishora qiladi, kalitlar noyob', () => {
    const names = new Set(mongoose.modelNames());
    for (const n of Object.keys(PURGE_EXEMPT)) expect(names.has(n), n).toBe(true);
    for (const s of SCHOOL_PURGE_STEPS) expect(names.has(s.model.modelName), s.key).toBe(true);
    const keys = SCHOOL_PURGE_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const n of Object.keys(PURGE_EXEMPT)) {
      expect(registered().has(n), `${n} ham ro'yxatda, ham istisno`).toBe(false);
      expect(PURGE_EXEMPT[n].length).toBeGreaterThan(5);
    }
  });

  it('schoolId bor modellarning filtri schoolId ga bog‘langan, foydalanuvchiga bog‘liqlariniki userId.$in', () => {
    const sid = new mongoose.Types.ObjectId();
    const uid = new mongoose.Types.ObjectId();
    const ctx = { schoolId: sid, userIds: [uid] };
    for (const s of SCHOOL_PURGE_STEPS) {
      const f = s.filter(ctx);
      expect(() => assertSafeFilter(s, f, ctx), s.key).not.toThrow();
      const hasSchoolId = pathsOf(s.model.schema as unknown as SchemaLike).some(
        (p) => leaf(p) === 'schoolId',
      );
      if (hasSchoolId) expect(s.scope, s.key).toBe('school');
    }
  });

  it('xavfsiz bo‘lmagan filtrlar rad etiladi (bo‘sh, schoolId siz, begona id)', () => {
    const sid = new mongoose.Types.ObjectId();
    const ctx = { schoolId: sid, userIds: [new mongoose.Types.ObjectId()] };
    const school = SCHOOL_PURGE_STEPS.find((s) => s.scope === 'school') as PurgeStep;
    const users = SCHOOL_PURGE_STEPS.find((s) => s.scope === 'users') as PurgeStep;
    expect(() => assertSafeFilter(school, {}, ctx)).toThrow();
    expect(() => assertSafeFilter(school, { role: 'teacher' }, ctx)).toThrow();
    expect(() =>
      assertSafeFilter(school, { schoolId: new mongoose.Types.ObjectId() }, ctx),
    ).toThrow();
    expect(() => assertSafeFilter(school, { schoolId: String(sid) }, ctx)).toThrow();
    expect(() => assertSafeFilter(school, { schoolId: null }, ctx)).toThrow();
    expect(() => assertSafeFilter(users, {}, ctx)).toThrow();
    expect(() => assertSafeFilter(users, { userId: { $in: [] } }, ctx)).toThrow();
    expect(() =>
      assertSafeFilter(users, { userId: { $in: [new mongoose.Types.ObjectId()] } }, ctx),
    ).toThrow();
  });
});
