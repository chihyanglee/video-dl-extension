import type { DownloadJob, JobProgress, StreamId } from './types';

// Typed message channel. All runtime messages use a discriminated `type`.
export type Message =
  // sidepanel -> background
  | { type: 'GET_DETECTIONS'; tabId: number }
  | { type: 'START_DOWNLOAD'; job: DownloadJob }
  | { type: 'CANCEL_DOWNLOAD'; jobId: string }
  | { type: 'SET_THUMBNAIL'; id: StreamId; dataUrl: string }
  | { type: 'RENAME_DETECTION'; tabId: number; id: StreamId; name: string }
  | { type: 'DISMISS_DETECTION'; tabId: number; id: StreamId }
  // background -> offscreen
  | { type: 'OFFSCREEN_START'; job: DownloadJob }
  | { type: 'OFFSCREEN_CANCEL'; jobId: string }
  // offscreen -> background (offscreen has no chrome.downloads API)
  | { type: 'OFFSCREEN_SAVE'; jobId: string; url: string; filename: string }
  // offscreen -> background -> sidepanel
  | { type: 'JOB_PROGRESS'; progress: JobProgress }
  // background -> sidepanel (push on detection change)
  | { type: 'DETECTIONS_CHANGED'; tabId: number };

export function send<T = unknown>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function onMessage(
  handler: (
    msg: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean | void | Promise<unknown>,
): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const result = handler(msg as Message, sender, sendResponse);
    if (result instanceof Promise) {
      result.then((r) => sendResponse(r)).catch((e) => sendResponse({ error: String(e) }));
      return true; // keep channel open for async
    }
    return result;
  });
}
