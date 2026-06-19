# Plan 007: Bound the thumbnail cache (evict oldest) to stop unbounded storage growth

## Status
- Priority: P3 | Effort: S | Risk: LOW | Depends on: 001 (vitest, merged)
- Category: tech-debt
- Planned at: commit `44f2f6d`, 2026-06-19

## Why this matters

Generated thumbnails are JPEG data URLs cached in `chrome.storage.local` under
`thumb:<id>` keys and **never evicted**. Every distinct detected stream adds a
~5–30 KB entry that lives forever, so heavy use creeps toward the extension's
`storage.local` quota with no ceiling. Bound the cache to a fixed number of most
recently written thumbnails, evicting the oldest. Extracting the cache into its
own module also makes the eviction logic unit-testable (the current
`thumbnail.ts` imports `hls.js`, which is awkward to load in a node test).

## Current state

`src/sidepanel/thumbnail.ts` (top) — the cache, inline, with no bound:

```ts
import Hls from 'hls.js';
import type { Detection } from '../shared/types';

const CACHE_PREFIX = 'thumb:';

export async function getCachedThumb(id: string): Promise<string | undefined> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + id);
  return res[CACHE_PREFIX + id] as string | undefined;
}

async function setCachedThumb(id: string, dataUrl: string): Promise<void> {
  await chrome.storage.local.set({ [CACHE_PREFIX + id]: dataUrl });
  // Also persist onto the detection so the SW state carries it.
  chrome.runtime.sendMessage({ type: 'SET_THUMBNAIL', id, dataUrl }).catch(() => void 0);
}
```

- `getCachedThumb` is exported and used by `generateThumbnail` and
  `generateNativeThumbnail` (both call it at the top to short-circuit).
- `setCachedThumb` is module-private, called at the end of both generators
  (`await setCachedThumb(id, dataUrl);`).
- `import Hls from 'hls.js'` at the top of `thumbnail.ts` means importing this
  module in a node test pulls in hls.js (browser-oriented) — avoid by putting the
  cache in a separate, hls-free module.

Conventions: TS strict, ESM, 2-space indent, pnpm. vitest is set up (`pnpm test`),
tests co-located as `*.test.ts`. An existing test mocks `chrome.storage` in
`src/background/store.test.ts` — model the mock after it.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test run` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

In scope:
- `src/sidepanel/thumbnail-cache.ts` (create) — the cache + bounded eviction.
- `src/sidepanel/thumbnail.ts` — import the cache from the new module; remove the
  inline `CACHE_PREFIX`/`getCachedThumb`/`setCachedThumb`.
- `src/sidepanel/thumbnail-cache.test.ts` (create) — eviction test.

Out of scope: the thumbnail *generation* logic (hls.js capture, canvas), the
`SET_THUMBNAIL` message handling in the SW, anything reading `thumbnailDataUrl`.

## Git workflow
Branch `advisor/007-bound-thumbnail-cache`. Conventional commit e.g.
`perf: bound the thumbnail cache with LRU-style eviction`. No push/PR.

## Steps

### Step 1: Create `src/sidepanel/thumbnail-cache.ts`
Move the cache here and add a bounded index of keys (most-recent last). On write,
de-dup the id, append it, and evict the oldest beyond the cap (deleting their
`thumb:` entries):

```ts
// Bounded thumbnail cache in chrome.storage.local. Without a cap, every detected
// stream's JPEG dataURL would persist forever and creep toward the storage quota.
const CACHE_PREFIX = 'thumb:';
const INDEX_KEY = 'thumb:__index';
export const MAX_THUMBNAILS = 100;

export async function getCachedThumb(id: string): Promise<string | undefined> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + id);
  return res[CACHE_PREFIX + id] as string | undefined;
}

