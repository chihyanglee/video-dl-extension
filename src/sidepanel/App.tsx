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
    const jobId = newJobId();
    jobToDetection.current[jobId] = det.id;
    const job: DownloadJob = {
      jobId,
      detectionId: det.id,
      mediaPlaylistUrl: variant?.url ?? det.manifestUrl,
      headers: det.headers,
      filename: `${sanitizeFilename(det.pageTitle)}.mp4`,
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
        />
      ))}
    </div>
  );
}
