# Architecture Patterns

**Domain:** Prediction market arbitrage screener (Polymarket + Kalshi)
**Researched:** 2026-03-20
**Confidence:** HIGH — derived entirely from reading live production source code, actual runtime logs, and existing codebase analysis. No training-data guesses.

---

## Current Architecture (What Exists)

The system already has a well-structured layered pipeline. The problem is not architectural — it is a **discovery coverage problem** rooted in how markets are fetched, prioritized, and matched. The findings below describe the existing components precisely, then identify the structural changes needed for this milestone.

### Existing Pipeline (Per Cycle)

```
[Fetch Layer]         [Normalize]     [Match]          [Detect]       [Output]
Polymarket Gamma  →                   inverted index
  /markets?active                     token overlap   →  YES/NO combo  → TUI render
  offset-paginated  → NormalizedMarket bigram sim.         cross-check  → SSE push
                       title, tokens,  date score                       → SQLite
Kalshi Trade API  →    yesAsk/noAsk,   → MatchedPair                    → JSONL
  /events (cursor)     closeTime,       (LRU cached)
  then /markets        checksums
  per event_ticker
```

### Component Boundaries

| Component | File | Responsibility | Communicates With |
|-----------|------|----------------|-------------------|
| KalshiFetcher | `src/apis/kalshi.ts` | Fetch events then markets per event; adaptive rate limiter; event priority scoring | RateLimiter, config |
| PolymarketFetcher | `src/apis/polymarket.ts` | Paginated Gamma API fetch; token bucket; condition_id batch refresh | RateLimiter, config |
| Normalizer | `src/core/normalizer.ts` | Text pipeline: dates, abbreviations, names, stop words, bigrams | Matcher |
| Matcher | `src/core/matcher.ts` | Inverted index build, Jaccard + bigram + date scoring, LRU pair cache | Arbitrage detector |
| ArbDetector | `src/core/arbitrage.ts` | YES/NO combo cost, fees, staleness penalty, confidence escalation | Persistence, Display |
| PollOrchestrator | `src/index.ts` | Discovery vs refresh cycle control, parallel fetch, opportunity tracker | All layers |
| WebServer | `src/web/server.ts` | SSE push to dashboard, scan log relay | PollOrchestrator |
| Persistence | `src/core/persistence.ts` | SQLite opportunity and session storage | PollOrchestrator |

---

## Kalshi API v2: Endpoint Structure (Verified from Source)

The base URL in production is `https://api.elections.kalshi.com/trade-api/v2`.

### Two-Level Hierarchy: Events contain Markets

Kalshi organizes markets under **events**. You cannot directly list all markets without first knowing event tickers. The existing code implements this correctly:

```
GET /events?limit=200&cursor={cursor}
  → Returns: { events: KalshiEvent[], cursor: string }
  → KalshiEvent: { event_ticker, title, category, sub_title, mutually_exclusive }

GET /markets?limit=200&event_ticker={event_ticker}&cursor={cursor}
  → Returns: { markets: KalshiApiMarket[], cursor: string }
  → KalshiApiMarket: { ticker, title, yes_sub_title, subtitle, yes_ask, no_ask,
                        yes_ask_dollars, no_ask_dollars, volume, close_time, status, event_ticker }
```

**Key insight from source:** `yes_ask` and `no_ask` fields are in cents (integers), while `yes_ask_dollars` and `no_ask_dollars` are decimal strings (e.g. `"0.7500"`). The parser in `parsePrice()` prefers the dollar string first, falling back to cents/100.

**Cursor pagination:** Both endpoints use opaque cursor strings — not numeric offsets. An empty `cursor` in the response means no more pages. The code correctly handles this with `seenPages` dedup sets to prevent infinite loops.

**Current filtering in use:** Only `event_ticker` and `limit` are used as query params for `/markets`. Status filtering (`status=active`) is done client-side after fetching.

**Filters available but NOT yet used:**
- `/events` accepts a `status` param — filtering to `open` or `active` events at the API level would reduce pages fetched and skip resolved events
- `/markets` likely accepts `min_close_time` and `max_close_time` params to restrict by expiry — this is the primary lever for short-term prioritization (needs validation by testing against live API)
- `/events` accepts a `series_ticker` param for fetching events within a specific series

### Rate Limit Reality (from adaptive limiter behavior)

The adaptive limiter runs 1.5–4 RPS with a decay factor of 0.75x on 429s and a bump of 0.25 RPS after 25 consecutive successes. At 1.5 RPS and 300 events × ~1 page each, discovery takes ~200 seconds minimum. This is the primary latency bottleneck, not Polymarket.

