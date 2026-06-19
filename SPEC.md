# Video DL Extension — MVP Spec

A Chrome (MV3) extension that detects non-DRM HLS video streams on any page, shows
them in a side panel with thumbnails + hover preview, and downloads a selected
stream as a clean `.mp4` using **ffmpeg.wasm** — entirely in-browser, no companion
app. This is the architecture model of Video DownloadHelper **v10** (which retired
its native companion app in Dec 2025).

---

## 1. Goal & Non-Goals

### Goal
Pure-extension HLS downloader. Vertical-slice smoke test that defines "done" for MVP:

> On a page playing a **non-DRM HLS (VOD)** stream, the extension detects it,
> lists it in the side panel with a thumbnail, lets the user pick a quality, and
> downloads it as a playable `.mp4` in the Downloads folder.

### Non-Goals (explicitly out of MVP)
- **No native companion app.** Pure extension + ffmpeg.wasm. Accept browser
  memory limits and Downloads-folder-only output.
- **No YouTube.** Out of scope (DASH cipher arms race + ToS).
- **No DRM.** SAMPLE-AES, Widevine, FairPlay → detected but flagged unsupported.
- **No live streams.** No `#EXT-X-ENDLIST` → flagged unsupported.
- **No re-encoding/format conversion.** Remux only (`-c copy`).
- **No MSE/blob reassembly** beyond HLS/DASH.

---

## 1b. Phase 2 Scope (current)

Phase 1 (HLS) is implemented. Phase 2 adds two source types:

### Direct files (`.mp4`, `.webm`, `.mov`, `.m4v`, `.ogv`)
- **Detect** via `webRequest.onHeadersReceived` where `details.type === 'media'`
  (genuine `<video>/<audio>` playback) and response `Content-Type` is `video/*`
  (excluding HLS/DASH manifest types). The `type === 'media'` filter is what
  separates a standalone file from HLS/DASH segments (fetched as
  `xmlhttprequest` via MSE), avoiding segment noise.
- Skip segment-like extensions (`.ts`, `.m4s`).
- **Download** directly with `chrome.downloads.download({ url })` — rides browser
  cookies, **no ffmpeg, no offscreen**. Size from `Content-Length`.
- A direct-file `Detection` has `kind: 'file'`, a single variant, `encryption:
  'none'`, `supported: true`.

### DASH (`.mpd`) — static (VOD) only
- **Detect** via `Content-Type: application/dash+xml` or `.mpd` URL.
- **Parse** the MPD: video + audio `AdaptationSet`s, `Representation`s
  (bandwidth, resolution, codecs), `BaseURL`, and `SegmentTemplate` with
  `$Number$` (with `SegmentTimeline` or `@duration`-based numbering) and
  `$RepresentationID$`. Init segment from `initialization` template.
- **Supported subset:** `type="static"`, `SegmentTemplate` numbering. `SegmentBase`
  (byte-range single file) and `SegmentList` are out of phase 2; flagged
  unsupported. `type="dynamic"` (live) flagged unsupported.
- **Download** (offscreen): pick the chosen video Representation + the best audio
  Representation, fetch init+media segments for each, concat each track, then
  **ffmpeg mux**: `ffmpeg -i video -i audio -c copy out.mp4`.
- A DASH `Detection` has `kind: 'dash'`; `variants` = video Representations.

### HLS with alternate (demuxed) audio
- Some providers (e.g. X/Twitter `amplify_video`) serve **demuxed** HLS: the
  master lists video-only `#EXT-X-STREAM-INF` variants plus a separate audio
  rendition group via `#EXT-X-MEDIA:TYPE=AUDIO`. The video media playlists carry
  **no audio**; audio lives in its own media playlist.
- **Parse** the master's `#EXT-X-MEDIA:TYPE=AUDIO` renditions and map each video
  variant to its audio group (`AUDIO="<group-id>"`, preferring `DEFAULT=YES`).
  Each `Variant` carries the resolved `audioUrl` when audio is demuxed.
- **Download** (offscreen): when a variant has `audioUrl`, build the video track
  and audio track from their separate media playlists, then **ffmpeg mux**
  (`-c copy`) exactly like DASH. When audio is muxed into the video segments
  (no `audioUrl`), use the single-track remux path.
- **Dedup / grouping**: all playlists sharing a video id (`amplify_video/<id>` or
  `tweet_video/<id>`) collapse into **one** detection. If a master is observed it's
  authoritative (its variants + audio groups). If not — common on the X timeline,
  which fetches renditions directly — the detection is **synthesized** from the
  loose sub-playlists: video renditions become quality variants (resolution parsed
  from the URL) and the audio playlist is stored as the group's muxable audio. So
  one X video = one row with a quality picker, never one row per rendition, and it
  still downloads with sound.

