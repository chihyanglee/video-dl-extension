# Plan 005: Serialize download jobs so concurrent downloads don't corrupt each other

## Status
- Priority: P2 | Effort: S–M | Risk: LOW | Depends on: none
- Category: bug (concurrency)
- Planned at: commit `5157f9d`, 2026-06-19

## Why this matters

The offscreen pipeline uses a **single shared ffmpeg.wasm instance** (`ffmpeg`
singleton in `src/offscreen/ffmpeg.ts`) and **fixed virtual-FS filenames**
(`input.ts`/`input.mp4`/`out.mp4`, `video.mp4`/`audio.mp4`/`out.mp4`). The SW
allows multiple jobs in flight (`activeJobs` is a Set; each `START_DOWNLOAD`
calls `runJob` with no mutual exclusion). If the user starts a second download
while the first is remuxing, both `runJob`s drive the same ffmpeg instance and
write the same FS paths concurrently → one job's `out.mp4`/`input.*` clobbers the
other → corrupted output or an ffmpeg error. ffmpeg.wasm also can't run two
`exec()`s at once. Fix: serialize jobs in the offscreen document so they run one
at a time (the singleton is single-threaded anyway, so this costs nothing real).

## Current state

`src/offscreen/index.ts` (tail) — each `OFFSCREEN_START` fires `runJob` immediately,
and `runJob` creates its own AbortController:

```ts
async function runJob(job: DownloadJob): Promise<void> {
  const ac = new AbortController();
  controllers.set(job.jobId, ac);
  const signal = ac.signal;
  try {
    const mp4 = job.source.type === 'hls'
      ? await runHls(job, job.source.mediaPlaylistUrl, job.source.audioPlaylistUrl, signal)
      : await runDash(job, job.source.mpdUrl, job.source.videoRepId, signal);
    // ... save via OFFSCREEN_SAVE ... report done ...
  } catch (e) { /* cancelled/error */ }
  finally { controllers.delete(job.jobId); }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_START') {
    void runJob(msg.job as DownloadJob);
  } else if (msg?.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.jobId)?.abort();
  }
});

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => void 0);
```

`controllers` is `const controllers = new Map<string, AbortController>();` (top of file).
`ffmpeg.ts` exports `remuxToMp4`/`muxAvToMp4`, both using the shared `ensureFfmpeg()`
instance and fixed FS filenames.

Conventions: TS strict, ESM, 2-space indent, pnpm. `noUnusedLocals` on.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test run` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

In scope: `src/offscreen/index.ts` only.
Out of scope: `src/offscreen/ffmpeg.ts` (do NOT change the singleton or filenames — serialization makes the fixed names safe), the SW (`src/background/index.ts`), the download/parse logic, message shapes.

## Git workflow
Branch `advisor/005-serialize-download-jobs`. Conventional commit e.g. `fix: serialize offscreen download jobs to avoid ffmpeg FS clobber`. No push/PR.

## Steps

### Step 1: Create the AbortController at enqueue time and serialize runJob
In `src/offscreen/index.ts`:

1. Change `runJob` to accept its AbortController instead of creating it (so a job
   cancelled while still queued is handled):
```ts
async function runJob(job: DownloadJob, ac: AbortController): Promise<void> {
  controllers.set(job.jobId, ac);
  const signal = ac.signal;
  try {
    // ... unchanged body ...
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    report(job, aborted ? 'cancelled' : 'error', { error: aborted ? undefined : String(e) });
  } finally {
    controllers.delete(job.jobId);
  }
}
```
2. Add a serialization queue and an enqueue function near `controllers`:
```ts
// One ffmpeg instance + fixed FS filenames → jobs must not overlap. Serialize.
let jobChain: Promise<void> = Promise.resolve();

function enqueueJob(job: DownloadJob): void {
  const ac = new AbortController();
  controllers.set(job.jobId, ac); // registered now so CANCEL works while queued
  jobChain = jobChain.then(() => runJob(job, ac));
}
```
3. Update the message listener to enqueue:
```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_START') {
    enqueueJob(msg.job as DownloadJob);
  } else if (msg?.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.jobId)?.abort();
  }
});
```
Note: `runJob` no longer creates its own AbortController or the initial
`controllers.set` (that moves to `enqueueJob`). Keep the `controllers.delete` in
`finally`.

Verify: `pnpm typecheck` → exit 0; `pnpm build` → exit 0.

### Step 2: Confirm wiring
Verify:
- `grep -n "enqueueJob\|jobChain" src/offscreen/index.ts` → queue defined and used by the listener.
- `grep -n "new AbortController" src/offscreen/index.ts` → appears once, inside `enqueueJob` (not in `runJob`).
- `pnpm test run` → all existing tests still pass (no behavior change to parsers).

## Done criteria (ALL)
- `pnpm typecheck` exit 0.
- `pnpm build` exit 0.
- `pnpm test run` exit 0.
- `runJob` takes an `AbortController` parameter; `enqueueJob` chains jobs on `jobChain`; the listener calls `enqueueJob`.
- Only `src/offscreen/index.ts` changed.

## STOP conditions
- "Current state" excerpts don't match live code (drift since `5157f9d`).
- A verification fails twice after a reasonable fix attempt.
- The change appears to require editing `ffmpeg.ts` or the SW.

## Maintenance notes
- If a future change moves to per-job unique FS filenames + a fresh ffmpeg
  instance per job, this serialization could be relaxed for parallelism — but
  the single-threaded core makes parallel remux pointless, so prefer keeping it.
- A cancelled-while-queued job runs its `runJob` with an already-aborted signal;
  the first `fetch(signal)` throws `AbortError` and is reported `cancelled` — that
  is the intended behavior; confirm it in review.
