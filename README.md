# Video DL — HLS Downloader (Chrome MV3)

A pure-extension Chrome (Manifest V3) video downloader. It detects **non-DRM HLS
and DASH streams plus direct video files** on any page, lists them in a side
panel with **thumbnails + on-hover preview**, and downloads a chosen quality as a
clean **`.mp4`** using **ffmpeg.wasm** — entirely in the browser, **no companion
app required**.

This mirrors the architecture of Video DownloadHelper **v10**, which retired its
native companion app (CoApp) in December 2025 and moved the muxing into
ffmpeg.wasm in the browser.

> Full design rationale and the decision log live in [`SPEC.md`](./SPEC.md).

---

## Features

- **Automatic detection** via `webRequest` of HLS manifests (`.m3u8`), DASH
  manifests (`.mpd`), and direct video files (`<video src>` media loads) — by URL
  and response `Content-Type`.
- **Classification** of HLS master/media playlists and DASH representations:
  quality variants, duration, encryption/DRM, and live-vs-VOD.
- **DASH download**: parse the MPD, fetch the chosen video representation + best
  audio representation, and **mux them** into one mp4 with ffmpeg (`-c copy`).
- **Direct files**: fetched in the side panel and saved as a blob (no ffmpeg).
  The fetch carries the page `Referer` via a scoped `declarativeNetRequest` rule
  so hotlink-protected CDNs don't return a 403 error page.
- **Side panel UI** (React): per-tab stream list, toolbar badge count, refresh.
- **Dev mode** (`</>` toggle): per-detection debug block — manifest URL, captured
  headers, dedup id, variants, plus live **Probe** (HTTP status + content-type)
  and **View manifest** tools for diagnosing detection/preview issues.
- **Lazy thumbnails** captured to `<canvas>` and cached in `chrome.storage` —
  HLS via hls.js, DASH via manual MSE, direct files from a fetched blob
  (best-effort; falls back to a placeholder on CORS/codec failure).
