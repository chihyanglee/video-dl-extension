# Plan 003: Fix the offscreen-document START race with a ready handshake

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for plan 003 in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 16db614..HEAD -- src/background/index.ts src/offscreen/index.ts src/shared/messages.ts`
> If any changed, compare the "Current state" excerpts below against the live
> code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (concurrency / correctness)
- **Planned at**: commit `16db614`, 2026-06-19

## Why this matters

When the user starts a download, the service worker creates the offscreen
document and then **immediately** broadcasts the job message to it. But
`chrome.offscreen.createDocument()` resolves when the document is *created*, not
when its module script has finished evaluating and registered its
`chrome.runtime.onMessage` listener. So the `OFFSCREEN_START` message can be sent
before the offscreen document is listening → the message is dropped → the
download silently never starts (the user clicks, the row shows "saving"/preparing
forever or nothing happens). This is an intermittent, hard-to-reproduce failure.
The fix is a one-way readiness handshake: the offscreen document announces when
it's ready, and the SW waits for that before sending the job.

## Current state

`src/background/index.ts` — `ensureOffscreen()` resolves on `createDocument`, and
`START_DOWNLOAD` sends the job right after:

```ts
async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Fetch HLS segments and remux to MP4 with ffmpeg.wasm.',
    })
    .finally(() => { creating = null; });
  return creating;
}
// ...
    case 'START_DOWNLOAD':
      activeJobs.add(msg.job.jobId);
      await ensureOffscreen();
      // Forward to offscreen (it listens on the same runtime channel).
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', job: msg.job }).catch(() => void 0);
      return { ok: true };
```

`src/offscreen/index.ts` registers its listener at module top level (end of file):

```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_START') {
    void runJob(msg.job as DownloadJob);
  } else if (msg?.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.jobId)?.abort();
  }
});
```

`src/shared/messages.ts` — the `Message` union; offscreen-bound messages:

```ts
  // background -> offscreen
  | { type: 'OFFSCREEN_START'; job: DownloadJob }
  | { type: 'OFFSCREEN_CANCEL'; jobId: string }
  // offscreen -> background (offscreen has no chrome.downloads API)
  | { type: 'OFFSCREEN_SAVE'; jobId: string; url: string; filename: string }
```

Note `chrome.runtime.sendMessage` **broadcasts** to all extension contexts, so a
naive "retry until any response" is ambiguous (the side panel also has a
listener). Use an explicit one-way READY signal instead.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Build | `pnpm build` | exit 0 |
| Tests | `pnpm test run` | exit 0 (no behavior regressions) |

## Scope

**In scope**:
- `src/shared/messages.ts` — add `OFFSCREEN_READY` to the `Message` union.
- `src/offscreen/index.ts` — announce readiness after the listener is registered.
- `src/background/index.ts` — wait for readiness in `ensureOffscreen` before
  `START_DOWNLOAD` sends the job.

**Out of scope** (do NOT touch):
- The download pipeline (`runJob`, `runHls`, `runDash`), `OFFSCREEN_SAVE` flow,
  job/progress shapes. This plan only fixes *when* the START message is sent.
- The side panel.

## Git workflow

- Branch: `advisor/003-offscreen-start-handshake`
- Conventional commits, e.g. `fix: wait for offscreen ready before sending job`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the `OFFSCREEN_READY` message type

In `src/shared/messages.ts`, add to the union (offscreen → background section):

```ts
  | { type: 'OFFSCREEN_READY' }
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Announce readiness from the offscreen document

In `src/offscreen/index.ts`, **after** the existing
`chrome.runtime.onMessage.addListener(...)` call (it must already be registered),
append:

```ts
// Tell the SW we're listening — it withholds OFFSCREEN_START until this lands,
// otherwise a job sent right after createDocument() can arrive before this
// module has evaluated and be dropped.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => void 0);
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Wait for readiness in `ensureOffscreen`

In `src/background/index.ts`:

1. Add module-level readiness state near the offscreen lifecycle code:

```ts
let offscreenReady = false;
let resolveReady: (() => void) | null = null;

