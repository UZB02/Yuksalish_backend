import { User } from '../../models/User';
import type { IncomingMessage } from './telegram.client';
import { linkChat, unlinkUser } from './telegram.link.service';

export const HELP_TEXT = [
  'Yuksalish EDU botiga xush kelibsiz.',
  '',
  'Hisobingizni ulash uchun:',
  '1. Admin panelga kiring va profil sahifasini oching.',
  '2. "Telegramni ulash" tugmasini bosing.',
  '3. Hosil bo‘lgan havola orqali shu botga qayting va "Start" tugmasini bosing.',
  '',
  'Buyruqlar:',
  '/help — yordam',
  '/stop — hisobni uzish',
].join('\n');

const NEW_LINK_HINT =
  "Admin panelda profil sahifasidan yangi havola oling va qayta urinib ko'ring.";

/**
 * Kiruvchi xabarga javob matni (yoki null). Telegram klientidan mustaqil — testlarda to'g'ridan-to'g'ri chaqiriladi.
 * Faqat shaxsiy (private) chatlar qayta ishlanadi.
 */
export async function handleIncoming(msg: IncomingMessage): Promise<string | null> {
  if (msg.chatType !== 'private') return null;
  const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+(\S+))?/.exec(msg.text.trim());
  if (!m) return HELP_TEXT;
  const cmd = m[1]!.toLowerCase();
  const payload = m[2];

  if (cmd === 'start') {
    if (!payload) return HELP_TEXT;
    const r = await linkChat(payload, { chatId: msg.chatId, username: msg.username });
    if (r.ok) {
      return `Salom, ${r.fullName}! Hisobingiz Yuksalish EDU tizimiga ulandi. Endi bildirishnomalar shu yerga keladi. Uzish uchun /stop buyrug'ini yuboring.`;
    }
    if (r.reason === 'inactive') {
      return "Bu hisob faol emas, shuning uchun ulab bo'lmaydi. Maktab ma'muriyatiga murojaat qiling.";
    }
    return `Havola yaroqsiz yoki muddati tugagan. ${NEW_LINK_HINT}`;
  }

  if (cmd === 'stop') {
    const user = await User.findOne({ 'telegram.chatId': msg.chatId }).select('_id');
    if (!user) return 'Bu chat hech qaysi hisobga ulanmagan. Yordam uchun /help.';
    await unlinkUser(user._id, { actorId: user._id.toString(), reason: 'bot_stop' });
    return 'Hisobingiz Telegramdan uzildi. Qayta ulash uchun admin panelda profil sahifasidan yangi havola oling.';
  }

  return HELP_TEXT;
}
