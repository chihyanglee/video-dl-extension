import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../shared/messages';
import type { Detection, DownloadJob, JobProgress, Variant } from '../shared/types';
import { StreamRow } from './StreamRow';
import { fetchWithReferer } from './referer';

function sanitizeFilename(name: string): string {
  return (name || 'video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

let jobSeq = 0;
function newJobId(): string {
  return `job_${Date.now().toString(36)}_${jobSeq++}`;
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [dev, setDev] = useState<boolean>(() => localStorage.getItem('dev') === '1');
  const [paused, setPaused] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [progressByDetection, setProgressByDetection] = useState<Record<string, JobProgress>>({});
  // Detection snapshots taken at download-start. Downloads run in the offscreen
  // doc (tab-independent), but the detected list is per-tab and gets replaced on
  // tab switch — so we keep our own copy to render the Downloads section no
  // matter which tab is active.
  const [jobDetections, setJobDetections] = useState<Record<string, Detection>>({});
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

  // Detection pause flag is persisted in storage.local (read by the SW).
  useEffect(() => {
    void chrome.storage.local.get('detectPaused').then((r) => setPaused(!!r.detectPaused));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.detectPaused) setPaused(!!changes.detectPaused.newValue);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

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
    // Snapshot the detection so its row survives a tab switch (see jobDetections).
    setJobDetections((prev) => ({ ...prev, [det.id]: det }));
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
        : {
            type: 'hls',
            mediaPlaylistUrl: variant?.url ?? det.manifestUrl,
            audioPlaylistUrl: variant?.audioUrl ?? det.audioUrl,
          };
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

  // Remove a finished/failed item from the Downloads section. If it's still a
  // current-tab detection it drops back into the detected list below.
  const onClearDownload = useCallback((det: Detection) => {
    setProgressByDetection((prev) => {
      const n = { ...prev };
      delete n[det.id];
      return n;
    });
    setJobDetections((prev) => {
      const n = { ...prev };
      delete n[det.id];
      return n;
    });
  }, []);

  // Bulk-clear every finished/failed/cancelled download in one go. Active jobs
  // are left untouched (no terminal phase) — same drop-back-to-Detected rule as
  // the per-row clear applies to anything still detected on the current tab.
  const onClearFinished = useCallback(() => {
    const terminalIds = Object.entries(progressByDetection)
      .filter(([, p]) => TERMINAL.has(p.phase))
      .map(([id]) => id);
    if (!terminalIds.length) return;
    setProgressByDetection((prev) => {
      const n = { ...prev };
      terminalIds.forEach((id) => delete n[id]);
      return n;
    });
    setJobDetections((prev) => {
      const n = { ...prev };
      terminalIds.forEach((id) => delete n[id]);
      return n;
    });
  }, [progressByDetection]);

  const isActive = (d: Detection): boolean => {
    const p = progressByDetection[d.id];
    return !!p && !TERMINAL.has(p.phase);
  };
  const order = (a: Detection, b: Detection) =>
    Number(isActive(b)) - Number(isActive(a)) || b.detectedAt - a.detectedAt;

  // Downloads section: anything with progress, drawn from the snapshot (so it
  // survives tab switches) or the current list. Active first, then newest.
  const downloads = Object.keys(progressByDetection)
    .map((id) => jobDetections[id] ?? detections.find((d) => d.id === id))
    .filter((d): d is Detection => !!d)
    .sort(order);
  const inDownloads = new Set(downloads.map((d) => d.id));
  const finishedCount = downloads.reduce(
    (n, d) => n + (TERMINAL.has(progressByDetection[d.id]?.phase ?? '') ? 1 : 0),
    0,
  );

  // Detected list excludes whatever's already shown under Downloads.
  const supported = detections.filter((d) => d.supported && !inDownloads.has(d.id)).sort(order);
  const unsupported = detections.filter((d) => !d.supported && !inDownloads.has(d.id)).sort(order);

  return (
    <div className="app">
      <header>
        <h1>Video DL</h1>
        <div className="head-right">
          <span className="count">{supported.length} found</span>
          <button
            className={`refresh${paused ? ' on' : ''}`}
            title={paused ? 'Detection paused — click to resume' : 'Pause detection'}
            aria-label={paused ? 'Resume detection' : 'Pause detection'}
            aria-pressed={paused}
            onClick={() => {
              const next = !paused;
              setPaused(next);
              void chrome.storage.local.set({ detectPaused: next });
            }}
          >
            {paused ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            )}
          </button>
          <button
            className={`devtoggle${dev ? ' on' : ''}`}
            title="Toggle debug info"
            aria-pressed={dev}
            onClick={() => {
              const next = !dev;
              setDev(next);
              localStorage.setItem('dev', next ? '1' : '0');
            }}
          >
            {'</>'}
          </button>
          <button
            className="refresh"
            title="Clear the list (page is not reloaded; new videos detect as they play)"
            aria-label="Clear detected list"
            disabled={tabId == null}
            onClick={() => {
              if (tabId == null) return;
              // Clear only — don't reload the page. Detection is observational,
              // so videos already loaded won't reappear, but new playback
              // re-detects normally.
              void chrome.runtime.sendMessage({ type: 'CLEAR_DETECTIONS', tabId } satisfies Message);
              setDetections([]);
              // Keep the Downloads section — in-flight/finished downloads aren't
              // tied to the detected list and shouldn't vanish on a list clear.
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </header>

      {downloads.length > 0 && (
        <section className="dl-section">
          <div className="dl-header">
            <span className="section-label">Downloads</span>
            {finishedCount > 0 && (
              <button
                className="link-btn"
                title="Remove finished, failed, and cancelled items (files already saved are not deleted)"
                onClick={onClearFinished}
              >
                Clear finished{finishedCount > 1 ? ` (${finishedCount})` : ''}
              </button>
            )}
          </div>
          {downloads.map((d) => (
            <StreamRow
              key={d.id}
              detection={d}
              progress={progressByDetection[d.id]}
              dev={dev}
              onDownload={onDownload}
              onCancel={onCancel}
              onRename={onRename}
              onDismiss={onClearDownload}
            />
          ))}
        </section>
      )}

      {supported.length + unsupported.length === 0 ? (
        downloads.length === 0 && (
          <p className="empty">No video streams detected on this tab yet. Play a video to detect it.</p>
        )
      ) : (
        <>
          {downloads.length > 0 && <div className="section-label">Detected</div>}
          {[...supported, ...unsupported].map((d) => (
            <StreamRow
              key={d.id}
              detection={d}
              progress={progressByDetection[d.id]}
              dev={dev}
              onDownload={onDownload}
              onCancel={onCancel}
              onRename={onRename}
              onDismiss={onDismiss}
            />
          ))}
        </>
      )}
    </div>
  );
}
