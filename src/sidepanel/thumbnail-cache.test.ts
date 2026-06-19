import { describe, it, expect, beforeEach } from 'vitest';

function installChromeMock() {
  const data: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: { local: {
      get: async (k: string) => ({ [k]: data[k] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(data, obj); },
      remove: async (keys: string[]) => { for (const k of keys) delete data[k]; },
    } },
    runtime: { sendMessage: async () => undefined },
  };
  return data;
}

describe('thumbnail cache eviction', () => {
  beforeEach(() => installChromeMock());

  it('caps stored thumbnails at MAX_THUMBNAILS and evicts oldest', async () => {
    const { setCachedThumb, getCachedThumb, MAX_THUMBNAILS } = await import('./thumbnail-cache');
    for (let i = 0; i < MAX_THUMBNAILS + 5; i++) {
      await setCachedThumb(`id${i}`, `data${i}`);
    }
    expect(await getCachedThumb('id0')).toBeUndefined();
    expect(await getCachedThumb('id4')).toBeUndefined();
    expect(await getCachedThumb('id5')).toBe('data5');
    expect(await getCachedThumb(`id${MAX_THUMBNAILS + 4}`)).toBe(`data${MAX_THUMBNAILS + 4}`);
  });

  it('re-writing an id keeps it fresh (moves to newest)', async () => {
    const { setCachedThumb, getCachedThumb, MAX_THUMBNAILS } = await import('./thumbnail-cache');
    await setCachedThumb('keep', 'v1');
    for (let i = 0; i < MAX_THUMBNAILS; i++) await setCachedThumb(`x${i}`, `d${i}`);
    await setCachedThumb('keep', 'v2');
    for (let i = 0; i < MAX_THUMBNAILS - 1; i++) await setCachedThumb(`y${i}`, `d${i}`);
    expect(await getCachedThumb('keep')).toBe('v2');
  });
});
