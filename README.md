# Video DL — HLS Downloader (Chrome MV3)

A pure-extension Chrome (Manifest V3) video downloader. It detects **non-DRM HLS
streams** on any page, lists them in a side panel with **thumbnails + on-hover
preview**, and downloads a chosen quality as a clean **`.mp4`** using
**ffmpeg.wasm** — entirely in the browser, **no companion app required**.

This mirrors the architecture of Video DownloadHelper **v10**, which retired its
native companion app (CoApp) in December 2025 and moved the muxing into
ffmpeg.wasm in the browser.

> Full design rationale and the decision log live in [`SPEC.md`](./SPEC.md).

---

## Features

- **Automatic detection** of HLS manifests via `webRequest` — matches by URL
  (`.m3u8`) and by response `Content-Type`.
- **Classification** of master vs media playlists, quality variants, duration,
  encryption method, and live-vs-VOD.
- **Side panel UI** (React): per-tab stream list, toolbar badge count.
- **Lazy thumbnails** generated with hls.js → `<canvas>`, cached in
  `chrome.storage`.
- **On-hover mini-player** preview (single live instance at a time).
- **Download pipeline** running in an offscreen document:
  fetch segments (concurrent + retry) → AES-128 decrypt (if needed) → concat →
  ffmpeg.wasm remux (`-c copy`, no re-encode) → save to Downloads.
- **AES-128** encrypted streams supported (decrypted in-JS via Web Crypto).
- **fMP4 / CMAF** segments supported (`#EXT-X-MAP` init segment).
- **Progress, retry/backoff, and cancel** per download.
- Live streams and DRM are **detected and clearly flagged as unsupported**.

### Scope

| In scope (MVP) | Out of scope |
|---|---|
| Non-DRM HLS **VOD** | YouTube (DASH + signature cipher) |
| TS + fMP4 segments | DASH (`.mpd`) |
| Master + media playlists | Direct files (`.mp4`/`.webm` `<video src>`) |
| AES-128 encryption | DRM (Widevine, FairPlay, SAMPLE-AES) |
| Remux to mp4 (no transcode) | Live streams, format conversion / re-encode |

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
work. The SW only detects, stores, and routes.

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
   │  ├─ types.ts             # Detection, DownloadJob, JobProgress
   │  ├─ messages.ts          # typed runtime message channel
   │  ├─ m3u8.ts              # HLS manifest parser (master/media/key/endlist)
   │  └─ hash.ts              # stable id hash for manifest URLs
   ├─ background/
   │  ├─ index.ts             # SW entry: listeners, offscreen lifecycle, routing
   │  ├─ detect.ts            # match + classify + capture headers + badge
   │  └─ store.ts             # per-tab detection state (storage.session)
   ├─ offscreen/
   │  ├─ offscreen.html
   │  ├─ index.ts             # job runner: fetch → decrypt → concat → remux → save
   │  ├─ fetcher.ts           # concurrent segment fetch + retry/backoff
   │  ├─ decrypt.ts           # AES-128-CBC (Web Crypto) + IV derivation
   │  └─ ffmpeg.ts            # ffmpeg.wasm load + remux
   └─ sidepanel/
      ├─ index.html
      ├─ main.tsx
      ├─ App.tsx              # tab tracking, detections, job state
      ├─ StreamRow.tsx        # row: thumbnail, quality, download, progress
      ├─ HoverPreview.tsx     # on-hover hls.js mini-player
      ├─ thumbnail.ts         # hls.js → canvas → cached dataURL
      └─ styles.css
```

---

## Getting started

### Prerequisites
- Node.js ≥ 20 (developed on 24), npm ≥ 10
- Chrome ≥ 116 (for the offscreen + side panel APIs used)

### Install & build

```bash
npm install
npm run build      # tsc --noEmit && vite build  →  dist/
```

Other scripts:

```bash
npm run dev        # Vite dev build with HMR
npm run typecheck  # tsc --noEmit
npm run serve:test # serve test/ at http://localhost:8080
```

### Load the extension in Chrome

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select the **`dist/`** folder.
4. Click the extension's toolbar icon to open the **side panel**.

### Try it on a real stream

1. `npm run serve:test`
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

Core domain logic is verified headlessly by bundling the modules with esbuild and
running fixtures under Node (Node 24 provides a global WebCrypto):

- **Manifest parser** — master/media classification, variant sorting + URL
  resolution, duration summation, ENDLIST (VOD/live), media-sequence,
  AES-128 vs SAMPLE-AES classification, `#EXT-X-MAP`.
- **Decryption** — AES-128-CBC round-trip and IV derivation (explicit IV +
  sequence-number default).

The end-to-end download (network → ffmpeg.wasm → file) must be verified by
loading the extension in Chrome against the test page above — it cannot be
exercised headlessly.

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
- **`<all_urls>` permission:** required to observe and fetch on arbitrary sites;
  this is the review-sensitive permission for store submission.
- **ffmpeg cold load:** the ~32 MB core loads lazily on the first download; the
  UI shows a “preparing” state.

---

## License

Not yet specified.