### Out of phase 2 (still deferred)
- Stream-to-disk (File System Access) for the memory ceiling.
- Native companion app.
- DASH `SegmentBase`/`SegmentList`, live DASH, multi-period MPDs.

---

## 2. Architecture

Three execution contexts (MV3), each with a single responsibility:

```
┌─────────────────────┐     detection      ┌──────────────────────────┐
│  Service Worker      │  webRequest watch  │  Page network traffic     │
│  (background)        │◄───────────────────│  (.m3u8 + content-type)   │
│                      │                    └──────────────────────────┘
│  - detect .m3u8      │
│  - capture headers   │   chrome.storage.session (detections + headers)
│  - per-tab state     │◄──────────────────────────┐
│  - badge count       │                            │
│  - dispatch jobs     │                            │
└─────────┬───────────┘                             │
          │ start job (job spec)                    │ read detections
          ▼                                         │
┌─────────────────────┐                   ┌─────────┴────────────────┐
│  Offscreen Document  │   progress msgs   │  Side Panel (React)       │
│  (download worker)   │──────────────────▶│  - detected stream list   │
│                      │                   │  - lazy thumbnails (cached)│
│  - fetch manifest    │                   │  - hover preview (hls.js)  │
│  - fetch segments    │                   │  - quality dropdown        │
│  - fetch AES key     │                   │  - download button         │
│  - ffmpeg.wasm remux │                   │  - progress bars           │
│  - chrome.downloads  │                   └──────────────────────────┘
└─────────────────────┘
```

### 2.1 Service Worker (`src/background/`)
- **Detection**: `chrome.webRequest.onSendHeaders` (observational; MV3-legal) +
  `onHeadersReceived` to read response `Content-Type`. Match HLS by:
  - URL path ends in `.m3u8` (with/without query), **or**
  - response `Content-Type` ∈ {`application/vnd.apple.mpegurl`, `application/x-mpegurl`, `audio/mpegurl`}.
- **Header capture**: at detection, stash the request headers needed for later
  download (`Referer`, `Origin`, `User-Agent`, `Cookie` via `chrome.cookies` API,
  and any `Authorization`). Store alongside the detection.
- **State**: detections keyed by `tabId` in `chrome.storage.session` (survives SW
  restart; cleared on tab close / navigation). Each detection has a stable id
  (hash of manifest URL).
- **Badge**: per-tab count of supported detections.
- **Dispatch**: on download request from side panel, create the offscreen
  document (if absent) and post a **job spec** (small control message, well under
  the Native-Messaging-irrelevant here but kept lean). Close offscreen when no
  jobs remain.
- **No heavy work in SW** — it only detects, stores, routes.

### 2.2 Offscreen Document (`src/offscreen/`)
Created via `chrome.offscreen.createDocument` with reason `WORKERS` (+ `BLOBS`).
Hosts the whole download pipeline because the SW would be killed mid-job (~30s
idle limit) and lacks DOM/stable Workers.

Pipeline per job:
1. **Fetch master/media playlist** (privileged extension fetch → bypasses page
   CORS; replays captured headers).
2. If master → already resolved to chosen variant URL by side panel; fetch that
   media playlist.
3. **Parse media playlist**: segment URIs, `#EXT-X-MAP` (init segment for fMP4),
   `#EXT-X-KEY` (AES-128 method/URI/IV), `#EXTINF` durations.
4. **Guard**: no `#EXT-X-ENDLIST` → abort as "live, unsupported".
   `METHOD=SAMPLE-AES` or unknown → abort "DRM, unsupported".
5. **Fetch AES key** (if `METHOD=AES-128`) from key URI (with headers).
6. **Fetch all segments** with bounded concurrency + retry (see §5).
7. **Write into ffmpeg.wasm FS**: init segment, all segments, a rewritten local
   playlist (or feed concatenated input), key file if encrypted.
8. **Remux**: `ffmpeg -allowed_extensions ALL -i playlist.m3u8 -c copy -movflags +faststart out.mp4`
   (no re-encode). For AES-128, the key is provided via local key info so ffmpeg
   decrypts during remux.
9. **Save**: `URL.createObjectURL(blob)` → `chrome.downloads.download({ url, filename })`.
10. **Progress**: post `{ jobId, phase, fetched, total, percent }` to SW → side panel.
11. **Cleanup**: free ffmpeg FS, revoke object URL.

ffmpeg core: **single-threaded** (`@ffmpeg/core`, no `SharedArrayBuffer`) → avoids
cross-origin-isolation (COOP/COEP) setup. CPU is light because we only remux.

