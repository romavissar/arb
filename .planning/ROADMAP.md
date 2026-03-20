# Roadmap: Polymarket ↔ Kalshi Arbitrage Screener

## Overview

Fix and optimize the existing arbitrage screener to find real, actionable short-term opportunities. The pipeline is structurally sound but broken at the data layer: Kalshi returns zero markets (HTTP 401 on all reads), discovery selects the wrong markets (long-dated political events fill the cap), and matching produces structural false positives (categorical vs binary type mismatches). This roadmap fixes those root causes in dependency order — connectivity first, then discovery, then match quality, then display polish.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: API Connectivity and Observability** - Get Kalshi data flowing without auth and surface failures loudly
- [ ] **Phase 2: Short-Term Discovery** - Reorient event selection to surface near-expiry markets first
- [ ] **Phase 3: Match Quality** - Eliminate structural false positives and tune matching for short-term markets
- [ ] **Phase 4: Display and UX** - Surface real opportunities clearly, sorted by time horizon

## Phase Details

### Phase 1: API Connectivity and Observability
**Goal**: Kalshi markets are discovered without API authentication and all failure modes surface clearly
**Depends on**: Nothing (first phase)
**Requirements**: KAPI-01, KAPI-02, KAPI-03, KAPI-04, KAPI-05, KAPI-06
**Success Criteria** (what must be TRUE):
  1. Screener discovers Kalshi markets on startup without a KALSHI_API_KEY configured (uses public endpoints only; no auth header sent)
  2. A 401 response stops retrying that endpoint immediately and logs a clear error — it does not silently loop
  3. Dashboard header shows Kalshi market count; count displays in red when it reaches zero
  4. Startup health check reports Kalshi API status before the poll loop begins — pass or fail is visible in terminal
  5. Sports exclusion behavior can be toggled via env var without code changes
**Plans**: TBD

### Phase 2: Short-Term Discovery
**Goal**: Markets expiring within 7 days are discovered and matched before longer-dated markets in every cycle
**Depends on**: Phase 1
**Requirements**: DISC-01, DISC-02, DISC-03, DISC-04, DISC-05, DISC-06
**Success Criteria** (what must be TRUE):
  1. Event ticker suffix (e.g., `-26MAR2717`) is parsed to a close date locally — no extra API call required
  2. Short-term economic events (CPI, NFP, FOMC, PCE, JOLTS) rank above long-dated political events in discovery priority
  3. Short-term markets (≤7 days) appear in match candidates before longer-dated markets within the same discovery cycle
  4. Kalshi API requests include `status=open` filter — resolved events do not consume rate-limit budget
  5. Polymarket fetch targets markets closing within 7 days before fetching the full universe (via `end_date_max` or client-side filtering)
**Plans**: TBD

### Phase 3: Match Quality
**Goal**: All matched pairs are structurally valid arbitrage candidates with no categorical/binary type mismatches
**Depends on**: Phase 2
**Requirements**: MATC-01, MATC-02, MATC-03, MATC-04, MATC-05, MATC-06
**Success Criteria** (what must be TRUE):
  1. Kalshi mutually-exclusive markets are never matched against Polymarket binary markets — zero categorical/binary false positives
  2. Economic event synonyms match correctly across platforms (NFP matches "Non-Farm Payrolls", PCE matches "Personal Consumption Expenditures", etc.)
  3. Short-term markets (≤14 days) match with a single shared token threshold — close-date proximity gates false positives
  4. Numeric range tokens from Kalshi sub-titles (e.g., "40k to 44.9k") do not pollute the inverted index
  5. Volume filter is relaxed to zero for markets closing within 48 hours — near-expiry low-volume markets are not discarded
**Plans**: TBD

### Phase 4: Display and UX
**Goal**: Real arbitrage opportunities are surfaced immediately with short-term markets prominently shown
**Depends on**: Phase 3
**Requirements**: DISP-01, DISP-02, DISP-03, DISP-04
**Success Criteria** (what must be TRUE):
  1. Opportunity list sorts with ≤7 day markets at the top, then by profit % descending within each horizon band
  2. Terminal and web dashboard visually distinguish short-term (≤7d) from longer-dated opportunities
  3. Kalshi market count appears in the dashboard header and turns red when the count is zero
  4. Running with `--debug-match` outputs per-pair scoring details to help diagnose missed matches
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. API Connectivity and Observability | 0/TBD | Not started | - |
| 2. Short-Term Discovery | 0/TBD | Not started | - |
| 3. Match Quality | 0/TBD | Not started | - |
| 4. Display and UX | 0/TBD | Not started | - |
