# Plan 001: Establish a runnable test suite (vitest) for the pure parsers/crypto

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for plan 001 in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 16db614..HEAD -- src/shared/m3u8.ts src/shared/mpd.ts src/offscreen/decrypt.ts package.json`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `16db614`, 2026-06-19

## Why this matters

The three highest-value modules in this repo are pure, dependency-light logic:
the HLS playlist parser (`m3u8.ts`), the DASH MPD parser (`mpd.ts`), and AES-128
segment decryption (`decrypt.ts`). They have **zero committed automated tests**.
`CLAUDE.md` documents an ad-hoc "bundle with esbuild and run under node" workflow,
but nothing runnable is checked in, and `package.json` has no `test` script — so
the only verification gate today is `tsc --noEmit`. This plan adds a real,
one-command test suite. It is a prerequisite for plan 002 (the detection-race
fix needs a test harness) and for plan 004 (CI runs `pnpm test`).

## Current state

- `src/shared/m3u8.ts` — HLS parser. Exports `resolveUrl`, `parseAttributes`,
  `isMaster`, `parseMaster`, `parseMedia`. `parseMaster` handles demuxed audio:
  `#EXT-X-MEDIA:TYPE=AUDIO` renditions are mapped onto each variant's `audioUrl`.
  Excerpt (`src/shared/m3u8.ts`):
  ```ts
  export function isMaster(text: string): boolean {
    return text.includes('#EXT-X-STREAM-INF');
  }
  // parseMaster(text, baseUrl) -> { kind:'master', variants: Variant[] }
  //   variants sorted highest BANDWIDTH first; each variant.audioUrl is the
  //   resolved URI of its AUDIO group (prefers DEFAULT=YES) or undefined.
  // parseMedia(text, baseUrl) -> { kind:'media', segments[], initSegment?,
  //   durationSec, endlist, key?, encryption, mediaSequence }
  // encryption: 'none' | 'aes-128' | 'unsupported-drm' (SAMPLE-AES etc.)
  ```
- `src/shared/mpd.ts` — DASH parser. Exports `parseIsoDuration`, `parseMpd`,
  `buildSegmentUrls`. `parseMpd(text, baseUrl)` returns
  `{ type, durationSec, video[], audio[], supported, reason? }`. `buildSegmentUrls(rep, totalDurationSec)`
  returns `{ initUrl?, mediaUrls[] }`. Imports `fast-xml-parser` (works in node).
- `src/offscreen/decrypt.ts` — exports `ivForSequence`, `parseIv`, `importAesKey`,
  `decryptSegment`. Uses the global `crypto.subtle` (Web Crypto). **Node ≥ 20
  exposes `globalThis.crypto`**, so these run unmodified under vitest's node
  environment.
- No test files exist (`git ls-files | grep test` shows only `test/hls-test.html`,
  a manual browser page — unrelated).
- `package.json` scripts today:
  ```json
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "serve:test": "python3 -m http.server 8080 --directory test"
  }
  ```

Repo conventions to match:
- TypeScript strict, ES modules, 2-space indent, terse "why" comments.
- Package manager is **pnpm** (`packageManager: pnpm@11.6.0`). Use pnpm only.
- Test files live next to the source as `*.test.ts` (standard vitest co-location).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Add dev dep | `pnpm add -D vitest` | exit 0; `vitest` in `devDependencies` |
| Run tests | `pnpm test` | exit 0, all tests pass |
| Run once (CI mode) | `pnpm test run` | exit 0 (no watch) |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you may create/modify):
- `package.json` — add `vitest` devDep + a `test` script.
- `src/shared/m3u8.test.ts` (create)
- `src/shared/mpd.test.ts` (create)
- `src/offscreen/decrypt.test.ts` (create)

**Out of scope** (do NOT touch):
- Any source in `src/**` other than the three new `.test.ts` files. This plan
  adds tests only — it must not change parser/crypto behavior. If a test reveals
  a real bug, record it in the STOP/report, do not fix it here.