### 2.3 Side Panel (`src/sidepanel/`, React + TS)
- Subscribes to detections for the active tab (`chrome.storage` + live messages).
- Renders a row per detection:
  - **Thumbnail** (lazy, on render, cached in `chrome.storage.local` by manifest id).
  - **Hover preview**: instantiate hls.js mini-player on `mouseenter`, destroy on
    `mouseleave`; single live instance at a time.
  - **Editable filename** (inline input, defaults to page title) persisted to the
    detection as `customName` (`RENAME_DETECTION`); used as the download filename.
    Output extension shown beside it (`.mp4`, or the file's own extension).
  - **Dismiss** button (✕) removes the row from the panel — UI-only, it deletes
    the detection from `storage.session` (`DISMISS_DETECTION`) and updates the
    badge; it does **not** touch any already-downloaded file. (A dismissed stream
    may reappear if the page re-requests its manifest.)
  - duration, est. size, quality **dropdown** (master variants), **Download** button.
  - Unsupported (live/DRM) rows greyed with reason badge, no download (still dismissable).
- **Progress**: live progress bar per active job; persists while user browses
  (side panel stays open).

### 2.4 Thumbnail / Preview detail
- Chrome `<video>` cannot play `.m3u8` natively → **hls.js** drives an off-DOM
  `<video>` fed via MSE.
- Because hls.js appends segments through MSE `appendBuffer`, captured frames are
  **same-origin → canvas not tainted** → `toDataURL()` works (the naive
  `<video src=segment>` approach would taint and throw).
- Thumbnail: seek to first keyframe (~0s, fallback ~10%), draw to `<canvas>`,
  export JPEG dataURL, cache.
- **DASH** has no dash.js, but still gets a thumbnail via **manual MSE**: parse the
  MPD, pick the smallest video Representation (fastest to fetch), fetch its init +
  first media segment ourselves, `appendBuffer` both into a `SourceBuffer`, seek,
  and capture. Feeding the bytes through MSE keeps the `<video>` same-origin (a
  `blob:` `MediaSource` URL) so the canvas isn't tainted — same trick hls.js uses.
  Best-effort: a cross-origin segment CDN without CORS, or an unsupported codec
  (`MediaSource.isTypeSupported`), falls back to the placeholder. No hover preview
  for DASH still (that would need a full player).

---

## 3. Detection → Data Model

```ts
type StreamId = string; // sha1(manifestUrl)

interface CapturedHeaders {
  referer?: string;
  origin?: string;
  userAgent?: string;
  cookie?: string;        // assembled via chrome.cookies for the manifest origin
  authorization?: string;
}

interface Variant {
  url: string;            // absolute media-playlist URL
  bandwidth: number;      // bits/s from #EXT-X-STREAM-INF
  resolution?: string;    // e.g. "1920x1080"
  codecs?: string;
}

interface Detection {
  id: StreamId;
  tabId: number;
  manifestUrl: string;
  pageUrl: string;
  pageTitle: string;
  kind: 'master' | 'media';
  variants: Variant[];        // [single] for media-only
  durationSec?: number;       // sum of #EXTINF (media playlist)
  encryption: 'none' | 'aes-128' | 'unsupported-drm';
  live: boolean;              // true if no #EXT-X-ENDLIST
  supported: boolean;         // false if live or unsupported-drm
  unsupportedReason?: string;
  headers: CapturedHeaders;
  thumbnailDataUrl?: string;  // cached
  detectedAt: number;
}
```

Manifest is fetched + parsed **once at detection** (cheap) to populate variants,
duration, encryption, live flag, and the supported flag. Thumbnail generated lazily.

### Job spec (SW → offscreen)
```ts
interface DownloadJob {
  jobId: string;
  detectionId: StreamId;
  mediaPlaylistUrl: string;   // resolved chosen variant
  headers: CapturedHeaders;
  filename: string;           // sanitized, .mp4
}
```

---

## 4. Permissions (`manifest.json`)

```jsonc
{
  "manifest_version": 3,
  "permissions": [
    "webRequest",        // observational detection
    "storage",           // detections + thumbnail cache
    "downloads",         // save final mp4
    "offscreen",         // download worker host
    "sidePanel",         // UI
    "cookies",           // assemble auth cookies for fetch
    "tabs"               // active-tab title/url + per-tab badge
  ],
  "host_permissions": ["<all_urls>"]  // observe + privileged fetch on any site
}
```

> `<all_urls>` is the review-sensitive permission. Justified: must observe + fetch
> on arbitrary sites. Documented in store listing.

---

## 5. Reliability

- **Segment fetch concurrency**: 6 parallel (configurable const), queue the rest.
- **Retry**: 3 attempts per segment, exponential backoff (250ms × 2ⁿ), then fail job.
- **Progress**: report `fetched/total` segments during fetch phase, then a
  remux phase (indeterminate or ffmpeg progress callback).
- **Memory ceiling (accepted limit)**: whole stream buffered in ffmpeg.wasm FS.
  Large/long streams may OOM the offscreen doc. MVP accepts this (matches VDH v10).
  Surface a friendly error on failure rather than silent hang. Phase-2: streaming
  to disk via File System Access / chunked remux.
- **Cancellation**: side panel can cancel a job → offscreen aborts fetches +
  terminates ffmpeg + cleans FS.

---

## 6. File Naming
- Derive from page title, fallback hostname + timestamp.
- Sanitize illegal filename chars; force `.mp4` extension.
- Collisions: rely on `chrome.downloads` default uniquifier.

---

## 7. Tech Stack
- **TypeScript** everywhere.
- **Vite + `@crxjs/vite-plugin`** — MV3 build, multi-entry (SW / offscreen /
  sidepanel), HMR, static wasm assets.
- **React** — side panel UI.
- **hls.js** — preview playback + manifest parsing.
- **@ffmpeg/ffmpeg + @ffmpeg/core** — single-threaded wasm, **bundled locally**
  (MV3 CSP forbids remote wasm/script).

---

## 8. Project Structure
```
video-dl-extension/
├─ SPEC.md
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ public/
│  └─ ffmpeg-core/          # bundled @ffmpeg/core wasm + js (local)
├─ src/
│  ├─ manifest.config.ts    # crxjs manifest definition
│  ├─ shared/
│  │  ├─ types.ts           # Detection, DownloadJob, messages
│  │  ├─ messages.ts        # typed message channel helpers
│  │  └─ m3u8.ts            # lightweight manifest parser (variants, key, endlist)
│  ├─ background/
│  │  ├─ index.ts           # SW entry: webRequest listeners, dispatch
│  │  ├─ detect.ts          # match + classify + capture headers
│  │  └─ store.ts           # per-tab detection state (storage.session)
│  ├─ offscreen/
│  │  ├─ offscreen.html
│  │  ├─ index.ts           # job runner: fetch → ffmpeg → download
│  │  ├─ fetcher.ts         # concurrent segment fetch + retry
│  │  └─ ffmpeg.ts          # ffmpeg.wasm load + remux
│  └─ sidepanel/
│     ├─ index.html
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ StreamRow.tsx       # row + quality dropdown + download/progress
│     ├─ HoverPreview.tsx    # hls.js mini-player
│     └─ thumbnail.ts        # hls.js → canvas → dataURL (cached)
└─ ...
```

---

## 9. Build Sequence (incremental, each verifiable)

1. **Scaffold**: Vite + @crxjs + React + manifest; empty SW, side panel "hello",
   offscreen stub. Loads unpacked in Chrome. ✅ extension installs.
2. **Detection**: webRequest listeners → log detected `.m3u8`. ✅ console shows
   manifest URLs + headers on an HLS page.
3. **Parse + classify**: `m3u8.ts` parses master/media; populate `Detection`
   (variants, duration, encryption, live). ✅ correct classification on test
   streams (VOD-TS, VOD-fMP4, AES-128, live, master multi-variant).
4. **Side panel list**: render detections for active tab + badge count. ✅ rows
   appear, live/DRM greyed.
5. **Thumbnails**: lazy hls.js → canvas → cached dataURL. ✅ thumbnail per row.
6. **Hover preview**: on-hover hls.js mini-player. ✅ plays on hover, tears down.
7. **Download pipeline (TS, unencrypted)**: offscreen fetch + ffmpeg remux + save.
   ✅ **smoke test passes** — playable mp4.
8. **AES-128**: key fetch + ffmpeg decrypt. ✅ encrypted VOD → playable mp4.
9. **fMP4**: `#EXT-X-MAP` init segment handling. ✅ CMAF VOD → playable mp4.
10. **Progress + retry + cancel**: per-job progress bar, retry/backoff, cancel.
    ✅ progress updates; flaky segment recovers; cancel stops cleanly.

---

## 10. Open Risks (acknowledged)
- **wasm memory OOM** on long streams — accepted MVP limit; clear error on failure.
- **`<all_urls>`** store-review friction — documented justification.
- **Sites with anti-bot / token-expiring segment URLs** — captured headers may go
  stale between detection and download; surface failure, don't hang.
- **ffmpeg.wasm cold-load** (~25-30MB) latency on first download — load lazily on
  first job, show "preparing" state.
