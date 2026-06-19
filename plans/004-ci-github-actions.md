# Plan 004: Add CI (GitHub Actions) — typecheck + build + test on push/PR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for plan 004 in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 16db614..HEAD -- package.json`
> If `package.json` scripts changed, reconcile the command names below with the
> live `scripts` before writing the workflow.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-test-suite-vitest.md (for the `test` step; if 001
  isn't done yet, omit the test step and add it when 001 lands)
- **Category**: dx / tooling
- **Planned at**: commit `16db614`, 2026-06-19

## Why this matters

There is no CI. The only thing standing between a broken change and `main` is
whoever remembers to run `pnpm build` locally. This repo has already shipped
regressions that a CI gate would have caught immediately — the UMD-vs-ESM
ffmpeg-core break and the "`chrome.downloads` unavailable in offscreen" break
both compiled fine but were broken paths. A minimal GitHub Actions workflow that
installs, typechecks, builds, and runs the test suite on every push and PR turns
those into red checks instead of shipped bugs.

## Current state

- Package manager: **pnpm** (`packageManager: "pnpm@11.6.0"` in `package.json`),
  lockfile `pnpm-lock.yaml` committed, `pnpm-workspace.yaml` present.
- Relevant scripts in `package.json`:
  ```json
  "typecheck": "tsc --noEmit",
  "build": "tsc --noEmit && vite build",
  // plan 001 adds:  "test": "vitest"
  ```
- No `.github/` directory exists yet.
- Node: the project targets a modern runtime (TS `target` ES2022, `@types/node`
  v22). Use Node 20 LTS in CI (matches the README's "Node ≥ 20").
- Default branch is `main` (from `git log` / repo state).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Local sanity (mirrors CI) | `pnpm install --frozen-lockfile` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Build | `pnpm build` | exit 0 |
| Test (if 001 done) | `pnpm test run` | exit 0 |
| YAML sanity | `cat .github/workflows/ci.yml` | valid YAML, no tabs |

## Scope

**In scope** (create only):
- `.github/workflows/ci.yml`

**Out of scope** (do NOT touch):
- `package.json`, source, lockfile. This plan adds CI config only. (If you find
  `pnpm install --frozen-lockfile` fails because the lockfile is stale, that's a
  STOP condition — do not regenerate the lockfile here.)

## Git workflow

- Branch: `advisor/004-ci`
- Conventional commit, e.g. `ci: add GitHub Actions typecheck/build/test workflow`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Write `.github/workflows/ci.yml`

Create the file exactly as below. Pin the pnpm version to the one in
`package.json` (`11.6.0`). If plan 001 is **not** yet merged (no `test` script),
delete the "Test" step and keep the rest.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.6.0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test run

      - name: Build
        run: pnpm build
```

**Verify**: `cat .github/workflows/ci.yml` prints the file; it contains no tab
characters (`grep -nP "\t" .github/workflows/ci.yml` → no output).

### Step 2: Prove the CI command sequence passes locally

Run the exact sequence CI will run, from a clean install:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test run     # only if plan 001 is merged
pnpm build
```

**Verify**: each command exits 0. If `pnpm test run` fails because plan 001
isn't merged yet (no `test` script), confirm you removed the Test step from the
workflow in Step 1.

## Test plan

No application tests in this plan. Verification is:
- The workflow file is valid YAML with the correct, repo-matching commands.
- The same command sequence passes locally (Step 2), which is what the runner
  executes.

(There is no local GitHub Actions runner assumed. The real end-to-end check is
the first green run after this lands on a branch with Actions enabled.)

## Done criteria

ALL must hold:

- [ ] `.github/workflows/ci.yml` exists and is valid YAML (no tabs).
- [ ] Its steps are: checkout → pnpm setup (v11.6.0) → node 20 + pnpm cache →
      `pnpm install --frozen-lockfile` → `pnpm typecheck` → (`pnpm test run` if
      001 merged) → `pnpm build`.
- [ ] Local run of that exact sequence exits 0 at every step.
- [ ] Only `.github/workflows/ci.yml` was created (`git status`).
- [ ] `plans/README.md` status row for 004 updated.

## STOP conditions

Stop and report (do not improvise) if:

- `pnpm install --frozen-lockfile` fails (stale lockfile) — do not regenerate it
  here; report so it's handled deliberately.
- `pnpm typecheck` or `pnpm build` fails on the current tree — that's a
  pre-existing breakage; report it rather than working around it in CI.
- The repo's package manager or default branch differs from what's stated above.

## Maintenance notes

- When lint/format tooling is added later, add steps here (kept as separate steps
  so a failure points at the exact gate).
- If the build starts needing secrets or a longer timeout (ffmpeg core is ~32 MB
  but committed, so install/build stay cheap today), revisit the runner config.
- Reviewer: confirm the pinned pnpm version matches `packageManager` in
  `package.json` — a mismatch makes CI install differently than local.