- `tsconfig.json`, `vite.config.ts` — vitest runs zero-config; do not add a
  `vitest.config.ts` unless a STOP condition forces it.

## Git workflow

- Branch: `advisor/001-test-suite`
- Commit message style: conventional commits (repo uses `feat:` / `fix:` /
  `test:` — see `git log`). Example: `test: add vitest suite for m3u8/mpd/decrypt`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add vitest and the test script

Run `pnpm add -D vitest`. Then add a `test` script to `package.json` scripts:
```json
"test": "vitest"
```
(Leave the other scripts unchanged. `vitest` with no args is fine for local; CI
in plan 004 will call `vitest run`.)

**Verify**: `pnpm test run` → exits 0 and prints "No test files found" (or runs
0 tests). This confirms the runner is wired before any tests exist.

### Step 2: Write `src/shared/m3u8.test.ts`

Cover, using `import { describe, it, expect } from 'vitest'` and importing from
`./m3u8`:

1. **`isMaster`** — true for text containing `#EXT-X-STREAM-INF`, false for a
   media playlist.
2. **`parseMaster` — muxed master** (no `#EXT-X-MEDIA`): variants sorted
   highest-bandwidth first; `audioUrl` is `undefined`; relative URIs resolved
   against the base. Fixture:
   ```
   #EXTM3U
   #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
   360.m3u8
   #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
   720.m3u8
   ```
   base `https://h/path/master.m3u8`. Assert `variants[0].height === 720`,
   `variants[0].url === 'https://h/path/720.m3u8'`, `variants[0].audioUrl === undefined`.
3. **`parseMaster` — demuxed audio** (X/Twitter shape): each variant's `audioUrl`
   resolves to the `DEFAULT=YES` audio rendition's URI. Fixture:
   ```
   #EXTM3U
   #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,URI="/v/aud.m3u8"
   #EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=480x848,AUDIO="aud"
   /v/480.m3u8
   #EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=720x1280,AUDIO="aud"
   /v/720.m3u8
   ```
   base `https://video.twimg.com/x/master.m3u8`. Assert both variants have
   `audioUrl === 'https://video.twimg.com/v/aud.m3u8'` and `variants[0].height === 1280`.
4. **`parseMedia` — VOD, unencrypted**: fixture with `#EXT-X-ENDLIST`, two
   `#EXTINF:4.0,` segments. Assert `endlist === true`, `segments.length === 2`,
   `durationSec === 8`, `encryption === 'none'`, segment URLs resolved absolute.
5. **`parseMedia` — AES-128**: include
   `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123...` (any 32-hex IV). Assert
   `encryption === 'aes-128'`, `key.uri` resolved absolute, `key.iv` preserved.
6. **`parseMedia` — SAMPLE-AES → unsupported**: `#EXT-X-KEY:METHOD=SAMPLE-AES,...`
   → `encryption === 'unsupported-drm'`.
7. **`parseMedia` — fMP4 init**: include `#EXT-X-MAP:URI="init.mp4"` → `initSegment`
   resolved absolute.
8. **`parseMedia` — live**: no `#EXT-X-ENDLIST` → `endlist === false`.

**Verify**: `pnpm test run src/shared/m3u8.test.ts` → all pass.

### Step 3: Write `src/shared/mpd.test.ts`

Import from `./mpd`. Cover:

1. **`parseIsoDuration`**: `'PT1H2M3.5S'` → `3723.5`; `'PT30S'` → `30`;
   `undefined` → `0`.
2. **`parseMpd` — static SegmentTemplate with `@duration`**: a minimal MPD with
   one video `AdaptationSet` (`mimeType="video/mp4"`) and one audio, each a
   `Representation` with a `SegmentTemplate` using `$Number$` and `duration`/`timescale`.
   Assert `supported === true`, `type === 'static'`, `video.length === 1`,
   `audio.length === 1`, video sorted highest-bandwidth first.
