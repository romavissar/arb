# Project Research Summary

**Project:** Polymarket ↔ Kalshi Arbitrage Screener — Kalshi API Optimization Milestone
**Domain:** Cross-platform prediction market arbitrage (incremental optimization of existing TypeScript/Node.js codebase)
**Researched:** 2026-03-20
**Confidence:** HIGH (all four research files grounded in direct source code analysis, runtime logs, and live output data)

## Executive Summary

The Polymarket ↔ Kalshi arbitrage screener is a functioning pipeline that has a specific, well-diagnosed problem: it finds arbitrage opportunities, but the wrong ones. All current matches are 2028 US Presidential Election markets — long-dated, low-urgency candidates — while the user wants short-term (≤7 day) opportunities. This is not a structural failure; it is a prioritization failure caused by three compounding issues discovered through direct source code audit, runtime log analysis, and inspection of `opportunities.jsonl`.

The single most urgent issue is authentication: Kalshi's v2 API now requires a Bearer token for all requests, including read-only GETs. Every Kalshi market fetch returns HTTP 401, producing zero Kalshi markets and thus zero matched pairs. This is currently masked because the error is silently swallowed — the screener continues running and reports "0 opportunities" with no alarm. The second issue is that the event discovery logic actively selects against short-term markets: `PRIORITY_KEYWORDS` heavily weights political/election terms, filling the 300-event cap with long-dated presidential futures. The third issue is structural false positives: when Kalshi auth was working in earlier sessions, all "arbs" found were Polymarket individual-candidate binary markets matched against Kalshi mutually-exclusive categorical combo markets — not executable arbitrages.

The recommended approach is a strict three-phase sequence. Phase 1 (auth + circuit breakers) must come first because without working Kalshi data, no other optimization can be validated. Phase 2 (short-term discovery) reorients the event selection to surface near-expiry markets and eliminates the structural false positive problem. Phase 3 (matching quality) then tunes the fuzzy matching thresholds and synonym coverage once real short-term market pairs are flowing through the pipeline. No new npm dependencies are needed at any phase — the existing `TokenBucket`, `AdaptiveRateLimiter`, and Node.js built-in `fetch` are sufficient throughout.

## Key Findings

### Recommended Stack

The existing stack is correct and complete for this milestone. No new libraries are needed. The codebase already has Node.js built-in `fetch` (Node 18+), a custom `TokenBucket` + `AdaptiveRateLimiter` with 429-adaptive backoff, and `undici` already installed as a direct dependency for high-concurrency scenarios. Every recommended change is a code or configuration modification, not a dependency addition.

**Core technologies:**
- Node.js built-in `fetch` — all HTTP calls — already proven, no overhead from extra libraries
- `undici.Pool` (already in `package.json`) — available if concurrency exceeds 10 connections — import directly, no install needed
- Existing `AdaptiveRateLimiter` — rate limiting and 429 backoff — purpose-built and superior to `bottleneck`/`p-throttle` for this use case
- Environment config via `src/config.ts` — all tunable parameters already exposed — the primary lever for optimization without code changes

**Key open questions requiring validation before implementation:**
- Does `GET /trade-api/v2/markets` (without `event_ticker`) return all markets without auth? (Test before building direct-scan refactor)
- Does the Gamma API support `end_date_max`/`end_date_min` query params? (Confirm before building short-term Polymarket fetch)
- Does Kalshi `/events` accept `status=open`? (Low-risk to test — server ignores unknown params safely)
- What is Kalshi's actual rate limit ceiling? (Current 4 RPS cap may be 2–5x conservative)

### Expected Features

**Must have (table stakes):**
- **Kalshi API authentication** — Kalshi now requires Bearer token for all v2 API reads; without this, zero Kalshi markets are discovered and no matching can occur
- **Auth failure circuit breaker** — distinguish 401 (config failure, stop retrying) from 429 (rate limit, backoff) from 5xx (transient, retry); alert loudly when Kalshi market count drops to zero
- **Short-term market prioritization in event scoring** — `PRIORITY_KEYWORDS` must be rebalanced to boost economic events (FOMC, CPI, NFP, PCE, JOLTS) over long-dated political events
- **Kalshi close_time-based event horizon parsing** — parse event ticker suffix (e.g., `-26MAR`) to infer close date without extra API calls, enabling short-term-first discovery ordering
- **Opportunity display sort by time horizon** — sort `timeToClose < 168h` to the top; the sort key already exists on `ArbOpportunity`

