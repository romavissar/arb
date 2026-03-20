# Technology Stack — Kalshi API Optimization Milestone

**Project:** Polymarket ↔ Kalshi Arbitrage Screener
**Researched:** 2026-03-20
**Scope:** Existing TypeScript/Node.js codebase — incremental optimization milestone only.

---

## Context: What the Codebase Already Has

This research is grounded in direct analysis of the existing source code. The following are confirmed facts, not hypotheses:

- `src/apis/kalshi.ts` — two-stage discovery: fetch all events via `/trade-api/v2/events`, then fan out to `/trade-api/v2/markets?event_ticker=<ticker>` per event
- `src/core/rateLimit.ts` — working `TokenBucket` + `AdaptiveRateLimiter` (success-streak ramp-up, 429-decay)
- `src/config.ts` — full env-var configuration surface; relevant Kalshi knobs: `KALSHI_EVENTS_DISCOVERY_MAX_PAGES` (20), `KALSHI_MAX_EVENTS_DISCOVERY` (300), `KALSHI_MARKETS_MAX_PAGES_PER_EVENT_DISCOVERY` (3), `KALSHI_DISCOVERY_CONCURRENCY` (5), `KALSHI_RATE_MIN_RPS` (1.5), `KALSHI_RATE_MAX_RPS` (4)
- `src/core/matcher.ts` — inverted-index + Jaccard/bigram/date scoring; threshold at 0.60; requires `MIN_SHARED_TOKENS` (2) for a pair to be evaluated
- Discovery finds ~1,200 Kalshi markets from ~300 events; only 3 matched pairs from 763K candidate evaluations

---

## Root Cause Analysis (Diagnostic, Not Speculation)

Three distinct failure modes are visible in the code:

**1. Kalshi market coverage is capped at ~300 events (not all events)**
`selectDiscoveryEvents()` hard-caps at `KALSHI_MAX_EVENTS_DISCOVERY` (300) and filters out sports entirely. The Kalshi event universe likely exceeds this. Events with a priority score of 0 are round-robined, meaning many events never surface their markets.

**2. The two-stage fetch (events → markets per event) burns RPS budget on overhead**
Each event requires at least one HTTP call to `/markets?event_ticker=X`. With concurrency=5 and 300 events, that's 60 serial batches at 1.5–4 RPS each. Estimated discovery time: 75–200 seconds just for Kalshi, which competes with the poll cycle.

**3. Matching is token-count sensitive — short titles produce few tokens and miss the `MIN_SHARED_TOKENS=2` gate**
A Kalshi market titled "Trump - Approval Rating" and a Polymarket market "Donald Trump approval above 45%?" may each produce ≤3 relevant tokens after normalization, making the 2-token overlap gate fragile.

---

## Recommended Stack — No New Dependencies Required

The existing stack (Node.js built-in `fetch`, `TokenBucket`, `AdaptiveRateLimiter`, `dotenv`) is sufficient. No new npm packages are needed. Every recommendation below is a code or configuration change.

### Core HTTP Client

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js built-in `fetch` | Node 18+ (already in use) | All HTTP calls | Already proven; no overhead from extra libraries |
| `undici` | ^7.24.4 (already in package.json) | Available if parallel connection pooling needed | `undici.Pool` allows multiple concurrent connections to the same host; use if concurrency is raised above 10 |

**Verdict:** Do not add `axios`, `got`, `node-fetch`, or `p-limit`. The existing fetch + TokenBucket pattern works. `undici.Pool` is already installed if you need HTTP/1.1 connection reuse under high concurrency.

**Confidence: HIGH** — based on direct code inspection.

---

## Kalshi API Endpoints — What to Use

**Confidence for endpoint shape: MEDIUM** — derived from existing working code + official API base URL `https://api.elections.kalshi.com/trade-api/v2`. External web access was unavailable during this research session; these are grounded in the currently working implementation.

### Endpoint 1: `GET /trade-api/v2/events`

