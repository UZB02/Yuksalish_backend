import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { User } from '../../models/User';
import { escapeRegex } from '../../utils/helpers';
import { cleanText } from '../../utils/text';
import { passwordSchema, usernameSchema } from '../../core/validators';
import { auditService } from '../audit/audit.service';
import { assertSafeXlsx, asText } from '../students/students.excel';
import { userManagement } from '../users/user-management.service';
import {
  assignGeneratedLogins,
  baseLoginOf,
  defaultPasswordFor,
  normalizePhone,
  personKey,
  slugWord,
  splitName,
  type GenInput,
} from './teachers-import.logic';
import { parseTeachersSheet, type RawTeacherRow } from './teachers.excel';

export type ImportStatus = 'create' | 'skip_existing' | 'error';

export interface TeacherImportRow {
  rowNo: number;
  fullName: string;
  phone: string | null;
  login: string | null;
  loginGenerated: boolean;
  passwordGenerated: boolean;
  status: ImportStatus;
  messages: string[];
  /** Faqat status=create bo'lgan qatorlar uchun (saqlanmaydi, faqat javobda) */
  password: string | null;
}

interface Work extends TeacherImportRow {
  idx: number;
  providedLogin: string;
  providedPassword: string;
  base: string | null;
  surnameSlug: string;
}

const CONCURRENCY = 4;

const err = (w: Work, msg: string) => {
  w.status = 'error';
  w.messages.push(msg);
};

