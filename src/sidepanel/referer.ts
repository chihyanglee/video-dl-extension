// Shared Referer-rewrite helpers for the side panel. fetch() cannot set the
// forbidden `Referer` header, so we wrap requests in a scoped, self-removing
// declarativeNetRequest session rule (see manifest `declarativeNetRequest`).

// Session-rule id in a high range to avoid clashing with any static rules.
let drnRuleSeq = 100000;

/**
 * Install a standalone Referer rewrite that lives until you remove it. Use for a
 * <video>/<audio> element, which streams over many range requests across its
 * lifetime — a fetch-scoped rule (withRefererRule) would be gone after the first.
 * Element media requests are resourceType `media`, so include it. Returns the
 * rule id; pass it to removeRefererRule on teardown.
 */
export async function installRefererRule(
  urlFilter: string,
  referer: string,
  resourceTypes = ['media', 'xmlhttprequest'] as chrome.declarativeNetRequest.ResourceType[],
): Promise<number> {
  const ruleId = ++drnRuleSeq;
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
        condition: { urlFilter, resourceTypes },
      } as chrome.declarativeNetRequest.Rule,
    ],
  });
  return ruleId;
}

export async function removeRefererRule(ruleId: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

/** Run `fn` with `Referer` forced to `referer` for requests matching `url`. */
export async function withRefererRule<T>(
  url: string,
  referer: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ruleId = ++drnRuleSeq;
  if (referer) {
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
          condition: { urlFilter: url, resourceTypes: ['xmlhttprequest'] },
        } as chrome.declarativeNetRequest.Rule,
      ],
    });
  }
  try {
    return await fn();
  } finally {
    if (referer) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    }
  }
}

/** Stream `url` to a Blob; `onProgress(received, total)` drives a progress bar. */
export async function fetchWithReferer(
  url: string,
  referer: string | undefined,
  onProgress?: (received: number, total: number) => void,
): Promise<Blob> {
  return withRefererRule(url, referer, async () => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body) return await res.blob(); // no stream available; can't track
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
    return new Blob(chunks as BlobPart[], {
      type: res.headers.get('content-type') ?? 'application/octet-stream',
    });
  });
}

export interface ProbeResult {
  status: number;
  contentType: string;
  /** Present only for fetchText. Truncated to maxBytes. */
  text?: string;
  error?: string;
}

/** HEAD-like check: fetch and report status + content-type (detects 403/expiry). */
export async function probe(url: string, referer?: string): Promise<ProbeResult> {
  try {
    return await withRefererRule(url, referer, async () => {
      const res = await fetch(url, { credentials: 'include' });
      return { status: res.status, contentType: res.headers.get('content-type') ?? '' };
    });
  } catch (e) {
    return { status: 0, contentType: '', error: String(e) };
  }
}

/** Fetch and return the first `maxBytes` of the body as text (manifest viewer). */
export async function fetchText(
  url: string,
  referer?: string,
  maxBytes = 4000,
): Promise<ProbeResult> {
  try {
    return await withRefererRule(url, referer, async () => {
      const res = await fetch(url, { credentials: 'include' });
      const body = await res.text();
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        text: body.slice(0, maxBytes),
      };
    });
  } catch (e) {
    return { status: 0, contentType: '', error: String(e) };
  }
}
