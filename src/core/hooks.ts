// Modullar orasidagi bo'sh bog'lanish uchun sodda hodisalar (aylanma importlarsiz)
export interface SettingsChange {
  key: string;
  scope: 'global' | 'school';
  schoolId: string | null;
  /** O'zgargan maydon nomlari (qiymat tarkibi) */
  changed?: string[];
}

type Listener = (e: SettingsChange) => void | Promise<void>;
const settingsListeners: Listener[] = [];

export const settingsHooks = {
  on(fn: Listener) {
    settingsListeners.push(fn);
  },
  async emit(e: SettingsChange) {
    for (const fn of settingsListeners) await fn(e);
  },
};
