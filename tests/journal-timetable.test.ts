import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { TimetableVersion } from '../src/models/TimetableVersion';
import { chunkDates, lessonLabel } from '../src/modules/journal/journal.export';
import type { AttendanceCategory } from '../src/modules/settings/attendance.settings';
import {
  ADMIN_PERMS,
  AttendanceRecord,
  SubjectGrade,
  app,
  assignSubject,
  bearer,
  login,
  makeClass,
  makeSchool,
  makeStatus,
  makeStudent,
  makeSubject,
  makeUser,
  makeYear,
  useTestDb,
} from './helpers';
import { readXlsx } from './helpers/xlsx';

useTestDb();

type Doc = { id: string; _id: Types.ObjectId };
let school: Doc, year: Doc;
let c8: Awaited<ReturnType<typeof makeClass>>;
let eng: Doc, math: Doc;
let a1: Doc, a2: Doc;
let tEng: Doc;
let adm: string;
let statuses: Record<AttendanceCategory, Doc>;

const entry = (weekday: number, lessonNo: number, subjectId: string, teacherId: string) => ({
  weekday,
  lessonNo,
  subjectId,
  teacherId,
  groupKey: null,
  room: null,
});
const version = (
  validFrom: string,
  entries: ReturnType<typeof entry>[],
  validTo: string | null = null,
) =>
  TimetableVersion.create({
    schoolId: school.id,
    academicYearId: year.id,
    classId: c8.id,
    status: 'active',
    validFrom,
    validTo,
    activatedAt: new Date(),
    entries,
  });
const grade = (s: Doc, date: string, value: number, lessonNo: number, subject = eng) =>
  SubjectGrade.create({
    schoolId: school.id,
    studentId: s.id,
    classId: c8.id,
    subjectId: subject.id,
    teacherId: tEng.id,
    academicYearId: year.id,
    value,
    date,
    lessonNo,
  });
const att = (
  s: Doc,
  date: string,
  cat: AttendanceCategory,
  lessonNo: number,
  subjectId: string | null,
) =>
  AttendanceRecord.create({
    schoolId: school.id,
    studentId: s.id,
    classId: c8.id,
    academicYearId: year.id,
    date,
    lessonNo,
    subjectId,
    statusId: statuses[cat].id,
    category: cat,
    markedBy: tEng.id,
    updatedBy: tEng.id,
  });
const grid = (from: string, to: string, subject = eng) =>
  request(app)
    .get(`/api/v1/journal/subject?classId=${c8.id}&subjectId=${subject.id}&from=${from}&to=${to}`)
    .set(bearer(adm));
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => parts.push(c));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  });
const keys = (d: { columns: { key: string }[] }) => d.columns.map((c) => c.key);

beforeEach(async () => {
  school = await makeSchool('jt');
  year = await makeYear(school.id);
  tEng = await makeUser({ username: 'teng', role: 'teacher', schoolId: school.id });
  await makeUser({
    username: 'jadm',
    role: 'school_admin',
    schoolId: school.id,
    permissions: [...ADMIN_PERMS, 'grades.create', 'grades.edit'],
  });
  eng = await makeSubject('Ingliz tili');
  math = await makeSubject('Matematika');
  statuses = {
    present: await makeStatus('Keldi', 'present'),
    late: await makeStatus('Kechikdi', 'late'),
    absent_excused: await makeStatus('Sababli', 'absent_excused'),
    absent_unexcused: await makeStatus('Sababsiz', 'absent_unexcused'),
  };
  c8 = await makeClass(school.id, year.id, '8-B');
  await assignSubject(school.id, c8, eng.id, tEng.id);
  a1 = await makeStudent(school.id, c8.id, 'Aliyev Ali');
  a2 = await makeStudent(school.id, c8.id, 'Valiyev Vali');
  adm = (await login('jadm')).token;
});

