import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { User } from '../src/models/User';
import {
  assignGeneratedLogins,
  baseLoginOf,
  defaultPasswordFor,
  loginCandidate,
  normalizePhone,
} from '../src/modules/teachers/teachers-import.logic';
import { comparePassword } from '../src/utils/password';
import { ADMIN_PERMS, app, bearer, login, makeSchool, makeUser, useTestDb } from './helpers';
import { readXlsx, xlsxBuffer, XLSX_MIME } from './helpers/xlsx';

useTestDb();

describe('teachers-import: sof qoidalar', () => {
  it('telefon normalizatsiyasi', () => {
    expect(normalizePhone('93 944 00 89').value).toBe('+998 93 944 00 89');
    expect(normalizePhone('939440089').value).toBe('+998 93 944 00 89');
    expect(normalizePhone('+998939440089').value).toBe('+998 93 944 00 89');
    expect(normalizePhone('998 (93) 944-00-89').value).toBe('+998 93 944 00 89');
    expect(normalizePhone('093 944 00 89').value).toBe('+998 93 944 00 89');
    expect(normalizePhone('+7 912 345 67 89').value).toBe('+79123456789');
    expect(normalizePhone('').value).toBeNull();
    expect(normalizePhone('12345').error).toBeTruthy();
    expect(normalizePhone('abc').error).toBeTruthy();
  });

  it('bazaviy login: 2-so`z, apostroflar, lotin bo`lmagan belgilar', () => {
    expect(baseLoginOf('Raxmanova Zilola Shuxrat qizi')).toBe('zilola');
    expect(baseLoginOf('Yo`ldosheva O’g’ilhon Akbar qizi')).toBe('ogilhon');
    expect(baseLoginOf('Eshmatov Navro’zbek Akmal')).toBe('navrozbek');
    expect(baseLoginOf('Karimov Ma‘murbek')).toBe('mamurbek');
    expect(baseLoginOf("Karimov Ma'murbek")).toBe('mamurbek');
    expect(baseLoginOf('Karimov Maʻmurbek')).toBe('mamurbek');
    expect(baseLoginOf('Ахмедов Алишер')).toBeNull();
    expect(baseLoginOf('Aliyev Al')).toBeNull();
  });

  it('parol: login nuqtasiz + 12345', () => {
    expect(defaultPasswordFor('umida')).toBe('umida12345');
    expect(defaultPasswordFor('sardorbek.j')).toBe('sardorbekj12345');
  });

  const free = { used: new Set<string>(), dbState: () => 'free' as const };

  it('fayl ichida takror ism: HAMMASI .bosh harf oladi; yakka — oddiy', () => {
    const r = assignGeneratedLogins(
      [
        { idx: 0, base: 'sardorbek', surnameSlug: 'jumayev' },
        { idx: 1, base: 'sardorbek', surnameSlug: 'rahimov' },
        { idx: 2, base: 'sardorbek', surnameSlug: 'xolmatov' },
        { idx: 3, base: 'umida', surnameSlug: 'karimova' },
      ],
      free,
    );
    expect([0, 1, 2, 3].map((i) => r.get(i)?.login)).toEqual([
      'sardorbek.j',
      'sardorbek.r',
      'sardorbek.x',
      'umida',
    ]);
  });

  it('bosh harf ham to`qnashsa: to`qnashganlar ko`proq harf, oxirida raqam', () => {
    const r = assignGeneratedLogins(
      [
        { idx: 0, base: 'ali', surnameSlug: 'rahimov' },
        { idx: 1, base: 'ali', surnameSlug: 'rasulov' },
        { idx: 2, base: 'ali', surnameSlug: 'rasulov' },
        { idx: 3, base: 'ali', surnameSlug: 'karimov' },
      ],
      free,
    );
    expect(r.get(3)?.login).toBe('ali.k');
    expect(r.get(0)?.login).toBe('ali.rah');
    // aynan bir xil familiya: raqamli qo'shimchagacha ketadi, baribir noyob
    const all = [0, 1, 2, 3].map((i) => r.get(i)?.login);
    expect(new Set(all).size).toBe(4);
    expect(all.every(Boolean)).toBe(true);
  });

  it('bazadagi boshqa odam bilan to`qnashuv va band logindan o`tish', () => {
    const r = assignGeneratedLogins([{ idx: 0, base: 'umida', surnameSlug: 'saidova' }], {
      used: new Set(['umida.s']),
      dbState: (l) => (l === 'umida' ? 'other' : 'free'),
    });
    expect(r.get(0)).toMatchObject({ login: 'umida.sa', dbCollision: true });
    expect(loginCandidate('a', 'bc', 5)).toBe('a.bc4');
  });
});

