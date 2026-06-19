# Plan 006: Stop capturing/persisting session cookies (security hygiene + least privilege)

## Status
- Priority: P3 | Effort: S | Risk: LOW | Depends on: none
- Category: security
- Planned at: commit `5157f9d`, 2026-06-19

## Why this matters

Detection captures the request `Cookie` header and assembles a full cookie string
(`ensureCookie` via `chrome.cookies.getAll`), stores it in `Detection.headers.cookie`
in `chrome.storage.session`, and passes it into download jobs — **but it is never
sent**. `Cookie` is a forbidden `fetch` header; all fetches use
`credentials: 'include'`, which attaches cookies automatically. So the captured
value does nothing functional while parking sensitive session cookies in
extension storage. Remove the capture/assembly/storage and drop the now-unused
`cookies` permission (least privilege).

## Current state

`src/background/detect.ts`:
- Line 44 — captures cookie: `else if (n === 'cookie') h.cookie = value;`
- Lines ~59–66 — `ensureCookie(url, captured?)` uses `chrome.cookies.getAll`.
- Three call sites assign it: line 101 (`classifyAndStore`), line 347 (`classifyDash`),
  line 405 (`classifyFile`): `headers.cookie = await ensureCookie(<url>, headers.cookie);`
- `ensureCookie` is the **only** user of `chrome.cookies`.

`src/shared/types.ts` (lines 5–11):
```ts
export interface CapturedHeaders {
  referer?: string;
  origin?: string;
  userAgent?: string;
  cookie?: string;
  authorization?: string;
}
```

`src/manifest.config.ts` — `permissions` array includes `'cookies'` (line 28).

`src/offscreen/fetcher.ts` `toHeaders` and `src/background/detect.ts` `toFetchHeaders`
already ignore cookie (only set Referer/Authorization). Nothing reads
`headers.cookie` to send it.

Conventions: TS strict, ESM, 2-space indent, pnpm. `noUnusedLocals`/`noUnusedParameters` on.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test run` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

In scope: `src/background/detect.ts`, `src/shared/types.ts`, `src/manifest.config.ts`.
Out of scope: fetch logic, message shapes, UI, anything else.

## Git workflow
Branch `advisor/006-drop-cookie-capture`. Conventional commit e.g. `security: stop capturing/persisting session cookies`. No push/PR.

## Steps

### Step 1: Remove cookie capture + ensureCookie from detect.ts
- Delete line 44 (`else if (n === 'cookie') h.cookie = value;`) from `headersFromArray`.
- Delete the `ensureCookie` function (the `/** Assemble a Cookie header ... */`
  doc comment + the function body, ~lines 59–67).
- Delete the three `headers.cookie = await ensureCookie(...);` lines (in
  `classifyAndStore`, `classifyDash`, `classifyFile`). Removing the `await` is
  fine — those functions remain `async`.

Verify: `grep -n "cookie\|ensureCookie\|chrome.cookies" src/background/detect.ts`
→ matches only the explanatory comment near `toFetchHeaders` ("Cookie/User-Agent/
Origin are forbidden fetch headers ...") and nothing else functional.

### Step 2: Remove the `cookie` field from CapturedHeaders
In `src/shared/types.ts`, delete the `cookie?: string;` line from `CapturedHeaders`.

Verify: `grep -rn "\.cookie\b" src/` → no remaining reads/writes of `headers.cookie`
(only unrelated matches, if any). `pnpm typecheck` → exit 0 (this catches any
missed reference).

### Step 3: Drop the unused `cookies` permission
In `src/manifest.config.ts`, remove `'cookies',` from the `permissions` array.

Verify: `grep -rn "chrome.cookies" src/` → no matches (permission is unused).

### Step 4: Full green
Verify: `pnpm typecheck` exit 0, `pnpm test run` exit 0, `pnpm build` exit 0.
Confirm the built manifest no longer requests cookies:
`grep -c '"cookies"' dist/manifest.json` → `0`.

## Done criteria (ALL)
- `grep -rn "chrome.cookies\|ensureCookie" src/` → no matches.
- `CapturedHeaders` has no `cookie` field.
- `dist/manifest.json` does not contain `"cookies"`.
- `pnpm typecheck` / `pnpm test run` / `pnpm build` all exit 0.
- Only the three in-scope files changed.

## STOP conditions
- "Current state" excerpts don't match live code (drift since `5157f9d`).
- `grep -rn "\.cookie" src/` after Step 2 reveals a real consumer that *sends*
  the cookie (would mean it isn't dead) — STOP and report; do not remove it.
- Typecheck reveals a reference outside the in-scope files.

## Maintenance notes
- Cookies still reach requests via `credentials: 'include'`; this change only
  stops the redundant capture/persistence. If a future feature needs to read
  cookies (e.g. a token for a signed URL), reintroduce the `cookies` permission
  deliberately and document why.
- Reviewer: confirm no download path regressed (cookie-gated CDNs still work via
  `credentials: 'include'`).
