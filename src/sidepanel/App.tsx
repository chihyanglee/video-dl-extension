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
    // Direct files bypass the ffmpeg pipeline — just hand the URL to the
    // browser's download manager (rides cookies, no remux needed).
    if (det.kind === 'file') {
      const ext = (det.manifestUrl.match(/\.(mp4|webm|mov|m4v|ogv|ogg)/i)?.[1] ?? 'mp4').toLowerCase();
      chrome.downloads.download({
        url: det.manifestUrl,
        filename: `${baseName}.${ext}`,
      });
      setProgressByDetection((prev) => ({
        ...prev,
        [det.id]: { jobId: newJobId(), detectionId: det.id, phase: 'done', percent: 100 },
      }));
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
