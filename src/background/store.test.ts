import { describe, it, expect, beforeEach } from 'vitest';

function installChromeMock() {
  const data: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: { session: {
      get: async (k: string) => ({ [k]: data[k] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(data, obj); },
      remove: async (k: string) => { delete data[k]; },
    } },
  };
  return data;
}

describe('mutateDetections', () => {
  beforeEach(() => installChromeMock());
  it('does not lose concurrent appends to the same tab', async () => {
    const { mutateDetections, getDetections } = await import('./store');
    const tabId = 1;
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_n, i) =>
        mutateDetections(tabId, (list) => [
          ...list,
          { id: String(i), tabId, manifestUrl: `u${i}`, pageUrl: '', pageTitle: '',
            kind: 'media', variants: [], encryption: 'none', live: false,
            supported: true, headers: {}, detectedAt: 0 } as any,
        ]),
      ),
    );
    const list = await getDetections(tabId);
    expect(list).toHaveLength(N);
    expect(new Set(list.map((d) => d.id)).size).toBe(N);
  });
});
