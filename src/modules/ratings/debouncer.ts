export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.(); // jarayonni to'xtatib turmasin
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Kalit (maktab) bo'yicha debounce: bir necha tez-tez chaqiruv bitta ishga birlashadi.
 * Bir kalit uchun ish bir vaqtda faqat bittadan (run davomida kelgan so'rov keyingi navbatga qo'yiladi).
 */
export class Debouncer {
  private timers = new Map<string, unknown>();
  private pending = new Set<string>();
  private running = new Set<string>();
  private rerun = new Set<string>();

  constructor(
    private delayMs: number,
    private run: (key: string) => Promise<unknown>,
    private t: Timers = realTimers,
    private onError: (key: string, err: unknown) => void = () => undefined,
  ) {}

  schedule(key: string): void {
    this.pending.add(key);
    const old = this.timers.get(key);
    if (old !== undefined) this.t.clear(old);
    this.timers.set(
      key,
      this.t.set(() => {
        void this.fire(key);
      }, this.delayMs),
    );
  }

  get pendingKeys(): string[] {
    return [...this.pending];
  }

  private async fire(key: string): Promise<void> {
    const handle = this.timers.get(key);
    if (handle !== undefined) this.t.clear(handle);
    this.timers.delete(key);
    if (!this.pending.has(key)) return;
    if (this.running.has(key)) {
      this.rerun.add(key); // ish ketayotgan paytda yangi so'rov: tugagach yana bir marta
      return;
    }
    this.pending.delete(key);
    this.running.add(key);
    try {
      await this.run(key);
    } catch (err) {
      this.onError(key, err);
    } finally {
      this.running.delete(key);
      if (this.rerun.delete(key)) {
        this.pending.add(key);
        await this.fire(key);
      }
    }
  }

  /** Kutayotgan barcha ishlarni darhol bajaradi (testlar, o'chirish paytida) */
  async flush(): Promise<void> {
    await Promise.all([...this.pending].map((k) => this.fire(k)));
  }
}
