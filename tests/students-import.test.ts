import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { ImportSession } from '../src/models/ImportSession';
import { Student } from '../src/models/Student';
import {
  ADMIN_PERMS,
  app,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStudent,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { HEADER, readXlsx, xlsxBuffer, XLSX_MIME } from './helpers/xlsx';

useTestDb();

let school: Awaited<ReturnType<typeof makeSchool>>;
let other: Awaited<ReturnType<typeof makeSchool>>;
let year: Awaited<ReturnType<typeof makeYear>>;
let c5: Awaited<ReturnType<typeof makeClass>>;
let c6: Awaited<ReturnType<typeof makeClass>>;
let token: string;

beforeEach(async () => {
  school = await makeSchool('a');
  other = await makeSchool('b');
  year = await makeYear(school.id);
  await makeUser({
    username: 'adm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: ADMIN_PERMS,
  });
  await makeUser({
    username: 'adm2',
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
  await makeUser({
    username: 'adm3',
    role: 'school_admin',
    schoolId: other.id,
    permissions: ADMIN_PERMS,
  });
  c5 = await makeClass(school.id, year.id, '5-A');
  c6 = await makeClass(school.id, year.id, '6-B');
  token = (await login('adm')).token;
});

const binary = (r: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (d: Buffer) => chunks.push(d));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

const preview = (
  t: string,
  file: Buffer,
  fields: Record<string, string> = {},
  name = 'students.xlsx',
  mime = XLSX_MIME,
) => {
  let req = request(app).post('/api/v1/students/import/preview').set(bearer(t));
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file, { filename: name, contentType: mime });
};
const confirm = (t: string, importId: string, onDuplicate = 'skip') =>
  request(app)
    .post('/api/v1/students/import/confirm')
    .set(bearer(t))
    .send({ importId, onDuplicate });

describe('Import: shablon', () => {
  it("shablon xlsx: aniq sarlavhalar, namuna qator va izoh varag'i", async () => {
    const res = await request(app)
      .get('/api/v1/students/import/template')
      .set(bearer(token))
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const rows = await readXlsx(res.body as Buffer);
    expect(rows[0]).toEqual(HEADER);
    expect(rows).toHaveLength(2);
  });
});

describe('Import: preview -> confirm', () => {
  it("to'liq oqim: to'g'ri/xato/dublikat qatorlar, DB ga yozilmaydi, confirm, ikkinchi confirm 409", async () => {
    await makeStudent(school.id, c5.id, 'Mavjud Bola', { studentCode: 'M-1' });
    const file = await xlsxBuffer([
      HEADER,
      ['Aliyev Vali', '5-A', '15.03.2013', 'Erkak', 'S-1', '+998901234567'], // 2 valid
      ['Karimova Dilnoza', '6b', new Date(Date.UTC(2012, 4, 20)), 'ayol', null, null], // 3 valid (sinf normalizatsiyasi)
      ['', '5-A', null, null, null, null], // 4 invalid: ism yo'q
      ['Sinfsiz Bola', '9-Z', null, null, null, null], // 5 invalid: sinf yo'q
      ["Noto'g'ri Sana", '5-A', '31.02.2013', 'x', null, 'abc'], // 6 invalid: 3 xato
      ['Mavjud Bola Boshqa', '5-A', null, null, 'M-1', null], // 7 duplicate (bazada, ID)
      ['Aliyev Vali', '5-A', '2013-03-15', 'M', null, null], // 8 duplicate (faylda 2-qator)
      ['=cmd|calc', '5-A', null, null, null, null], // 9 invalid: formula belgisi
      ['Excel Sana', '5-A', 41000, 'F', 'S-9', null], // 10 valid (serial sana)
    ]);

    const res = await preview(token, file);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.importId).toBeTruthy();
    expect(new Date(d.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(d.summary).toEqual({ total: 9, valid: 3, invalid: 4, duplicates: 2 });
    const byRow = (n: number) => d.rows.find((r: { row: number }) => r.row === n);
    expect(byRow(2)).toMatchObject({
      status: 'valid',
      resolvedClassId: c5.id,
      data: {
        fullName: 'Aliyev Vali',
        className: '5-A',
        birthDate: '2013-03-15',
        gender: 'male',
        studentCode: 'S-1',
        parentPhone: '+998901234567',
      },
      duplicateOfStudentId: null,
      errors: [],
    });
    expect(byRow(3)).toMatchObject({
      status: 'valid',
      resolvedClassId: c6.id,
      data: { birthDate: '2012-05-20', gender: 'female' },
    });
    expect(byRow(4).status).toBe('invalid');
    expect(byRow(5).errors[0]).toMatch(/Sinf topilmadi/);
    expect(byRow(6).errors).toHaveLength(3);
    expect(byRow(7)).toMatchObject({ status: 'duplicate' });
    expect(byRow(7).duplicateOfStudentId).toBeTruthy();
    expect(byRow(8)).toMatchObject({ status: 'duplicate', duplicateOfStudentId: null });
    expect(byRow(8).errors[0]).toMatch(/2-qator/);
    expect(byRow(9).status).toBe('invalid');
    expect(byRow(10)).toMatchObject({
      status: 'valid',
      data: { birthDate: '2012-04-01', gender: 'female' },
    });

    // Preview DB ga o'quvchi yozmaydi, sessiya saqlanadi
    expect(await Student.countDocuments({ schoolId: school.id })).toBe(1);
    expect(await ImportSession.countDocuments()).toBe(1);

    const errs = await request(app)
      .get(`/api/v1/students/import/${d.importId}/errors`)
      .set(bearer(token))
      .buffer(true)
      .parse(binary);
    expect(errs.status).toBe(200);
    const errRows = await readXlsx(errs.body as Buffer);
    expect(errRows[0][errRows[0].length - 1]).toBe('Xato sababi');
    expect(errRows).toHaveLength(1 + 6);

    const done = await confirm(token, d.importId);
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({ created: 3, updated: 0, skipped: 2, failed: 4 });
    expect(await Student.countDocuments({ schoolId: school.id, isDeleted: false })).toBe(4);
    const created = await Student.findOne({ studentCode: 'S-1' });
    expect(created!.classHistory).toHaveLength(1);
    expect(created!.nameKey).toBe('aliyev vali');
    expect(await AuditLog.countDocuments({ action: 'students.import' })).toBe(1);

    const again = await confirm(token, d.importId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    expect(await Student.countDocuments({ schoolId: school.id })).toBe(4);
  });

  it('classId berilsa Sinf ustuni ixtiyoriy va barcha qatorlar shu sinfga yoziladi', async () => {
    const file = await xlsxBuffer([
      ['F.I.Sh.', "Tug'ilgan sana"],
      ['Bir Bola', '01.02.2014'],
      ['Ikki Bola', null],
    ]);
    const noClass = await preview(token, file);
    expect(noClass.status).toBe(400);

    const res = await preview(token, file, { classId: c6.id });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ valid: 2, invalid: 0 });
    expect(
      res.body.data.rows.every((r: { resolvedClassId: string }) => r.resolvedClassId === c6.id),
    ).toBe(true);
    const ok = await confirm(token, res.body.data.importId);
    expect(ok.body.data.created).toBe(2);
    expect((await Student.find({ classId: c6.id })).length).toBe(2);

    // Begona sinf -> 400
    const oy = await makeYear(other.id);
    const oc = await makeClass(other.id, oy.id, '5-A');
    expect((await preview(token, file, { classId: oc.id })).status).toBe(400);
  });

  it("sarlavhalar moslashuvchan (tartib, katta-kichik harf, bo'sh joy)", async () => {
    const file = await xlsxBuffer([
      [' ota-ona TELEFONI ', 'id', 'jinsi', 'sinf', 'f.i.sh.'],
      ['+998 90 111 22 33', 'Z-1', 'Erkak', '5-a', 'Teskari Tartib'],
    ]);
    const res = await preview(token, file);
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0]).toMatchObject({
      status: 'valid',
      data: {
        fullName: 'Teskari Tartib',
        studentCode: 'Z-1',
        gender: 'male',
        parentPhone: '+998 90 111 22 33',
      },
    });
  });

  it("onDuplicate='update': mavjud o'quvchi yangilanadi (sinf o'zgarmaydi); 'skip': o'tkaziladi", async () => {
    const existing = await makeStudent(school.id, c5.id, 'Eski Ism', { studentCode: 'U-1' });
    const file = await xlsxBuffer([
      HEADER,
      ['Yangi Ism', '6-B', '10.10.2012', 'Ayol', 'U-1', '+998909998877'],
    ]);

    const skip = await preview(token, file);
    expect(skip.body.data.rows[0].status).toBe('duplicate');
    expect((await confirm(token, skip.body.data.importId, 'skip')).body.data).toEqual({
      created: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
    });
    expect((await Student.findById(existing.id))!.fullName).toBe('Eski Ism');

    const upd = await preview(token, file);
    const res = await confirm(token, upd.body.data.importId, 'update');
    expect(res.body.data).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
    const fresh = await Student.findById(existing.id);
    expect(fresh).toMatchObject({
      fullName: 'Yangi Ism',
      gender: 'female',
      parentPhone: '+998909998877',
    });
    expect(fresh!.nameKey).toBe('yangi ism');
    expect(String(fresh!.classId)).toBe(c5.id);
  });

  it('importId faqat shu maktab va shu foydalanuvchiniki (boshqasi 404)', async () => {
    const file = await xlsxBuffer([HEADER, ['Ali Valiyev', '5-A', null, null, null, null]]);
    const res = await preview(token, file);
    const id = res.body.data.importId;

    expect((await confirm((await login('adm2')).token, id)).status).toBe(404);
    expect((await confirm((await login('adm3')).token, id)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/v1/students/import/${id}/errors`)
          .set(bearer((await login('adm2')).token))
      ).status,
    ).toBe(404);
    expect((await confirm(token, 'bad-id')).status).toBe(404);
    expect((await confirm(token, '64b64b64b64b64b64b64b64b')).status).toBe(404);
    // Muddati o'tgan sessiya
    await ImportSession.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await confirm(token, id)).status).toBe(404);
    expect(await Student.countDocuments()).toBe(0);
  });

  it("ruxsat: students.manage kerak; boshqa maktab sinfi nomi bilan bog'lanmaydi", async () => {
    const file = await xlsxBuffer([HEADER, ['Ali Valiyev', '5-A', null, null, null, null]]);
    expect((await preview((await login('viewer')).token, file)).status).toBe(403);
    expect(
      (await request(app).post('/api/v1/students/import/preview').attach('file', file, 'a.xlsx'))
        .status,
    ).toBe(401);

    // Boshqa maktabda "5-A" bor, lekin faol yili yo'q -> 400; yili bor bo'lsa ham o'z sinflari bo'yicha ishlaydi
    const t3 = (await login('adm3')).token;
    expect((await preview(t3, file)).status).toBe(400);
    const oy = await makeYear(other.id);
    await makeClass(other.id, oy.id, '5-A');
    const r = await preview(t3, file);
    expect(r.body.data.rows[0].resolvedClassId).not.toBe(c5.id);
  });
});

describe('Import: fayl xavfsizligi', () => {
  it("xlsx bo'lmagan kengaytma / MIME / sodda ZIP-siz kontent rad etiladi", async () => {
    const good = await xlsxBuffer([HEADER, ['Ali Valiyev', '5-A', null, null, null, null]]);
    expect((await preview(token, good, {}, 'students.xls')).status).toBe(400);
    expect((await preview(token, good, {}, 'students.xlsx', 'text/csv')).status).toBe(400);
    expect(
      (await preview(token, Buffer.from('F.I.Sh.,Sinf\nAli,5-A'), {}, 'students.xlsx')).status,
    ).toBe(400);
    // ZIP imzosi bor, lekin xlsx emas
    const fakeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);
    expect((await preview(token, fakeZip)).status).toBe(400);
    expect(
      (await request(app).post('/api/v1/students/import/preview').set(bearer(token))).status,
    ).toBe(400);
  });

  it('5 MB dan katta fayl rad etiladi', async () => {
    const big = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(5 * 1024 * 1024 + 10, 0),
    ]);
    const res = await preview(token, big);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/5 MB/);
  });

  it("1000 tadan ko'p qator rad etiladi; ustunsiz fayl rad etiladi", async () => {
    const rows: unknown[][] = [HEADER];
    for (let i = 0; i < 1001; i++) rows.push([`Bola Nomer${i}`, '5-A', null, null, null, null]);
    const many = await preview(token, await xlsxBuffer(rows));
    expect(many.status).toBe(400);
    expect(many.body.error.message).toMatch(/1000/);

    const noName = await preview(token, await xlsxBuffer([['Boshqa'], ['x']]));
    expect(noName.status).toBe(400);
    const empty = await preview(token, await xlsxBuffer([HEADER]));
    expect(empty.status).toBe(400);
  });

  it('1000 qatorli fayl qabul qilinadi va samarali saqlanadi', async () => {
    const rows: unknown[][] = [HEADER];
    for (let i = 0; i < 1000; i++)
      rows.push([`Bola Nomer${i}`, i % 2 ? '5-A' : '6-B', null, null, `ID-${i}`, null]);
    const res = await preview(token, await xlsxBuffer(rows));
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ total: 1000, valid: 1000 });
    const done = await confirm(token, res.body.data.importId);
    expect(done.body.data).toEqual({ created: 1000, updated: 0, skipped: 0, failed: 0 });
  });

  it("formula hujayralari bajarilmaydi — faqat saqlangan natija o'qiladi", async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(HEADER);
    ws.addRow([
      { formula: 'CONCATENATE("Ali"," Valiyev")', result: 'Ali Valiyev' },
      '5-A',
      null,
      null,
      null,
      null,
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await preview(token, buf);
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].data.fullName).toBe('Ali Valiyev');
  });
});
