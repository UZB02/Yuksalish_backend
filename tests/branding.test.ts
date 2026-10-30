import ExcelJS from 'exceljs';
import request from 'supertest';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { brandingService } from '../src/modules/branding/branding.service';
import {
  renderTimetableExcel,
  renderTimetablePdf,
  type TimetableDoc,
} from '../src/modules/timetable/timetable.export';
import { app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';

useTestDb();

const API = '/api/v1/branding';
let root: string;
let admin: string;
let admin2: string;
let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;

const png = (w = 300, h = 200) =>
  sharp({
    create: { width: w, height: h, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();

function binary(
  res: NodeJS.ReadableStream & { on: (e: string, f: (c: Buffer) => void) => void },
  cb: (e: Error | null, b: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
const getBin = (url: string) =>
  request(app)
    .get(url)
    .buffer(true)
    .parse(binary as never);

beforeEach(async () => {
  school = await makeSchool('b1');
  other = await makeSchool('b2');
  await makeUser({ username: 'root', role: 'superadmin' });
  await makeUser({ username: 'ad1', role: 'school_admin', schoolId: school.id });
  await makeUser({ username: 'ad2', role: 'school_admin', schoolId: other.id });
  root = (await login('root')).token;
  admin = (await login('ad1')).token;
  admin2 = (await login('ad2')).token;
});

const upload = (token: string, buf: Buffer, name = 'l.png', type = 'image/png') =>
  request(app)
    .post(`${API}/logo`)
    .set(bearer(token))
    .attach('file', buf, { filename: name, contentType: type });

describe('branding: platforma', () => {
  it('default qiymatlar, ochiq, 60s kesh', async () => {
    const res = await request(app).get(API);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toEqual({
      success: true,
      data: {
        appName: 'Yuksalish EDU',
        shortName: 'Yuksalish EDU',
        logoUrl: null,
        icons: null,
        version: expect.any(String),
      },
    });
  });

  it('yangilash faqat superadmin, validatsiya, version ozgaradi, audit', async () => {
    const v0 = (await request(app).get(API)).body.data.version;
    const put = (t: string | null, body: object) => {
      const r = request(app).put(API);
      return (t ? r.set(bearer(t)) : r).send(body);
    };
    expect((await put(admin, { appName: 'X', shortName: 'X' })).status).toBe(403);
    expect((await put(null, { appName: 'X', shortName: 'X' })).status).toBe(401);
    for (const body of [
      { appName: '', shortName: 'a' },
      { appName: 'a'.repeat(61), shortName: 'a' },
      { appName: 'a', shortName: 'b'.repeat(21) },
    ]) {
      expect((await put(root, body)).status).toBe(400);
    }
    const ok = await put(root, { appName: 'Maktab Pro', shortName: 'MPro' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ appName: 'Maktab Pro', shortName: 'MPro' });
    const g = await request(app).get(API);
    expect(g.body.data.appName).toBe('Maktab Pro');
    expect(g.body.data.version).not.toBe(v0);
    expect(await AuditLog.countDocuments({ action: 'branding.updated' })).toBe(1);
  });

  it('logo yuklash: variantlar, versiya, immutable kesh, ochirish', async () => {
    expect((await upload(admin, await png())).status).toBe(403);
    const up = await upload(root, await png());
    expect(up.status).toBe(200);
    const d = up.body.data;
    expect(d.logoUrl).toMatch(/^\/api\/v1\/branding\/logo\/logo\?v=/);
    expect(Object.keys(d.icons).sort()).toEqual(
      ['apple180', 'favicon', 'icon192', 'icon512', 'maskable512'].sort(),
    );
    const sizes: Record<string, [number, number]> = {
      favicon: [32, 32],
      icon192: [192, 192],
      icon512: [512, 512],
      maskable512: [512, 512],
      apple180: [180, 180],
    };
    for (const [k, [w, h]] of Object.entries(sizes)) {
      const r = await getBin(d.icons[k]);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const m = await sharp(r.body as Buffer).metadata();
      expect([m.width, m.height]).toEqual([w, h]);
    }
    const logo = await getBin(d.logoUrl);
    const lm = await sharp(logo.body as Buffer).metadata();
    expect(lm.width).toBe(300);
    expect(lm.hasAlpha).toBe(true);
    const opaque = async (u: string) =>
      (await sharp((await getBin(u)).body as Buffer).stats()).isOpaque;
    expect(await opaque(d.icons.maskable512)).toBe(true);
    expect(await opaque(d.icons.apple180)).toBe(true);
    expect(await opaque(d.icons.icon512)).toBe(false);
    const stale = await request(app).get(`${API}/logo/logo?v=old`);
    expect(stale.headers['cache-control']).toBe('public, max-age=60');
    expect((await request(app).get(`${API}/logo/nope`)).status).toBe(404);

    expect((await request(app).delete(`${API}/logo`).set(bearer(admin))).status).toBe(403);
    const del = await request(app).delete(`${API}/logo`).set(bearer(root));
    expect(del.body.data).toMatchObject({ logoUrl: null, icons: null });
    expect((await request(app).get(`${API}/logo/logo`)).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'branding.logo_updated' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'branding.logo_deleted' })).toBe(1);
  });

  it('notogri fayllar rad etiladi', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await upload(root, svg, 'a.svg', 'image/svg+xml')).status).toBe(400);
    // mimetype png, lekin mazmun SVG
    expect((await upload(root, svg)).status).toBe(400);
    expect((await upload(root, Buffer.from('not an image'))).status).toBe(400);
    expect((await upload(root, await png(64, 64))).status).toBe(400);
    const big = Buffer.concat([await png(), Buffer.alloc(2 * 1024 * 1024 + 1)]);
    expect((await upload(root, big)).status).toBe(400);
    expect((await request(app).post(`${API}/logo`).set(bearer(root))).status).toBe(400);
  });

  it('manifest: default statik ikonkalar va yuklangan logo', async () => {
    const m = await request(app).get(`${API}/manifest.webmanifest`);
    expect(m.status).toBe(200);
    expect(m.headers['content-type']).toContain('application/manifest+json');
    expect(m.headers['cache-control']).toBe('no-cache');
    const j = JSON.parse(m.text);
    expect(j).toMatchObject({
      id: '/',
      name: 'Yuksalish EDU',
      short_name: 'Yuksalish EDU',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'uz',
      theme_color: '#4f46e5',
      background_color: '#ffffff',
    });
    expect(j.icons.map((i: { src: string }) => i.src)).toContain('/pwa-512x512.png');
    expect(j.shortcuts).toHaveLength(3);

    await request(app).put(API).set(bearer(root)).send({ appName: 'Zor', shortName: 'Zor' });
    await upload(root, await png());
    const j2 = JSON.parse((await request(app).get(`${API}/manifest.webmanifest`)).text);
    expect(j2.name).toBe('Zor');
    expect(j2.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
    expect(j2.icons.every((i: { src: string }) => i.src.startsWith('/api/v1/branding/logo/'))).toBe(
      true,
    );
  });
});

describe('branding: maktab logosi', () => {
  const sUp = (token: string, id: string, buf: Buffer) =>
    request(app)
      .post(`/api/v1/schools/${id}/logo`)
      .set(bearer(token))
      .attach('file', buf, { filename: 'l.png', contentType: 'image/png' });

  it('ruxsatlar va tenant izolyatsiyasi', async () => {
    const b = await png();
    expect((await sUp(admin, other.id, b)).status).toBe(403);
    expect((await sUp(admin, school.id, b)).status).toBe(200);
    expect((await sUp(root, other.id, b)).status).toBe(200);
    expect(
      (await request(app).delete(`/api/v1/schools/${school.id}/logo`).set(bearer(admin2))).status,
    ).toBe(403);
    // school_admin faqat o'z maktabini o'qiy oladi
    expect((await request(app).get(`/api/v1/schools/${school.id}`).set(bearer(admin))).status).toBe(
      200,
    );
    expect((await request(app).get(`/api/v1/schools/${other.id}`).set(bearer(admin))).status).toBe(
      403,
    );
    await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
    expect((await sUp((await login('tch')).token, school.id, b)).status).toBe(403);
  });

  it('DTO logoUrl, ochiq logo, ochirish, audit', async () => {
    const up = await sUp(admin, school.id, await png());
    expect(up.body.data.logoUrl).toMatch(
      new RegExp(`^/api/v1/branding/schools/${school.id}/logo\\?v=`),
    );
    const adminLogo = await getBin(up.body.data.logoUrl);
    expect(adminLogo.status).toBe(200);
    expect(adminLogo.headers['cache-control']).toContain('immutable');

    await request(app)
      .put('/api/v1/settings/public')
      .set(bearer(root))
      .send({ scope: 'school', schoolId: school.id, values: { enabled: true } });
    const cfg = await request(app).get('/api/v1/public/b1/config');
    expect(cfg.body.data.school.logoUrl).toMatch(/^\/api\/v1\/public\/schools\/b1\/logo\?v=/);
    const list = await request(app).get('/api/v1/public/schools');
    expect(list.body.data.find((s: { slug: string }) => s.slug === 'b1').logoUrl).toMatch(
      /^\/api\/v1\/public\/schools\/b1\/logo\?v=/,
    );
    const pub = await getBin(cfg.body.data.school.logoUrl);
    expect(pub.status).toBe(200);
    expect(pub.headers['content-type']).toBe('image/png');
    expect(pub.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const m = await sharp(pub.body as Buffer).metadata();
    expect(Math.max(m.width ?? 0, m.height ?? 0)).toBeLessThanOrEqual(512);
    expect((await request(app).get('/api/v1/public/schools/b2/logo')).status).toBe(404);

    const del = await request(app).delete(`/api/v1/schools/${school.id}/logo`).set(bearer(admin));
    expect(del.status).toBe(200);
    expect(del.body.data.logoUrl).toBeNull();
    expect((await request(app).get('/api/v1/public/schools/b1/logo')).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'school.logo_updated' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'school.logo_deleted' })).toBe(1);
  });

  it('exportLogo: maktab, keyin platforma, keyin null', async () => {
    expect(await brandingService.exportLogo(school.id)).toBeNull();
    await upload(root, await png());
    const plat = await brandingService.exportLogo(school.id);
    expect(plat).not.toBeNull();
    await sUp(admin, school.id, await png(400, 400));
    const own = await brandingService.exportLogo(school.id);
    expect(own).not.toBeNull();
    expect((own as Buffer).equals(plat as Buffer)).toBe(false);
  });
});

describe('branding: eksport hujjatlari', () => {
  const doc: TimetableDoc = {
    kind: 'class',
    title: '5-A',
    schoolName: 'Maktab',
    yearName: '2026',
    validity: '',
    draft: false,
    weekdays: [1, 2],
    rows: 2,
    cells: { '1:1': [{ subject: 'Matematika', detail: 'Aliyev A.', room: null }] },
    lessonCount: 1,
  };

  it('PDF va Excel logo bilan yaroqli', async () => {
    const logo = await sharp(await png())
      .resize(120)
      .png()
      .toBuffer();
    const pdf = await renderTimetablePdf([doc], logo);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const plain = await renderTimetablePdf([doc]);
    expect(pdf.length).toBeGreaterThan(plain.length);
    const xl = await renderTimetableExcel([doc], {}, logo);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl as never);
    const ws = wb.worksheets[0];
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.getCell('A1').value).toBe('Maktab');
    expect(ws.getCell('A2').value).toBe('Dars jadvali · 5-A');
  });
});
