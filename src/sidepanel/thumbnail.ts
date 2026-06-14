import Hls from 'hls.js';
import type { Detection } from '../shared/types';

const CACHE_PREFIX = 'thumb:';

export async function getCachedThumb(id: string): Promise<string | undefined> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + id);
  return res[CACHE_PREFIX + id] as string | undefined;
}

async function setCachedThumb(id: string, dataUrl: string): Promise<void> {
  await chrome.storage.local.set({ [CACHE_PREFIX + id]: dataUrl });
  // Also persist onto the detection so the SW state carries it.
  chrome.runtime.sendMessage({ type: 'SET_THUMBNAIL', id, dataUrl }).catch(() => void 0);
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
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 180;
      const ctx = canvas.getContext('2d');
      if (!ctx) return fail(new Error('no 2d context'));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const url = canvas.toDataURL('image/jpeg', 0.6);
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
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 180;
        const ctx = canvas.getContext('2d');
        if (!ctx) return fail(new Error('no 2d context'));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const url = canvas.toDataURL('image/jpeg', 0.6);
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

/** Pick the right thumbnail strategy for a detection. DASH has no in-page
 *  player here (no dash.js), so it returns undefined (UI shows a placeholder). */
export async function thumbnailFor(det: Detection): Promise<string | undefined> {
  if (det.kind === 'file') return generateNativeThumbnail(det.id, det.manifestUrl);
  if (det.kind === 'master' || det.kind === 'media') {
    return generateThumbnail(det.id, det.variants[0]?.url ?? det.manifestUrl);
  }
  return undefined; // dash
}