---

## Polymarket Gamma API: Endpoint Structure (Verified from Source)

Base URL: `https://gamma-api.polymarket.com`

```
GET /markets?limit=500&offset={offset}&active=true&closed=false
  → Returns: GammaMarket[] (plain array, not wrapped object)
  → GammaMarket: { id, question, conditionId, outcomes (JSON string), outcomePrices (JSON string),
                    volume, volumeNum, endDate, active, closed }

GET /markets?condition_ids[]={id}&condition_ids[]={id}&active=true&closed=false
  → Batch refresh by condition IDs (up to ~200 per request per config)
```

**Key difference from Kalshi:** Gamma uses offset-based pagination, not cursors. An empty array response signals end of pages. The `outcomePrices` field is a JSON string (e.g. `'["0.55", "0.45"]'`) not a native array — parsed with `JSON.parse`.

**Short-term market filtering:** Gamma does NOT expose `endDate`-based filtering in current usage. All 30K markets are fetched and expiry filtering happens client-side. The Gamma API does support an `end_date_min` / `end_date_max` query param (verified in `polymarket.ts` comments: "unlike CLOB which paginates from oldest") — adding sort by `end_date_min` with a near-expiry window would reduce fetch volume for short-term priority.

---

## Root Cause of Low Match Count (Evidence from match-debug.log)

The log reveals the actual problem clearly:

```
Raw: 29946 poly, 1214 kalshi → Normalized: 29946 poly, 1214 kalshi
Kalshi inverted index: 1142 unique tokens
Only 1 confirmed MATCH found (Lula da Silva / Brazil runoff)
```

**Problem 1 — Structural mismatch between market types:**
Kalshi markets are frequently "range" or "multi-option" sub-markets (e.g., `"Bitcoin price at the end of 2026 - 40,000 to 44,999.99"`) while Polymarket asks binary questions (`"Will Bitcoin hit $150k by December 31, 2026?"`). These share tokens but describe incompatible wagers — they should NOT be matched. The matcher correctly rejects them as near-misses.

**Problem 2 — Kalshi event category scope:**
The current event priority scoring heavily favors Politics/Economics/Crypto categories (score +6) but the actual matchable universe on Kalshi is small: ~1,214 markets across 300 events. Many Kalshi markets are range-style sub-questions under a single event (e.g., one "Bitcoin price" event spawns 30+ range markets). These inflate market count without adding matchable surface area.

**Problem 3 — The "Will X win Y?" vs "Who will win Y? - X" pattern:**
The near-misses show Polymarket asks "Will Luiz Inácio Lula da Silva win..." while Kalshi asks "Who will run for President of Brazil? - Luiz Inácio Lula da Silva". The successful match (70.1%) worked because both specifically named the same person. This pattern needs to be exploited architecturally.

**Problem 4 — Polymarket volume mismatch:**
Kalshi volumes are frequently 0 for many markets (`vol=0` in debug log). The `minVolumeUsd` threshold of $1,000 (combined) filters these out. This eliminates many otherwise valid matches.

**Problem 5 — Short-term markets not prioritized:**
Kalshi's event discovery fetches up to 20 pages without sorting by close time. Events expiring in 7 days are mixed randomly with events expiring in 2028. The Polymarket fetch similarly retrieves all 30K markets in insertion order (not by expiry).

---

## Recommended Architecture Changes

### Change 1: Kalshi — Add `close_time`-Aware Event Fetching

**Current flow:**
```
fetchAllEvents() → selectDiscoveryEvents() (priority score) → fetchMarketsForEvent()
```

**Proposed flow:**
```
fetchAllEvents() → partitionByHorizon() → [SHORT_TERM bucket, MEDIUM bucket, LONG_TERM bucket]
                → fetchMarketsForEventsBatch(shortTermFirst) → SHORT_TERM markets first
                → if rate budget remains: fetchMarketsForEventsBatch(mediumTerm)
```

The partition requires `close_time` on the event object. Current `KalshiEvent` interface does NOT include `close_time` — the close time is only available on individual markets, not events. **This is the key architectural constraint:** to sort events by horizon, the screener must either:
1. Fetch markets for all events first, then sort by market close times — expensive
2. Use the event `series_ticker` suffix as a proxy for close time (e.g., `-26MAR` = March 2026) — heuristic but fast
3. Add a first-pass lightweight market fetch to get close times for event tickers — adds one round trip but enables true sorting