// ---- Integratsiya ----

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let token: string;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'viewer',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ['students.view'],
  });
  await makeUser({ username: 'tch', role: 'teacher', schoolId: school.id });
  await makeUser({ username: 'root', role: 'superadmin' });
  token = (await login('adm')).token;
});

const HDR = ['T/r', 'O’qituvchining ismi va familiyasi', 'Telefon', 'Login', 'Parol'];

/** Egasining ro'yxati shakli: dastlabki 5 qator login/parol bilan (Excel qatori = indeks + 1) */
const ownerRows = (): unknown[][] => [
  HDR,
  [1, 'Raxmanova Zilola Shuxrat qizi', '93 944 00 89', 'zilola.r', 'Zilola2024'], // 2
  [2, 'Karimov Alisher Bahodir o‘g‘li', 939440011, 'alisher', 'Alisher77'], // 3
  [3, 'Toshpulatova Dilnoza Karim qizi', '+998 90 111 22 33', 'dilnoza', null], // 4
  [4, 'Ergasheva Malika Rustam qizi', null, 'malika_e', 'Malika!99'], // 5
  [5, 'Usmonov Bobur Anvar o‘g‘li', '97 777 77 77', 'bobur', 'Bobur12345'], // 6
  [6, 'Mamatova Zilola Karim qizi', '91 234 56 78', null, null], // 7
  [7, 'Jumayev Sardorbek Aziz o‘g‘li', '90 000 00 01', null, null], // 8
  [8, 'Rahimov Sardorbek Ali o‘g‘li', null, null, null], // 9
  [9, 'Xolmatov Sardorbek Hasan o‘g‘li', '', null, null], // 10
  [10, 'Yo‘ldoshev O’g’ilhon Akmal o‘g‘li', null, null, null], // 11
  [11, 'Eshmatova Navro’zbek Ali', null, null, null], // 12
  [12, 'Saidova Umida Karim qizi', 'xato-tel', null, null], // 13
  [13, 'Nurmatov Ma’murbek Olim', null, null, null], // 14
];

const file = (buf: Buffer, name = 'oqituvchilar.xlsx', mime = XLSX_MIME) => ({ buf, name, mime });
const post = (
  path: string,
  t: string,
  f: ReturnType<typeof file>,
  headers: Record<string, string> = {},
) => {
  let req = request(app).post(`/api/v1/teachers/import/${path}`).set(bearer(t));
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.attach('file', f.buf, { filename: f.name, contentType: f.mime });
};
type Row = {
  rowNo: number;
  login: string;
  phone: string | null;
  status: string;
  loginGenerated: boolean;
  passwordGenerated: boolean;
  password: string | null;
  messages: string[];
};
const byNo = (rows: Row[], n: number) => rows.find((r) => r.rowNo === n) as Row;

describe('Teachers import: shablon va ruxsat', () => {
  it('shablon yuklanadi; ruxsatsiz 403', async () => {
    const res = await request(app)
      .get('/api/v1/teachers/import/template')
      .set(bearer(token))
      .buffer(true)
      .parse((r, cb) => {
        const ch: Buffer[] = [];
        r.on('data', (d: Buffer) => ch.push(d));
        r.on('end', () => cb(null, Buffer.concat(ch)));
      });
    expect(res.status).toBe(200);
    const rows = await readXlsx(res.body as Buffer);
    expect(rows[0]).toEqual(['T/r', 'F.I.Sh.', 'Telefon', 'Login', 'Parol']);

    const v = (await login('viewer')).token;
    const buf = await xlsxBuffer(ownerRows());
    expect((await post('preview', v, file(buf))).status).toBe(403);
    expect((await post('confirm', v, file(buf))).status).toBe(403);
    const t = (await login('tch')).token;
    expect((await post('preview', t, file(buf))).status).toBe(403);
    expect((await request(app).post('/api/v1/teachers/import/preview')).status).toBe(401);
  });
});