**Should have (differentiators):**
- **Two-speed discovery cycle** — every-2-cycles short-term discovery pass + every-10-cycles full discovery; reduces rate budget burn while keeping near-expiry markets current
- **Volume filter relaxation for short-term markets** — apply `minVolumeUsd=$0` for markets closing within 48h; zero-volume markets may still have actionable prices
- **Structural false positive detection** — detect Kalshi `mutually_exclusive: true` events and exclude them from binary-market matching; currently produces all the "high-profit" opportunities that are not executable
- **Synonym expansion for economic event vocabulary** — audit NFP, PCE, PPI, JOLTS, FOMC title divergence between platforms; extend `ABBREVIATIONS` and `NAME_MAP` in `normalizer.ts`
- **Kalshi API status filter at API level** — add `status=open` to `/events` and `/markets` requests to skip resolved markets server-side

**Defer (after this milestone):**
- WebSocket price feeds — explicitly out of scope per `PROJECT.md`; not the current bottleneck
- Embedding-based/ML matching — explicitly deferred; existing fuzzy matching works, coverage is the constraint
- Additional platforms (PredictIt, Manifold) — Poly/Kalshi pair is not yet saturated
- Trade execution/order placement — future milestone
- Dynamic threshold tuning via UI — env vars are sufficient for now
- Minimum profit floor lowering below 0.8% — user explicitly wants this constraint respected

### Architecture Approach

The existing layered pipeline (Fetch → Normalize → Match → Detect → Output) is architecturally sound. The problem is not the structure but the data flowing through it: the KalshiFetcher returns zero markets (auth failure) or selects the wrong markets (priority scoring). The recommended changes add a horizon-aware routing layer between the fetcher and matcher without changing any downstream interfaces. The key architectural constraint is that `close_time` is only available on individual Kalshi markets, not on events — so horizon-based prioritization must use either ticker-suffix parsing (fast, no extra requests) or a first-pass lightweight fetch (accurate, one extra round trip). Ticker-suffix parsing is the recommended approach for Phase 1 since it unblocks the rest of the pipeline immediately.

**Major components:**
1. **KalshiFetcher** (`src/apis/kalshi.ts`) — needs auth header injection, status filter, event horizon parsing, and short-term bucket separation
2. **PolymarketFetcher** (`src/apis/polymarket.ts`) — needs short-term window query (if Gamma supports `end_date_max`) and horizon-aware fetch ordering
3. **Normalizer** (`src/core/normalizer.ts`) — needs synonym expansion for economic event vocabulary and partial date past-year correction
4. **Matcher** (`src/core/matcher.ts`) — needs `mutually_exclusive` market type exclusion and configurable `minSharedTokens` by time horizon
5. **ArbDetector** (`src/core/arbitrage.ts`) — needs horizon-aware volume filter (`minVolumeUsd` relaxation for ≤48h markets)
6. **PollOrchestrator** (`src/index.ts`) — needs two-speed discovery cadence (short-term every 2 cycles, full every 10)
7. **Display/WebServer** — needs time-horizon sort before render and zero-Kalshi-market alarm in dashboard header

### Critical Pitfalls

1. **Kalshi 401 auth failure (CRITICAL — current blocker)** — Kalshi v2 API now requires authentication for all reads. Add `Authorization: Bearer <KALSHI_API_KEY>` when key is set. Add startup health check. Fail fast on 401 — do not retry. Surface zero-market state prominently in the dashboard.

2. **Structural false positives from categorical vs binary market type mismatch (CRITICAL — affects all discovered opportunities)** — Kalshi `mutually_exclusive: true` events (e.g., "Who will win the 2028 election?") should never be matched against Polymarket individual-candidate binary markets. Check `event.mutually_exclusive` before matching. Fix this before touching match thresholds — lowering the threshold without fixing this produces more false positives, not more real arbs.

3. **Silent zero-market failure — no circuit breaker (CRITICAL — operational)** — `fetchAllKalshiMarkets()` returns empty array on 401 without alarming. Add a consecutive-failure counter; distinguish auth failures from transient errors; show Kalshi market count in red in dashboard when zero.

4. **Event discovery systematically excludes short-term markets (HIGH — primary feature gap)** — `PRIORITY_KEYWORDS` weights "politic", "election", "trump" at +6 while economic weekly events score 0–2. The 300-event cap fills with long-dated political events. Rebalance scoring before other discovery changes.