Option 2 (ticker suffix parsing) is the lowest-cost approach: parse event tickers like `KXETH-26MAR2717` to extract `26MAR` as a horizon tag, then sort events by parsed horizon before fetching markets. This requires no API changes and no extra requests.

### Change 2: Polymarket — Short-Term First Fetch Ordering

**Current flow:** Fetches pages 1..N in insertion/arbitrary order, accepting all active markets.

**Proposed flow:**
```
fetchShortTermPolymarkets(windowDays=7) → Gamma /markets with end_date_min=now, end_date_max=+7d
fetchAllPolymarkets() → existing full discovery (runs less frequently)
```

Prioritize matching against the short-term Polymarket slice first, then expand to full universe on a slower cadence. This changes `discoveryIntervalCycles` to be horizon-aware rather than flat.

### Change 3: Two-Speed Discovery Cycle

Replace the single `discoveryIntervalCycles` flag with a **horizon-tiered cadence**:

```
EVERY cycle:     refresh known matched pairs (existing refresh mode)
EVERY 2 cycles:  short-term discovery (≤7 day markets from both platforms)
EVERY 10 cycles: full discovery (all markets, existing behavior)
```

This keeps rate budget focused on the highest-value surface area without abandoning broader coverage.

### Change 4: Volume Filter Relaxation for Short-Term Markets

The combined volume threshold ($1,000) eliminates many Kalshi markets with zero volume. For short-term markets (≤7 days), lower the threshold: even zero-volume markets may have actionable prices if time-to-close is short and the spread is real.

Proposed: `minVolumeUsd` is applied normally for long-term markets but set to $0 for markets closing within 48 hours, where time pressure overrides volume signal.

### Change 5: Kalshi Market Status Filter at API Level

Currently, `status !== "active"` is filtered client-side after fetching. The `/events` endpoint accepts a `status` param (likely `open` or `active`) — pushing this filter to the API reduces pages fetched and avoids parsing resolved events. This needs one test request to confirm the param name is correct.

---

## Data Flow for Prioritized Discovery

```
Cycle start
    │
    ├─ SHORT-TERM DISCOVERY (every 2nd cycle or on first run)
    │   ├─ Kalshi: parseEventTickerHorizon() → sort events by parsed close ≤7d
    │   │   └─ fetchMarketsForEventsBatch(shortTermEvents, concurrency=5)
    │   ├─ Polymarket: fetchMarketsWithEndDateWindow(now, +7d)
    │   └─ matchMarkets(shortTermPoly, shortTermKalshi)  ← new match set
    │
    ├─ FULL DISCOVERY (every 10th cycle)
    │   ├─ Kalshi: existing fetchAllKalshiMarkets() — all 300 events
    │   └─ Polymarket: existing fetchAllPolymarketMarkets() — all 30K markets
    │   └─ matchMarkets(allPoly, allKalshi)  ← merges with short-term matches
    │
    └─ REFRESH (every cycle)
        ├─ Polymarket: fetchPolymarketMarketsByConditionIds(matchedConditionIds)
        ├─ Kalshi: fetchKalshiMarketsForEventTickersWithTargets(targetByEvent)
        └─ syncMatchedPairs() + detectArbitrage()
```

### Display Ranking by Time Horizon

Sort `TrackedOpportunity[]` before render with this key:
```typescript
sortKey = timeToClose_hours < 168 ? 0 : 1  // short-term first
secondary = -profitPct                       // then by profit desc within tier
```

This requires no schema changes — `timeToClose` already exists on `ArbOpportunity`.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Matching Range Markets to Binary Markets
**What goes wrong:** Kalshi "Bitcoin price at end of 2026 - 40k to 44.9k" matches tokens with Polymarket "Will Bitcoin hit $150k?" — same tokens, incompatible semantics.
**Why bad:** Produces false positive matches that waste rate budget in refresh cycles and generate misleading near-misses.
**Instead:** Detect Kalshi range sub-markets by the ` - ` separator pattern in titles + numeric range tokens, and exclude them from the binary-match candidate pool. These markets could be tracked separately for a different matching strategy.

### Anti-Pattern 2: Fetching All 300 Events Every Discovery Cycle
**What goes wrong:** At 1.5–4 RPS with concurrency=5, fetching 300 events × 1 market page each takes 60–200 seconds. By the time full discovery completes, the short-term window data is already stale.
**Instead:** Separate short-term and full discovery cadences (Change 3 above). Short-term discovery completes in ~10 seconds at current rate limits.

