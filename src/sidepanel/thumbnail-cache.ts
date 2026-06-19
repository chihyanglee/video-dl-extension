// Bounded thumbnail cache in chrome.storage.local. Without a cap, every detected
// stream's JPEG dataURL would persist forever and creep toward the storage quota.
const CACHE_PREFIX = 'thumb:';
const INDEX_KEY = 'thumb:__index';
export const MAX_THUMBNAILS = 100;

export async function getCachedThumb(id: string): Promise<string | undefined> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + id);
  return res[CACHE_PREFIX + id] as string | undefined;
}

export async function setCachedThumb(id: string, dataUrl: string): Promise<void> {
  await chrome.storage.local.set({ [CACHE_PREFIX + id]: dataUrl });

  // Maintain a bounded recency index; evict oldest beyond MAX_THUMBNAILS.
  const res = await chrome.storage.local.get(INDEX_KEY);
  const index = ((res[INDEX_KEY] as string[] | undefined) ?? []).filter((x) => x !== id);
  index.push(id);
  if (index.length > MAX_THUMBNAILS) {
    const evicted = index.splice(0, index.length - MAX_THUMBNAILS);
    await chrome.storage.local.remove(evicted.map((e) => CACHE_PREFIX + e));
  }
  await chrome.storage.local.set({ [INDEX_KEY]: index });

  // Also persist onto the detection so the SW state carries it.
  chrome.runtime.sendMessage({ type: 'SET_THUMBNAIL', id, dataUrl }).catch(() => void 0);
}