5. **`minSharedTokens=2` gate blocks valid short-term matches before scoring (MODERATE)** — Lower to 1 for markets closing within 14 days, where the close-date proximity acts as the primary false-positive gate. Do not lower globally until structural false positive detection is in place.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Kalshi Auth and Observability
**Rationale:** Zero Kalshi markets = zero valid output. No other optimization is measurable until data flows. This is the uncrossable prerequisite for everything downstream.
**Delivers:** Working Kalshi API connectivity, auth failure alarm, per-failure-type error handling (401 vs 429 vs 5xx), Kalshi market count visibility in dashboard, startup health check
**Addresses:** Table stakes: Kalshi API authentication, auth failure circuit breaker
**Avoids:** Pitfall 1 (401 loop), Pitfall 3 (silent zero-market failure), Pitfall 8 (sports filter exclusion — make configurable while here)
**No research-phase needed:** This is a straightforward credential injection + error handling task with clear implementation path.

### Phase 2: Short-Term Discovery Prioritization
**Rationale:** Once Kalshi auth is working, the pipeline will produce real data — but it will again produce only long-dated political opportunities unless discovery is reoriented. This phase fixes the root cause of wrong-market selection.
**Delivers:** Event ticker horizon parsing, rebalanced `PRIORITY_KEYWORDS` (economic events boosted), `SHORT_TERM_CATEGORIES` whitelist, two-speed discovery cycle (2-cycle short-term / 10-cycle full), `close_time`-based event bucket separation, Polymarket short-term window fetch (conditional on Gamma API support), `status=open` filter on Kalshi API calls
**Addresses:** Table stakes: short-term market prioritization, Kalshi coverage maximization; Differentiators: two-speed discovery cycle, Kalshi event category whitelist
**Avoids:** Anti-pattern 2 (fetching all 300 events every cycle); Pitfall 8 (discovery rotation skipping short-term events)
**Needs validation:** Whether Gamma API supports `end_date_max` param (test before building). Whether `/markets` without `event_ticker` works without auth (test before direct-scan refactor).

### Phase 3: Match Quality and False Positive Elimination
**Rationale:** With short-term markets now flowing, the matcher must correctly distinguish real arbs from structural false positives. Tuning thresholds before fixing the categorical/binary type mismatch will surface more false signals, not more real opportunities.
**Delivers:** `mutually_exclusive` market type compatibility check before `computeArb()`, synonym expansion for NFP/PCE/PPI/JOLTS/FOMC vocabulary, `minSharedTokens=1` for ≤14-day markets (separate config from global threshold), `MATCHER_YEAR_GATE=false` default for short-term markets, numeric range token stripping for Kalshi sub-title tokens, partial date past-year correction in normalizer, volume filter relaxation for ≤48h markets, Polymarket Gamma ask premium config
**Addresses:** Differentiators: looser token matching with time-gating, synonym expansion, match diagnostic reporting; Should-have: structural false positive detection
**Avoids:** Pitfall 2 (categorical vs binary mismatch), Pitfall 4 (numeric sub-title token pollution), Pitfall 5 (Gamma indicative prices), Pitfall 6 (minSharedTokens too strict), Pitfall 7 (close date gate partial-year bug), Pitfall 9 (no_ask zero filtering)

### Phase 4: Display and UX Polish
**Rationale:** Once real short-term opportunities are discovered, surface them clearly. This phase is low-complexity but depends on Phase 2 producing enough matched pairs to make the sort meaningful.
**Delivers:** Time-horizon sort (≤7d first, then by profit% descending), short-term vs long-term visual segmentation in terminal and web dashboard, Kalshi market count in dashboard header (red when zero), match diagnostic `--debug-match` CLI flag
**Addresses:** Table stakes: opportunity ranking by time horizon, short-term vs long-term visual segmentation; Differentiators: match diagnostic reporting
**Avoids:** Pitfall 3 (zero-market silent failure — final UX layer for operator visibility)
**No research-phase needed:** Standard display changes; patterns are established in existing renderer.

### Phase Ordering Rationale

- **Phase 1 before all others:** Auth failure completely blocks observable output. All other optimizations are invisible without it.
- **Phase 2 before Phase 3:** Discovering the right markets before tuning matching. Matching quality improvements are only validatable once the correct input data is present. Running matching tuning against long-dated political markets will produce wrong conclusions about thresholds.
- **Phase 3 before Phase 4:** False positive elimination before display polish. Showing misleading high-profit opportunities prominently (sorted to top) would be worse than no display improvement.
- **Phase 4 last:** Display changes require enough real matched pairs to be meaningful. With zero or one match, sorting by time horizon is vacuous.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** Gamma API `end_date_max` parameter support needs empirical validation before building the short-term Polymarket fetch. Run a test request: `GET /markets?active=true&closed=false&end_date_max=<ISO>` and inspect response.
- **Phase 2:** Direct Kalshi `/markets` pagination (without `event_ticker`) needs validation before committing to the full direct-scan refactor. The refactor would reduce discovery from 300+ requests to ~8 pages but requires confirming the endpoint behavior.
- **Phase 2:** Kalshi actual rate limit ceiling is unknown. Current 4 RPS cap may be 2–5x conservative. Test with `KALSHI_RATE_MAX_RPS=10` and observe 429 frequency in production before setting defaults.

