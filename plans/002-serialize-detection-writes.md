# Plan 002: Serialize detection writes to fix the concurrent read-modify-write race

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for plan 002 in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 16db614..HEAD -- src/background/detect.ts src/background/store.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-test-suite-vitest.md (vitest must exist)
- **Category**: bug (concurrency / correctness)
- **Planned at**: commit `16db614`, 2026-06-19

## Why this matters

X/Twitter videos are detected as several separate playlist requests that arrive
near-simultaneously (a video rendition per quality + a separate audio playlist).
The detector merges them into one "grouped" detection keyed by video id. But the
merge does an **asynchronous read-modify-write** on `chrome.storage.session`:
it reads the current detection list, decides what to change, then writes — with
`await`s in between. When two rendition requests for the same video are processed
concurrently, both read the same (stale) list, and the second write clobbers or
is rejected by the first. The observable result: a grouped video shows **only
one quality**, is **missing its `audioUrl`** (so it downloads as silent video),
or shows **duplicate rows**. This plan makes the read-decide-write atomic per tab
by serializing it through a small queue, so concurrent renditions all land.

## Current state

### The race, concretely

`src/background/detect.ts` → `classifyGrouped(...)` reads then writes with awaits
between (lines ~208–261 at `16db614`):

```ts
  const existing = await getDetections(tabId);          // READ
  const cur = existing.find((d) => d.id === gid);
  // ... isMaster / isAudio branches ...
  const media = parseMedia(text, manifestUrl);
  if (cur) {
    const patch: Partial<Detection> = {};
    if (isAudio) { if (cur.audioUrl) return; patch.audioUrl = manifestUrl; }
    else {
      if (cur.variants.some((v) => v.url === manifestUrl)) return;
      patch.variants = [...cur.variants, { url: manifestUrl, bandwidth: 0, resolution, height }]
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
      patch.supported = !cur.live && cur.encryption !== 'unsupported-drm';
    }
    await updateDetection(tabId, gid, patch);           // WRITE (decision made on stale read)
    notifyDetections(tabId);
    return;
  }
  // First rendition: create the detection.
  const det = baseDetection(gid, ...);
  if (isAudio) det.audioUrl = manifestUrl;
  det.supported = det.supported && det.variants.length > 0;
  await putDetection(det, false);                       // WRITE
  notifyDetections(tabId);
```

`src/background/store.ts` writes are each their own read-modify-write with no
locking — interleaving loses updates:

```ts
export async function addDetection(det: Detection): Promise<boolean> {
  const list = await getDetections(det.tabId);
  if (list.some((d) => d.id === det.id)) return false; // dedupe
  list.push(det);
  await chrome.storage.session.set({ [key(det.tabId)]: list });
  return true;
}
export async function updateDetection(tabId, id, patch): Promise<void> {
  const list = await getDetections(tabId);
  const idx = list.findIndex((d) => d.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch };
  await chrome.storage.session.set({ [key(tabId)]: list });
}
// key(tabId) => `detections:${tabId}`  (module-private)
```

Two concurrent `classifyGrouped` calls for the same `gid`: both see `cur ===
undefined`, both build a create; the first `addDetection` adds it, the second
`addDetection` re-reads, sees the id present, and **returns false → its rendition
is dropped**. Or a create + an update interleave and the update lands on a list
that doesn't yet contain the row. Either way renditions/audio are lost.

### Helpers in play

- `classifyGrouped` also has, near its top:
  ```ts
  // A real master is authoritative — once we have one, ignore loose subs.
  if (cur && isMaster(text) === false && belongsToMaster(cur, manifestUrl)) return;
  ```
- `putDetection(det, replace)` (lines ~269–273): `replace ? updateDetection(...) : addDetection(...)`.
- `notifyDetections(tabId)` (lines ~264–267): `updateBadge` + broadcast `DETECTIONS_CHANGED`.
- `baseDetection(...)`, `probeMedia(...)`, `isAudioOnlyHls(...)`, `amplifyGroupId(...)`,
  `belongsToMaster(...)` are all defined in the same file and unchanged by this plan.