3. **`parseMpd` — dynamic (live) → unsupported**: `type="dynamic"` →
   `supported === false`, `reason === 'Live stream'`.
4. **`parseMpd` — ContentProtection → unsupported**: a `<ContentProtection>` child
   → `supported === false`, `reason === 'DRM-protected'`.
5. **`buildSegmentUrls` — `@duration` numbering**: a `DashRep` with
   `mediaTemplate` `'https://h/$RepresentationID$/seg-$Number%03d$.m4s'`,
   `initTemplate` `'https://h/$RepresentationID$/init.mp4'`, `id:'v0'`,
   `startNumber:1`, `segDurationSec:4`, `timescale:1`, and `totalDurationSec:10`
   → `initUrl === 'https://h/v0/init.mp4'`, `mediaUrls.length === 3` (ceil(10/4)),
   first `'https://h/v0/seg-001.m4s'`.
6. **`buildSegmentUrls` — SegmentTimeline**: a `timeline` of
   `[{ t:0, d:4, r:2 }]` → 3 media URLs.

   Build the `DashRep` objects inline in the test (don't go through `parseMpd`) so
   the templating is tested directly; the `DashRep` interface is exported from
   `./mpd`.

**Verify**: `pnpm test run src/shared/mpd.test.ts` → all pass.

### Step 4: Write `src/offscreen/decrypt.test.ts`

Import from `./decrypt`. Cover:

1. **`ivForSequence`**: `ivForSequence(0)` → 16 zero bytes; `ivForSequence(1)` →
   last byte `1`, rest `0` (big-endian in the low 32 bits at offset 12).
2. **`parseIv`**: explicit hex IV `'0x000102030405060708090a0b0c0d0e0f'` →
   those 16 bytes; missing IV → falls back to `ivForSequence(seq)`.
3. **AES-128-CBC round-trip**: generate a 16-byte key + 16-byte IV, encrypt a
   known plaintext with `crypto.subtle` (AES-CBC) in the test, then
   `importAesKey(key)` + `decryptSegment(key, iv, ciphertext)` returns the
   original plaintext bytes. Use `globalThis.crypto.subtle` to produce the
   ciphertext so the test is self-contained.

**Verify**: `pnpm test run src/offscreen/decrypt.test.ts` → all pass. If
`crypto` is undefined under your node version, STOP (see STOP conditions).

### Step 5: Full green

**Verify**:
- `pnpm test run` → all suites pass, prints the new test count (≈ 20+ tests).
- `pnpm typecheck` → exit 0.
- `pnpm build` → exit 0.

## Test plan

This plan *is* the test plan. New files: `src/shared/m3u8.test.ts`,
`src/shared/mpd.test.ts`, `src/offscreen/decrypt.test.ts`. No existing test to
model after (none exist) — follow standard vitest `describe/it/expect` style.
Verification: `pnpm test run` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm test run` exits 0 with the three new suites present and passing.
- [ ] `package.json` has a `test` script and `vitest` in `devDependencies`.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `git status` shows only the four in-scope files changed (plus `pnpm-lock.yaml`).
- [ ] `plans/README.md` status row for 001 updated.

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift since `16db614`).
- A test you wrote per the spec **fails because the code is wrong** (not because
  your fixture is wrong) — that's a real bug; report it, do not change source.
- `crypto`/`crypto.subtle` is `undefined` in the test environment — report the
  node version; do not add polyfills or new deps beyond vitest.
- Making tests pass appears to require editing any `src/**` non-test file.

## Maintenance notes

- Keep parser tests fixture-driven; when the parsers gain features (e.g.
  subtitles, new DASH segmenting), add a fixture + assertions here first.
- Plan 002 will add a fourth test file with an in-memory `chrome.storage` mock;
  it builds on this vitest setup.
- A reviewer should confirm the tests assert real output values (not just "does
  not throw") and that fixtures match real-world manifest shapes.
