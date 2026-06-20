import type { CapturedHeaders } from '../shared/types';
import type { SegmentRef } from '../shared/m3u8';

const MAX_CONCURRENCY = 6;
const MAX_RETRIES = 3;

function toHeaders(h: CapturedHeaders, byteRange?: { offset: number; length: number }): Record<string, string> {
  const out: Record<string, string> = {};
  if (h.referer) out['Referer'] = h.referer;
  if (h.authorization) out['Authorization'] = h.authorization;
  // CMAF single-file segments: request just this sub-range of the .m4s.
  if (byteRange) out['Range'] = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchBytes(
  url: string,
  headers: CapturedHeaders,
  signal: AbortSignal,
  byteRange?: { offset: number; length: number },
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const res = await fetch(url, {
        headers: toHeaders(headers, byteRange),
        credentials: 'include',
        signal,
      });
      // A Range request should yield 206; some servers answer 200 with the full
      // body (then we'd have the bytes anyway). Both are acceptable.
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
  segs: SegmentRef[],
  headers: CapturedHeaders,
  signal: AbortSignal,
  onDone: (completed: number, total: number) => void,
): Promise<Uint8Array[]> {
  const results: Uint8Array[] = new Array(segs.length);
  let completed = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= segs.length) return;
      results[i] = await fetchBytes(segs[i].url, headers, signal, segs[i].byteRange);
      completed++;
      onDone(completed, segs.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, segs.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