The fix only needs to make the **grouped** path atomic (that's where same-key
concurrent writes collide). The non-grouped master/media path keys by
`hashId(manifestUrl)` (distinct per request), so it does not have the same
lost-update collision and is **out of scope** here.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test run` | exit 0, all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `src/background/store.ts` — add a serialized `mutateDetections` primitive.
- `src/background/detect.ts` — route `classifyGrouped`'s read-decide-write through it.
- `src/background/store.test.ts` (create) — concurrency test for the primitive.

**Out of scope** (do NOT touch):
- The non-grouped `classifyAndStore` master/media branch and `classifyDash` —
  different keying, not the reported race. Leave as-is.
- `addDetection` / `updateDetection` / `removeDetection` signatures — other
  callers (`src/background/index.ts`) depend on them; keep them working. You may
  reimplement their *bodies* on top of `mutateDetections` only if you keep the
  exact same exported signatures and return types; otherwise leave them alone.
- Any UI / message-shape change.

## Git workflow

- Branch: `advisor/002-serialize-detection-writes`
- Conventional commits, e.g. `fix: serialize detection writes to prevent lost renditions`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add `mutateDetections` to `store.ts`

Add a per-tab serialization queue and an atomic mutate primitive. The mutator
receives the *freshly read* list (read inside the lock) and returns the next list,
or `null` to signal "no change" (so callers know whether to notify):

```ts
// Per-tab promise chain so read-modify-write of a tab's detection list is
// atomic: concurrent webRequest events can't clobber each other's updates.
const chains = new Map<number, Promise<unknown>>();

/**
 * Atomically read this tab's detections, transform them, and write back.
 * `mutate` runs with the freshly-read list and returns the next list, or null
 * for "no change". Resolves true if a write happened.
 */
export async function mutateDetections(
  tabId: number,
  mutate: (list: Detection[]) => Detection[] | null,
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const list = await getDetections(tabId);
    const next = mutate(list);
    if (!next) return false;
    await chrome.storage.session.set({ [key(tabId)]: next });
    return true;
  };
  const prev = chains.get(tabId) ?? Promise.resolve();
  const result = prev.then(run, run); // run regardless of prior settle
  chains.set(
    tabId,
    result.catch(() => undefined),
  );
  return result;
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Route `classifyGrouped`'s write through `mutateDetections`

In `src/background/detect.ts`:

1. Add `mutateDetections` to the import from `./store`.
2. Compute everything that needs `await` (the `await getTabTitle(...)` title, and
   for the master branch the `await probeMedia(...)`) **before** entering the
   mutator — the mutator passed to `mutateDetections` must be **synchronous**
   (no `await` inside it). Parsing (`parseMaster`/`parseMedia`) is already sync.
3. Replace the body that currently reads `existing`/`cur` and calls
   `putDetection`/`updateDetection`/`notifyDetections` with a single
   `mutateDetections` call whose synchronous mutator recomputes `cur` from the
   fresh `list` and returns the next list (or `null`). Then notify once if it
   changed.

Target shape for the merge portion (transcribe carefully; keep the existing
pre-computed `gid`, `isAudio`, `resolution`, `height`, and the parsed inputs):

```ts
  // master branch: probe BEFORE the lock (async), then commit atomically.
  if (isMaster(text)) {
    const master = parseMaster(text, manifestUrl);
    if (!master.variants.length) return;
    const probe = await probeMedia(master.variants[0].url, headers);
    const title = await getTabTitle(tabId);
    const det = baseDetection(gid, tabId, manifestUrl, pageUrl, title, headers, {
      kind: 'master',
      variants: master.variants,
      durationSec: probe?.durationSec,
      encryption: probe?.encryption ?? 'none',
      live: probe ? !probe.endlist : false,
    });
    const changed = await mutateDetections(tabId, (list) => {
      const i = list.findIndex((d) => d.id === gid);
      if (i === -1) return [...list, det];
      const next = list.slice();
      next[i] = det; // a real master is authoritative — overwrite
      return next;
    });
    if (changed) notifyDetections(tabId);
    return;
  }

  const media = parseMedia(text, manifestUrl);
  const title = await getTabTitle(tabId);
  const changed = await mutateDetections(tabId, (list) => {
    const cur = list.find((d) => d.id === gid);
    // A real master is authoritative — once we have one, ignore loose subs.
    if (cur && cur.kind === 'master' && belongsToMaster(cur, manifestUrl)) {
      // only skip when this url is actually part of that master's renditions
      if (cur.variants.length && belongsToMaster(cur, manifestUrl)) return null;
    }
    if (cur) {
      if (isAudio) {
        if (cur.audioUrl) return null;
        return replaceById(list, gid, { ...cur, audioUrl: manifestUrl });
      }
      if (cur.variants.some((v) => v.url === manifestUrl)) return null;
      const variants = [...cur.variants, { url: manifestUrl, bandwidth: 0, resolution, height }]
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
      const supported = !cur.live && cur.encryption !== 'unsupported-drm';
      return replaceById(list, gid, { ...cur, variants, supported });
    }
    // First rendition seen — create the group detection.
    const det = baseDetection(gid, tabId, manifestUrl, pageUrl, title, headers, {
      kind: 'master',
      variants: isAudio ? [] : [{ url: manifestUrl, bandwidth: 0, resolution, height }],
      durationSec: media.durationSec,
      encryption: media.encryption,
      live: !media.endlist,
    });
    if (isAudio) det.audioUrl = manifestUrl;
    det.supported = det.supported && det.variants.length > 0;
    return [...list, det];
  });
  if (changed) notifyDetections(tabId);
```