Phases with standard patterns (skip research-phase):
- **Phase 1:** Auth header injection and circuit breaker logic are standard patterns; clear implementation path from pitfalls analysis.
- **Phase 3:** All matcher changes are configuration and code changes within the existing `matcher.ts` and `normalizer.ts` interfaces; no API dependencies.
- **Phase 4:** Display changes use existing data model; `timeToClose` already on `ArbOpportunity`.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Based on direct source code inspection; no new dependencies needed; all recommendations are config/code changes |
| Features | HIGH | Root causes confirmed via `opportunities.jsonl`, `match-debug.log`, and `errors.log`; feature priorities derived from evidence, not speculation |
| Architecture | HIGH | All component boundaries and data flows derived from live production source; actual runtime log used to confirm match counts (29,946 poly + 1,214 kalshi → 1 match) |
| Pitfalls | HIGH for P1-P3 | Pitfalls 1–3 have direct log evidence (50+ consecutive 401s, false positive pattern in jsonl, zero-market silent failure visible in code); Pitfalls 4–8 are MEDIUM (code analysis, not yet triggered in observed logs) |

**Overall confidence:** HIGH

### Gaps to Address

- **Kalshi rate limit ceiling:** Unknown actual ceiling. Conservative 4 RPS setting may be unnecessarily slow. Validate with incremental RPS bumps in Phase 2 and observe 429 frequency.
- **Gamma API `end_date_max` support:** Not confirmed from code inspection (only inferred from comments). Must test before building short-term Polymarket fetch in Phase 2. If unsupported, client-side filtering of the full 30K market set is the fallback.
- **Direct Kalshi `/markets` pagination without `event_ticker`:** The direct-scan refactor (reducing 300+ requests to ~8 pages) depends on this endpoint variant being accessible. Confirm with one test call in Phase 2 before committing to the refactor. Fallback is the existing two-stage events → markets approach with rebalanced priority scoring.
- **Total active Kalshi market count:** Unknown whether ~1,200 markets discovered is the full universe or an artifact of the 300-event cap. Direct `/markets` scan will answer this definitively.
- **Near-miss at 69.2% below 60% threshold:** The `match-debug.log` shows "Trump out as President before GTA VI?" vs "Donald Trump out as President? - Before August 1, 2026" scoring 69.2% — above the 60% threshold, yet logged as a near-miss. Investigate whether this is a date-gate rejection or a bug in threshold application.

## Sources

### Primary (HIGH confidence — direct source code analysis)
- `src/apis/kalshi.ts` — endpoint structure, two-stage discovery, rate limiter, event priority scoring, auth header absence
- `src/apis/polymarket.ts` — Gamma API structure, offset pagination, condition_id batch refresh
- `src/core/matcher.ts` — inverted index, Jaccard + bigram + date scoring, LRU cache, candidate gate
- `src/core/arbitrage.ts` — volume filter, staleness penalty, passesFilters logic
- `src/core/normalizer.ts` — token pipeline, date normalization, abbreviation map
- `src/config.ts` — all tunable parameter defaults and env var names
- `errors.log` — 50+ consecutive `Kalshi HTTP 401: Unauthorized` entries confirming auth failure
- `match-debug.log` — runtime evidence: 29,946 Poly + 1,214 Kalshi → 1 match; near-miss analysis at 69.2%
- `opportunities.jsonl` — evidence of structural false positive pattern (all matches are 2028 presidential election categorical combos)
- `.planning/PROJECT.md` — scope constraints, explicit anti-features, key decisions
- `.planning/codebase/CONCERNS.md` — known fragile areas and performance bottlenecks

### Secondary (MEDIUM confidence — inferred from working code patterns)
- Kalshi `/events?status=open` parameter — structurally standard; not externally verified; low-risk to test
- Kalshi `/markets` without `event_ticker` — inferred from REST API pattern and existing `KalshiMarketsResponse` type; needs one test call to confirm
- Gamma API `end_date_max` parameter — inferred from `polymarket.ts` comments; needs empirical test

### Tertiary (LOW confidence — theoretical / common pattern)
- Polymarket offset pagination market-miss risk — known limitation of offset-based pagination with a frequently-changing dataset; not observed in logs but structurally guaranteed

---
*Research completed: 2026-03-20*
*Ready for roadmap: yes*