describe('Teachers import: preview', () => {
  it('egasining ro`yxati: loginlar, parollar, telefon, statuslar; DB ga yozilmaydi', async () => {
    const before = await User.countDocuments();
    const res = await post('preview', token, file(await xlsxBuffer(ownerRows())));
    expect(res.status).toBe(200);
    const { rows, summary } = res.body.data as { rows: Row[]; summary: Record<string, number> };
    expect(summary).toEqual({ total: 13, create: 13, skipExisting: 0, error: 0 });
    expect(await User.countDocuments()).toBe(before);

    expect(byNo(rows, 2)).toMatchObject({
      login: 'zilola.r',
      phone: '+998 93 944 00 89',
      loginGenerated: false,
      passwordGenerated: false,
      password: 'Zilola2024',
      status: 'create',
    });
    expect(byNo(rows, 3).phone).toBe('+998 93 944 00 11');
    expect(byNo(rows, 4)).toMatchObject({
      login: 'dilnoza',
      password: 'dilnoza12345',
      passwordGenerated: true,
    });
    expect(byNo(rows, 5).login).toBe('malika_e');
    // Mamatova Zilola: yakka generatsiya (zilola.r kiritilgan) -> zilola
    expect(byNo(rows, 7)).toMatchObject({
      login: 'zilola',
      loginGenerated: true,
      password: 'zilola12345',
    });
    // 3 ta Sardorbek
    expect([8, 9, 10].map((n) => byNo(rows, n).login)).toEqual([
      'sardorbek.j',
      'sardorbek.r',
      'sardorbek.x',
    ]);
    expect(byNo(rows, 8).password).toBe('sardorbekj12345');
    expect(byNo(rows, 8).messages.join()).toMatch(/takrorlangani/);
    // apostroflar
    expect(byNo(rows, 11).login).toBe('ogilhon');
    expect(byNo(rows, 12).login).toBe('navrozbek');
    expect(byNo(rows, 14).login).toBe('mamurbek');
    // noto'g'ri telefon: ogohlantirish, qator yaratiladi
    expect(byNo(rows, 13)).toMatchObject({ phone: null, status: 'create', login: 'umida' });
    expect(byNo(rows, 13).messages.join()).toMatch(/Telefon/);
  });

  it('ikki Zilola (ikkalasi generatsiya): zilola.r va zilola.m', async () => {
    const buf = await xlsxBuffer([
      HDR,
      [1, 'Raxmanova Zilola Shuxrat qizi', null, null, null],
      [2, 'Mamatova Zilola Karim qizi', null, null, null],
    ]);
    const { rows } = (await post('preview', token, file(buf))).body.data as { rows: Row[] };
    expect(rows.map((r) => r.login)).toEqual(['zilola.r', 'zilola.m']);
  });

  it('sarlavha variantlari: F.I.Sh., Ism familiya, apostrof/registr/bo`shliq', async () => {
    const heads = [
      'F.I.Sh.',
      'Ism familiya',
      '  O‘QITUVCHINING  ISMI VA FAMILIYASI ',
      "O'qituvchi F.I.Sh",
      'FIO',
    ];
    for (const h of heads) {
      const buf = await xlsxBuffer([
        [h, 'TELEFON', ' login ', 'PAROL'],
        ['Aliyev Vali Karim', '901234567', 'vali', 'Vali12345'],
      ]);
      const res = await post('preview', token, file(buf));
      expect(res.status, h).toBe(200);
      expect(res.body.data.rows[0]).toMatchObject({ login: 'vali', phone: '+998 90 123 45 67' });
    }
    const noName = await xlsxBuffer([
      ['Telefon', 'Login'],
      ['90', 'x'],
    ]);
    expect((await post('preview', token, file(noName))).status).toBe(400);
  });

  it('bazadagi o`sha odam: o`tkaziladi; boshqa odam bilan to`qnashuv va yaroqsiz kiritmalar', async () => {
    await makeUser({ username: 'umida', role: 'teacher', schoolId: other.id }); // global login band
    await User.create({
      username: 'bobur',
      fullName: 'Karimov Bobur Ali',
      role: 'teacher',
      schoolId: school.id,
      passwordHash: 'x',
    });
    await User.create({
      username: 'zz',
      fullName: 'Raxmanova  Zilola   Shuxrat qizi',
      role: 'teacher',
      schoolId: school.id,
      passwordHash: 'x',
    });
    const buf = await xlsxBuffer([
      HDR,
      [1, 'Saidova Umida Karim qizi', null, null, null], // 2: umida band -> umida.s
      [2, 'Usmonov Bobur Anvar', null, 'bobur', null], // 3: kiritilgan login band (boshqa odam)
      [3, 'Raxmanova Zilola Shuxrat qizi', null, null, null], // 4: o'sha odam
      [4, 'Karimov Bobur Ali', null, null, null], // 5: o'sha odam
      [5, 'Soliyev Hamid Aka', null, 'ha', null], // 6: login qisqa
      [6, 'Soliyev Karim Aka', null, 'Karim Bek', null], // 7: yaroqsiz belgi
      [7, 'Soliyev Nodir Aka', null, 'nodir', 'qisqa1'], // 8: parol qisqa
      [8, 'Soliyev Sanjar Aka', null, 'sanjar', '12345678'], // 9: harf yo'q
      [9, 'Soliyev Orif Aka', null, 'orif', 'Orif12345'], // 10
      [10, 'Qodirov Sherzod Aka', null, 'orif', 'Orif12345'], // 11: faylda takror login
      [11, 'Soliyev Orif Aka', null, 'orif2', null], // 12: faylda takror odam
      [12, null, '90 123 45 67', null, null], // 13: ism yo'q
      [13, 'Ali', null, null, null], // 14: bitta so'z
    ]);
    const { rows, summary } = (await post('preview', token, file(buf))).body.data as {
      rows: Row[];
      summary: Record<string, number>;
    };
    expect(byNo(rows, 2)).toMatchObject({ login: 'umida.s', status: 'create' });
    expect(byNo(rows, 2).messages.join()).toMatch(/band/);
    expect(byNo(rows, 3).status).toBe('error');
    expect(byNo(rows, 3).messages.join()).toMatch(/band/);
    expect(byNo(rows, 4)).toMatchObject({ status: 'skip_existing', login: 'zz', password: null });
    expect(byNo(rows, 4).messages.join()).toMatch(/Allaqachon mavjud/);
    expect(byNo(rows, 5)).toMatchObject({ status: 'skip_existing', password: null });
    for (const n of [6, 7, 8, 9]) expect(byNo(rows, n).status, `qator ${n}`).toBe('error');
    expect(byNo(rows, 10).status).toBe('create');
    expect(byNo(rows, 11).status).toBe('error');
    expect(byNo(rows, 11).messages.join()).toMatch(/10-qatorda/);
    expect(byNo(rows, 12).status).toBe('error');
    expect(byNo(rows, 12).messages.join()).toMatch(/takrorlangan/);
    expect(byNo(rows, 13).status).toBe('error');
    expect(byNo(rows, 14)).toMatchObject({ login: 'ali', status: 'create' });
    expect(summary.skipExisting).toBe(2);
  });

  it('qator limiti, fayl turi va magic bytes', async () => {
    const mk = (n: number) => [
      HDR,
      ...Array.from({ length: n }, (_, i) => [i, `Fam${i} Ism${i} Ota`, null, null, null]),
    ];
    const res = await post('preview', token, file(await xlsxBuffer(mk(501))));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/500/);
    expect((await post('preview', token, file(await xlsxBuffer(mk(500))))).status).toBe(200);

    const csv = file(Buffer.from('a,b'), 'a.csv', 'text/csv');
    expect((await post('preview', token, csv)).status).toBe(400);
    const fake = file(Buffer.from('not zip at all'), 'a.xlsx');
    expect((await post('preview', token, fake)).status).toBe(400);
    const junk = file(Buffer.from('PK\u0003\u0004junk'), 'a.xlsx');
    expect((await post('preview', token, junk)).status).toBe(400);
    const none = await request(app).post('/api/v1/teachers/import/preview').set(bearer(token));
    expect(none.status).toBe(400);
  });
});

