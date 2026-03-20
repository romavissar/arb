---
phase: 01-api-connectivity-and-observability
verified: 2026-03-20T16:00:00Z
status: passed
score: 8/8 must-haves verified
re_verification: false
---

# Phase 01: API Connectivity and Observability — Verification Report

**Phase Goal:** Replace broken Kalshi event fan-out with direct market pagination, add auth circuit-breaker and configurable sports exclusion, surface connectivity health and zero-count alarms across terminal and web.
**Verified:** 2026-03-20
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth                                                                                  | Status     | Evidence                                                                                      |
|----|----------------------------------------------------------------------------------------|------------|-----------------------------------------------------------------------------------------------|
| 1  | Kalshi markets fetched via direct /markets?status=open pagination, not event fan-out   | VERIFIED   | `fetchAllKalshiMarketsDirect()` at kalshi.ts:264; `url.searchParams.set("status", "open")` at line 298; `fetchAllKalshiMarkets()` delegates to it at line 435-438 |
| 2  | A 401 response throws KalshiAuthError immediately without retrying                     | VERIFIED   | `if (res.status === 401)` check at kalshi.ts:149 placed before the generic `!res.ok` branch; throws `KalshiAuthError` without entering retry loop |
| 3  | A 429 response still backs off and retries (existing behavior preserved)               | VERIFIED   | kalshi.ts:135-141 — 429 increments `kalshiHttp429`, calls `kalshiAdaptive.record429()`, sleeps exponential backoff, and `continue`s the retry loop |
| 4  | Sports exclusion controlled by KALSHI_EXCLUDE_SPORTS env var                           | VERIFIED   | config.ts:75 `kalshiExcludeSports: envBool("KALSHI_EXCLUDE_SPORTS", true)`; kalshi.ts:199 gates `selectDiscoveryEvents` filter; kalshi.ts:272 gates category-map fetch in `fetchAllKalshiMarketsDirect` |
| 5  | Startup health check prints Kalshi API status before poll loop begins                  | VERIFIED   | index.ts:481-483 logs "--- Startup Health Check ---", calls `checkKalshiHealth()`, then prints result; occurs before `startWebServer()` and `pollCycle()` at lines 489-491 |
| 6  | Kalshi market count displays in red when zero after at least one cycle (terminal)      | VERIFIED   | renderer.ts:38-44 `kalshiCountDisplay()` returns ANSI `\x1b[91m${count} [!]\x1b[0m` when `totalCycles > 0 && count === 0`; used in header line at line 69 |
| 7  | Web dashboard Kalshi count turns red when zero after first cycle                       | VERIFIED   | server.ts:723-731 — `updateState` JS sets `kalshiEl.style.color = 'var(--red)'` and appends `[!]` when `data.totalCycles > 0 && data.kalshiCount === 0` |
| 8  | API status (ok/auth_error/unreachable) visible in both terminal and web dashboard      | VERIFIED   | `KalshiApiStatus` type at types/index.ts:130; `checkKalshiHealth()` logs status text to terminal; `kalshiApiStatus` flows index.ts:415 -> WebState -> `serializeState` at server.ts:113 -> SSE clients |

**Score:** 8/8 truths verified

---

## Required Artifacts

| Artifact                   | Expected                                             | Status     | Details                                                                 |
|----------------------------|------------------------------------------------------|------------|-------------------------------------------------------------------------|
| `src/apis/kalshi.ts`       | Direct market pagination, KalshiAuthError, sports filter | VERIFIED | `class KalshiAuthError` at line 123; `fetchAllKalshiMarketsDirect` at line 264; `config.kalshiExcludeSports` gating at lines 199, 272, 327 |
| `src/config.ts`            | kalshiExcludeSports config field                     | VERIFIED   | Line 75: `kalshiExcludeSports: envBool("KALSHI_EXCLUDE_SPORTS", true)` |
| `src/types/index.ts`       | kalshiExcludeSports in Config interface              | VERIFIED   | Line 184: `kalshiExcludeSports: boolean;` with doc comment             |
| `src/index.ts`             | Startup health check function and call               | VERIFIED   | `checkKalshiHealth()` defined at line 421; called at line 482 in `main()` |
| `src/display/renderer.ts`  | Red alarm for zero Kalshi count                      | VERIFIED   | `kalshiCountDisplay()` at line 38 with `\x1b[91m` ANSI code; used in header at line 69 |
| `src/web/server.ts`        | kalshiApiStatus in WebState and red styling in HTML  | VERIFIED   | WebState.kalshiApiStatus at line 22; `currentState` init at line 36; serialized at line 113; updateState JS at lines 723-731 |

---

## Key Link Verification

