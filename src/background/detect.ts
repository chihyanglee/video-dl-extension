import { hashId } from '../shared/hash';
import {
  isMaster,
  parseMaster,
  parseMedia,
  type MediaPlaylist,
} from '../shared/m3u8';
import { parseMpd } from '../shared/mpd';
import type { CapturedHeaders, Detection, Variant } from '../shared/types';
import { addDetection, getDetections, removeDetection, updateDetection } from './store';

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

const DASH_CONTENT_TYPES = ['application/dash+xml'];

// Direct-file extensions we offer to download. Segment extensions are excluded
// so HLS/DASH fMP4/TS segments never register as standalone files.
const FILE_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)($|\?)/i;
const SEGMENT_EXT = /\.(ts|m4s|m4a|aac|vtt)($|\?)/i;

// requestId -> captured request headers (in-memory; best-effort across SW life).
const headerCache = new Map<string, CapturedHeaders>();

function headersFromArray(
  arr: chrome.webRequest.HttpHeader[] | undefined,
): CapturedHeaders {
  const h: CapturedHeaders = {};
  for (const { name, value } of arr ?? []) {
    if (!value) continue;
    const n = name.toLowerCase();
    if (n === 'referer') h.referer = value;
    else if (n === 'origin') h.origin = value;
    else if (n === 'user-agent') h.userAgent = value;
    else if (n === 'cookie') h.cookie = value;
    else if (n === 'authorization') h.authorization = value;
  }
  return h;
}

function looksLikeHlsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\.m3u8($|\?)/i.test(u.pathname + u.search) || /\.m3u8/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Assemble a Cookie header for `url` if we didn't capture one. */
async function ensureCookie(url: string, captured?: string): Promise<string | undefined> {
  if (captured) return captured;
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies.length) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined;
  }
}

async function getTabTitle(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.title || tab.url || 'video';
  } catch {
    return 'video';
  }
}

export async function updateBadge(tabId: number): Promise<void> {
  const list = await getDetections(tabId);
  const n = list.filter((d) => d.supported).length;
  await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
}

/**
 * Fetch + parse a candidate manifest, classify it, and store a Detection.
 * Runs once per unique manifest URL per tab.
 */
async function classifyAndStore(
  manifestUrl: string,
  tabId: number,
  pageUrl: string,
  headers: CapturedHeaders,
): Promise<void> {
  const id = hashId(manifestUrl);
  const existing = await getDetections(tabId);
  if (existing.some((d) => d.id === id)) return;

  headers.cookie = await ensureCookie(manifestUrl, headers.cookie);

  let text: string;
  try {
    const res = await fetch(manifestUrl, {
      headers: toFetchHeaders(headers),
      credentials: 'include',
    });
    if (!res.ok) return;
    text = await res.text();
  } catch {
    return; // transient / blocked; skip silently
  }

  if (!text.includes('#EXTM3U')) return; // not a real playlist

  // Demuxed providers (X/Twitter amplify) expose per-rendition video + audio
  // playlists and often don't surface a master. Collapse everything sharing a
  // video id into one detection so it's a single row with a quality picker and
  // a muxable audio track.
  const group = amplifyGroupId(manifestUrl);
  if (group) {
    await classifyGrouped(group, manifestUrl, text, tabId, pageUrl, headers);
    return;
  }

  const pageTitle = await getTabTitle(tabId);
  let detection: Detection;
  // Sub-playlists (video variants + demuxed audio) of an existing master are
  // collapsed into it — one X video = one row, not one per rendition.
  let subPlaylistUrls: Set<string> | undefined;

  if (isMaster(text)) {
    const master = parseMaster(text, manifestUrl);
    if (!master.variants.length) return;
    // Probe the top variant to learn encryption/live (cheap, one fetch).
    const probe = await probeMedia(master.variants[0].url, headers);
    detection = baseDetection(id, tabId, manifestUrl, pageUrl, pageTitle, headers, {
      kind: 'master',
      variants: master.variants,
      durationSec: probe?.durationSec,
      encryption: probe?.encryption ?? 'none',
      live: probe ? !probe.endlist : false,
    });
    subPlaylistUrls = new Set(
      master.variants.flatMap((v) => [v.url, v.audioUrl].filter((u): u is string => !!u)),
    );
  } else {
    // A media playlist that belongs to a master we already have: skip it.
    if (existing.some((d) => d.kind === 'master' && belongsToMaster(d, manifestUrl))) return;
    const media = parseMedia(text, manifestUrl);
    // Demuxed providers (X/Twitter) expose audio-only rendition playlists. They
    // aren't a downloadable video on their own, so drop them from the list.
    if (isAudioOnlyHls(manifestUrl, media)) return;
    const variant: Variant = { url: manifestUrl, bandwidth: 0 };
    detection = baseDetection(id, tabId, manifestUrl, pageUrl, pageTitle, headers, {
      kind: 'media',
      variants: [variant],
      durationSec: media.durationSec,
      encryption: media.encryption,
      live: !media.endlist,
    });
  }

  const added = await addDetection(detection);
  if (added) {
    // If this is a master, drop any media detections already stored for its
    // sub-playlists (they may have been observed before the master).
    if (subPlaylistUrls) {
      for (const d of existing) {
        if (d.kind === 'media' && subPlaylistUrls.has(d.manifestUrl)) {
          await removeDetection(tabId, d.id);
        }
      }
    }
    await updateBadge(tabId);
    chrome.runtime
      .sendMessage({ type: 'DETECTIONS_CHANGED', tabId })
      .catch(() => void 0); // side panel may be closed
  }
}

