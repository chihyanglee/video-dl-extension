import type { CapturedHeaders } from '../shared/types';

const MAX_CONCURRENCY = 6;
const MAX_RETRIES = 3;

function toHeaders(h: CapturedHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (h.referer) out['Referer'] = h.referer;
  if (h.authorization) out['Authorization'] = h.authorization;
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchBytes(
  url: string,
  headers: CapturedHeaders,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const res = await fetch(url, {
        headers: toHeaders(headers),
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      if (signal.aborted) throw e;
      lastErr = e;
      await sleep(250 * 2 ** attempt); // 250, 500, 1000ms
    }
  }
  throw new Error(`Failed after ${MAX_RETRIES} attempts: ${String(lastErr)}`);
}

/**
 * Fetch many URLs with bounded concurrency, preserving order. Calls `onDone`
 * each time any segment completes so the caller can report progress.
 */
export async function fetchAll(
  urls: string[],
  headers: CapturedHeaders,
  signal: AbortSignal,
  onDone: (completed: number, total: number) => void,
): Promise<Uint8Array[]> {
  const results: Uint8Array[] = new Array(urls.length);
  let completed = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      results[i] = await fetchBytes(urls[i], headers, signal);
      completed++;
      onDone(completed, urls.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, urls.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
