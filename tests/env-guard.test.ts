import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_JWT_SECRET,
  productionEnvProblems,
  resolveEnableDocs,
  seedPasswordProblem,
} from '../src/config/env-guard';

describe('productionEnvProblems', () => {
  it('productionda change-me sirni rad etadi', () => {
    expect(productionEnvProblems({ NODE_ENV: 'production', JWT_ACCESS_SECRET: EXAMPLE_JWT_SECRET })).toHaveLength(1);
    expect(
      productionEnvProblems({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'xx-Change-Me-' + 'a'.repeat(40) }),
    ).toHaveLength(1);
  });
  it('productionda CHANGE_ME_ (production.env.example) placeholderlarini rad etadi', () => {
    for (const v of ['CHANGE_ME_openssl_rand_hex_48', 'change_me_' + 'a'.repeat(40), 'Change-Me_' + 'b'.repeat(40)]) {
      expect(productionEnvProblems({ NODE_ENV: 'production', JWT_ACCESS_SECRET: v })).toHaveLength(1);
    }
  });
  it('productionda haqiqiy sirni qabul qiladi', () => {
    expect(productionEnvProblems({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'f3a9'.repeat(24) })).toEqual([]);
  });
  it('development/test da tekshirmaydi', () => {
    expect(productionEnvProblems({ NODE_ENV: 'development', JWT_ACCESS_SECRET: EXAMPLE_JWT_SECRET })).toEqual([]);
    expect(productionEnvProblems({ NODE_ENV: 'test', JWT_ACCESS_SECRET: EXAMPLE_JWT_SECRET })).toEqual([]);
  });
});

describe('resolveEnableDocs', () => {
  it('productionda sukut bo\'yicha o\'chiq', () => {
    expect(resolveEnableDocs(undefined, 'production')).toBe(false);
    expect(resolveEnableDocs('', 'production')).toBe(false);
  });
  it('boshqa muhitda sukut bo\'yicha yoqiq', () => {
    expect(resolveEnableDocs(undefined, 'development')).toBe(true);
    expect(resolveEnableDocs(undefined, 'test')).toBe(true);
  });
  it('aniq qiymat doim ustun', () => {
    expect(resolveEnableDocs('true', 'production')).toBe(true);
    expect(resolveEnableDocs('1', 'production')).toBe(true);
    expect(resolveEnableDocs('false', 'development')).toBe(false);
    expect(resolveEnableDocs('0', 'development')).toBe(false);
  });
});

describe('seedPasswordProblem', () => {
  it('productionda ChangeMe123 ni rad etadi', () => {
    expect(seedPasswordProblem('production', 'ChangeMe123')).toMatch(/ChangeMe123/);
  });
  it('productionda CHANGE_ME_kuchli_parol_123 placeholderini rad etadi', () => {
    expect(seedPasswordProblem('production', 'CHANGE_ME_kuchli_parol_123')).toMatch(/CHANGE_ME/);
    expect(seedPasswordProblem('production', 'change-me-parol1')).not.toBeNull();
  });
  it('kuchli parol va dev muhitiga ruxsat', () => {
    expect(seedPasswordProblem('production', 'Zx9!kLm2Qw7r')).toBeNull();
    expect(seedPasswordProblem('development', 'ChangeMe123')).toBeNull();
  });
});
