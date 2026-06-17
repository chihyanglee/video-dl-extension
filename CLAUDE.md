# CLAUDE.md

Guidance for AI agents working in this repository.

## What this is

A Chrome **Manifest V3** extension that detects non-DRM **HLS** and **DASH**
streams plus **direct video files**, previews them in a side panel, and downloads
a selected quality as `.mp4` using **ffmpeg.wasm** — pure extension, **no native
companion app** (the Video DownloadHelper v10 model). Authoritative design +
decision log: `SPEC.md` (§1b is the current phase-2 scope). Status, build, and
usage: `README.md`.

## Commands

```bash
pnpm install
pnpm build        # tsc --noEmit && vite build  →  dist/   (run this to verify a change compiles)
pnpm typecheck    # tsc --noEmit only
pnpm dev          # Vite HMR
pnpm serve:test   # serve test/ at http://localhost:8080 (hls-test.html)
```

Load `dist/` as an unpacked extension at `chrome://extensions` (Developer mode).

### Verifying logic without a browser
The MV3 runtime can't be driven headlessly here, but pure modules can. Bundle one
with the already-installed esbuild and run fixtures under Node (Node ≥ 20 has a
global WebCrypto):

```bash
pnpm exec esbuild src/shared/m3u8.ts --bundle --format=esm --outfile=/tmp/m.mjs --log-level=error
node /tmp/test.mjs   # import from /tmp/m.mjs and assert
```

This is how `src/shared/m3u8.ts` (HLS parser), `src/shared/mpd.ts` (DASH parser),
and `src/offscreen/decrypt.ts` (AES) were verified. Prefer this for any change to
parsing or crypto. The end-to-end download path (network → ffmpeg.wasm → file)
requires loading in Chrome.

## Architecture (three contexts, one job each)

- **`src/background/`** — service worker. Detects manifests (`webRequest`,
  observational), captures request headers, stores per-tab detections in
  `chrome.storage.session`, sets the badge, and dispatches download jobs. Owns the
  offscreen document lifecycle. **Do no heavy work here** — the SW is killed after
  ~30s idle.
- **`src/offscreen/`** — offscreen document. Hosts the entire download pipeline
  because it survives long jobs and has DOM/Workers: `index.ts` orchestrates
  fetch (`fetcher.ts`) → AES-128 decrypt (`decrypt.ts`) → concat → ffmpeg remux
  (`ffmpeg.ts`) → save. `chrome.downloads` is **not** exposed to offscreen docs,
  so it sends the blob URL to the SW (`OFFSCREEN_SAVE`) which does the download.
- **`src/sidepanel/`** — React UI. Stream list, lazy cached thumbnails
  (`thumbnail.ts`), on-hover mini-player (`HoverPreview.tsx`), quality selection,
  progress (`StreamRow.tsx`, `App.tsx`), dev-mode inspector (`DebugPanel.tsx`),
  and the Referer-rewrite/fetch helpers (`referer.ts`). Direct-file downloads run
  here (not the offscreen pipeline).
- **`src/shared/`** — cross-context code: `types.ts`, the typed message channel
  `messages.ts`, the HLS parser `m3u8.ts`, and the id hash `hash.ts`.

Messages flow over `chrome.runtime` with a discriminated-union `Message` type
(`src/shared/messages.ts`). `runtime.sendMessage` **broadcasts** to all contexts
except the sender — the side panel receives `JOB_PROGRESS` directly from the
offscreen doc; the SW only watches terminal phases to close the offscreen doc.
Don't re-broadcast a message in the SW that the panel already receives (causes
loops).

## Hard MV3 constraints (don't relearn these the hard way)

- **No remote code.** CSP forbids loading JS/wasm from a CDN. ffmpeg core lives in
  `public/ffmpeg-core/` and is loaded via `chrome.runtime.getURL`, **not** a blob
  URL or CDN. `content_security_policy.extension_pages` includes
  `'wasm-unsafe-eval'`.
- **Single-threaded ffmpeg core** — avoids `SharedArrayBuffer` / COOP-COEP. Fine
  because we only remux (`-c copy`). If you ever add re-encoding you must revisit
  threading + cross-origin isolation.
- **ffmpeg core must be the ESM build.** Vite bundles `@ffmpeg/ffmpeg`'s worker as
  a *module* worker, where `importScripts` is unavailable; it falls back to
  `import(coreURL).default`. The UMD core has no default export and fails with
  "failed to import ffmpeg-core.js" — ship `@ffmpeg/core` `dist/esm/ffmpeg-core.js`
  (see the note in `src/offscreen/ffmpeg.ts`).
- **`chrome.downloads` is unavailable in offscreen documents.** The offscreen doc
  mints the blob URL and delegates the save to the SW via `OFFSCREEN_SAVE`; the SW
  (same extension origin) resolves the blob URL and calls `chrome.downloads`.
- **Offscreen document isn't manifest-discoverable.** It's created at runtime, so
  it's declared as an explicit Rollup input in `vite.config.ts`
  (`input.offscreen`). If you rename/move `offscreen.html`, update both that input
  and `OFFSCREEN_PATH` in `src/background/index.ts`.
- **Forbidden fetch headers.** `Cookie`/`User-Agent`/`Origin`/**`Referer`** can't
  be set on `fetch` — the browser drops them. Rely on `credentials: 'include'` for
  cookies. `toFetchHeaders` sets `Referer`/`Authorization` for the SW's *manifest*
  fetches; the `Referer` is silently dropped but those CDNs don't check it. To set
  `Referer` for real (hotlink-protected downloads), rewrite it at the network layer
  with a scoped `declarativeNetRequest` session rule — `withRefererRule` in
  `src/sidepanel/referer.ts` (needs the `declarativeNetRequest` permission).
- **`webRequest` is observational only** in MV3 (no blocking). Detection uses
  `onBeforeSendHeaders` (capture) + `onHeadersReceived` (classify). Skip requests
  whose `initiator` is `chrome-extension://` to avoid detecting our own fetches.

## Conventions

- **TypeScript strict**, ES modules, `.ts`/`.tsx`. `tsc --noEmit` must pass.
- Keep the three contexts decoupled; share only through `src/shared/`.
- Match the existing terse-comment style: explain *why*, not *what*. Comment the
  MV3 gotchas inline where they bite.
- New runtime messages go in the `Message` union in `src/shared/messages.ts`.
- HLS data shapes live in `src/shared/types.ts` (`Detection`, `DownloadJob`,
  `JobProgress`).

## Scope discipline

In: non-DRM HLS **VOD** (TS + fMP4, master/media, AES-128); **DASH** static/VOD
with `SegmentTemplate` numbering (video + best-audio muxed); **direct files**
(downloaded via `chrome.downloads`, no ffmpeg). Out: YouTube, DASH
`SegmentBase`/`SegmentList`/live/multi-period, DRM (Widevine/FairPlay/SAMPLE-AES/
DASH `ContentProtection`), live HLS, re-encoding/format conversion. Live and DRM
are detected but flagged `supported: false` — keep that; don't download them.

Per-kind notes: direct files are handled in `App.onDownload` (not the offscreen
pipeline). DASH has no in-page preview (no dash.js) — `thumbnailFor` returns
undefined for it and the row shows a placeholder. The `DownloadJob.source` union
(`hls` | `dash`) selects the offscreen path; files never produce a `DownloadJob`.

Before expanding scope (e.g. DASH `SegmentBase`, dash.js preview, or a native
helper), update `SPEC.md` first — it's the source of truth for what this project
deliberately does and doesn't do.