**Currently used.** Returns paginated list of events.

Query parameters confirmed working in existing code:
```
limit     — page size (currently KALSHI_PAGE_SIZE = 200; max is likely 200)
cursor    — opaque pagination cursor from previous response
status    — NOT currently used; should filter to "open" to skip resolved events early
```

**Optimization gap:** The code does not pass `status=open`. Every page includes resolved/closed events that get filtered out after fetching. Adding `status=open` reduces pages needed and total bytes transferred.

Recommended URL construction:
```typescript
url.searchParams.set("limit", String(config.kalshiPageSize));
url.searchParams.set("status", "open");  // ADD THIS — skip resolved events server-side
if (cursor) url.searchParams.set("cursor", cursor);
```

### Endpoint 2: `GET /trade-api/v2/markets`

**Currently used** (with `event_ticker` filter). Also supports direct pagination without event scoping.

Key parameters confirmed working:
```
limit          — page size
cursor         — pagination cursor
event_ticker   — filter to one event (current approach)
status         — "open" filters to active markets server-side
```

**Optimization gap — direct markets pagination:** The API supports fetching markets directly (no `event_ticker` required), paginating through all active markets in one stream. This bypasses the two-stage events→markets fan-out entirely.

Recommended discovery strategy (direct markets scan):
```typescript
// Replace the two-stage approach for full coverage
const url = new URL(`${BASE_URL}/markets`);
url.searchParams.set("limit", "200");
url.searchParams.set("status", "open");  // active markets only
if (cursor) url.searchParams.set("cursor", cursor);
```

This single-stream approach:
- Eliminates the N×1 HTTP calls per event (300 events × 1+ calls = 300+ requests → replaced by ~6–10 pages)
- Gets ALL Kalshi markets, not just those under selected events
- Is compatible with the existing cursor-based pagination loop already in `fetchAllEvents()`

**Confidence: MEDIUM** — The `/markets` endpoint accepting no `event_ticker` is a standard REST API pattern and is structurally supported by the existing `KalshiMarketsResponse` type. Validate this is accessible without auth before committing to the refactor.

### Endpoint 3: `GET /trade-api/v2/markets/{ticker}`

Not currently used. Useful for single-market refresh without re-fetching the whole event. Already supported by the existing `fetchMarketsForEventTargets` targeted refresh logic.

---

## Rate Limit Optimization

