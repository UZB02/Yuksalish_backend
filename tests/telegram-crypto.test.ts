import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/modules/telegram/telegram.crypto';
import { splitMessage } from '../src/modules/telegram/telegram.outbox';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x';

describe('telegram crypto', () => {
  it('shifrlab-ochish aylanishi ishlaydi va shifrda token korinmaydi', () => {
    const enc = encryptToken(TOKEN);
    expect(enc).not.toContain(TOKEN.slice(0, 12));
    expect(decryptToken(enc)).toBe(TOKEN);
  });

  it('har safar boshqa iv beradi', () => {
    expect(encryptToken(TOKEN)).not.toBe(encryptToken(TOKEN));
  });

  it('notogri kalit (almashtirilgan JWT siri) bilan ochilmaydi', () => {
    const enc = encryptToken(TOKEN, 'a'.repeat(40));
    expect(() => decryptToken(enc, 'b'.repeat(40))).toThrow();
  });

  it('buzilgan malumot ochilmaydi', () => {
    const buf = Buffer.from(encryptToken(TOKEN), 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptToken(buf.toString('base64'))).toThrow();
    expect(() => decryptToken('abc')).toThrow();
  });
});

describe('splitMessage', () => {
  it('qisqa matn bolinmaydi', () => {
    expect(splitMessage('salom')).toEqual(['salom']);
  });

  it('4096 dan uzun matn qator chegarasida bolinadi va hech narsa yoqolmaydi', () => {
    const lines = Array.from({ length: 800 }, (_, i) => `Qator raqami ${i}`);
    const parts = splitMessage(lines.join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n').split('\n')).toEqual(lines);
  });

  it('boshliqsiz uzun satr qattiq kesiladi', () => {
    const parts = splitMessage('x'.repeat(10_000));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });
});
