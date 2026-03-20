# Phase 1: API Connectivity and Observability — Research

**Researched:** 2026-03-20
**Domain:** Kalshi REST API v2, TypeScript/Node.js HTTP error handling, terminal dashboard observability
**Confidence:** HIGH (evidence drawn from live codebase, runtime error logs, and official Kalshi API documentation cross-referenced via web sources)

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| KAPI-01 | Screener works without API authentication — uses Kalshi public endpoints that don't require auth | Endpoint verified: `GET /trade-api/v2/markets?status=open` and `GET /trade-api/v2/events` on `api.elections.kalshi.com` are documented as public. The 401 errors in `errors.log` are from the per-event `/markets?event_ticker=X` calls — likely an intermittent access-control change or a rate-limit quirk that returns 401 before 429. Switching to direct `/markets?status=open` pagination without the `event_ticker` filter is the correct fix. |
| KAPI-02 | Screener distinguishes 401 (skip/fallback) from 429 (backoff) from 5xx (retry) | Current code conflates 401 with generic HTTP errors in the throw path. The `kalshiFetchJson` function handles 429 and 5xx specially but throws `Kalshi HTTP 401` as a generic error caught per-event, which silently swallows it and continues. Need a 401 fast-path: stop retrying, log clearly, stop that endpoint for the session. |
| KAPI-03 | Screener logs and surfaces API errors clearly instead of silently swallowing them | Currently, per-event errors are caught and converted to a single `appendError` line but the poll loop continues. The dashboard header does not indicate API health. A `kalshiStatus` field needs to exist in `RenderState` and `WebState`. |
| KAPI-04 | Startup health check validates Kalshi API connectivity before starting poll loop | No health check exists. Currently `main()` jumps straight into `pollCycle()`. A pre-flight `GET /trade-api/v2/markets?limit=1&status=open` call with clear pass/fail console output is needed before `while (running)`. |
| KAPI-05 | Dashboard displays Kalshi market count prominently; shows red alarm when count is zero | `kalshiCount` already exists in `RenderState` and is displayed in the header. However: (1) it does not turn red when zero — it uses `formatNumber()` with no color logic, (2) the web dashboard serializes `kalshiCount` but the frontend HTML would need to style it. Both terminal renderer and web dashboard need zero-count color logic. |
| KAPI-06 | Sports event exclusion is configurable via env var (not hardcoded) | `isSportsEventCategory()` in `kalshi.ts` is hardcoded — no env var controls it. A `KALSHI_EXCLUDE_SPORTS` env var (default `true`) needs to be added to `config.ts` and plumbed through to `selectDiscoveryEvents()`. |

</phase_requirements>

---

## Summary

Phase 1 addresses the root cause of zero Kalshi market discovery and adds enough observability that the operator knows the system is working. The current codebase already has the structural scaffolding (rate limiting, adaptive backoff, error logging, market count in the header) but each piece has a gap that prevents correct operation.

The most critical finding is the 401/429 dual failure mode. The `errors.log` shows 83 lines of `Kalshi HTTP 401` from 2026-03-19, followed by 1,030 lines of `Kalshi 429` in subsequent sessions. Both failure modes are caused by the same architectural issue: the two-stage discovery (fetch all events, then fan out to `/markets?event_ticker=X` for each event) makes 300+ HTTP requests per discovery cycle. This burns through rate-limit headroom, generates 401 responses on the per-event calls (possibly Kalshi treating high-frequency unauthenticated event-scoped queries differently), and produces 429s when the rate limiter doesn't back off fast enough across the entire batch.

The solution is to replace the two-stage fan-out with direct `/markets?status=open` pagination — the same endpoint already used in the code but currently only used with `event_ticker`. Multiple authoritative sources confirm this endpoint is public without authentication. Kalshi's own quick-start documentation shows `GET /markets?limit=20&status=open` as a no-auth call.

**Primary recommendation:** Replace the two-stage events→markets fan-out with direct `GET /markets?status=open&limit=200` cursor pagination. Add a 401 circuit-breaker. Add a startup health check. Add zero-count red alarm in the dashboard.

---

## Standard Stack