/** Faylni tahlil qilib, har bir qator uchun qaror chiqaradi (DB'ga yozmaydi) */
async function analyze(schoolId: string, buffer: Buffer): Promise<TeacherImportRow[]> {
  await assertSafeXlsx(buffer);
  const raw: RawTeacherRow[] = await parseTeachersSheet(buffer);

  const works: Work[] = raw.map((r, idx) => {
    const fullName = asText(r.cells.fullName, 150);
    const phoneText = asText(r.cells.phone, 40);
    const w: Work = {
      idx,
      rowNo: r.row,
      fullName,
      phone: null,
      login: null,
      loginGenerated: false,
      passwordGenerated: false,
      status: 'create',
      messages: [],
      password: null,
      providedLogin: asText(r.cells.login, 80).toLowerCase(),
      providedPassword: r.cells.password === null ? '' : String(r.cells.password).trim(),
      base: null,
      surnameSlug: '',
    };

    if (fullName.length < 2) err(w, 'F.I.Sh. kiritilmagan yoki juda qisqa');
    else if (fullName.length > 100) err(w, 'F.I.Sh. 100 belgidan oshmasligi kerak');
    else if (/^[=+\-@]/.test(fullName)) err(w, "F.I.Sh. noto'g'ri belgi bilan boshlanadi");

    // Telefon: noto'g'ri bo'lsa ogohlantirish — o'qituvchi telefonsiz yaratiladi
    if (phoneText) {
      const p = normalizePhone(phoneText);
      if (p.error) w.messages.push(`${p.error} — telefon qo'shilmaydi`);
      else w.phone = p.value;
    }
    return w;
  });

  // Fayl ichida bir xil odam (F.I.Sh.) takrorlangan bo'lsa
  const seenPerson = new Map<string, number>();
  for (const w of works) {
    if (w.status === 'error') continue;
    const key = personKey(w.fullName);
    const first = seenPerson.get(key);
    if (first !== undefined) err(w, `Faylda ${first}-qator bilan takrorlangan (bir xil F.I.Sh.)`);
    else seenPerson.set(key, w.rowNo);
  }

  // Bazadagi shu maktab o'qituvchilari (bir xil odam = maktab + F.I.Sh.)
  const teachers = await User.find({ schoolId, role: 'teacher' }).select('fullName username');
  const teacherByPerson = new Map<string, string>();
  for (const t of teachers) {
    const k = personKey(t.fullName);
    if (!teacherByPerson.has(k)) teacherByPerson.set(k, t.username);
  }
  for (const w of works) {
    if (w.status !== 'create') continue;
    const existing = teacherByPerson.get(personKey(w.fullName));
    if (existing) {
      w.status = 'skip_existing';
      w.login = existing;
      w.messages.push("Allaqachon mavjud — o'tkaziladi");
    }
  }

  // Kiritilgan loginlar
  const providedSeen = new Map<string, number>();
  for (const w of works) {
    if (w.status !== 'create' || !w.providedLogin) continue;
    const parsed = usernameSchema.safeParse(w.providedLogin);
    if (!parsed.success) {
      err(w, "Login noto'g'ri: 3–32 ta belgi, faqat lotin harflari, raqam va . _ -");
      continue;
    }
    w.providedLogin = parsed.data;
    const first = providedSeen.get(parsed.data);
    if (first !== undefined) err(w, `Login faylda ${first}-qatorda ham bor: ${parsed.data}`);
    else providedSeen.set(parsed.data, w.rowNo);
  }

  // Generatsiya uchun nomzodlar
  const gen: Work[] = [];
  for (const w of works) {
    if (w.status !== 'create' || w.providedLogin) continue;
    const parts = splitName(w.fullName);
    w.base = baseLoginOf(w.fullName);
    w.surnameSlug = slugWord(parts.surname);
    if (!w.base) {
      err(
        w,
        "Loginni avtomatik yaratib bo'lmadi (ism lotin harflarida emas) — Login ustunini to'ldiring",
      );
      continue;
    }
    if (parts.singleWord)
      w.messages.push("F.I.Sh. bitta so'zdan iborat — login shu so'zdan olindi");
    gen.push(w);
  }

  // Bazadagi to'qnashuvlar: nomzod loginlar prefiksi va kiritilgan loginlar
  const prefixes = [...new Set(gen.map((w) => w.base as string))];
  const orClauses: Record<string, unknown>[] = [];
  if (prefixes.length) {
    orClauses.push({ username: new RegExp(`^(${prefixes.map(escapeRegex).join('|')})(\\.|$)`) });
  }
  const provided = [...providedSeen.keys()];
  if (provided.length) orClauses.push({ username: { $in: provided } });
  const dbUsers = orClauses.length ? await User.find({ $or: orClauses }).select('username') : [];
  const dbNames = new Set(dbUsers.map((u) => u.username));

  // Kiritilgan login bazada band (boshqa odam) — xato; yaroqlilar band qilinadi
  const used = new Set<string>();
  for (const w of works) {
    if (w.status !== 'create' || !w.providedLogin) continue;
    if (dbNames.has(w.providedLogin))
      err(w, `Bu login boshqa foydalanuvchida band: ${w.providedLogin}`);
    else {
      w.login = w.providedLogin;
      used.add(w.providedLogin);
    }
  }

  const inputs: GenInput[] = gen.map((w) => ({
    idx: w.idx,
    base: w.base as string,
    surnameSlug: w.surnameSlug,
  }));
  const assigned = assignGeneratedLogins(inputs, {
    used,
    dbState: (login) => (dbNames.has(login) ? 'other' : 'free'),
  });
  for (const w of gen) {
    const a = assigned.get(w.idx);
    if (!a) {
      err(w, "Bo'sh login topilmadi — Login ustunini to'ldiring");
      continue;
    }
    w.login = a.login;
    w.loginGenerated = true;
    if (a.dupInFile) {
      w.messages.push(`Ismi takrorlangani uchun login ajratildi: ${a.login}`);
    }
    if (a.dbCollision) {
      w.messages.push(`Asosiy login bazada boshqa foydalanuvchida band — ${a.login} berildi`);
    }
  }

  // Parol
  for (const w of works) {
    if (w.status !== 'create' || !w.login) continue;
    let pwd = w.providedPassword;
    if (!pwd) {
      pwd = defaultPasswordFor(w.login);
      w.passwordGenerated = true;
    }
    const ok = passwordSchema.safeParse(pwd);
    if (!ok.success) {
      err(
        w,
        w.passwordGenerated
          ? "Avtomatik parol yaroqsiz (kamida bitta harf kerak) — Parol ustunini to'ldiring"
          : "Parol yaroqsiz: kamida 8 ta belgi, harf va raqam bo'lishi kerak",
      );
      continue;
    }
    w.password = pwd;
  }

  return works
    .sort((a, b) => a.rowNo - b.rowNo)
    .map(
      ({
        idx: _i,
        providedLogin: _l,
        providedPassword: _p,
        base: _b,
        surnameSlug: _s,
        ...row
      }) => ({
        ...row,
        password: row.status === 'create' ? row.password : null,
        messages: row.messages.map(cleanText),
      }),
    );
}

