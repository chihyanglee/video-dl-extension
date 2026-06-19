# Plan 008 (SPIKE): Referer for offscreen segment/key fetches — investigate before building

## Status
- Priority: P3 | Effort: M (spike: S–M) | Risk: MED | Depends on: none
- Category: tech-debt / correctness (investigation)
- Planned at: commit `44f2f6d`, 2026-06-19
- **Recommendation: DO NOT execute yet — speculative.** Spike first; build only if a
  real failing CDN is found.

## Why this matters (and why it's held)

The offscreen download pipeline sets a `Referer` header on its segment and
AES-key fetches (`src/offscreen/fetcher.ts` `toHeaders`), but `Referer` is a
**forbidden fetch header** that the browser silently drops. The side panel works
around this for direct-file downloads with a scoped `declarativeNetRequest` rule
(`src/sidepanel/referer.ts`), but the **offscreen segment fetches have no such
fallback**. So a hotlink-protected *segment* CDN (one that 403s requests lacking
the page `Referer`) would fail mid-download.

**Why held:** no such failure has been observed. X/Twitter — the demuxed provider
this project targets — serves segments that do **not** gate on Referer (downloads
succeed today). The fix adds real complexity (a SW↔offscreen protocol to install/
remove DNR rules around a job, since `chrome.declarativeNetRequest` may not be
available in offscreen documents) for a hypothetical CDN. Per "prefer not-worth-
doing over speculative work," this is a spike: confirm the problem is real and the
mechanism works before committing to it.

## Current state

- `src/offscreen/fetcher.ts` `toHeaders` builds `{ Referer, Authorization }`;
  `fetchBytes`/`fetchAll` pass it to `fetch(..., { credentials: 'include' })`.
  The `Referer` is dropped by the browser.
- `src/sidepanel/referer.ts` `withRefererRule(url, referer, fn)` installs a
  scoped `chrome.declarativeNetRequest` session rule (modifyHeaders → set
  `referer`) for the duration of a fetch, then removes it. This works **from the
  side panel** (an extension page).
- `src/background/index.ts` owns the offscreen lifecycle and message routing;
  jobs carry `headers.referer` (a `DownloadJob.headers: CapturedHeaders`).
- `declarativeNetRequest` permission is already in the manifest.

## Spike tasks (investigation only — no production code commit required)

1. **Confirm the gap is reachable.** Identify whether any in-scope target CDN
   actually 403s segment requests without `Referer`. Test by fetching a segment
   URL with and without a `Referer` (e.g. via `curl -e` vs not, or a throwaway
   fetch). If none of the supported providers gate segments on Referer, record
   that and mark 008 REJECTED ("no reachable case").
2. **Determine the mechanism.** Verify whether `chrome.declarativeNetRequest`
   (specifically `updateSessionRules`) is callable **from an offscreen document**.
   - If YES: the offscreen pipeline can reuse a `withRefererRule`-style wrapper
     directly around `fetchAll`/`fetchBytes`, keyed by the segment host.
   - If NO: the rule must be installed from the SW. Design the protocol: SW, on
     `START_DOWNLOAD`, installs a session rule rewriting `Referer` for requests to
     the job's media host (scoped by `initiatorDomains`/`urlFilter`), and removes
     it when the job reaches a terminal phase (it already watches `JOB_PROGRESS`
     terminal phases in `maybeCloseOffscreen`).
3. **Define rule scope + cleanup.** Segments are many URLs under one host →
   `urlFilter` by host, `resourceTypes: ['xmlhttprequest']`. Ensure the rule is
   removed on done/error/cancel and that concurrent jobs (now serialized per plan
   005) don't leak rules. Note the rule-id allocation must not collide with
   `referer.ts`'s range (`>= 100000`).

## Deliverable of the spike

A short findings note appended here (or a follow-up plan `009`) stating:
- whether a reachable failing case exists,
- whether offscreen can call DNR directly or must go via the SW,
- the concrete rule scope + lifecycle,
- a go/no-go with effort estimate for the build plan.

Only after that, write/execute the implementation plan.

## STOP conditions
- If the spike shows no provider gates segments on Referer → mark 008 REJECTED in
  `plans/README.md` ("no reachable case; revisit if a gated CDN appears").
- Do not ship a SW-side global DNR rule without scoped cleanup — a leaked
  `modifyHeaders` rule would rewrite `Referer` on unrelated requests.

## Maintenance notes
- If implemented, document it alongside `referer.ts` and the CLAUDE.md "Forbidden
  fetch headers" note so the two Referer-rewrite paths (panel + offscreen) stay
  consistent.