describe('Teachers import: confirm', () => {
  it('yaratadi: hashlangan parol, ruxsatlar, maktab, audit (parolsiz), qayta confirm — hammasi skip', async () => {
    const buf = await xlsxBuffer(ownerRows());
    const res = await post('confirm', token, file(buf));
    expect(res.status).toBe(200);
    const d = res.body.data as {
      summary: Record<string, number>;
      results: { rowNo: number; login: string; password: string | null; status: string }[];
    };
    expect(d.summary).toEqual({ total: 13, created: 13, skipped: 0, failed: 0 });
    const r8 = d.results.find((r) => r.rowNo === 8)!;
    expect(r8).toMatchObject({
      login: 'sardorbek.j',
      password: 'sardorbekj12345',
      status: 'created',
    });

    const u = await User.findOne({ username: 'sardorbek.j' }).select('+passwordHash');
    expect(u).toMatchObject({ role: 'teacher', isActive: true, permissions: [] });
    expect(String(u!.schoolId)).toBe(school.id);
    expect(u!.passwordHash).not.toContain('sardorbekj12345');
    expect(await comparePassword('sardorbekj12345', u!.passwordHash)).toBe(true);
    const z = await User.findOne({ username: 'zilola.r' }).select('+passwordHash');
    expect(await comparePassword('Zilola2024', z!.passwordHash)).toBe(true);
    expect(await User.countDocuments({ role: 'teacher', schoolId: school.id })).toBe(14);

    // yaratilgan o'qituvchi tizimga kira oladi
    expect((await login('umida', 'umida12345')).res.status).toBe(200);

    // audit: har bir o'qituvchi + bitta yig'ma, parolsiz
    expect(await AuditLog.countDocuments({ action: 'teacher.create' })).toBe(13);
    const sum = await AuditLog.findOne({ action: 'teachers.import' });
    expect(sum!.after).toMatchObject({ total: 13, created: 13, skipped: 0, failed: 0 });
    const logs = JSON.stringify(await AuditLog.find({}).lean());
    expect(logs).not.toMatch(/12345|Zilola2024|passwordHash|"password"/);

    // qayta yuklash: hammasi mavjud — o'tkaziladi
    const again = await post('confirm', token, file(buf));
    expect(again.body.data.summary).toEqual({ total: 13, created: 0, skipped: 13, failed: 0 });
    expect(again.body.data.results.every((r: { password: unknown }) => r.password === null)).toBe(
      true,
    );
    expect(await User.countDocuments({ role: 'teacher', schoolId: school.id })).toBe(14);
  });

  it('xato qatorlar yaratilmaydi, qolganlari yaratiladi', async () => {
    const buf = await xlsxBuffer([
      HDR,
      [1, 'Aliyev Vali Karim', null, 'vali', 'qisqa'],
      [2, 'Soliyev Nodir Aka', null, null, null],
    ]);
    const res = await post('confirm', token, file(buf));
    expect(res.body.data.summary).toEqual({ total: 2, created: 1, skipped: 0, failed: 1 });
    expect(await User.exists({ username: 'vali' })).toBeNull();
    expect(await User.exists({ username: 'nodir' })).toBeTruthy();
  });

  it('superadmin: X-School-Id majburiy va shu maktabga yoziladi', async () => {
    const root = (await login('root')).token;
    const buf = await xlsxBuffer([HDR, [1, 'Aliyev Vali Karim', null, null, null]]);
    expect((await post('confirm', root, file(buf))).status).toBe(400);
    const res = await post('confirm', root, file(buf), { 'X-School-Id': other.id });
    expect(res.status).toBe(200);
    const u = await User.findOne({ username: 'vali' });
    expect(String(u!.schoolId)).toBe(other.id);
  });

  it('maktab admini boshqa maktabga yoza olmaydi (o`z maktabiga yoziladi)', async () => {
    const buf = await xlsxBuffer([HDR, [1, 'Aliyev Vali Karim', null, null, null]]);
    await post('confirm', token, file(buf), { 'X-School-Id': other.id });
    const u = await User.findOne({ username: 'vali' });
    expect(String(u!.schoolId)).toBe(school.id);
  });
});

