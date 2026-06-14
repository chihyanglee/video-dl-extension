import { onMessage, type Message } from '../shared/messages';
import { registerDetection } from './detect';
import { clearTab, getDetections, updateDetection } from './store';

// --- Detection ---
registerDetection();

// --- Side panel: open on toolbar click ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('sidePanel behavior:', e));
});

// --- Tab cleanup: drop detections + badge on close / navigation ---
chrome.tabs.onRemoved.addListener((tabId) => void clearTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // New top-level navigation → previous detections no longer apply.
  if (changeInfo.url) {
    void clearTab(tabId);
    void chrome.action.setBadgeText({ tabId, text: '' });
  }
});

// --- Offscreen document lifecycle ---
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Fetch HLS segments and remux to MP4 with ffmpeg.wasm.',
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

// Track active jobs so we can tear down the offscreen doc when idle.
const activeJobs = new Set<string>();

async function maybeCloseOffscreen(): Promise<void> {
  if (activeJobs.size > 0) return;
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument().catch(() => void 0);
  }
}

// --- Message routing ---
onMessage(async (msg: Message, _sender) => {
  switch (msg.type) {
    case 'GET_DETECTIONS':
      return getDetections(msg.tabId);

    case 'SET_THUMBNAIL': {
      // Find which tab owns this detection id, then patch it.
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id == null) continue;
        const list = await getDetections(t.id);
        if (list.some((d) => d.id === msg.id)) {
          await updateDetection(t.id, msg.id, { thumbnailDataUrl: msg.dataUrl });
          break;
        }
      }
      return { ok: true };
    }

    case 'START_DOWNLOAD':
      activeJobs.add(msg.job.jobId);
      await ensureOffscreen();
      // Forward to offscreen (it listens on the same runtime channel).
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', job: msg.job }).catch(() => void 0);
      return { ok: true };

    case 'CANCEL_DOWNLOAD':
      chrome.runtime
        .sendMessage({ type: 'OFFSCREEN_CANCEL', jobId: msg.jobId })
        .catch(() => void 0);
      return { ok: true };

    case 'JOB_PROGRESS': {
      // Offscreen broadcasts progress; the side panel receives it directly.
      // SW only watches terminal phases to tear down the offscreen document.
      const { phase, jobId } = msg.progress;
      if (phase === 'done' || phase === 'error' || phase === 'cancelled') {
        activeJobs.delete(jobId);
        await maybeCloseOffscreen();
      }
      return { ok: true };
    }

    default:
      return undefined;
  }
});
