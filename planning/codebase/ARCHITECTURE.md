# Architecture

**Analysis Date:** 2026-03-20

## Pattern Overview

**Overall:** Polling-based event-driven scanner with real-time arbitrage detection between two prediction markets (Polymarket and Kalshi). Implements a classic three-layer architecture: data fetch → normalize → match → detect → persist → display.

**Key Characteristics:**
- Continuous polling loop with configurable discovery/refresh cycles
- Dual-market data normalization and fuzzy matching
- Real-time arbitrage opportunity tracking across cycles
- Persistent session state with SQLite
- Real-time web dashboard via Server-Sent Events (SSE)
- Adaptive rate limiting with backoff strategies
- Metrics-driven observability with rolling statistics

## Layers

**APIs Layer:**
- Purpose: Fetch market data from Polymarket (Gamma API) and Kalshi (public trade API)
- Location: `src/apis/polymarket.ts`, `src/apis/kalshi.ts`, `src/apis/kalshiDemo.ts`
- Contains: HTTP clients with rate limiting, response parsing, normalization
- Depends on: `TokenBucket` and `AdaptiveRateLimiter` from `core/rateLimit.ts`, config
- Used by: Main poll loop in `src/index.ts`

**Normalization Layer:**
- Purpose: Convert raw API responses to a unified `NormalizedMarket` format with text processing, token extraction, and checksum generation
- Location: `src/core/normalizer.ts`, `src/core/checksums.ts`
- Contains: Text normalization (abbreviations, names, dates), bigram extraction, token extraction
- Depends on: Config for normalization rules
- Used by: `src/index.ts` before matching

**Matching Layer:**
- Purpose: Identify which Polymarket and Kalshi markets represent the same event through token overlap, string similarity (bigrams, Jaccard), and date compatibility
- Location: `src/core/matcher.ts`
- Contains: Inverted index builder, candidate filtering, similarity scoring (token overlap, bigram Jaccard, date scoring), LRU cache for matched pairs
- Depends on: `LRUCache`, normalizer, config (match threshold, token minimums)
- Used by: Main loop for discovery/refresh cycles

**Arbitrage Detection Layer:**
- Purpose: Compute all possible buy-one-sell-other combinations for a matched pair, calculate profit after fees, apply staleness penalties, and filter by thresholds
- Location: `src/core/arbitrage.ts`, `src/core/fees.ts`
- Contains: Arb computation (cost, profit, fees), fee tier lookup, staleness penalty, confidence escalation (higher profits need higher match scores), quote validation
- Depends on: Config (fee fractions/tiers, profit thresholds), matching layer
- Used by: Main loop to generate opportunities from matched pairs

**Persistence Layer:**
- Purpose: Store opportunities and session metadata in SQLite, provide historical aggregation (total sessions, all-time best profit, 24h stats)
- Location: `src/core/persistence.ts`
- Contains: SQLite schema with `opportunities` and `sessions` tables, session lifecycle, opportunity insertion, historical stats queries
- Depends on: `better-sqlite3`
- Used by: Main loop (periodic updates every 5 cycles) and startup/shutdown

**Display Layer:**
- Purpose: Render TUI with live opportunities, match counts, staleness indicators, cycle timing metrics, and scan phase progress
- Location: `src/display/renderer.ts`, `src/display/formatter.ts`
- Contains: Terminal table rendering with color codes, progress bars, time/currency formatting, ASCII art helpers
- Depends on: `cli-table3` for table layout, formatter utilities
- Used by: Main loop every cycle

**Web/API Layer:**
- Purpose: HTTP server providing real-time SSE stream of state updates and scan log entries to web dashboard
- Location: `src/web/server.ts`
- Contains: Native Node.js HTTP server, SSE push to connected clients, state serialization, scan log relay
- Depends on: Scan log buffer, web state interface
- Used by: Main loop via `pushState()`, standalone server started at app boot

**Logging & Metrics:**
- Purpose: Append-only logging to files for error tracking, opportunity archival, and cycle metrics; structured scan log for live dashboard
- Location: `src/core/logging.ts`, `src/core/scanLog.ts`, `src/core/metrics.ts`
- Contains: File I/O wrappers (errors.log, opportunities.jsonl, metrics.log), scan log with listener pattern, rolling statistics (p50/p95 cycle latency)
- Depends on: None (fail-safe)
- Used by: All layers for observability

**Configuration:**
- Purpose: Parse environment variables with type coercion and sensible defaults
- Location: `src/config.ts`
- Contains: Rate limit parameters, fee schedules, matching thresholds, polling intervals, discovery/refresh cadence, staleness penalties
- Depends on: `dotenv`
- Used by: All layers

## Data Flow

**Discovery Cycle (runs every N cycles):**

1. **Fetch all markets** (parallel)
   - Polymarket: Gamma API, paginated, token-bucket rate-limited
   - Kalshi: Trade API paginated by events, adaptive rate-limited (backoff on 429)