### Core (No New Dependencies Needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js built-in `fetch` | Node 18+ (in use) | All HTTP calls to Kalshi API | Already proven, no overhead |
| `dotenv` | ^17.3.1 (in use) | Env var loading for new `KALSHI_EXCLUDE_SPORTS` | Already wired in `config.ts` |
| `cli-table3` | ^0.6.5 (in use) | Terminal dashboard table rendering | Already used in `renderer.ts` |
| ANSI escape codes (inline) | N/A | Red color for zero Kalshi count | Already used via `\x1b[91m` in `renderer.ts` |

### Supporting (Already Installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `undici` | ^7.24.4 (in package.json) | HTTP connection pool for high concurrency | Only needed if concurrency is raised above 10 requests; not required for this phase |

**Installation:** No new packages required.

---

## Architecture Patterns

### Recommended Project Structure Changes

No file additions needed for this phase. All changes are within existing files:

```
src/
├── apis/
│   └── kalshi.ts          # PRIMARY: replace 2-stage discovery, add 401 fast-path
├── config.ts              # Add KALSHI_EXCLUDE_SPORTS env var
├── types/index.ts         # Add kalshiApiStatus to RenderState and WebState
├── display/renderer.ts    # Add zero-count red alarm
├── web/server.ts          # Expose kalshiApiStatus in WebState serialization
└── index.ts               # Add startup health check before poll loop
```

### Pattern 1: Direct Markets Pagination (Replace Two-Stage Discovery)

**What:** Replace the `fetchAllEvents()` → `fetchMarketsForEventsBatch()` fan-out with a single `GET /markets?status=open` cursor-pagination loop.

**When to use:** Full discovery cycle (every `DISCOVERY_INTERVAL_CYCLES` cycles).

**Current approach (broken):** 1 events-list request + N per-event market requests = 300+ HTTP calls per discovery.

**New approach:** Single stream of paginated `/markets?status=open` requests = ~6–10 HTTP calls per discovery.

```typescript
// Source: pattern from existing fetchAllEvents() + STACK.md recommendation
async function fetchAllKalshiMarketsDirectly(): Promise<KalshiApiMarket[]> {
  const markets: KalshiApiMarket[] = [];
  let cursor = "";
  const MAX_PAGES = config.kalshiEventsDiscoveryMaxPages; // reuse existing config

  for (let page = 0; page < MAX_PAGES; page++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 3000);

    try {
      const url = new URL(`${BASE_URL}/markets`);
      url.searchParams.set("limit", String(config.kalshiPageSize));
      url.searchParams.set("status", "open");
      if (cursor) url.searchParams.set("cursor", cursor);

      const body = await kalshiFetchJson<KalshiMarketsResponse>(url.toString(), controller.signal);
      const data = body.markets ?? [];
      markets.push(...data);

      cursor = body.cursor ?? "";
      if (!cursor || data.length === 0) break;
    } catch (err) {
      appendError(`Kalshi direct market fetch error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  return markets;
}
```

**Note:** `KalshiApiMarket` has an `event_ticker` field — use it to look up event metadata from a separate (smaller) events fetch if the `title` field in the market response is sufficient. Verify that `/markets?status=open` returns `title` and `event_ticker` in the response shape. If titles are missing without `event_ticker` scoping, a hybrid approach is needed: fetch all events once (not 300 individual calls) and build a map, then fetch markets directly.

### Pattern 2: 401 Circuit Breaker

**What:** On a 401 response in `kalshiFetchJson`, throw a distinguishable error type that the caller catches to permanently stop that endpoint's fetching for the session.

**When to use:** In the retry loop inside `kalshiFetchJson`.

```typescript
class KalshiAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = "KalshiAuthError"; }
}

// Inside kalshiFetchJson retry loop, before the generic !res.ok throw:
if (res.status === 401) {
  throw new KalshiAuthError(`Kalshi 401 — endpoint requires auth or is restricted. Stop retrying.`);
}

