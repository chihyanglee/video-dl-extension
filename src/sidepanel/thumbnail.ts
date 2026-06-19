import Hls from 'hls.js';
import type { Detection } from '../shared/types';
import { parseMpd, buildSegmentUrls } from '../shared/mpd';
import { withRefererRule } from './referer';
import { getCachedThumb, setCachedThumb } from './thumbnail-cache';

/** Draw the current frame of a ready <video> to a canvas → JPEG dataURL.
 *  Throws if the canvas is tainted (cross-origin without CORS). */
function captureVideoFrame(video: HTMLVideoElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 180;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6); // throws on tainted canvas
}

/**
 * Generate a poster thumbnail for an HLS variant. Uses hls.js → MSE so the
 * captured frame stays same-origin (canvas not tainted). Returns a JPEG dataURL.
 */
export async function generateThumbnail(id: string, variantUrl: string): Promise<string> {
  const cached = await getCachedThumb(id);
  if (cached) return cached;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    let hls: Hls | null = null;
    let settled = false;
    const cleanup = () => {
      hls?.destroy();
      video.remove();
    };
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error('thumbnail timeout')), 15_000);

    const capture = () => {
      if (settled) return;
      try {
        const url = captureVideoFrame(video);
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(url);
      } catch (e) {
        fail(e); // tainted canvas etc.
      }
    };

    video.addEventListener('seeked', capture, { once: true });
    video.addEventListener('error', () => fail(new Error('video error')), { once: true });

    if (Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) fail(new Error(`hls: ${data.details}`));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Seek a hair in to land on a decoded keyframe.
        const onLoaded = () => {
          video.currentTime = Math.min(1, (video.duration || 2) / 10);
        };
        video.addEventListener('loadeddata', onLoaded, { once: true });
        video.play().catch(() => void 0);
      });
      hls.loadSource(variantUrl);
      hls.attachMedia(video);
    } else {
      fail(new Error('HLS not supported'));
    }
  });

  await setCachedThumb(id, dataUrl);
  return dataUrl;
}

/** Thumbnail for a directly-playable file: seek a native <video> and snapshot. */
export async function generateNativeThumbnail(id: string, fileUrl: string): Promise<string> {
  const cached = await getCachedThumb(id);
  if (cached) return cached;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.src = fileUrl;

    let settled = false;
    const cleanup = () => video.remove();
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error('thumbnail timeout')), 15_000);

    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(1, (video.duration || 2) / 10);
    });
    video.addEventListener('error', () => fail(new Error('video error')), { once: true });
    video.addEventListener(
      'seeked',
      () => {
        try {
          const url = captureVideoFrame(video);
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(url);
        } catch (e) {
          fail(e); // cross-origin tainted canvas
        }
      },
      { once: true },
    );
  });

  await setCachedThumb(id, dataUrl);
  return dataUrl;
}

/**
 * Thumbnail for a DASH stream without dash.js: parse the MPD, fetch the init +
 * first media segment of the smallest video Representation, and feed both into a
 * MediaSource SourceBuffer. Because we append the bytes ourselves the <video>
 * stays same-origin (a blob: MediaSource URL) → the capture canvas isn't tainted,
 * same trick the hls.js path relies on. Best-effort: an unsupported codec or a
 * CORS-less segment CDN rejects, and the caller falls back to the placeholder.
 */
export async function generateDashThumbnail(det: Detection): Promise<string> {
  const cached = await getCachedThumb(det.id);
  if (cached) return cached;

  const referer = det.headers?.referer ?? det.pageUrl;
  // Scope the Referer rewrite to the MPD host so the segment fetches are covered
  // too (most DASH CDNs serve segments from the manifest's host).
  const host = new URL(det.manifestUrl).hostname;

  const dataUrl = await withRefererRule(host, referer, async () => {
    const mpdRes = await fetch(det.manifestUrl, { credentials: 'include' });
    if (!mpdRes.ok) throw new Error(`mpd HTTP ${mpdRes.status}`);
    const parsed = parseMpd(await mpdRes.text(), det.manifestUrl);
    const rep = parsed.video[parsed.video.length - 1]; // smallest = fastest to fetch
    if (!rep) throw new Error('no video representation');

    const mime = `${rep.mimeType ?? 'video/mp4'}; codecs="${rep.codecs ?? ''}"`;
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      throw new Error(`unsupported codec: ${mime}`);
    }

    const { initUrl, mediaUrls } = buildSegmentUrls(rep, parsed.durationSec);
    if (!mediaUrls.length) throw new Error('no segments');

    const fetchBuf = async (url: string) => {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`segment HTTP ${r.status}`);
      return r.arrayBuffer();
    };
    const parts: ArrayBuffer[] = [];
    if (initUrl) parts.push(await fetchBuf(initUrl));
    parts.push(await fetchBuf(mediaUrls[0]));

    return captureFromMse(mime, parts);
  });

  await setCachedThumb(det.id, dataUrl);
  return dataUrl;
}

/** Append pre-fetched fMP4 byte ranges into a MediaSource, seek, and snapshot. */
function captureFromMse(mime: string, parts: ArrayBuffer[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const cleanup = () => {
      try {
        URL.revokeObjectURL(video.src);
      } catch {
        /* noop */
      }
      video.remove();
    };
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error('dash thumbnail timeout')), 15_000);

    video.addEventListener('error', () => fail(new Error('video error')), { once: true });
    video.addEventListener(
      'seeked',
      () => {
        try {
          const url = captureVideoFrame(video);
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(url);
        } catch (e) {
          fail(e);
        }
      },
      { once: true },
    );

    const ms = new MediaSource();
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(mime);
        let i = 0;
        const appendNext = () => {
          if (settled) return;
          if (i >= parts.length) {
            try {
              ms.endOfStream();
            } catch {
              /* already ended */
            }
            const seek = () => {
              video.currentTime = Math.min(1, (video.duration || 2) / 10);
            };
            if (video.readyState >= 1) seek();
            else video.addEventListener('loadedmetadata', seek, { once: true });
            return;
          }
          sb.appendBuffer(parts[i++]);
        };
        sb.addEventListener('updateend', appendNext);
        sb.addEventListener('error', () => fail(new Error('sourcebuffer error')));
        appendNext();
      } catch (e) {
        fail(e);
      }
    });
    video.src = URL.createObjectURL(ms);
  });
}

/** Pick the right thumbnail strategy for a detection. */
export async function thumbnailFor(det: Detection): Promise<string | undefined> {
  if (det.kind === 'file') return generateNativeThumbnail(det.id, det.manifestUrl);
  if (det.kind === 'master' || det.kind === 'media') {
    return generateThumbnail(det.id, det.variants[0]?.url ?? det.manifestUrl);
  }
  return generateDashThumbnail(det); // dash
}
