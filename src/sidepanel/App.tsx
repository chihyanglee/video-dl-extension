import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../shared/messages';
import type { Detection, DownloadJob, JobProgress, Variant } from '../shared/types';
import { StreamRow } from './StreamRow';

function sanitizeFilename(name: string): string {
  return (name || 'video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

let jobSeq = 0;
function newJobId(): string {
  return `job_${Date.now().toString(36)}_${jobSeq++}`;
}

// declarativeNetRequest session-rule id, kept in a high range to avoid clashing
// with any static rules. One in flight per download is enough.
let drnRuleSeq = 100000;

/**
 * Fetch `url` with `Referer` forced to `referer`. fetch() cannot set Referer
 * (forbidden header), so we install a scoped modifyHeaders session rule for the
 * duration of the request and remove it in `finally`. Streams the body so
 * `onProgress(received, total)` can drive a progress bar; `total` is 0 when the
 * server sends no Content-Length. Returns the body as a Blob; throws on non-2xx.
 */
async function fetchWithReferer(
  url: string,
  referer: string | undefined,
  onProgress?: (received: number, total: number) => void,
): Promise<Blob> {
  const ruleId = ++drnRuleSeq;
  if (referer) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: referer }],
          },
          condition: { urlFilter: url, resourceTypes: ['xmlhttprequest'] },
        } as chrome.declarativeNetRequest.Rule,
      ],
    });
  }
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body) return await res.blob(); // no stream available; can't track
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
    return new Blob(chunks as BlobPart[], {
      type: res.headers.get('content-type') ?? 'application/octet-stream',
    });
  } finally {
    if (referer) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    }
  }
}

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [progressByDetection, setProgressByDetection] = useState<Record<string, JobProgress>>({});
  const jobToDetection = useRef<Record<string, string>>({});

  const refresh = useCallback(async (id: number) => {
    const list = (await chrome.runtime.sendMessage({
      type: 'GET_DETECTIONS',
      tabId: id,
    } satisfies Message)) as Detection[];
    setDetections(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id != null) {
        setTabId(tab.id);
        void refresh(tab.id);
      }
    });
  }, [refresh]);

  // React to detection changes + job progress broadcasts.
  useEffect(() => {
    const listener = (msg: Message) => {
      if (msg.type === 'DETECTIONS_CHANGED' && msg.tabId === tabId) {
        void refresh(tabId);
      } else if (msg.type === 'JOB_PROGRESS') {
        const p = msg.progress;
        setProgressByDetection((prev) => ({ ...prev, [p.detectionId]: p }));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId, refresh]);

  // Re-query detections when the active tab switches.
  useEffect(() => {
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      setTabId(info.tabId);
      void refresh(info.tabId);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, [refresh]);

  const onDownload = useCallback((det: Detection, variant: Variant) => {
    const baseName = sanitizeFilename(det.customName ?? det.pageTitle);
    // Direct files bypass the ffmpeg pipeline. We must fetch them ourselves
    // rather than hand the URL to chrome.downloads: many CDNs gate the file
    // behind a Referer check (hotlink protection), and the download manager
    // doesn't send the page Referer — it would save the 403 error page as a
    // broken .mp4. We fetch from this extension context (rides cookies via
    // credentials:'include') and download the resulting blob. Referer is a
    // forbidden fetch header (fetch() drops it), so we set it with a scoped,
    // self-removing declarativeNetRequest session rule wrapping the fetch.
    if (det.kind === 'file') {
      const ext = (det.manifestUrl.match(/\.(mp4|webm|mov|m4v|ogv|ogg)/i)?.[1] ?? 'mp4').toLowerCase();
      const jobId = newJobId();
      setProgressByDetection((prev) => ({
        ...prev,
        [det.id]: { jobId, detectionId: det.id, phase: 'saving' },
      }));
      const referer = det.headers.referer ?? det.pageUrl;
      void (async () => {
        let url: string | undefined;
        try {
          const blob = await fetchWithReferer(det.manifestUrl, referer, (received, total) => {
            setProgressByDetection((prev) => ({
              ...prev,
              [det.id]: {
                jobId,
                detectionId: det.id,
                phase: 'saving',
                fetched: received,
                total: total || undefined,
                percent: total ? Math.round((received / total) * 100) : undefined,
              },
            }));
          });
          url = URL.createObjectURL(blob);
          await chrome.downloads.download({ url, filename: `${baseName}.${ext}` });
          setProgressByDetection((prev) => ({
            ...prev,
            [det.id]: { jobId, detectionId: det.id, phase: 'done', percent: 100 },
          }));
        } catch (e) {
          setProgressByDetection((prev) => ({
            ...prev,
            [det.id]: { jobId, detectionId: det.id, phase: 'error', error: String(e) },
          }));
        } finally {
          // Revoke after the download manager has read the blob.
          if (url) {
            const u = url;
            setTimeout(() => URL.revokeObjectURL(u), 60_000);
          }
        }
      })();
      return;
    }

    const jobId = newJobId();
    jobToDetection.current[jobId] = det.id;
    const source: DownloadJob['source'] =
      det.kind === 'dash'
        ? { type: 'dash', mpdUrl: det.manifestUrl, videoRepId: variant?.repId ?? det.variants[0]?.repId ?? '' }
        : { type: 'hls', mediaPlaylistUrl: variant?.url ?? det.manifestUrl };
    const job: DownloadJob = {
      jobId,
      detectionId: det.id,
      source,
      headers: det.headers,
      filename: `${baseName}.mp4`,
    };
    setProgressByDetection((prev) => ({
      ...prev,
      [det.id]: { jobId, detectionId: det.id, phase: 'preparing' },
    }));
    chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', job } satisfies Message);
  }, []);

  const onCancel = useCallback((jobId: string) => {
    chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', jobId } satisfies Message);
  }, []);

  const onRename = useCallback(
    (det: Detection, name: string) => {
      if (tabId == null) return;
      chrome.runtime.sendMessage({
        type: 'RENAME_DETECTION',
        tabId,
        id: det.id,
        name,
      } satisfies Message);
      setDetections((prev) => prev.map((d) => (d.id === det.id ? { ...d, customName: name } : d)));
    },
    [tabId],
  );

  const onDismiss = useCallback(
    (det: Detection) => {
      if (tabId == null) return;
      chrome.runtime.sendMessage({ type: 'DISMISS_DETECTION', tabId, id: det.id } satisfies Message);
      setDetections((prev) => prev.filter((d) => d.id !== det.id)); // optimistic
    },
    [tabId],
  );

  const supported = detections.filter((d) => d.supported);
  const unsupported = detections.filter((d) => !d.supported);

  return (
    <div className="app">
      <header>
        <h1>Video DL</h1>
        <span className="count">{supported.length} found</span>
      </header>

      {detections.length === 0 && (
        <p className="empty">No video streams detected on this tab yet. Play a video to detect it.</p>
      )}

      {[...supported, ...unsupported].map((d) => (
        <StreamRow
          key={d.id}
          detection={d}
          progress={progressByDetection[d.id]}
          onDownload={onDownload}
          onCancel={onCancel}
          onRename={onRename}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