**Confidence: HIGH for existing behavior** (direct code analysis). **MEDIUM for ceiling** (Kalshi's undocumented public API rate limit is not verified externally).

### What the Current Adaptive Limiter Does

- Starts at 1.5 RPS, ramps up 0.25 RPS every 25 consecutive successes
- Decays by 0.75 RPS on any 429
- Caps at 4.0 RPS
- Concurrency: 5 simultaneous event fetches (each awaiting `acquire()` independently)

### The Problem: Concurrency and RPS Are Not Properly Coordinated

The `AdaptiveRateLimiter` has one token bucket shared across all 5 concurrent goroutines. With `concurrency=5` and `effectiveRps=4`, each concurrent fetch competes for 4 tokens/second. In practice the system uses ≤4 HTTP calls/second regardless of concurrency setting. Raising concurrency without raising `KALSHI_RATE_MAX_RPS` has no throughput benefit.

Actual ceiling math:
- 300 events × avg 1.2 pages each = 360 requests at 4 RPS = 90 seconds minimum
- With direct markets scan: ~8 pages at 4 RPS = 2 seconds

### Recommended Configuration Changes

```bash
# Current (too conservative for public API, and sub-optimal structurally)
KALSHI_RATE_MIN_RPS=1.5
KALSHI_RATE_MAX_RPS=4
KALSHI_DISCOVERY_CONCURRENCY=5
KALSHI_ADAPTIVE_SUCCESS_BEFORE_BUMP=25

# Recommended (if switching to direct markets scan)
KALSHI_RATE_MIN_RPS=2
KALSHI_RATE_MAX_RPS=8          # Test carefully — bump only if no 429s observed
KALSHI_ADAPTIVE_SUCCESS_BEFORE_BUMP=10   # Ramp up faster
KALSHI_ADAPTIVE_BUMP_RPS=0.5   # Larger bumps
KALSHI_ADAPTIVE_DECAY_ON429=1.0  # Steeper penalty to recover gracefully
```

With direct markets scanning, discovery shrinks from 300+ requests to ~6–10, so rate limits become largely irrelevant for discovery. The rate budget is then better spent on refresh cycles.

### 429 Backoff: Current Logic is Correct, Minor Improvement Available

Current: exponential backoff with `Math.min(2000 * Math.pow(2, i), 30000)`.

The code does not read the `Retry-After` response header on 429s (Polymarket does, Kalshi does not). Add this:

```typescript
if (res.status === 429) {
  kalshiHttp429++;
  kalshiAdaptive.record429();
  const retryAfter = parseInt(res.headers.get("retry-after") ?? "0", 10);
  const backoff = retryAfter > 0
    ? retryAfter * 1000
    : Math.min(2000 * Math.pow(2, i), 30000);
  await new Promise((r) => setTimeout(r, backoff));
  continue;
}
```

---

## Short-Term Market Prioritization

**Confidence: HIGH** — pure code change, no API dependency.

### Where to Add the Sort

The existing `selectDiscoveryEvents()` function scores and sorts events by category/keyword priority but ignores close time. Adding close-time weighting here is the right place.

If switching to direct markets scan, sort the fetched markets array before passing to the matcher:

```typescript
// After fetching all markets, sort by close_time ascending
markets.sort((a, b) => {
  const aClose = new Date(a.close_time).getTime();
  const bClose = new Date(b.close_time).getTime();
  const aValid = !isNaN(aClose);
  const bValid = !isNaN(bClose);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return aClose - bClose;  // ascending: soonest first
});
```

Alternatively, in the existing two-stage flow, add a close-time score component to `eventPriorityScore()`. Events resolving within 7 days should receive a large bonus (e.g. +10 points) to ensure they're always included even if their category score is 0.

### Display Ranking

The `detectArbitrage()` return value already includes `timeToClose` (seconds). The renderer sorts by `profitPct`. Change the sort key to a composite: `timeToClose <= 7*86400 ? profitPct + 1000 : profitPct` (or equivalent priority band) so short-term opportunities float to the top without suppressing others.

---

## Matching Coverage Improvements

**Confidence: HIGH** — direct analysis of `matcher.ts` and `normalizer.ts`.

### The MIN_SHARED_TOKENS Gate is Too Strict for Short-Named Markets

Many Kalshi markets have short, highly specific titles like "Fed Funds Rate 5.25% - 5.5% after March 2026 meeting?" After normalization this produces tokens like: `["federal", "reserve", "funds", "rate", "5", "25", "5", "march", "2026", "meeting"]`. A Polymarket equivalent may phrase it as "Fed keeps rates unchanged in March?" — tokens: `["federal", "reserve", "keeps", "rates", "unchanged", "march"]`. Shared tokens: `federal`, `reserve`, `march` = 3. This passes. But the year gate may drop it if the Polymarket title lacks "2026".

Concrete risk: `MATCHER_YEAR_GATE=true` (the default) drops pairs where one side mentions a year and the other does not. For short-term markets (≤7 days), the expiry date is the year signal — disable the year gate OR only apply it when both titles contain explicit years AND the close-date delta is also large.

**Recommendation:** Set `MATCHER_YEAR_GATE=false` initially, monitor near-miss logs for false positives, then re-enable with tighter logic if needed.

### MIN_SHARED_TOKENS Can Be Reduced to 1 for Short-Term Markets

With direct market access sorted by close_time, you can apply a lower `minSharedTokens` threshold (1 instead of 2) for market pairs where both close within 14 days. The date-score component of the match formula (25% weight) will act as a strong filter for false positives in this cohort.

This is a config-only change: expose `MIN_SHARED_TOKENS_SHORT_TERM` as a separate config value.

---

## What NOT to Use

| What | Why Not |
|------|---------|
| `axios` / `got` / `node-fetch` | Redundant with Node 18+ built-in fetch; adds dependency weight for zero gain |
| `p-limit` / `p-queue` | The existing batch-concurrency loop in `fetchMarketsForEventsBatch` already does this; adding a library here is over-engineering |
| WebSocket feed for Kalshi | Explicitly out-of-scope per PROJECT.md; also not the bottleneck |
| Kalshi unofficial/community SDKs (e.g. `kalshi-js`) | Training-data–only knowledge; version currency unverified; the raw fetch approach is already working and simpler |
| Embedding-based matching (e.g. OpenAI embeddings, `@xenova/transformers`) | Explicitly out-of-scope; also adds cold-start latency incompatible with a tight poll loop |
| `bottleneck` npm package for rate limiting | The existing `AdaptiveRateLimiter` is purpose-built for this use case and handles 429-based adaptation; `bottleneck` does not |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Kalshi discovery strategy | Direct `/markets?status=open` pagination | Two-stage events→markets fan-out (current) | Current approach requires 300+ requests; direct scan takes 6–10 |
| Short-term prioritization | Sort by `close_time` before matching | Filter out long-dated markets | Filtering loses opportunities; ranking preserves them |
| Rate limit library | Existing `AdaptiveRateLimiter` | `bottleneck`, `p-throttle` | Existing solution already handles 429 backoff adaptively |
| HTTP client | Node built-in `fetch` | `undici` directly | `undici` is already available as a transitive dep; only reach for `undici.Pool` if HTTP connection overhead shows up in profiling |

---

## Installation

No new dependencies required for the recommended changes.

If `undici.Pool` is needed for high-concurrency direct scanning:
```bash
# undici is already in package.json as a direct dependency
# No install needed — import directly:
# import { Pool } from 'undici'
```

---

## Open Questions Requiring Validation

1. **Does `/trade-api/v2/markets` (without `event_ticker`) return all markets or require auth?**
   The current code only uses it with `event_ticker`. Confirm the no-filter variant works with a quick test call before building the refactor around it.

2. **What is Kalshi's actual public API rate limit ceiling?**
   The current 4 RPS cap is conservative and empirically set. The real ceiling may be 10–20 RPS. Test with `KALSHI_RATE_MAX_RPS=10` and observe 429 frequency.

3. **Does `status=open` exist as a query param on `/events` and `/markets`?**
   Inferred from the API structure; not confirmed externally. If it doesn't exist, the server will ignore the param and return all statuses (safe fallback), so testing it is low-risk.

4. **How many total active Kalshi markets exist?**
   The current flow discovers ~1,200 markets from ~300 events. If the total active universe is actually ~1,200–1,500 markets, the two-stage approach is not missing markets — the problem may be entirely in the matching logic. Run a direct `/markets` scan to get a ground-truth count.

---

## Sources

- Direct source code analysis: `/Users/rom/Documents/coding/arb-screener-v2/src/apis/kalshi.ts` (confirmed)
- Direct source code analysis: `/Users/rom/Documents/coding/arb-screener-v2/src/config.ts` (confirmed)
- Direct source code analysis: `/Users/rom/Documents/coding/arb-screener-v2/src/core/rateLimit.ts` (confirmed)
- Direct source code analysis: `/Users/rom/Documents/coding/arb-screener-v2/src/core/matcher.ts` (confirmed)
- Direct source code analysis: `/Users/rom/Documents/coding/arb-screener-v2/src/core/normalizer.ts` (confirmed)
- Kalshi API base URL: `https://api.elections.kalshi.com/trade-api/v2` (confirmed working — in production code)
- Confidence levels: HIGH where based solely on code inspection; MEDIUM where endpoint behavior is inferred from working code patterns but not externally verified