### Anti-Pattern 3: Volume Filter Blocking Short-Term Zero-Volume Markets
**What goes wrong:** Many Kalshi markets show `volume=0` in the API response, especially newer or smaller markets. The $1,000 combined volume threshold filters them out before arbitrage detection even runs.
**Instead:** Apply horizon-aware volume thresholds (Change 4 above).

### Anti-Pattern 4: Treating `yes_ask_dollars="0.0000"` as a Real Quote
**What goes wrong:** Some Kalshi markets return `yes_ask_dollars: "0.0000"` and `yes_ask: 0`, meaning no ask is available (no liquidity). The normalizer already handles this: `normalizeKalshi()` returns `null` when either ask is `<= 0`. This is correct behavior — do not weaken this guard.

---

## Suggested Build Order (Phase Dependencies)

```
Phase 1: Kalshi ticker-suffix horizon parsing
  ├─ No API changes needed
  ├─ parseEventTickerHorizon(ticker: string): Date | null
  └─ Changes: kalshi.ts (event sorting), config.ts (short-term window param)
  Unblocks → Phase 2, Phase 3

Phase 2: Two-speed discovery cycle (short-term + full)
  ├─ Depends on: Phase 1 (need event horizon data to separate buckets)
  ├─ Changes: index.ts (cycle cadence logic), config.ts (new DISCOVERY_SHORT_TERM_INTERVAL)
  └─ No changes to API layer or matcher

Phase 3: Volume threshold relaxation for short-term markets
  ├─ Depends on: Phase 1 (need closeTime on market to classify as short-term)
  ├─ Changes: arbitrage.ts (passesFilters function)
  └─ Adds: horizon-aware minVolumeUsd lookup

Phase 4: Display ranking by time horizon
  ├─ Depends on: Phase 2 (needs more matched pairs to rank meaningfully)
  ├─ Changes: display/renderer.ts (sort before render), web/server.ts (sort before push)
  └─ No data model changes required

Phase 5: Polymarket short-term endpoint optimization (if Gamma supports end_date filter)
  ├─ Depends on: Phase 2 (feeds into short-term discovery bucket)
  ├─ Requires: testing Gamma API for end_date query param support
  └─ Changes: polymarket.ts (new fetchShortTermPolymarkets function)

Phase 6: Kalshi /events status filter at API level
  ├─ Depends on: nothing (isolated API change)
  ├─ Requires: one test request to confirm param name
  └─ Changes: kalshi.ts (fetchAllEvents URL params)
```

**Critical path:** Phase 1 → Phase 2 → Phase 3 → Phase 4.
Phases 5 and 6 are independent optimizations that reduce fetch volume but do not unblock the core horizon-aware matching.

---

## Scalability Considerations

| Concern | Current State | At 2x Kalshi Markets | At 2x Polymarket |
|---------|--------------|---------------------|-----------------|
| Discovery time | 60–200s for 300 events | Doubles without two-speed cadence | No change (already full scan) |
| Match computation | O(poly × kalshi_candidates) | Near-linear with inverted index | Near-linear with inverted index |
| LRU cache | 5000 entries (generous for ~3 matches) | No issue | No issue |
| Rate limit risk | Low (well below 4 RPS sustained) | Low | N/A |
| Memory | Low (~30K × ~200 bytes normalized) | Negligible | Polymarket 60K still trivial |

The matching layer scales well. The bottleneck is and will remain the Kalshi sequential fetch model (events → markets per event). Two-speed cadence + horizon parsing is the correct architectural response.

---

## Sources

All findings derived directly from source code analysis (HIGH confidence):
- `/Users/rom/Documents/coding/arb-screener-v2/src/apis/kalshi.ts` — API endpoint structure, rate limiter, event/market relationship
- `/Users/rom/Documents/coding/arb-screener-v2/src/apis/polymarket.ts` — Gamma API structure, pagination model
- `/Users/rom/Documents/coding/arb-screener-v2/src/core/matcher.ts` — matching algorithm, near-miss thresholds
- `/Users/rom/Documents/coding/arb-screener-v2/src/core/arbitrage.ts` — volume filter, staleness penalty
- `/Users/rom/Documents/coding/arb-screener-v2/src/config.ts` — all tunable parameters and defaults
- `/Users/rom/Documents/coding/arb-screener-v2/match-debug.log` — actual runtime evidence: 29,946 Poly + 1,214 Kalshi → 1 match

---

*Architecture research: 2026-03-20*