2. **Normalize** to `NormalizedMarket` (extract title, tokens, dates, checksums)
3. **Build inverted index** on tokens from both exchanges
4. **Match markets** using token overlap → bigram/Jaccard similarity → date compatibility, cache results in LRU
5. **Detect arbitrage** for all matched pairs (YES/NO x YES/NO combinations)
6. **Filter by thresholds** (profit %, match score, volume, freshness penalties)
7. **Track persistently** across cycles (new/updated/stale opportunities)
8. **Persist** top opportunities to SQLite
9. **Push to web** via SSE and render TUI

**Refresh Cycle (between discoveries):**

1. **Fetch only target markets** (condition IDs from cached pairs)
   - Polymarket: Batch request by condition_ids
   - Kalshi: Fetch only events from current matched pairs
2. **Sync quotes** without re-matching (use structure checksums to detect if pairing changed)
3. **Re-run arbitrage detection** with fresh prices
4. **Same tracking, persist, web push, render as discovery**

**Opportunity Lifecycle:**

- **First seen**: Create `TrackedOpportunity` with `firstSeenAt`, `consecutiveCycles=1`, `peakProfitPct`
- **Seen again this cycle**: Update `lastSeenAt`, increment `consecutiveCycles`, update peak
- **Not seen for N cycles**: Mark `live=false` but keep in tracker
- **Expiry**: Remove if `cyclesSinceLastSeen > STALE_EXPIRY_CYCLES` OR market closes

## Key Abstractions

**NormalizedMarket:**
- Purpose: Universal representation of a market (either Polymarket or Kalshi)
- Examples: `src/types/index.ts` (lines 44-59)
- Pattern: Source-agnostic interface with `title`, `tokens`, `yesAsk`/`noAsk`, `closeTime`, checksums for quote vs. structure changes

**MatchedPair:**
- Purpose: Association between a Polymarket and Kalshi market with confidence score
- Examples: `src/types/index.ts` (lines 63-69), created in `src/core/matcher.ts`
- Pattern: Immutable reference pair with `matchScore` and `matchedAt` timestamp

**ArbOpportunity:**
- Purpose: Computed arbitrage with full financial details (costs, fees, profit, position sizing)
- Examples: `src/types/index.ts` (lines 73-98), computed in `src/core/arbitrage.ts`
- Pattern: Snapshot of opportunity at detection time with gross/net profit, staleness metadata

**TrackedOpportunity:**
- Purpose: Wrapper that accumulates history of an opportunity across cycles
- Examples: `src/types/index.ts` (lines 102-117), maintained in `src/index.ts` (lines 50-106)
- Pattern: Stable key + evolving `current` snapshot + lifecycle metadata (first/last seen, peak profit)

**TokenBucket & AdaptiveRateLimiter:**
- Purpose: Control HTTP request rate to avoid 429 rate limits; adapt rate based on success/failure
- Examples: `src/core/rateLimit.ts`
- Pattern: Token-based flow control with async `acquire()` and runtime rate adjustment

**LRUCache:**
- Purpose: Bound memory usage of cached matched pairs
- Examples: `src/core/lruCache.ts`
- Pattern: Generic O(1) cache with eviction of least-recently-used on size overflow

## Entry Points

**Main Entry:**
- Location: `src/index.ts` (lines 419-455)
- Triggers: `npm run dev` or `npm start` after compilation
- Responsibilities: Initialize DB and session, start web server, run polling loop, handle graceful shutdown on SIGINT/SIGTERM

**Poll Cycle:**
- Location: `src/index.ts` (lines 152-415)
- Triggers: Called immediately at startup, then every `config.pollIntervalMs` (default 3s)
- Responsibilities: Orchestrate fetch → normalize → match/sync → arb detect → track → persist → render in sequence

**Web Server:**
- Location: `src/web/server.ts`
- Triggers: Started in main before first poll cycle
- Responsibilities: Accept HTTP connections, serve SSE endpoint, relay state and scan log updates

## Error Handling

**Strategy:** Fail-soft logging pattern — errors never crash the poll loop. Each phase logs errors to files, returns empty/null, and continues.

**Patterns:**
- API fetch failures return `[]` (empty markets), error logged
- Parse errors return `null` individually, filter out
- Logging operations wrapped in try-catch (silent fail)
- Graceful shutdown collects metrics and closes DB on SIGINT/SIGTERM
- Rate limit backoff: 429 responses trigger adaptive decay (reduce RPS)

## Cross-Cutting Concerns

**Logging:**
- Error log: `errors.log` (append-only, human-readable timestamps)
- Opportunity log: `opportunities.jsonl` (JSONL for analysis)
- Metrics log: `metrics.log` (cycle timing, fetch stats, rolling p50/p95)
- Scan log: In-memory buffer (500 max entries) + SSE relay to dashboard

**Validation:**
- Quote validation: Ask prices must be in (0, 1), volume > minimum
- Match validation: Token overlap + date compatibility before scoring
- Arbitrage validation: Combined cost must be < 1, no negative profit
- Staleness: Penalty applied to profit based on time since fetch

**Authentication:**
- Polymarket: Public API, no auth required
- Kalshi: Optional API key for elevated rate limits (environment variable)
- Demo mode: Simulated Kalshi data for testing without API

---

*Architecture analysis: 2026-03-20*