export async function setCachedThumb(id: string, dataUrl: string): Promise<void> {
  await chrome.storage.local.set({ [CACHE_PREFIX + id]: dataUrl });

  // Maintain a bounded recency index; evict oldest beyond MAX_THUMBNAILS.
  const res = await chrome.storage.local.get(INDEX_KEY);
  const index = ((res[INDEX_KEY] as string[] | undefined) ?? []).filter((x) => x !== id);
  index.push(id);
  if (index.length > MAX_THUMBNAILS) {
    const evicted = index.splice(0, index.length - MAX_THUMBNAILS);
    await chrome.storage.local.remove(evicted.map((e) => CACHE_PREFIX + e));
  }
  await chrome.storage.local.set({ [INDEX_KEY]: index });

  // Also persist onto the detection so the SW state carries it.
  chrome.runtime.sendMessage({ type: 'SET_THUMBNAIL', id, dataUrl }).catch(() => void 0);
}
```

Verify: `pnpm typecheck` → exit 0.

### Step 2: Use the cache module from `thumbnail.ts`
In `src/sidepanel/thumbnail.ts`:
- Remove the inline `const CACHE_PREFIX`, `getCachedThumb`, `setCachedThumb`.
- Add `import { getCachedThumb, setCachedThumb } from './thumbnail-cache';`
- Keep re-exporting `getCachedThumb` if other modules import it from `thumbnail.ts`.
  Check first: `grep -rn "getCachedThumb" src/` — if anything outside `thumbnail.ts`
  imports it from `./thumbnail`, add `export { getCachedThumb } from './thumbnail-cache';`
  to preserve that path. (If only `thumbnail.ts` uses it internally, the import
  suffices.)

Verify: `pnpm typecheck` → exit 0; `pnpm build` → exit 0.

### Step 3: Eviction test
Create `src/sidepanel/thumbnail-cache.test.ts`, mocking `chrome.storage.local` +
`chrome.runtime.sendMessage` (model after `src/background/store.test.ts`):

```ts
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
    // Oldest 5 evicted, newest present.
    expect(await getCachedThumb('id0')).toBeUndefined();
    expect(await getCachedThumb('id4')).toBeUndefined();
    expect(await getCachedThumb('id5')).toBe('data5');
    expect(await getCachedThumb(`id${MAX_THUMBNAILS + 4}`)).toBe(`data${MAX_THUMBNAILS + 4}`);
  });

  it('re-writing an id keeps it fresh (moves to newest)', async () => {
    const { setCachedThumb, getCachedThumb, MAX_THUMBNAILS } = await import('./thumbnail-cache');
    await setCachedThumb('keep', 'v1');
    for (let i = 0; i < MAX_THUMBNAILS; i++) await setCachedThumb(`x${i}`, `d${i}`);
    await setCachedThumb('keep', 'v2'); // refresh before it would evict
    for (let i = 0; i < MAX_THUMBNAILS - 1; i++) await setCachedThumb(`y${i}`, `d${i}`);
    expect(await getCachedThumb('keep')).toBe('v2');
  });
}
```

Use `await import('./thumbnail-cache')` after the mock is installed.

Verify: `pnpm test run src/sidepanel/thumbnail-cache.test.ts` → passes.

### Step 4: Full green
Verify: `pnpm test run` (all suites), `pnpm typecheck`, `pnpm build` → all exit 0.

## Done criteria (ALL)
- `pnpm typecheck` / `pnpm test run` / `pnpm build` exit 0.
- `src/sidepanel/thumbnail-cache.ts` holds the cache; `thumbnail.ts` imports it and
  has no inline `CACHE_PREFIX`/`setCachedThumb` definition.
- `thumbnail-cache.test.ts` exists and asserts eviction + recency refresh.
- `grep -n "import Hls" src/sidepanel/thumbnail-cache.ts` → no output (cache module is hls-free).
- Only the three in-scope files changed.

## STOP conditions
- "Current state" excerpts don't match live code (drift since `44f2f6d`).
- A consumer imports `setCachedThumb` from `./thumbnail` (it's currently private) —
  if so, re-export it and note the deviation.
- A verification fails twice after a reasonable fix.

## Maintenance notes
- The index read-modify-write isn't serialized; concurrent thumbnail writes could
  rarely leave a stale `thumb:` key (orphaned, harmless — it just isn't in the
  index so it won't be re-evicted). Acceptable for a best-effort image cache; if it
  ever matters, route through a serialized mutate like `store.mutateDetections`.
- `MAX_THUMBNAILS = 100` is a guess; tune if real usage shows the cache too small
  (re-generating thumbnails) or still too large.