const summarize = (rows: TeacherImportRow[]) => ({
  total: rows.length,
  create: rows.filter((r) => r.status === 'create').length,
  skipExisting: rows.filter((r) => r.status === 'skip_existing').length,
  error: rows.filter((r) => r.status === 'error').length,
});

export interface ImportResultRow {
  rowNo: number;
  fullName: string;
  phone: string | null;
  login: string | null;
  /** Faqat yaratilgan qatorlar uchun */
  password: string | null;
  status: 'created' | 'skipped' | 'failed';
  message: string | null;
}

export const teachersImportService = {
  async preview(schoolId: string, file: { buffer: Buffer }) {
    const rows = await analyze(schoolId, file.buffer);
    return { summary: summarize(rows), rows };
  },

  /**
   * Faylni qayta tahlil qiladi (mijoz yuborgan qiymatlarga ishonilmaydi) va `create`
   * qatorlarini yaratadi. Parollar hech qayerda saqlanmaydi: faqat javobda qaytariladi.
   */
  async confirm(ctx: Ctx, schoolId: string, file: { buffer: Buffer; originalname: string }) {
    const rows = await analyze(schoolId, file.buffer);
    const results = new Map<number, ImportResultRow>();
    const base = (r: TeacherImportRow) => ({
      rowNo: r.rowNo,
      fullName: r.fullName,
      phone: r.phone,
      login: r.login,
    });

    const toCreate: TeacherImportRow[] = [];
    for (const r of rows) {
      if (r.status === 'skip_existing') {
        results.set(r.rowNo, {
          ...base(r),
          password: null,
          status: 'skipped',
          message: "Allaqachon mavjud — o'tkazildi",
        });
      } else if (r.status === 'error') {
        results.set(r.rowNo, {
          ...base(r),
          password: null,
          status: 'failed',
          message: r.messages.join('; '),
        });
      } else toCreate.push(r);
    }

    const createOne = async (r: TeacherImportRow) => {
      try {
        await userManagement.create(ctx, {
          role: 'teacher',
          schoolId,
          fullName: r.fullName,
          username: r.login as string,
          password: r.password as string,
          phone: r.phone,
          permissions: [],
        });
        results.set(r.rowNo, {
          ...base(r),
          password: r.password,
          status: 'created',
          message: null,
        });
      } catch (e) {
        const message =
          e instanceof AppError ? e.message : "Kutilmagan xato — o'qituvchi yaratilmadi";
        results.set(r.rowNo, { ...base(r), password: null, status: 'failed', message });
      }
    };
    for (let i = 0; i < toCreate.length; i += CONCURRENCY) {
      await Promise.all(toCreate.slice(i, i + CONCURRENCY).map(createOne));
    }

    const ordered = rows.map((r) => results.get(r.rowNo) as ImportResultRow);
    const count = (s: ImportResultRow['status']) => ordered.filter((r) => r.status === s).length;
    const summary = {
      total: ordered.length,
      created: count('created'),
      skipped: count('skipped'),
      failed: count('failed'),
    };
    await auditService.log({
      userId: ctx.actor.id,
      schoolId,
      action: 'teachers.import',
      entity: 'user',
      after: { ...summary, fileName: file.originalname.slice(0, 200) },
      ip: ctx.ip,
    });
    return { summary, results: ordered };
  },
};