// In fetchAllKalshiMarketsDirectly (or the events wrapper):
} catch (err) {
  if (err instanceof KalshiAuthError) {
    appendError(`[CRITICAL] Kalshi API returned 401. Endpoint may require authentication. Kalshi discovery disabled for this session.`);
    kalshiApiStatus = "auth_error"; // module-level status flag
    break; // stop all pagination immediately
  }
  appendError(`Kalshi fetch error: ${err instanceof Error ? err.message : String(err)}`);
  break;
}
```

### Pattern 3: Startup Health Check

**What:** A pre-flight request to Kalshi before entering the poll loop, with pass/fail output to console.

**When to use:** In `main()` before `await pollCycle()`.

```typescript
// In src/index.ts main()
async function checkKalshiHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${BASE_URL}/markets?limit=1&status=open`;
    const res = await fetch(url, { signal: controller.signal, headers: HEADERS });
    clearTimeout(timeout);
    if (res.ok) {
      console.log("  Kalshi API:       OK (public endpoint reachable)");
      return true;
    } else {
      console.log(`  Kalshi API:       FAIL (HTTP ${res.status})`);
      return false;
    }
  } catch (err) {
    clearTimeout(timeout);
    console.log(`  Kalshi API:       FAIL (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
```

### Pattern 4: Zero-Count Red Alarm in Terminal Renderer

**What:** When `kalshiCount === 0`, display the Kalshi count in red in the header.

**When to use:** In `renderer.ts` `render()` function header construction.

```typescript
// In renderer.ts — replace formatNumber(kalshiCount) with:
const kalshiDisplay = kalshiCount === 0
  ? `\x1b[91m${formatNumber(kalshiCount)}\x1b[0m`  // bright red
  : formatNumber(kalshiCount);

// In header string:
`Poly: ${formatNumber(polymarketCount)}  Kalshi: ${kalshiDisplay}`
```

### Anti-Patterns to Avoid

- **Don't add auth headers speculatively:** The requirement (KAPI-01) is to work WITHOUT auth. Do not add `Authorization: Bearer` header pre-emptively. If 401s occur, the circuit breaker logs and stops — does not retry with auth.
- **Don't retry on 401:** A 401 is a permanent failure (wrong endpoint or policy change). Retry logic for 401 creates infinite loops in the current code and is exactly what KAPI-02 prohibits.
- **Don't hide health check failures:** If the startup health check fails, log it clearly but still start the poll loop (demo mode still works; health check is diagnostic, not a gate).
- **Don't conflate 429 and 401 handling:** 429 = back off and retry; 401 = stop immediately and flag. These must be separate code paths.
- **Don't add sports exclusion logic in the new direct-markets path before testing:** The `isSportsEventCategory()` check works on event `category` field. Verify that the direct `/markets` response includes category data before relying on it. If not, sports filtering may need to be done on market titles instead.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Rate limiting | Custom delay logic | Existing `AdaptiveRateLimiter` + `TokenBucket` | Already handles 429 backoff, success ramp-up, and per-host coordination |
| Retry with backoff | Custom exponential backoff | Existing `kalshiFetchJson` retry loop | Already has `maxAttempts`, exponential backoff formula, 5xx retry logic |
| Error file logging | Custom `fs.writeFile` wrappers | Existing `appendError()` in `core/logging.ts` | Already timestamped, atomic append, never crashes the poll loop |
| Cursor pagination | Custom state machine | Existing pattern in `fetchAllEvents()` | Already handles dedup, max pages, cursor cycling |
| Config parsing | Custom env var reading | Existing `envBool()` in `config.ts` | Already handles missing vars, `true`/`1`/`yes` values, throws on invalid |

**Key insight:** The infrastructure for all Phase 1 requirements already exists. This phase is surgical modifications to existing code paths, not new infrastructure.

---

## Common Pitfalls

### Pitfall 1: 401 Loop Without Circuit Breaker (CONFIRMED IN errors.log)

**What goes wrong:** The current `kalshiFetchJson` does not special-case 401. The retry loop runs `maxAttempts=5` times on 401, each call returning 401 again. Then the per-event catch logs and continues. With 300 events × 5 attempts = 1,500 requests all returning 401 in a single discovery cycle.

**Why it happens:** The 401 is treated the same as any other non-OK, non-429, non-5xx status — it falls through to `throw new Error("Kalshi HTTP 401")` which the per-event catch swallows.

**How to avoid:** Add a 401 early-exit branch BEFORE the generic `!res.ok` throw. Throw a distinguishable `KalshiAuthError`. In the outer fetch function, catch `KalshiAuthError` separately and set a session-level `kalshiDisabled` flag.

**Warning signs:** `errors.log` filling with `Kalshi HTTP 401` at a rate of 1 per ~7 seconds (per the 401 block in current log).

---

### Pitfall 2: Sports Filter May Not Work on Direct Markets Response

**What goes wrong:** `isSportsEventCategory(category)` filters on the event's `category` field, which comes from `/events` response. The direct `/markets?status=open` response includes an `event_ticker` field but may not include the event's category. If category is absent, all sports markets will pass the filter.

**Why it happens:** The Kalshi API market object (`KalshiApiMarket` interface in the code) does not have a `category` field — that's only on `KalshiEvent`. In the current two-stage flow, the event metadata is fetched first and then joined. In the direct-markets flow, the event is not fetched.

**How to avoid:** Option A: fetch events list once (not per-event) to build a `eventTicker → category` map, then apply the sports filter during market processing. Option B: apply sports filtering on market `title` keywords as a fallback. Option C: add `KALSHI_EXCLUDE_SPORTS=false` as default if category data is unavailable, and document the tradeoff.

**Warning signs:** Sports markets appearing in the dashboard after switching to direct pagination.

---

### Pitfall 3: `status=open` Parameter May Be Ignored by Kalshi API

**What goes wrong:** The Kalshi API may silently ignore unknown or unsupported query parameters. If `status=open` is not actually supported on `/markets` without an `event_ticker`, the response will include all statuses (open, closed, settled) and discovered market count will include non-tradeable markets.

**Why it happens:** API parameter support varies; the current code does NOT use `status=open` on events, meaning it's never been tested in this codebase.

**How to avoid:** After implementing, verify the health check response contains only `status: "active"` markets by spot-checking a few returned items in a debug log line. If closed markets appear, add client-side `status === "active"` filtering (already done in `fetchMarketsForEventsBatch` — carry it forward).

**Warning signs:** Market count dramatically higher than expected (>5,000) on first direct scan, or markets with past close times appearing in results.

---

### Pitfall 4: Health Check Uses Same Broken Endpoint

**What goes wrong:** If the health check uses the same two-stage or per-event endpoint path that currently 401s, it will report "FAIL" even after implementing the direct-markets fix (because the fix is in a different code path).

**How to avoid:** The health check must specifically test the new direct `/markets?limit=1&status=open` endpoint path, not a code path that goes through `fetchAllEvents()`.

---

### Pitfall 5: Zero-Count Alarm Fires During Startup Before First Fetch

**What goes wrong:** On startup, `kalshiCount = 0` (initial value in `RenderState`). If the red alarm triggers immediately, the operator sees a red alarm on every startup before data arrives, making the alarm noise rather than signal.

**How to avoid:** Only trigger the alarm after at least one successful discovery cycle has completed. Gate the red alarm on `stats.totalCycles > 0 && kalshiCount === 0` rather than just `kalshiCount === 0`.

---

## Code Examples

### Verified Pattern: How to Distinguish 401 from Other Errors

```typescript
// In kalshiFetchJson — insert BEFORE the existing !res.ok check:
if (res.status === 401) {
  // Not a transient error — do not retry. Surface immediately.
  throw new KalshiAuthError(
    `Kalshi 401 Unauthorized — endpoint at ${url} returned 401. ` +
    `No auth header is configured. This endpoint may require authentication.`
  );
}

if (res.status >= 500 && i < maxAttempts - 1) {
  await new Promise((r) => setTimeout(r, 1000));
  continue; // existing 5xx retry
}

if (!res.ok) {
  throw new Error(`Kalshi HTTP ${res.status}`);
}
```

### Verified Pattern: Env Bool for Sports Exclusion

```typescript
// In config.ts — add alongside existing envBool calls:
kalshiExcludeSports: envBool("KALSHI_EXCLUDE_SPORTS", true),

// In types/index.ts Config interface:
kalshiExcludeSports: boolean;

// In kalshi.ts selectDiscoveryEvents():
const nonSports = config.kalshiExcludeSports
  ? events.filter((e) => !isSportsEventCategory(e.category))
  : events;
```

### Verified Pattern: ANSI Red for Zero Count (from existing renderer.ts)

```typescript
// The renderer already uses \x1b[91m for STALE alerts — use same pattern for zero count:
// Existing staleIndicator():  return `  \x1b[91m[${name} STALE ${seconds}s]\x1b[0m`;

// New kalshiCountDisplay():
function kalshiCountDisplay(count: number, hasCycled: boolean): string {
  if (hasCycled && count === 0) {
    return `\x1b[91m${formatNumber(count)}\x1b[0m`;  // red
  }
  return formatNumber(count);
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Two-stage fan-out: events → per-event markets | Direct `/markets?status=open` pagination | Phase 1 | 300+ requests → 6-10 requests per discovery; eliminates 401/429 cascade |
| Silent 401 swallowed per-event | 401 circuit-breaker with session-level disable flag | Phase 1 | Operator knows immediately why Kalshi count is 0 |
| No startup health check | Pre-flight connectivity test before poll loop | Phase 1 | Pass/fail visible before any data is fetched |
| Sports exclusion hardcoded | `KALSHI_EXCLUDE_SPORTS` env var (default `true`) | Phase 1 | Operator can enable sports markets without code changes |
| Kalshi count always white | Zero count displayed in red | Phase 1 | Dashboard alarm is visible immediately |

**Deprecated in this phase:**
- `fetchAllEvents()` — replaced by a simpler single-endpoint discovery path (or kept as a fallback if the direct endpoint fails to include category data)
- `fetchMarketsForEventsBatch()` — replaced by direct pagination; the event-scoped batch fetcher is still used for REFRESH mode (not discovery)

---

## Open Questions

1. **Does `GET /trade-api/v2/markets?status=open` (no `event_ticker`) include `title` in the response, or only `ticker`?**
   - What we know: `KalshiApiMarket.title` is in the type and used in `buildTitle()`. The direct endpoint hasn't been tested.
   - What's unclear: Whether titles are populated without the event context.
   - Recommendation: In the implementation, log the first 3 returned market items to verify all needed fields are present. If `title` is empty, the fallback is to use `ticker` as the title or keep the event-join for title construction only.

2. **Does the 401 error come from `/markets?event_ticker=X` specifically, or from all Kalshi endpoints?**
   - What we know: `errors.log` shows 83 lines of 401 from March 19 sessions. All are from `Kalshi fetch error` (the per-event market fetch error path). No 401s from the events endpoint.
   - What's unclear: Whether the 401s are specific to `event_ticker`-filtered queries or whether direct `/markets` also 401s.
   - Recommendation: The startup health check answers this definitively before any discovery logic runs.

3. **What is the total count of active Kalshi markets when fetched directly (without the 300-event cap)?**
   - What we know: Current two-stage discovery finds ~1,200 markets from ~300 events.
   - What's unclear: The actual universe — could be 1,200–5,000 markets.
   - Recommendation: Log the total count from the first direct scan run. This number determines whether the existing `KALSHI_MAX_EVENTS_DISCOVERY` cap needs replacement with a `KALSHI_MAX_MARKETS_DIRECT` cap.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None currently installed |
| Config file | None — see Wave 0 |
| Quick run command | `npx tsx --test src/**/*.test.ts` (after setup) |
| Full suite command | `npx tsx --test src/**/*.test.ts` |

**Note:** The project has no test framework configured as of this research. The `package.json` has no `vitest`, `jest`, or `node:test` setup. For this phase, testing the health check and 401 handling should be done with Node's built-in test runner (`node:test`) which requires no additional install.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| KAPI-01 | Health check returns true on successful 200 from `/markets?limit=1` | unit (mock fetch) | `node --test src/apis/kalshi.test.ts` | No — Wave 0 |
| KAPI-02 | `kalshiFetchJson` throws `KalshiAuthError` on 401, does not retry | unit (mock fetch) | `node --test src/apis/kalshi.test.ts` | No — Wave 0 |
| KAPI-02 | `kalshiFetchJson` retries on 429 with backoff | unit (mock fetch) | `node --test src/apis/kalshi.test.ts` | No — Wave 0 |
| KAPI-02 | `kalshiFetchJson` retries on 5xx (up to maxAttempts) | unit (mock fetch) | `node --test src/apis/kalshi.test.ts` | No — Wave 0 |
| KAPI-03 | 401 error produces a line in errors.log with `[CRITICAL]` prefix | integration (live or mock) | manual verify | No |
| KAPI-04 | `checkKalshiHealth()` returns false on non-OK response | unit (mock fetch) | `node --test src/index.test.ts` | No — Wave 0 |
| KAPI-05 | `kalshiCountDisplay(0, true)` returns ANSI red string | unit | `node --test src/display/renderer.test.ts` | No — Wave 0 |
| KAPI-06 | `KALSHI_EXCLUDE_SPORTS=false` causes sports events to pass filter | unit | `node --test src/apis/kalshi.test.ts` | No — Wave 0 |

### Sampling Rate

- **Per task commit:** `node --test src/apis/kalshi.test.ts` (covers KAPI-01, KAPI-02, KAPI-06)
- **Per wave merge:** `node --test src/**/*.test.ts`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/apis/kalshi.test.ts` — covers KAPI-01, KAPI-02, KAPI-06 (mock fetch, no network required)
- [ ] `src/display/renderer.test.ts` — covers KAPI-05 (pure function, no I/O)
- [ ] `src/index.test.ts` — covers KAPI-04 (mock fetch for health check)
- [ ] Framework install: None needed — use `node:test` built-in + `node:assert`

---

## Sources

### Primary (HIGH confidence)

- `/Users/rom/Documents/coding/arb-screener-v2/src/apis/kalshi.ts` — direct code inspection; all function names, error paths, and type definitions verified here
- `/Users/rom/Documents/coding/arb-screener-v2/errors.log` — runtime evidence: 83 × 401 errors (2026-03-19), 1,030 × 429 errors (2026-03-19 to 2026-03-20)
- `/Users/rom/Documents/coding/arb-screener-v2/src/config.ts` — all env var names and defaults verified here
- `/Users/rom/Documents/coding/arb-screener-v2/src/display/renderer.ts` — ANSI color patterns, RenderState interface
- `/Users/rom/Documents/coding/arb-screener-v2/.planning/research/PITFALLS.md` — prior research confirming 401 issue, circuit-breaker recommendation
- `/Users/rom/Documents/coding/arb-screener-v2/.planning/research/STACK.md` — direct markets scan recommendation, `status=open` parameter
- `agentbets.ai/guides/prediction-market-api-reference/` — confirmed: `GET /markets?limit=20&status=open` is public, no auth required

### Secondary (MEDIUM confidence)

- WebSearch results for "Kalshi API v2 public endpoints without authentication" — multiple sources confirm `api.elections.kalshi.com` endpoints are public for read access; no single authoritative source due to expired SSL certificate on docs.kalshi.com
- `github.com/AndrewNolte/KalshiPythonClient` — confirms API key goes in Authorization header, but doesn't specify which endpoints require it

### Tertiary (LOW confidence)

- Network test results: SSL certificate error on `api.elections.kalshi.com` from this machine (ISP block/Romania gambling restriction proxy), so live endpoint testing was not possible during research. The 404 responses from `curl -k` may be due to the proxy interception, not the actual Kalshi server.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, existing code is the reference
- Architecture patterns: HIGH — all patterns derived from existing working code in the same file
- Pitfalls: HIGH for Pitfalls 1, 2, 5 (direct runtime evidence); MEDIUM for Pitfalls 3, 4 (code analysis + inference)
- Kalshi public endpoint status: MEDIUM — documented as public by third-party sources; live verification blocked by network restrictions in research environment

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (Kalshi API policy could change; re-verify endpoint accessibility before implementation)
