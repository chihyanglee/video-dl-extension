import type { Detection } from '../shared/types';

// Per-tab detection state, persisted in storage.session so it survives SW
// restarts within the browsing session and is cleared when the session ends.

const KEY_PREFIX = 'detections:'; // detections:<tabId> -> Detection[]

function key(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

export async function getDetections(tabId: number): Promise<Detection[]> {
  const res = await chrome.storage.session.get(key(tabId));
  return (res[key(tabId)] as Detection[] | undefined) ?? [];
}

export async function getDetection(
  tabId: number,
  id: string,
): Promise<Detection | undefined> {
  const list = await getDetections(tabId);
  return list.find((d) => d.id === id);
}

export async function addDetection(det: Detection): Promise<boolean> {
  const list = await getDetections(det.tabId);
  if (list.some((d) => d.id === det.id)) return false; // dedupe
  list.push(det);
  await chrome.storage.session.set({ [key(det.tabId)]: list });
  return true;
}

export async function updateDetection(
  tabId: number,
  id: string,
  patch: Partial<Detection>,
): Promise<void> {
  const list = await getDetections(tabId);
  const idx = list.findIndex((d) => d.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch };
  await chrome.storage.session.set({ [key(tabId)]: list });
}

export async function removeDetection(tabId: number, id: string): Promise<void> {
  const list = await getDetections(tabId);
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return;
  await chrome.storage.session.set({ [key(tabId)]: next });
}

export async function clearTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(key(tabId));
}

export async function supportedCount(tabId: number): Promise<number> {
  const list = await getDetections(tabId);
  return list.filter((d) => d.supported).length;
}
