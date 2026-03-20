---
phase: 01-api-connectivity-and-observability
plan: "01"
subsystem: api
tags: [kalshi, rate-limiting, error-handling, pagination, typescript]

# Dependency graph
requires: []
provides:
  - Direct Kalshi market discovery via GET /markets?status=open cursor pagination (~6-10 requests vs 300+)
  - KalshiAuthError class with 401 circuit breaker (no retry on auth failures)
  - Session-level auth disable flag (kalshiDisabledDueToAuth) with isKalshiDisabled() export
  - Configurable sports exclusion via KALSHI_EXCLUDE_SPORTS env var
affects:
  - 01-02 (observability plan uses isKalshiDisabled())
  - Phase 2 (DISC — matcher uses Kalshi market data from new direct pagination)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Session-level circuit breaker flag for fatal API errors (401)
    - Direct pagination over fan-out: single /markets?status=open loop instead of events->markets cascade
    - Env-var-gated behavior (KALSHI_EXCLUDE_SPORTS) for tunable filtering

key-files:
  created: []
  modified:
    - src/apis/kalshi.ts
    - src/config.ts
    - src/types/index.ts
    - src/index.ts

key-decisions:
  - "Use GET /markets?status=open direct pagination instead of events fan-out — reduces 300+ requests to ~6-10 per cycle"
  - "401 on Kalshi endpoints throws KalshiAuthError with no retry — avoids cascading failures when endpoint requires auth"
  - "Session-level disable flag: once a 401 is seen, all subsequent discovery calls short-circuit to empty array"
  - "Sports filtering uses a single fetchAllEvents() call for category map, not per-market lookups"
  - "Old selectDiscoveryEvents/fetchMarketsForEventsBatch functions preserved for refresh-mode code paths"

patterns-established:
  - "KalshiAuthError: distinct error class for auth failures, separate from generic HTTP errors"
  - "isKalshiDisabled(): exported health-check function for observability and conditional logic in callers"

requirements-completed: [KAPI-01, KAPI-02, KAPI-06]

# Metrics
duration: 3min
completed: 2026-03-20
---

# Phase 01 Plan 01: Direct Kalshi Market Pagination Summary

**Replaced broken two-stage Kalshi discovery (events fan-out causing 401/429 cascades) with direct /markets?status=open cursor pagination, adding a 401 circuit breaker and env-var-gated sports filter**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-20T15:08:47Z
- **Completed:** 2026-03-20T15:11:43Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Direct market pagination replaces 300+ HTTP requests per cycle with ~6-10 (one pass over /markets?status=open)
- KalshiAuthError class with 401 circuit breaker: no retry on auth failures, session-level disable flag set
- KALSHI_EXCLUDE_SPORTS env var (default true) controls sports category filtering; sports filter uses a single events fetch for category map instead of per-market lookups

## Task Commits

Each task was committed atomically:

1. **Task 1: Add KalshiAuthError, 401 circuit breaker, and config for sports exclusion** - `e01b3ed` (feat)
2. **Task 2: Replace two-stage discovery with direct /markets?status=open pagination** - `d1020a0` (feat)

## Files Created/Modified

- `src/apis/kalshi.ts` - Added KalshiAuthError class, 401 guard in kalshiFetchJson, fetchAllKalshiMarketsDirect(), isKalshiDisabled(), kalshiDisabledDueToAuth flag; fetchAllKalshiMarkets() now delegates to direct pagination
- `src/config.ts` - Added kalshiExcludeSports: envBool("KALSHI_EXCLUDE_SPORTS", true)
- `src/types/index.ts` - Added kalshiExcludeSports: boolean to Config interface
- `src/index.ts` - Added isKalshiDisabled to imports for Plan 02 observability use

## Decisions Made

- Direct pagination chosen over events fan-out: eliminates 300+ requests per cycle and removes the event-ticker-scoped 401 cascade
- KalshiAuthError is a distinct error class (not a generic error string) so callers can instanceof-check without parsing messages
- Session-level circuit breaker: once disabled, all discovery returns empty immediately — avoids hammering a 401-returning endpoint every cycle
- Old discovery code (selectDiscoveryEvents, fetchMarketsForEventsBatch) preserved since fetchKalshiMarketsForEventTickersWithTargets (refresh mode) still uses the event-ticker-scoped approach

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None — TypeScript compiled with zero errors on first run.

## User Setup Required

None — no external service configuration required. KALSHI_EXCLUDE_SPORTS defaults to true; set to false in .env to include sports markets.

## Next Phase Readiness

- Kalshi discovery is now lean (~6-10 requests vs 300+) and fault-tolerant on 401
- isKalshiDisabled() is exported and imported in src/index.ts — ready for Plan 02 to surface auth status in observability output
- 429 backoff behavior is unchanged (existing AdaptiveRateLimiter)

---
*Phase: 01-api-connectivity-and-observability*
*Completed: 2026-03-20*
