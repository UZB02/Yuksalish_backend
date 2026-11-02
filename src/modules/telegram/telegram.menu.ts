import type { BotCommand } from './telegram.client';

const CMD = {
  bugun: { command: 'bugun', description: 'Bugungi darslarim' },
  ertaga: { command: 'ertaga', description: 'Ertangi darslarim' },
  hafta: { command: 'hafta', description: 'Haftalik jadval' },
  hisobot: { command: 'hisobot', description: 'Kunlik hisobot (rahbariyat)' },
  haftalik: { command: 'haftalik', description: 'Haftalik hisobot (rahbariyat)' },
  help: { command: 'help', description: 'Yordam' },
  stop: { command: 'stop', description: 'Hisobni uzish' },
} satisfies Record<string, BotCommand>;

/** Ulanmagan chatlar uchun (default scope) */
export const DEFAULT_COMMANDS: BotCommand[] = [CMD.help];

/** Ulangan chat menyusi, rolga qarab. school_admin darslarga ega bo'la olmaydi (o'qituvchi buyruqlari faqat teacher roliga) */
export function commandsForRole(role: string): BotCommand[] {
  switch (role) {
    case 'teacher':
      return [CMD.bugun, CMD.ertaga, CMD.hafta, CMD.help, CMD.stop];
    case 'school_admin':
      return [CMD.hisobot, CMD.haftalik, CMD.help, CMD.stop];
    case 'superadmin':
      // /haftalik superadmin uchun faqat "admin paneldan" deydi
      return [CMD.hisobot, CMD.help, CMD.stop];
    default:
      return DEFAULT_COMMANDS;
  }
}