function waitForOffscreenReady(timeoutMs = 3000): Promise<void> {
  if (offscreenReady) return Promise.resolve();
  return new Promise<void>((resolve) => {
    resolveReady = resolve;
    setTimeout(() => {
      // Fail open: if READY never arrives, proceed anyway rather than hang.
      resolveReady = null;
      resolve();
    }, timeoutMs);
  });
}
```

2. In `ensureOffscreen()`, set readiness correctly for both paths — an
   already-existing document (e.g. after an SW restart) is treated as ready; a
   freshly created one must wait for the READY signal:

```ts
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    offscreenReady = true; // already loaded in a prior SW lifetime
    return;
  }
  offscreenReady = false;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
        justification: 'Fetch HLS segments and remux to MP4 with ffmpeg.wasm.',
      })
      .finally(() => { creating = null; });
  }
  await creating;
  await waitForOffscreenReady();
}
```

3. Handle `OFFSCREEN_READY` in the `onMessage` switch (add a case):

```ts
    case 'OFFSCREEN_READY':
      offscreenReady = true;
      resolveReady?.();
      resolveReady = null;
      return { ok: true };
```

4. When the offscreen document is torn down, reset readiness so the next create
   waits again. In `maybeCloseOffscreen()`, after the document is closed, set
   `offscreenReady = false`:

```ts
async function maybeCloseOffscreen(): Promise<void> {
  if (activeJobs.size > 0) return;
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument().catch(() => void 0);
    offscreenReady = false;
  }
}
```

(The `START_DOWNLOAD` case already does `await ensureOffscreen()` before sending
`OFFSCREEN_START`; no change needed there — `ensureOffscreen` now blocks until
ready.)

**Verify**:
- `pnpm typecheck` → exit 0.
- `pnpm build` → exit 0.

### Step 4: Confirm the handshake wiring

**Verify** (greps confirm each side is present):
- `grep -n "OFFSCREEN_READY" src/shared/messages.ts src/offscreen/index.ts src/background/index.ts`
  → matches in all three files.
- `grep -n "waitForOffscreenReady" src/background/index.ts` → defined and called
  inside `ensureOffscreen`.
- `pnpm test run` → all existing tests still pass.

## Test plan

This timing bug is not unit-testable without a full `chrome.offscreen` + message
mock harness (out of scope). Verification is static (typecheck/build/greps) plus
a manual smoke test:

- Load `dist/` in Chrome. With **no** download in flight (offscreen torn down),
  trigger a fresh HLS/DASH download. It should start every time (previously it
  could silently no-op on the first click after the doc was closed).
- Repeat several times closing/reopening to exercise the create→ready path.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `pnpm test run` exits 0 (no regressions).
- [ ] `OFFSCREEN_READY` exists in the `Message` union and is sent by
      `src/offscreen/index.ts` after the listener is registered.
- [ ] `ensureOffscreen` awaits `waitForOffscreenReady()` on the create path and
      treats an existing document as ready.
- [ ] `maybeCloseOffscreen` resets `offscreenReady = false`.
- [ ] Only in-scope files changed (`git status`).
- [ ] `plans/README.md` status row for 003 updated.

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift since `16db614`).
- `chrome.offscreen.hasDocument()` or `Reason.WORKERS/BLOBS` are not present in
  the live `index.ts` (API shape changed) — report before adapting.
- A step's verification fails twice after a reasonable fix attempt.
- The change appears to require touching the download pipeline or the side panel.

## Maintenance notes

- The 3 s `waitForOffscreenReady` timeout "fails open" (proceeds anyway) so a
  missed READY degrades to today's behavior rather than hanging the download.
  If downloads ever appear to start before the doc is truly ready, raise the
  timeout or make it fail closed with a user-visible error.
- If a second offscreen-bound message is ever added that's sent right after
  create, it must also go through `ensureOffscreen` (i.e. after readiness).
- Reviewer: confirm `offscreenReady` is reset on teardown — otherwise after the
  first close the SW would assume readiness for a not-yet-recreated doc.