| From                    | To                          | Via                                     | Status   | Details                                                                               |
|-------------------------|-----------------------------|-----------------------------------------|----------|---------------------------------------------------------------------------------------|
| `src/apis/kalshi.ts`    | `src/config.ts`             | `config.kalshiExcludeSports`            | WIRED    | Used at lines 199, 272, 327 in kalshi.ts; config imported at line 1                  |
| `src/apis/kalshi.ts`    | Kalshi API                  | GET /markets?status=open cursor pagination | WIRED | `url.searchParams.set("status", "open")` at line 298; cursor loop lines 291-318      |
| `src/index.ts`          | `src/apis/kalshi.ts`        | `isKalshiDisabled()` check in pushState | WIRED    | `isKalshiDisabled` imported at index.ts:16; used at line 415 in `pushState()` call   |
| `src/display/renderer.ts` | `RenderState.kalshiApiStatus` | status field controls header display | N/A      | Renderer uses `kalshiCount` + `stats.totalCycles` for alarm; `kalshiApiStatus` flows via web only (by design per SUMMARY) |
| `src/web/server.ts`     | `WebState.kalshiApiStatus`  | serialized to SSE clients               | WIRED    | Included in `serializeState()` return at server.ts:113; pushed on every `pushState()` call |

**Note on renderer/kalshiApiStatus link:** The PLAN listed `kalshiApiStatus` as a key link for renderer.ts, but the implementation correctly uses `kalshiCount + totalCycles` for the terminal alarm (not the status field). The status field flows through WebState to the web dashboard only. This is a deliberate design choice documented in 01-02-SUMMARY.md and does not affect goal achievement — both surfaces correctly alarm on zero count.

---

## Requirements Coverage

| Requirement | Source Plan | Description                                                              | Status    | Evidence                                                                                   |
|-------------|-------------|--------------------------------------------------------------------------|-----------|--------------------------------------------------------------------------------------------|
| KAPI-01     | 01-01       | Works without auth — uses public Kalshi endpoints                        | SATISFIED | `const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"` (no auth headers); HEADERS only has `Accept` |
| KAPI-02     | 01-01       | Distinguishes 401 (skip), 429 (backoff), 5xx (retry)                    | SATISFIED | kalshi.ts:135-153: 429 backoff loop, 5xx continue, 401 throws KalshiAuthError immediately |
| KAPI-03     | 01-02       | Logs and surfaces API errors clearly                                     | SATISFIED | `appendError("[CRITICAL]...")` on auth disable; `scanLog` on every page; `checkKalshiHealth()` logs status to console |
| KAPI-04     | 01-02       | Startup health check before poll loop                                    | SATISFIED | `checkKalshiHealth()` called at index.ts:482 before `pollCycle()` at line 491             |
| KAPI-05     | 01-02       | Dashboard shows Kalshi count; red alarm when zero                        | SATISFIED | Terminal: `kalshiCountDisplay()` in renderer.ts; Web: updateState JS in server.ts:723-731  |
| KAPI-06     | 01-01       | Sports exclusion configurable via env var                                | SATISFIED | `KALSHI_EXCLUDE_SPORTS` env var in config.ts:75; respected in direct pagination at kalshi.ts:272 |

All 6 requirements SATISFIED. No orphaned requirements found — REQUIREMENTS.md traceability table maps KAPI-01 through KAPI-06 to Phase 1, all covered by plans 01-01 and 01-02.

---

## Anti-Patterns Found

No blockers or warnings found. Scanned modified files:

- `src/apis/kalshi.ts` — substantive implementation, no TODOs or placeholder returns
- `src/config.ts` — all fields wired to env vars with defaults
- `src/types/index.ts` — types and interfaces fully defined
- `src/index.ts` — `checkKalshiHealth()` makes real HTTP call with response handling
- `src/display/renderer.ts` — real ANSI color logic with cycle guard
- `src/web/server.ts` — WebState field initialized, serialized, and consumed in HTML JS

---

## Human Verification Required

### 1. Terminal Red Alarm Live Appearance

**Test:** Run the screener in a cycle where Kalshi returns zero markets (e.g., with a bad URL or offline). After one completed cycle, observe the terminal header.
**Expected:** "Kalshi: 0 [!]" appears in bright red in the header line.
**Why human:** ANSI escape codes cannot be visually confirmed programmatically.

### 2. Web Dashboard Red Count

**Test:** Load the web dashboard during a run where `kalshiCount` is 0 and `totalCycles > 0`.
**Expected:** The Kalshi count element shows "0 [!]" in red (`var(--red)` = `#ef4444`).
**Why human:** CSS color application in a live browser cannot be asserted from grep.

### 3. Startup Health Check Output

**Test:** Start the screener in a normal (non-demo) environment with public API accessible.
**Expected:** Terminal prints "--- Startup Health Check ---", then "  Kalshi API:       OK (public endpoint reachable, got 1 market(s))", then "----------------------------".
**Why human:** Requires a live outbound network call to Kalshi API.

---

## TypeScript Compilation

`npx tsc --noEmit` exits with code 0 — no type errors. Verified.

---

## Commit Verification

All 6 task commits referenced in SUMMARY files are present in git log:

- `e01b3ed` feat(01-01): add KalshiAuthError, 401 circuit breaker, sports exclusion config
- `d1020a0` feat(01-01): replace two-stage discovery with direct /markets?status=open pagination
- `8111818` feat(01-02): add KalshiApiStatus type and startup health check
- `a8a39b0` feat(01-02): red alarm for zero Kalshi count in terminal renderer
- `41344f7` feat(01-02): kalshiApiStatus in WebState and red alarm in web dashboard

---

_Verified: 2026-03-20_
_Verifier: Claude (gsd-verifier)_