describe('Teachers import: login-parollar fayli', () => {
  it('so`rovdan xlsx yasaydi, hech narsa saqlamaydi; ruxsatsiz 403; bo`sh 400', async () => {
    const body = {
      rows: [
        {
          fullName: 'Aliyev Vali',
          phone: '+998 90 123 45 67',
          login: 'vali',
          password: 'vali12345',
          status: 'created',
        },
        {
          fullName: 'Mavjud Odam',
          phone: null,
          login: 'mavjud',
          password: null,
          status: 'skipped',
        },
      ],
    };
    const auditBefore = await AuditLog.countDocuments({});
    const usersBefore = await User.countDocuments({});
    const res = await request(app)
      .post('/api/v1/teachers/import/credentials')
      .set(bearer(token))
      .send(body)
      .buffer(true)
      .parse((r, cb) => {
        const ch: Buffer[] = [];
        r.on('data', (d: Buffer) => ch.push(d));
        r.on('end', () => cb(null, Buffer.concat(ch)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/login-parollar\.xlsx/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const rows = await readXlsx(res.body as Buffer);
    expect(rows[0]).toEqual(['F.I.Sh.', 'Telefon', 'Login', 'Parol', 'Holat']);
    expect(rows[1]).toEqual(['Aliyev Vali', '+998 90 123 45 67', 'vali', 'vali12345', 'Yaratildi']);
    expect(rows[2][4]).toBe("Mavjud — o'tkazildi");
    expect(await AuditLog.countDocuments({})).toBe(auditBefore);
    expect(await User.countDocuments({})).toBe(usersBefore);

    const v = (await login('viewer')).token;
    expect(
      (await request(app).post('/api/v1/teachers/import/credentials').set(bearer(v)).send(body))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/v1/teachers/import/credentials')
          .set(bearer(token))
          .send({ rows: [] })
      ).status,
    ).toBe(400);
  });
});