- **On-hover mini-player** preview (single live instance at a time).
- **Download pipeline** running in an offscreen document:
  fetch segments (concurrent + retry) → AES-128 decrypt (if needed) → concat →
  ffmpeg.wasm remux (`-c copy`, no re-encode) → save via the service worker
  (`chrome.downloads` isn't available in offscreen documents).
- **AES-128** encrypted streams supported (decrypted in-JS via Web Crypto).
- **fMP4 / CMAF** segments supported (`#EXT-X-MAP` init segment).
- **Progress, retry/backoff, and cancel** per download.
- Live streams and DRM are **detected and clearly flagged as unsupported**.

### Scope

| In scope | Out of scope |
|---|---|
| Non-DRM HLS **VOD** (TS + fMP4, master + media, AES-128) | YouTube (DASH + signature cipher) |
| **DASH** (`.mpd`) static/VOD, `SegmentTemplate` numbering | DASH `SegmentBase`/`SegmentList`, live, multi-period |
| **Direct files** (`.mp4`/`.webm`/`.mov`/…) | DRM (Widevine, FairPlay, SAMPLE-AES, DASH ContentProtection) |
| Remux/mux to mp4 (no transcode) | Live streams, format conversion / re-encode |

---

## Architecture

Three MV3 execution contexts, each with one job:

```
┌──────────────────────┐   observe network   ┌──────────────────────────┐
│  Service Worker       │◄────────────────────│  Page traffic (.m3u8)     │
│  (background)         │                     └──────────────────────────┘
│  • webRequest detect  │
│  • capture headers    │   storage.session (detections + headers)
│  • per-tab state+badge │◄────────────────────────────┐
│  • dispatch jobs      │                               │
└────────┬─────────────┘                               │ read / push
         │ START_DOWNLOAD (job spec)                    │
         ▼                                              │
┌──────────────────────┐    JOB_PROGRESS    ┌──────────┴───────────────┐
│  Offscreen Document   │───────────────────▶│  Side Panel (React)       │
│  (download worker)    │                    │  • stream list + badge    │
│  fetch → decrypt →    │                    │  • lazy cached thumbnails │
│  concat → ffmpeg.wasm │                    │  • hover mini-player      │
│  → chrome.downloads   │                    │  • quality + progress     │
└──────────────────────┘                    └──────────────────────────┘
```

**Why an offscreen document?** The MV3 service worker is killed after ~30s idle
and lacks a stable DOM/Worker environment — it cannot host a multi-minute
download + wasm job. The offscreen document is the canonical MV3 home for that
work. The SW only detects, stores, and routes. (One exception: `chrome.downloads`
isn't exposed to offscreen documents, so the offscreen doc hands its blob URL to
the SW, which performs the actual save.)

**Why ffmpeg.wasm (single-threaded)?** Multithreaded ffmpeg needs
`SharedArrayBuffer` → cross-origin isolation (COOP/COEP), which is painful for
extension pages. The MVP only **remuxes** (`-c copy`, no re-encode), so CPU is
light and the single-threaded core — which needs no `SharedArrayBuffer` — is
sufficient. The core is **bundled locally** under `public/ffmpeg-core/` because
MV3 CSP forbids loading wasm/JS from a remote CDN.

**Why decrypt AES-128 in JS instead of in ffmpeg?** Decrypting segments with Web
Crypto (AES-128-CBC) before handing plaintext to ffmpeg keeps the ffmpeg
invocation trivial (`-i input -c copy out.mp4`) and avoids wiring key files into
the wasm filesystem.

---

## Project layout

```
video-dl-extension/
├─ SPEC.md                    # design + decision log
├─ README.md
├─ CLAUDE.md                  # guidance for AI agents working in this repo
├─ package.json
├─ vite.config.ts             # crxjs + react; declares offscreen.html input
├─ tsconfig.json
├─ public/
│  └─ ffmpeg-core/            # bundled single-thread ffmpeg.wasm core (local)
│     ├─ ffmpeg-core.js
│     └─ ffmpeg-core.wasm     # ~32 MB
├─ test/
│  ├─ hls-test.html           # local page that plays public HLS test streams
│  └─ hls.min.js              # hls.js copied locally (no CDN)
└─ src/
   ├─ manifest.config.ts      # MV3 manifest (crxjs defineManifest)
   ├─ shared/
   │  ├─ types.ts             # Detection, DownloadJob (source union), JobProgress
   │  ├─ messages.ts          # typed runtime message channel
   │  ├─ m3u8.ts              # HLS manifest parser (master/media/key/endlist)
   │  ├─ mpd.ts               # DASH MPD parser + segment-URL builder
   │  └─ hash.ts              # stable id hash for manifest URLs
   ├─ background/
   │  ├─ index.ts             # SW entry: routing, offscreen lifecycle, download Referer rule
   │  ├─ detect.ts            # match + classify + capture headers + badge
   │  └─ store.ts             # per-tab detection state (storage.session)
   ├─ offscreen/
   │  ├─ offscreen.html
   │  ├─ index.ts             # job runner: HLS (fetch→decrypt→remux) + DASH (a/v→mux)
   │  ├─ fetcher.ts           # concurrent segment fetch + retry/backoff
   │  ├─ decrypt.ts           # AES-128-CBC (Web Crypto) + IV derivation
   │  └─ ffmpeg.ts            # ffmpeg.wasm load + remux (HLS) + a/v mux (DASH)
   └─ sidepanel/
      ├─ index.html
      ├─ main.tsx
      ├─ App.tsx              # tab tracking, detections, job state, dev toggle
      ├─ StreamRow.tsx        # row: thumbnail, quality, download, progress
      ├─ DebugPanel.tsx       # dev-mode inspector: probe + manifest viewer
      ├─ HoverPreview.tsx     # on-hover hls.js mini-player
      ├─ referer.ts           # Referer-rewrite (declarativeNetRequest) + fetch helpers
      ├─ thumbnail.ts         # hls.js → canvas → cached dataURL
      └─ styles.css
```

---

## Getting started

### Prerequisites
- Node.js ≥ 20 (developed on 24), pnpm ≥ 9 (developed on 11)
- Chrome ≥ 116 (for the offscreen + side panel APIs used)

### Install & build

```bash
pnpm install
pnpm build      # tsc --noEmit && vite build  →  dist/
```

Other scripts:

```bash
pnpm dev        # Vite dev build with HMR
pnpm test       # vitest unit tests
pnpm typecheck  # tsc --noEmit
pnpm serve:test # serve test/ at http://localhost:8080
```

### Load the extension in Chrome

1. `pnpm build`
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select the **`dist/`** folder.
4. Click the extension's toolbar icon to open the **side panel**.

### Try it on a real stream

1. `pnpm serve:test`
2. Open <http://localhost:8080/hls-test.html>.
3. Pick **“Mux — Tears of Steel”** and press **Load** (this fetches the
   `.m3u8`, triggering detection).
4. Open the side panel — the stream appears with a thumbnail. Hover to preview.
5. Choose a quality and click **Download MP4**. The file lands in your Downloads
   folder once the fetch → remux pipeline completes.

To test the AES-128 path, append your own encrypted VOD URL:
`http://localhost:8080/hls-test.html?url=https://…/encrypted.m3u8`.

---

## Testing

Pure domain logic is unit-tested with **vitest** (`pnpm test`) — 26 tests across
5 files:

- **HLS parser** (`m3u8.test.ts`, 10) — master/media classification, variant
  sorting + URL resolution, duration summation, ENDLIST (VOD/live), AES-128 vs
  SAMPLE-AES classification, `#EXT-X-MAP`, and CMAF single-file byte-range
  segments (`#EXT-X-BYTERANGE`).
- **DASH MPD parser** (`mpd.test.ts`, 8) — ISO-8601 duration, video/audio
  representation classification + sorting, `BaseURL` resolution, `SegmentTemplate`
  (`$Number$`/`$RepresentationID$`/`%0Nd`) and `SegmentTimeline`, live +
  `ContentProtection` flagged unsupported.
- **Decryption** (`decrypt.test.ts`, 5) — AES-128-CBC round-trip and IV
  derivation (explicit IV + sequence-number default); needs Node ≥ 20 WebCrypto.
- **Detection store** (`store.test.ts`, 1) and **thumbnail cache**
  (`thumbnail-cache.test.ts`, 2).

The end-to-end download (network → ffmpeg.wasm → file) cannot be exercised
headlessly; it has been **verified manually in Chrome** against the test page
above (HLS, DASH, and direct-file paths).

---

## Known limitations (accepted for MVP)

- **Memory ceiling:** the whole stream is buffered in the ffmpeg.wasm filesystem,
  so very long / large streams can exhaust the offscreen document's heap. Errors
  surface in the side panel rather than hanging silently. A future phase can
  stream to disk via the File System Access API.
- **Output location:** files save only to the browser Downloads folder (MV3
  sandbox).
- **Header expiry:** request headers captured at detection time may expire before
  download on token-protected CDNs; such downloads fail with an error.
- **`<all_urls>` + `declarativeNetRequest` permissions:** `<all_urls>` is needed
  to observe and fetch on arbitrary sites; `declarativeNetRequest` rewrites the
  `Referer` (a forbidden `fetch` header) on our own detection **and** download
  fetches so hotlink-protected CDNs don't return a 403. Both are review-sensitive
  for store submission.
- **ffmpeg cold load:** the ~32 MB core loads lazily on the first download; the
  UI shows a “preparing” state.

---

## License

Not yet specified.