/** True if `url` is one of the master detection's variant or audio playlists. */
function belongsToMaster(master: Detection, url: string): boolean {
  return master.variants.some((v) => v.url === url || v.audioUrl === url);
}

/** Canonical group prefix for X/Twitter demuxed media, or null. */
function amplifyGroupId(url: string): string | null {
  const m = url.match(/^(https?:\/\/[^/]+\/(?:amplify_video|tweet_video)\/\d+)\//);
  return m ? m[1] : null;
}

/**
 * Merge a loose X/Twitter rendition playlist into one per-video detection.
 * Video renditions become quality variants; the audio rendition is stored as
 * the group's `audioUrl` (muxed in at download). A real master, if observed,
 * overwrites the synthesized variants authoritatively.
 */
async function classifyGrouped(
  group: string,
  manifestUrl: string,
  text: string,
  tabId: number,
  pageUrl: string,
  headers: CapturedHeaders,
): Promise<void> {
  const gid = hashId(group);
  const isAudio = /\/mp4a\/|\/aud\//i.test(manifestUrl);
  const res = manifestUrl.match(/\/(\d+)x(\d+)\//);
  const resolution = res ? `${res[1]}x${res[2]}` : undefined;
  const height = res ? Number(res[2]) : undefined;

  const existing = await getDetections(tabId);
  const cur = existing.find((d) => d.id === gid);

  // A real master is authoritative — once we have one, ignore loose subs.
  if (cur && isMaster(text) === false && belongsToMaster(cur, manifestUrl)) return;

  if (isMaster(text)) {
    const master = parseMaster(text, manifestUrl);
    if (!master.variants.length) return;
    const probe = await probeMedia(master.variants[0].url, headers);
    const det = baseDetection(gid, tabId, manifestUrl, pageUrl, await getTabTitle(tabId), headers, {
      kind: 'master',
      variants: master.variants,
      durationSec: probe?.durationSec,
      encryption: probe?.encryption ?? 'none',
      live: probe ? !probe.endlist : false,
    });
    await putDetection(det, !!cur);
    notifyDetections(tabId);
    return;
  }

  const media = parseMedia(text, manifestUrl);
  if (cur) {
    const patch: Partial<Detection> = {};
    if (isAudio) {
      if (cur.audioUrl) return; // already have audio for this group
      patch.audioUrl = manifestUrl;
    } else {
      if (cur.variants.some((v) => v.url === manifestUrl)) return; // dup variant
      patch.variants = [...cur.variants, { url: manifestUrl, bandwidth: 0, resolution, height }].sort(
        (a, b) => (b.height ?? 0) - (a.height ?? 0),
      );
      patch.supported = !cur.live && cur.encryption !== 'unsupported-drm';
    }
    await updateDetection(tabId, gid, patch);
    notifyDetections(tabId);
    return;
  }

  // First rendition seen for this group — create the detection.
  const det = baseDetection(gid, tabId, manifestUrl, pageUrl, await getTabTitle(tabId), headers, {
    kind: 'master',
    variants: isAudio ? [] : [{ url: manifestUrl, bandwidth: 0, resolution, height }],
    durationSec: media.durationSec,
    encryption: media.encryption,
    live: !media.endlist,
  });
  if (isAudio) det.audioUrl = manifestUrl;
  // Not downloadable until at least one video variant exists.
  det.supported = det.supported && det.variants.length > 0;
  await putDetection(det, false);
  notifyDetections(tabId);
}

function notifyDetections(tabId: number): void {
  void updateBadge(tabId);
  chrome.runtime.sendMessage({ type: 'DETECTIONS_CHANGED', tabId }).catch(() => void 0);
}

/** Add a new detection, or overwrite the existing one (master supersedes subs). */
async function putDetection(det: Detection, replace: boolean): Promise<void> {
  if (replace) await updateDetection(det.tabId, det.id, det);
  else await addDetection(det);
}

/**
 * Heuristic: is this HLS media playlist an audio-only rendition? Demuxed
 * providers route audio under an `/aud/` or `/mp4a/` path (e.g. X/Twitter
 * `…/pl/mp4a/128000/…` with `…/aud/mp4a/…` segments). Muxed playlists hit
 * neither, so this won't misflag normal HLS.
 */
function isAudioOnlyHls(manifestUrl: string, media: MediaPlaylist): boolean {
  const sample = `${manifestUrl} ${media.initSegment ?? ''} ${media.segments[0] ?? ''}`;
  return /\/aud\/|\/mp4a\//i.test(sample);
}

async function probeMedia(
  url: string,
  headers: CapturedHeaders,
): Promise<MediaPlaylist | undefined> {
  try {
    const res = await fetch(url, { headers: toFetchHeaders(headers), credentials: 'include' });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return undefined;
    return parseMedia(text, url);
  } catch {
    return undefined;
  }
}

function baseDetection(
  id: string,
  tabId: number,
  manifestUrl: string,
  pageUrl: string,
  pageTitle: string,
  headers: CapturedHeaders,
  fields: Pick<Detection, 'kind' | 'variants' | 'durationSec' | 'encryption' | 'live'>,
): Detection {
  const live = fields.live;
  const drm = fields.encryption === 'unsupported-drm';
  const supported = !live && !drm;
  return {
    id,
    tabId,
    manifestUrl,
    pageUrl,
    pageTitle,
    ...fields,
    supported,
    unsupportedReason: live ? 'Live stream' : drm ? 'DRM-protected' : undefined,
    headers,
    detectedAt: Date.now(),
  };
}

/** Fetch + parse a DASH .mpd, classify, and store a Detection. */
async function classifyDash(
  mpdUrl: string,
  tabId: number,
  pageUrl: string,
  headers: CapturedHeaders,
): Promise<void> {
  const id = hashId(mpdUrl);
  const existing = await getDetections(tabId);
  if (existing.some((d) => d.id === id)) return;

  headers.cookie = await ensureCookie(mpdUrl, headers.cookie);

  let text: string;
  try {
    const res = await fetch(mpdUrl, { headers: toFetchHeaders(headers), credentials: 'include' });
    if (!res.ok) return;
    text = await res.text();
  } catch {
    return;
  }
  if (!text.includes('<MPD')) return;

  const mpd = parseMpd(text, mpdUrl);
  const variants: Variant[] = mpd.video.map((r) => ({
    url: mpdUrl, // segments are resolved from the MPD at download time
    bandwidth: r.bandwidth,
    resolution: r.width && r.height ? `${r.width}x${r.height}` : undefined,
    height: r.height,
    codecs: r.codecs,
    repId: r.id,
  }));

  const pageTitle = await getTabTitle(tabId);
  const detection: Detection = {
    id,
    tabId,
    manifestUrl: mpdUrl,
    pageUrl,
    pageTitle,
    kind: 'dash',
    variants,
    durationSec: mpd.durationSec || undefined,
    encryption: 'none',
    live: mpd.type === 'dynamic',
    supported: mpd.supported && variants.length > 0,
    unsupportedReason: mpd.supported ? undefined : mpd.reason,
    headers,
    detectedAt: Date.now(),
  };

  if (await addDetection(detection)) {
    await updateBadge(tabId);
    chrome.runtime.sendMessage({ type: 'DETECTIONS_CHANGED', tabId }).catch(() => void 0);
  }
}

/** Register a direct media file (no fetch needed; metadata from headers). */
async function classifyFile(
  fileUrl: string,
  tabId: number,
  pageUrl: string,
  headers: CapturedHeaders,
  contentLength: number | undefined,
): Promise<void> {
  const id = hashId(fileUrl);
  const existing = await getDetections(tabId);
  if (existing.some((d) => d.id === id)) return;

  headers.cookie = await ensureCookie(fileUrl, headers.cookie);
  const pageTitle = await getTabTitle(tabId);

  const detection: Detection = {
    id,
    tabId,
    manifestUrl: fileUrl,
    pageUrl,
    pageTitle,
    kind: 'file',
    variants: [{ url: fileUrl, bandwidth: 0 }],
    bytes: contentLength,
    encryption: 'none',
    live: false,
    supported: true,
    headers,
    detectedAt: Date.now(),
  };

  if (await addDetection(detection)) {
    await updateBadge(tabId);
    chrome.runtime.sendMessage({ type: 'DETECTIONS_CHANGED', tabId }).catch(() => void 0);
  }
}

function looksLikeDashUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\.mpd($|\?)/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

export function toFetchHeaders(h: CapturedHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (h.referer) out['Referer'] = h.referer;
  if (h.authorization) out['Authorization'] = h.authorization;
  // Note: Cookie/User-Agent/Origin are forbidden fetch headers and are set by
  // the browser from the extension context; we rely on credentials:'include'.
  return out;
}

// Detection can be paused from the side panel; persisted so it survives SW
// restarts. The classifier early-returns while paused.
let paused = false;
export const PAUSE_KEY = 'detectPaused';

function watchPaused(): void {
  void chrome.storage.local.get(PAUSE_KEY).then((r) => {
    paused = !!r[PAUSE_KEY];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PAUSE_KEY]) paused = !!changes[PAUSE_KEY].newValue;
  });
}