Add a tiny local helper near the other helpers:

```ts
function replaceById(list: Detection[], id: string, det: Detection): Detection[] {
  return list.map((d) => (d.id === id ? det : d));
}
```

4. Delete the now-unused `cur`/`existing` reads at the top of `classifyGrouped`
   and the old `putDetection(...)`/`updateDetection(...)`/`notifyDetections(...)`
   calls inside it. If `putDetection` becomes unused after this, remove it (it was
   only used by `classifyGrouped`). The early `await getDetections(tabId)` /
   `const cur = ...` lines and the standalone authoritative-master `return` at the
   top are replaced by the in-mutator logic above.

**Verify**:
- `pnpm typecheck` → exit 0 (no unused-symbol errors; the repo has
  `noUnusedLocals`/`noUnusedParameters` on).
- `pnpm build` → exit 0.

### Step 3: Concurrency test for the primitive

Create `src/background/store.test.ts`. Mock `chrome.storage.session` with an
in-memory store on `globalThis`, then fire many `mutateDetections` calls
concurrently and assert none are lost.

```ts
import { describe, it, expect, beforeEach } from 'vitest';

// Minimal in-memory chrome.storage.session mock.
function installChromeMock() {
  const data: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: async (k: string) => ({ [k]: data[k] }),
        set: async (obj: Record<string, unknown>) => { Object.assign(data, obj); },
        remove: async (k: string) => { delete data[k]; },
      },
    },
  };
  return data;
}

describe('mutateDetections', () => {
  beforeEach(() => installChromeMock());

  it('does not lose concurrent appends to the same tab', async () => {
    const { mutateDetections, getDetections } = await import('./store');
    const tabId = 1;
    const N = 25;
    // Fire N concurrent appends, each adding a distinct variant id.
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
```

(Use `await import('./store')` *after* the mock is installed so the module's
`chrome` references resolve to the mock.)

**Verify**: `pnpm test run src/background/store.test.ts` → passes; without the
serialization (sanity check, optional) the same test against a naive
read-modify-write would drop entries.

### Step 4: Full green

**Verify**: `pnpm test run` (all suites incl. plan 001's), `pnpm typecheck`,
`pnpm build` → all exit 0.

## Test plan

- New file `src/background/store.test.ts`: the concurrency test above (no lost
  updates under N concurrent mutations). Model structure after the vitest suites
  created in plan 001.
- Manual smoke (not automatable here): load `dist/` in Chrome, open an X timeline
  video, confirm **one** row with multiple quality options and that download
  produces video **with audio**.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test run` exits 0; `src/background/store.test.ts` present and passing.
- [ ] `pnpm build` exits 0.
- [ ] `grep -n "putDetection" src/background/detect.ts` returns nothing **or**
      only a still-used definition (no dangling unused function).
- [ ] `classifyGrouped` no longer calls `updateDetection`/`addDetection` directly
      (it goes through `mutateDetections`): `grep -n "updateDetection\|addDetection" src/background/detect.ts`
      shows those only in `classifyAndStore`/`classifyDash`, not `classifyGrouped`.
- [ ] Only in-scope files changed (`git status`).
- [ ] `plans/README.md` status row for 002 updated.

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift since `16db614`).
- After the refactor, the non-grouped path or `src/background/index.ts` callers
  fail to typecheck because you changed an exported store signature — revert to
  keeping the old signatures and only adding `mutateDetections`.
- The concurrency test still loses entries after the change (means the queue
  isn't actually serializing — re-check that `chains.set` stores the chained
  promise and that `getDetections` runs *inside* `run`).
- The fix appears to need touching files outside the in-scope list.

## Maintenance notes

- Any future code that mutates a tab's detection list should go through
  `mutateDetections` (or the store functions built on it), never a bare
  `getDetections` + `set`, or this race returns.
- A full integration test of `classifyGrouped` (mocking `fetch` + `chrome.tabs`)
  is deferred; the unit test here covers the atomicity primitive that the fix
  relies on. If `classifyGrouped` grows more branches, consider that integration test.
- Reviewer: confirm the mutator passed to `mutateDetections` is pure/synchronous
  (no `await`, no I/O) — that's what makes the critical section atomic.
