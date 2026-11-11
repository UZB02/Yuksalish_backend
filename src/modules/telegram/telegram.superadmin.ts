import { logger } from '../../core/logger';
import { School } from '../../models/School';
import { User } from '../../models/User';
import { auditService } from '../audit/audit.service';
import type { BotReply, CallbackResult, IncomingCallback, InlineButton } from './telegram.client';
import { escapeHtml } from './telegram.format';

/** Superadmin uchun bot sozlamalari: rejali kunlik/haftalik hisobotlar qaysi maktab bo'yicha yuborilsin */

export const REPORT_SCOPE_ALL = 'all';
const PAGE_SIZE = 8;
const TITLE = "Kunlik va haftalik hisobotlar qaysi maktab bo'yicha yuborilsin?";
const NOT_SUPERADMIN = 'Bu bo‘lim faqat superadmin uchun.';
const NOT_LINKED =
  'Bu chat hisobga ulanmagan. Avval hisobingizni ulang: admin panelda profil sahifasidan havola oling (yordam: /help).';

/**
 * Callback data (<= 64 bayt):
 *   rs:p:<sahifa>            sahifa almashtirish
 *   rs:a:<sahifa>            barcha maktablar
 *   rs:o:<sahifa>            o'chirish
 *   rs:s:<maktabId>:<sahifa> bitta maktab
 */
const CB = 'rs';

interface SuperadminLite {
  id: string;
  scope: string | null;
}

interface SchoolRow {
  id: string;
  name: string;
}

/** Chat faol, ulangan superadminga tegishli bo'lsa qaytaradi (har safar serverda qayta tekshiriladi) */
async function findSuperadmin(
  chatId: number,
): Promise<{ user: SuperadminLite } | { error: string }> {
  const u = await User.findOne({ 'telegram.chatId': chatId, isActive: true }).select(
    'role telegram.reportScope',
  );
  if (!u) return { error: NOT_LINKED };
  if (u.role !== 'superadmin') return { error: NOT_SUPERADMIN };
  return { user: { id: u.id, scope: u.telegram?.reportScope ?? null } };
}

async function activeSchools(): Promise<SchoolRow[]> {
  const rows = await School.find({ isActive: true }).select('name').sort({ name: 1 }).lean();
  return rows.map((s) => ({ id: String(s._id), name: s.name }));
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function currentLine(scope: string | null, schools: SchoolRow[]): string {
  if (scope === REPORT_SCOPE_ALL) return 'Hozirgi tanlov: barcha maktablar';
  if (scope) {
    const s = schools.find((x) => x.id === scope);
    return s
      ? `Hozirgi tanlov: ${escapeHtml(s.name)}`
      : 'Hozirgi tanlov: tanlangan maktab topilmadi yoki faol emas (hisobot yuborilmaydi)';
  }
  return 'Hozirgi tanlov: o‘chiq (rejali hisobot yuborilmaydi)';
}

export function buildSettingsView(
  scope: string | null,
  schools: SchoolRow[],
  page: number,
  note?: string,
): BotReply {
  const pages = Math.max(1, Math.ceil(schools.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keyboard: InlineButton[][] = schools.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE).map((s) => [
    {
      text: `${scope === s.id ? '✅ ' : ''}${clip(s.name)}`,
      data: `${CB}:s:${s.id}:${p}`,
    },
  ]);
  if (pages > 1) {
    const nav: InlineButton[] = [];
    if (p > 0) nav.push({ text: '⬅️ Oldingi', data: `${CB}:p:${p - 1}` });
    if (p < pages - 1) nav.push({ text: 'Keyingi ➡️', data: `${CB}:p:${p + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([
    {
      text: `${scope === REPORT_SCOPE_ALL ? '✅ ' : ''}🏫 Barcha maktablar`,
      data: `${CB}:a:${p}`,
    },
  ]);
  keyboard.push([{ text: `${scope === null ? '✅ ' : ''}🔕 O‘chirish`, data: `${CB}:o:${p}` }]);
  const lines = [TITLE, '', currentLine(scope, schools)];
  if (pages > 1) lines.push(`Sahifa ${p + 1}/${pages}`);
  if (note) lines.push('', note);
  return { text: lines.join('\n'), keyboard };
}

/** /sozlamalar: faqat superadmin uchun inline klaviatura; boshqalarga rad matni */
export async function settingsCommandReply(chatId: number): Promise<string | BotReply> {
  const r = await findSuperadmin(chatId);
  if ('error' in r) return r.error;
  return buildSettingsView(r.user.scope, await activeSchools(), 0);
}

const HEX24 = /^[0-9a-f]{24}$/i;

const pageOf = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : 0;
};

/** Inline tugma bosilishi. Rol har safar qayta tekshiriladi; soxta/eskirgan data hech narsani o'zgartirmaydi */
export async function handleSettingsCallback(c: IncomingCallback): Promise<CallbackResult | null> {
  if (c.chatType !== 'private') return null;
  const parts = c.data.split(':');
  if (parts[0] !== CB) return null;

  const r = await findSuperadmin(c.chatId);
  if ('error' in r) return { answer: r.error };
  const { user } = r;
  const kind = parts[1];
  const schools = await activeSchools();

  if (kind === 'p') {
    return { edit: buildSettingsView(user.scope, schools, pageOf(parts[2])) };
  }

  let next: string | null;
  let page: number;
  let label: string;
  if (kind === 'a') {
    next = REPORT_SCOPE_ALL;
    page = pageOf(parts[2]);
    label = 'barcha maktablar';
  } else if (kind === 'o') {
    next = null;
    page = pageOf(parts[2]);
    label = '';
  } else if (kind === 's' && parts[2] && HEX24.test(parts[2])) {
    page = pageOf(parts[3]);
    const id = parts[2].toLowerCase();
    const school = schools.find((s) => s.id === id);
    if (!school) {
      return {
        answer: 'Maktab topilmadi yoki faol emas.',
        edit: buildSettingsView(user.scope, schools, page),
      };
    }
    next = school.id;
    label = school.name;
  } else {
    return { answer: 'Noma‘lum amal.' };
  }

  if (next !== user.scope) {
    await User.updateOne({ _id: user.id }, { $set: { 'telegram.reportScope': next } });
    await auditService.log({
      userId: user.id,
      action: 'telegram.report_scope',
      entity: 'user',
      entityId: user.id,
      before: { reportScope: user.scope },
      after: { reportScope: next },
    });
    logger.info({ userId: user.id }, 'Superadmin hisobot tanlovi o‘zgardi');
  }
  const note =
    next === null ? '🔕 Rejali hisobotlar o‘chirildi.' : `✅ Saqlandi: ${escapeHtml(label)}`;
  return {
    answer: next === null ? 'O‘chirildi' : 'Saqlandi',
    edit: buildSettingsView(next, schools, page, note),
  };
}
