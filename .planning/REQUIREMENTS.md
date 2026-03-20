# Requirements: Polymarket ↔ Kalshi Arbitrage Screener

**Defined:** 2026-03-20
**Core Value:** Find the maximum number of real, actionable arbitrage opportunities across Polymarket and Kalshi — prioritizing short-term markets (≤7 days) where arbs are most likely to be executable and profitable.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Kalshi API Connectivity

- [ ] **KAPI-01**: Screener works without API authentication — uses Kalshi public endpoints that don't require auth (no `KALSHI_API_KEY` needed)
- [ ] **KAPI-02**: Screener distinguishes 401 (endpoint requires auth — skip/fallback) from 429 (rate limit — backoff) from 5xx (transient — retry) and handles each appropriately
- [ ] **KAPI-03**: Screener logs and surfaces API errors clearly instead of silently swallowing them
- [ ] **KAPI-04**: Screener performs startup health check validating Kalshi API connectivity before starting poll loop
- [ ] **KAPI-05**: Dashboard displays Kalshi market count prominently; shows red alarm when count is zero
- [ ] **KAPI-06**: Sports event exclusion is configurable via env var (not hardcoded)

### Short-Term Discovery

- [ ] **DISC-01**: Event ticker suffix (e.g. `-26MAR2717`) is parsed to extract close date without extra API calls
- [ ] **DISC-02**: `eventPriorityScore()` is rebalanced to boost short-term economic events (CPI, NFP, FOMC, PCE, JOLTS) over long-dated political events
- [ ] **DISC-03**: Short-term events (≤7 days to close) are discovered and matched before longer-dated events in each cycle
- [ ] **DISC-04**: Two-speed discovery cadence — short-term pass every 2 cycles, full discovery every 10 cycles
- [ ] **DISC-05**: Kalshi API requests include `status=open` filter to skip resolved events server-side
- [ ] **DISC-06**: Polymarket fetch prioritizes short-term markets (via `end_date_max` if supported, else client-side filtering)

### Match Quality

- [ ] **MATC-01**: Kalshi `mutually_exclusive` events are detected and excluded from binary-market matching before scoring
- [ ] **MATC-02**: Normalizer expands economic event synonyms (NFP↔Non-Farm Payrolls, PCE↔Personal Consumption Expenditures, etc.)
- [ ] **MATC-03**: `minSharedTokens` is relaxed to 1 for markets closing within 14 days (close-date proximity acts as false-positive gate)
- [ ] **MATC-04**: Year-gate (`MATCHER_YEAR_GATE`) is bypassed for short-term markets where year is implicit
- [ ] **MATC-05**: Numeric range tokens from Kalshi sub-titles (e.g. "40k to 44.9k") are stripped from inverted index
- [ ] **MATC-06**: Volume filter (`minVolumeUsd`) is relaxed for markets closing within 48 hours

### Display & UX

- [ ] **DISP-01**: Opportunities are sorted by time-to-close ascending (≤7d first), then by profit % descending
- [ ] **DISP-02**: Terminal and web dashboard visually segment short-term (≤7d) vs longer-dated opportunities
- [ ] **DISP-03**: Kalshi market count is shown in dashboard header, highlighted red when zero
- [ ] **DISP-04**: `--debug-match` CLI flag outputs match scoring details for troubleshooting

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Execution

- **EXEC-01**: Screener can place trades on Polymarket via CLOB API
- **EXEC-02**: Screener can place trades on Kalshi via authenticated trading API
- **EXEC-03**: Position sizing accounts for order book depth and slippage

### Real-Time Feeds

- **FEED-01**: Price updates arrive via WebSocket instead of REST polling
- **FEED-02**: Latency from price change to opportunity detection is <1 second

### Advanced Matching

- **ADVM-01**: Embedding-based semantic similarity for cross-platform market matching
- **ADVM-02**: ML-trained match confidence scoring

### Notifications

- **NOTF-01**: Push notifications for high-confidence arb opportunities (Telegram/Discord)
- **NOTF-02**: Configurable alert thresholds per market category

## Out of Scope

| Feature | Reason |
|---------|--------|
| Trade execution / bot integration | Future milestone — need reliable screening first |
| WebSocket feeds | Not the current bottleneck (market coverage is) |
| Embedding-based matching | Current fuzzy matching works; coverage is the constraint |
| Order book depth / slippage modeling | Only needed when executing trades |
| Additional platforms (PredictIt, Manifold) | Poly/Kalshi pair not yet saturated |
| Lowering profit threshold below 0.8% | User preference — only show worthwhile opportunities |
| Dynamic threshold tuning via UI | Env vars are sufficient for current milestone |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| KAPI-01 | — | Pending |
| KAPI-02 | — | Pending |
| KAPI-03 | — | Pending |
| KAPI-04 | — | Pending |
| KAPI-05 | — | Pending |
| KAPI-06 | — | Pending |
| DISC-01 | — | Pending |
| DISC-02 | — | Pending |
| DISC-03 | — | Pending |
| DISC-04 | — | Pending |
| DISC-05 | — | Pending |
| DISC-06 | — | Pending |
| MATC-01 | — | Pending |
| MATC-02 | — | Pending |
| MATC-03 | — | Pending |
| MATC-04 | — | Pending |
| MATC-05 | — | Pending |
| MATC-06 | — | Pending |
| DISP-01 | — | Pending |
| DISP-02 | — | Pending |
| DISP-03 | — | Pending |
| DISP-04 | — | Pending |

**Coverage:**
- v1 requirements: 22 total
- Mapped to phases: 0
- Unmapped: 22 (pending roadmap creation)

---
*Requirements defined: 2026-03-20*
*Last updated: 2026-03-20 after initial definition*