export function registerDetection(): void {
  watchPaused();

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return; // not a tab (e.g. our own fetch)
      headerCache.set(details.requestId, headersFromArray(details.requestHeaders));
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders'],
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (paused) return;
      if (details.tabId < 0) return;
      if (details.initiator?.startsWith('chrome-extension://')) return; // our fetch

      const headersList = details.responseHeaders ?? [];
      const ct = headersList
        .find((h) => h.name.toLowerCase() === 'content-type')
        ?.value?.toLowerCase();

      const isHls = looksLikeHlsUrl(details.url) || HLS_CONTENT_TYPES.some((t) => ct?.includes(t));
      const isDash = looksLikeDashUrl(details.url) || DASH_CONTENT_TYPES.some((t) => ct?.includes(t));
      // Direct file: a genuine <video>/<audio> media load (not an MSE segment,
      // which arrives as xmlhttprequest), with a video/* content-type.
      const isFile =
        details.type === 'media' &&
        !!ct &&
        ct.startsWith('video/') &&
        !SEGMENT_EXT.test(details.url) &&
        (FILE_EXT.test(details.url) || ct.includes('mp4') || ct.includes('webm'));

      if (!isHls && !isDash && !isFile) return;

      const headers = headerCache.get(details.requestId) ?? {};
      headerCache.delete(details.requestId);
      const pageUrl = details.initiator ?? details.url;

      if (isHls) {
        void classifyAndStore(details.url, details.tabId, pageUrl, headers);
      } else if (isDash) {
        void classifyDash(details.url, details.tabId, pageUrl, headers);
      } else if (isFile) {
        const len = headersList.find((h) => h.name.toLowerCase() === 'content-length')?.value;
        void classifyFile(
          details.url,
          details.tabId,
          pageUrl,
          headers,
          len ? Number(len) : undefined,
        );
      }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );
}
