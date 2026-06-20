import { onMessage, type Message } from '../shared/messages';
import { registerDetection, updateBadge } from './detect';
import { clearTab, getDetections, removeDetection, updateDetection } from './store';

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

// createDocument() resolves when the doc exists, not when its module has
// evaluated and registered its onMessage listener. Wait for an explicit
// OFFSCREEN_READY before sending the job, or the START can be dropped.
let offscreenReady = false;
let resolveReady: (() => void) | null = null;

function waitForOffscreenReady(timeoutMs = 3000): Promise<void> {
  if (offscreenReady) return Promise.resolve();
  return new Promise<void>((resolve) => {
    resolveReady = resolve;
    setTimeout(() => {
      // Fail open: if READY never arrives, proceed rather than hang.
      resolveReady = null;
      resolve();
    }, timeoutMs);
  });
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    offscreenReady = true; // already loaded in a prior SW lifetime
    return;
  }
  offscreenReady = false;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
        justification: 'Fetch HLS segments and remux to MP4 with ffmpeg.wasm.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
  await waitForOffscreenReady();
}

// --- Referer rewrite for the offscreen download path ---
// Offscreen documents can't use declarativeNetRequest, and fetch() can't set the
// forbidden Referer header. Hotlink-protected CDNs (e.g. phncdn) 403 the
// Referer-less segment/playlist fetches, so the SW installs a session rule for
// the job's lifetime that rewrites Referer for requests to the manifest host.
// Id range kept distinct from detect.ts (200000) and the side panel (100000).
let dlRuleSeq = 300000;
const jobRefererRule = new Map<string, number>();

async function installJobReferer(
  jobId: string,
  manifestUrl: string,
  referer: string | undefined,
): Promise<void> {
  if (!referer) return;
  let host: string;
  try {
    host = new URL(manifestUrl).hostname;
  } catch {
    return;
  }
  const ruleId = ++dlRuleSeq;
  jobRefererRule.set(jobId, ruleId);
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
        // Offscreen fetches are xmlhttprequest; media/other cover element loads.
        condition: { urlFilter: `||${host}`, resourceTypes: ['xmlhttprequest', 'media', 'other'] },
      } as chrome.declarativeNetRequest.Rule,
    ],
  });
}

async function removeJobReferer(jobId: string): Promise<void> {
  const ruleId = jobRefererRule.get(jobId);
  if (ruleId == null) return;
  jobRefererRule.delete(jobId);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => void 0);
}

// Track active jobs so we can tear down the offscreen doc when idle.
const activeJobs = new Set<string>();

async function maybeCloseOffscreen(): Promise<void> {
  if (activeJobs.size > 0) return;
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument().catch(() => void 0);
    offscreenReady = false;
  }
}

// --- Message routing ---
onMessage(async (msg: Message, _sender) => {
  switch (msg.type) {
    case 'GET_DETECTIONS':
      return getDetections(msg.tabId);

    case 'CLEAR_DETECTIONS':
      await clearTab(msg.tabId);
      await updateBadge(msg.tabId);
      return { ok: true };

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

    case 'RENAME_DETECTION':
      await updateDetection(msg.tabId, msg.id, { customName: msg.name });
      return { ok: true };

    case 'DISMISS_DETECTION':
      await removeDetection(msg.tabId, msg.id);
      await updateBadge(msg.tabId);
      return { ok: true };

    case 'START_DOWNLOAD': {
      activeJobs.add(msg.job.jobId);
      // Force the page Referer for every fetch this job makes (see installJobReferer).
      const manifestUrl =
        msg.job.source.type === 'hls' ? msg.job.source.mediaPlaylistUrl : msg.job.source.mpdUrl;
      await installJobReferer(msg.job.jobId, manifestUrl, msg.job.headers.referer);
      await ensureOffscreen();
      // Forward to offscreen (it listens on the same runtime channel).
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', job: msg.job }).catch(() => void 0);
      return { ok: true };
    }

    case 'OFFSCREEN_READY':
      offscreenReady = true;
      resolveReady?.();
      resolveReady = null;
      return { ok: true };

    case 'CANCEL_DOWNLOAD':
      chrome.runtime
        .sendMessage({ type: 'OFFSCREEN_CANCEL', jobId: msg.jobId })
        .catch(() => void 0);
      return { ok: true };

    case 'OFFSCREEN_SAVE':
      // Offscreen can't call chrome.downloads; it hands us a same-origin blob:
      // URL to enqueue. Await so the blob is read before the offscreen doc is
      // torn down (which would revoke it).
      try {
        await chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }

    case 'JOB_PROGRESS': {
      // Offscreen broadcasts progress; the side panel receives it directly.
      // SW only watches terminal phases to tear down the offscreen document.
      const { phase, jobId } = msg.progress;
      if (phase === 'done' || phase === 'error' || phase === 'cancelled') {
        activeJobs.delete(jobId);
        await removeJobReferer(jobId);
        await maybeCloseOffscreen();
      }
      return { ok: true };
    }

    default:
      return undefined;
  }
});
