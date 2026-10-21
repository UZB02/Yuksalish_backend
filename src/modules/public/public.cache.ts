import crypto from 'crypto';

/** Public javoblar uchun xotiradagi TTL kesh. Reyting/sozlama yangilanganda to'liq tozalanadi. */
const TTL_MS = 30_000;

interface Entry {
  expires: number;
  body: unknown;
  status: number;
  etag: string;
}

const store = new Map<string, Entry>();

export const publicCache = {
  async getOrCompute(
    key: string,
    compute: () => Promise<{ status?: number; body: unknown }>,
  ): Promise<Entry> {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return hit;
    const { status = 200, body } = await compute();
    const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('base64url')}"`;
    const entry: Entry = { expires: Date.now() + TTL_MS, body, status, etag };
    store.set(key, entry);
    if (store.size > 500) {
      for (const [k, v] of store) if (v.expires <= Date.now()) store.delete(k);
      if (store.size > 1000) store.clear(); // tasodifiy query lar bilan to'ldirishdan himoya
    }
    return entry;
  },
  clear() {
    store.clear();
  },
  get size() {
    return store.size;
  },
};
