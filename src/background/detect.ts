import { hashId } from '../shared/hash';
import {
  isMaster,
  parseMaster,
  parseMedia,
  type MediaPlaylist,
} from '../shared/m3u8';
import type { CapturedHeaders, Detection, Variant } from '../shared/types';
import { addDetection, getDetections } from './store';

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

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

async function updateBadge(tabId: number): Promise<void> {
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

  const pageTitle = await getTabTitle(tabId);
  let detection: Detection;

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
  } else {
    const media = parseMedia(text, manifestUrl);
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
    await updateBadge(tabId);
    chrome.runtime
      .sendMessage({ type: 'DETECTIONS_CHANGED', tabId })
      .catch(() => void 0); // side panel may be closed
  }
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

export function toFetchHeaders(h: CapturedHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (h.referer) out['Referer'] = h.referer;
  if (h.authorization) out['Authorization'] = h.authorization;
  // Note: Cookie/User-Agent/Origin are forbidden fetch headers and are set by
  // the browser from the extension context; we rely on credentials:'include'.
  return out;
}

export function registerDetection(): void {
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
      if (details.tabId < 0) return;
      if (details.initiator?.startsWith('chrome-extension://')) return; // our fetch

      const ct = (details.responseHeaders ?? [])
        .find((h) => h.name.toLowerCase() === 'content-type')
        ?.value?.toLowerCase();
      const isHls = looksLikeHlsUrl(details.url) || HLS_CONTENT_TYPES.some((t) => ct?.includes(t));
      if (!isHls) return;

      const headers = headerCache.get(details.requestId) ?? {};
      headerCache.delete(details.requestId);
      const pageUrl = details.initiator ?? details.url;
      void classifyAndStore(details.url, details.tabId, pageUrl, headers);
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );
}