describe('Jurnal ustunlari: dars jadvali', () => {
  it('kunda ikki dars -> ikki ustun (date#lessonNo), har biri alohida baho; boshqa fan darslari chiqmaydi', async () => {
    await version('2026-10-01', [
      entry(3, 1, eng.id, tEng.id),
      entry(3, 2, math.id, tEng.id),
      entry(3, 3, eng.id, tEng.id),
    ]);
    await grade(a1, '2026-10-14', 5, 1);
    await grade(a1, '2026-10-14', 3, 3);
    await grade(a2, '2026-10-14', 4, 3);
    const r = await grid('2026-10-12', '2026-10-17');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(keys(d)).toEqual(['2026-10-14#1', '2026-10-14#3']);
    expect(d.columns[0]).toEqual({
      key: '2026-10-14#1',
      date: '2026-10-14',
      weekday: 3,
      lessonNo: 1,
      source: 'timetable',
      cancelled: false,
    });
    expect(d.cells[a1.id]['2026-10-14#1']).toMatchObject({ grade: 5 });
    expect(d.cells[a1.id]['2026-10-14#3']).toMatchObject({ grade: 3 });
    expect(d.cells[a2.id]['2026-10-14#1']).toBeUndefined();
    // yig'indilar: barcha baholar bo'yicha o'rtacha
    expect(d.summary.perStudent[a1.id]).toMatchObject({ avg: 4, count: 2 });
    expect(d.summary.perColumn['2026-10-14#1']).toEqual({ avg: 5, count: 1 });
    expect(d.summary.perColumn['2026-10-14#3']).toEqual({ avg: 3.5, count: 2 });
    expect(d.summary.classAvg).toBe(4);
    expect(d.summary.classCount).toBe(3);
    // matematika jurnalida faqat 2-dars
    expect(keys((await grid('2026-10-12', '2026-10-17', math)).body.data)).toEqual([
      '2026-10-14#2',
    ]);
  });

  it('versiya chegarasi: qamralmagan kunlar ish kuni ustuni, keyin darslar; versiya validTo dan keyin yana ish kunlari', async () => {
    // 10-12 (dush) dan 10-14 (chor) gacha jadval; 10-15 dan keyin jadval yo'q
    await version(
      '2026-10-12',
      [entry(1, 2, eng.id, tEng.id), entry(3, 1, eng.id, tEng.id), entry(3, 3, eng.id, tEng.id)],
      '2026-10-14',
    );
    const r = await grid('2026-10-09', '2026-10-16');
    expect(keys(r.body.data)).toEqual([
      '2026-10-09', // jadvaldan oldin: ish kuni
      '2026-10-10',
      '2026-10-12#2',
      '2026-10-14#1',
      '2026-10-14#3',
      '2026-10-15', // jadvaldan keyin: ish kuni
      '2026-10-16',
    ]);
    const src = r.body.data.columns.map((c: { source: string }) => c.source);
    expect(src).toEqual([
      'workday',
      'workday',
      'timetable',
      'timetable',
      'timetable',
      'workday',
      'workday',
    ]);
    expect(r.body.data.columns[0]).toMatchObject({ lessonNo: 0, date: '2026-10-09' });
  });

  it('jadvalsiz sinf: avvalgidek ish kunlari ustunlari (lessonNo 0)', async () => {
    const r = await grid('2026-10-12', '2026-10-14');
    expect(keys(r.body.data)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(r.body.data.columns.every((c: { lessonNo: number }) => c.lessonNo === 0)).toBe(true);
  });

  it('record ustuni: jadvalda ustuni yo`q baho yashirinmaydi (lessonNo 0 eski baho, jadvalda yo`q dars, yakshanba)', async () => {
    await version('2026-10-01', [entry(3, 1, eng.id, tEng.id)]);
    await grade(a1, '2026-10-14', 5, 1); // jadval ustuni
    await grade(a1, '2026-10-14', 4, 0); // eski kunlik baho
    await grade(a2, '2026-10-14', 3, 5); // jadvalda 5-dars yo'q
    await grade(a2, '2026-10-18', 2, 0); // yakshanba
    const r = await grid('2026-10-12', '2026-10-18');
    const d = r.body.data;
    expect(keys(d)).toEqual(['2026-10-14', '2026-10-14#1', '2026-10-14#5', '2026-10-18']);
    expect(d.columns.map((c: { source: string }) => c.source)).toEqual([
      'record',
      'timetable',
      'record',
      'record',
    ]);
    expect(d.cells[a1.id]['2026-10-14']).toMatchObject({ grade: 4 });
    expect(d.cells[a2.id]['2026-10-14#5']).toMatchObject({ grade: 3 });
    expect(d.cells[a2.id]['2026-10-18']).toMatchObject({ grade: 2 });
    expect(d.summary.perStudent[a1.id]).toMatchObject({ avg: 4.5, count: 2 });
    expect(d.summary.classCount).toBe(4);
  });

  it('davomat dars ustuniga: shu darsning yozuvi; kunlik yozuv hamma ustunda; eski fansiz yozuv — o`z yozuvi bo`lmaganda', async () => {
    await version('2026-10-01', [
      entry(3, 1, eng.id, tEng.id),
      entry(3, 3, eng.id, tEng.id),
      entry(5, 1, eng.id, tEng.id),
      entry(5, 2, eng.id, tEng.id),
    ]);
    // 10-14 (chorshanba): a1 1-darsda yo'q (N), 3-darsda keldi; a2 1-darsda sababli yo'q
    await att(a1, '2026-10-14', 'absent_unexcused', 1, eng.id);
    await att(a1, '2026-10-14', 'present', 3, eng.id);
    await att(a2, '2026-10-14', 'absent_excused', 1, eng.id);
    // 10-16 (juma): kunlik rejim yozuvi (lessonNo 0) a1 uchun — ikkala ustunda ko'rinadi
    await att(a1, '2026-10-16', 'absent_unexcused', 0, null);
    // 10-16: a2 uchun eski fansiz dars yozuvi — kun darajasida (o'z yozuvi yo'q)
    await att(a2, '2026-10-16', 'absent_excused', 2, null);
    // boshqa fan darsi yozuvi e'tiborga olinmaydi
    await att(a2, '2026-10-14', 'absent_unexcused', 3, math.id);

    const d = (await grid('2026-10-12', '2026-10-17')).body.data;
    expect(keys(d)).toEqual(['2026-10-14#1', '2026-10-14#3', '2026-10-16#1', '2026-10-16#2']);
    expect(d.cells[a1.id]['2026-10-14#1']).toEqual({ absence: 'N' });
    expect(d.cells[a1.id]['2026-10-14#3']).toBeUndefined();
    expect(d.cells[a2.id]['2026-10-14#1']).toEqual({ absence: 'B' });
    expect(d.cells[a2.id]['2026-10-14#3']).toBeUndefined();
    expect(d.cells[a1.id]['2026-10-16#1']).toEqual({ absence: 'N' });
    expect(d.cells[a1.id]['2026-10-16#2']).toEqual({ absence: 'N' });
    expect(d.cells[a2.id]['2026-10-16#1']).toEqual({ absence: 'B' });
    expect(d.cells[a2.id]['2026-10-16#2']).toEqual({ absence: 'B' });
    expect(d.summary.perStudent[a1.id]).toMatchObject({ absentN: 3, absentB: 0 });
    expect(d.summary.perStudent[a2.id]).toMatchObject({ absentN: 0, absentB: 3 });
  });
});

describe('Jurnal eksport: dars ustunlari', () => {
  it('xlsx: ikki qatorli sarlavha (sana / dars), 200', async () => {
    await version('2026-10-01', [entry(3, 1, eng.id, tEng.id), entry(3, 3, eng.id, tEng.id)]);
    await grade(a1, '2026-10-14', 5, 3);
    const res = await binary(
      request(app)
        .get(
          `/api/v1/journal/subject/export.xlsx?classId=${c8.id}&subjectId=${eng.id}&from=2026-10-12&to=2026-10-17`,
        )
        .set(bearer(adm)),
    );
    expect(res.status).toBe(200);
    const rows = await readXlsx(res.body as Buffer);
    const lessonRow = rows.find((r) => r.includes('1-d') && r.includes('3-d'));
    expect(lessonRow).toBeTruthy();
    const dayRow = rows[rows.indexOf(lessonRow as unknown[]) - 1];
    expect(dayRow.filter((c) => c === 14)).toHaveLength(2); // ikkala ustun ham 14-sana
    const studentRow = rows.find((r) => r.includes('Aliyev Ali')) as unknown[];
    expect(studentRow).toContain(5);
  });

  it('pdf: 200 va sahifalar soni ustunlar bo`yicha teng bo`laklarga mos', async () => {
    const all: ReturnType<typeof entry>[] = [];
    for (let wd = 1; wd <= 6; wd++)
      all.push(entry(wd, 1, eng.id, tEng.id), entry(wd, 2, eng.id, tEng.id));
    await version('2026-09-01', all);
    const q = `classId=${c8.id}&subjectId=${eng.id}&from=2026-09-01&to=2026-10-31`;
    const g = await request(app).get(`/api/v1/journal/subject?${q}`).set(bearer(adm));
    const chunks = chunkDates({ columns: g.body.data.columns });
    expect(g.body.data.columns.length).toBeGreaterThan(80);
    for (const c of chunks) expect(c.columns.length).toBeGreaterThan(5);
    const res = await binary(
      request(app).get(`/api/v1/journal/subject/export.pdf?${q}`).set(bearer(adm)),
    );
    expect(res.status).toBe(200);
    const raw = (res.body as Buffer).toString('latin1');
    expect(raw.startsWith('%PDF')).toBe(true);
    expect((raw.match(/\/Type \/Page(?!s)/g) ?? []).length).toBe(chunks.length);
  });

  it('lessonLabel: dars ustuni "3-d", ish kuni ustuni hafta kuni', () => {
    expect(lessonLabel({ lessonNo: 3, weekday: 3 })).toBe('3-d');
    expect(lessonLabel({ lessonNo: 0, weekday: 3 })).toBe('Cho');
  });
});
