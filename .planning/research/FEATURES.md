# Feature Landscape: Prediction Market Arbitrage Screener (Opportunity Discovery)

**Domain:** Cross-platform prediction market arbitrage — Polymarket vs Kalshi
**Researched:** 2026-03-20
**Confidence:** HIGH (evidence drawn from live codebase + opportunities.jsonl + CONCERNS.md audit)

---

## Context: What the Evidence Shows

Before categorizing features, the codebase evidence reveals the actual problem:

**The screener finds arbs — but wrong ones.** `opportunities.jsonl` shows all detected opportunities are
2028 US Presidential Election markets (e.g., "Will JD Vance win the 2028 US Presidential Election?").
These are 2+ year markets. The problem is not zero opportunities — it's that the screener only matches
long-dated markets while the user wants short-term (≤7 days) opportunities.

**Root causes identified:**
1. Polymarket `fetchAllPolymarketMarkets()` fetches all active markets with no date filter — 30K markets
   of all time horizons, dominated by long-dated political futures
2. Kalshi `selectDiscoveryEvents()` uses keyword scoring that prioritizes "politic", "election",
   "president", "trump" — exactly the categories that match long-dated Polymarket markets
3. `maxCloseDateDeltaDays=180` allows matches 6 months out, which is correct, but there's no
   mechanism to prefer near-expiry markets
4. Short-term Kalshi events (e.g., weekly economic data: CPI, NFP, Fed decisions) may get
   deprioritized in event selection because they score lower on the keyword list vs political keywords

**The matching gap (3 pairs from 763K candidates) is the secondary problem.** The inverted index
requires `minSharedTokens=2` which is strict when platform titles diverge. Kalshi often uses terse
titles like "Fed rate cut at March meeting?" vs Polymarket's "Will the Federal Reserve cut rates in
March 2026?". Two shared tokens is achievable but title vocabulary divergence causes systematic misses.

---

## Table Stakes

Features that must exist for the screener to find short-term opportunities reliably.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Short-term market pre-fetching** | Without date-range filtering, short-term markets are buried in 30K results; fetching them first is the primary ask | Medium | Gamma API supports `end_date_max` and `end_date_min` params — unverified but standard REST API design; needs confirmation. Kalshi has no direct date filter on events endpoint, but markets have `close_time` |
| **Kalshi close-time filtering post-fetch** | Kalshi markets already have `close_time` in the response; filter to ≤7d on the client side without extra API calls | Low | Code already parses `close_time`; filtering is a 5-line change in `normalizeKalshi()` or `selectDiscoveryEvents()` |
| **Event priority scoring adjusted for short-term** | Current scoring boosts "politics" + "election" which selects long-dated events; weekly economic events (CPI, NFP, FOMC minutes) need higher weight | Low-Medium | Modify `eventPriorityScore()` in `kalshi.ts`; add time-to-expiry as a scoring factor |
| **Opportunity ranking by time horizon** | PROJECT.md: "display ranking by time horizon — short-term shown first"; user wants to see ≤7d arbs at top | Low | Sort key already exists (sort by profit%); add secondary sort by `timeToClose` ascending when `timeToClose < 168` (7 days) |
| **Short-term vs long-term visual segmentation** | User needs to immediately distinguish actionable (≤7d) from monitoring (7-30d) from long-dated (>30d) opportunities | Low | Terminal table already has column rendering; add time-horizon badge or section header |
| **Kalshi API coverage maximization** | Only ~1,200 Kalshi markets discovered despite 300 events configured; if events return many markets the cap limits coverage | Medium | Investigate: does `kalshiMaxEventsDiscovery=300` cap cause misses? How many total active Kalshi markets exist? The discovery rotation helps but may skip short-term events |

## Differentiators

Features that increase arb discovery rate beyond baseline.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Looser token matching with time-gating** | Current `minSharedTokens=2` drops many real pairs where titles diverge; dropping to 1 shared token with a stricter close-date gate (+/- 7 days for short-term) would find more matches without false positives | Low-Medium | Core insight: short-term markets are date-gated naturally (both platforms have same expiry week), so token matching can be more permissive; add `shortTermMatchThreshold` config separate from `matchThreshold` |
| **Platform-specific title synonym expansion** | Kalshi uses "Fed" while Polymarket uses "Federal Reserve"; normalizer expands "fed" → "federal reserve" but NOT the reverse; Kalshi "CPI" vs Polymarket "consumer price index" already handled but edge cases exist | Low | Extend `ABBREVIATIONS` map and `NAME_MAP` in `normalizer.ts`; specifically audit weekly economic event vocabulary (NFP, PCE, PPI, JOLTS) |
| **Direct `close_time`-based inverted index bucketing** | Instead of one global index for all markets, build separate indexes for (≤7d), (7-30d), (30-180d); match within same bucket first, then relax | Medium | Increases match precision for short-term events; avoids false positives where "trump" in a short-term Polymarket question matches "trump" in a 2028 Kalshi election event |
| **Kalshi event category whitelist for short-term** | Economic events (FOMC, CPI, NFP, PCE, JOLTS) almost always resolve ≤7 days; prioritize fetching these categories in discovery | Low | Add `SHORT_TERM_CATEGORIES` constant in `kalshi.ts`; bump their priority score to highest tier in `eventPriorityScore()` |
| **Gamma API date-range query for Polymarket** | If Gamma API supports `end_date_max` param, fetch the ≤7d and 7-30d buckets explicitly in the first pages of discovery instead of sorting all 30K markets | Medium | Needs verification: test `GET /markets?active=true&closed=false&end_date_max=<ISO date>`. HIGH impact if supported — eliminates 90% of irrelevant Polymarket markets from match processing |
| **Match diagnostic reporting** | The debug log (`match-debug.log`) shows near-misses but this isn't surfaced in the UI; a "why didn't X match Y?" diagnostic would help tune thresholds | Low-Medium | Add `--debug-match` flag that runs a targeted match between two specific market titles and shows scoring breakdown; invaluable for tuning |
| **Automatic threshold relaxation for near-expiry** | Markets expiring within 24h should have `maxCloseDateDeltaDays` collapsed to 2d and `minSharedTokens` dropped to 1; the tight time window is itself the best gate | Medium | Add `urgencyMode` logic in matcher: if `timeToClose < 24h`, use relaxed token gate but tighter date gate |

## Anti-Features

Features to explicitly NOT build for this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **WebSocket price feeds** | PROJECT.md: explicitly out of scope; not the current bottleneck — market coverage is | Fix event prioritization to get more short-term markets first |
| **Embedding-based matching (ML)** | PROJECT.md: explicitly deferred; current fuzzy matching works, coverage is the constraint, not match quality | Tune existing fuzzy thresholds; the existing algorithm can find more matches with configuration changes |
| **Additional platforms (PredictIt, Manifold, etc.)** | Scope creep; the Poly/Kalshi pair is not yet saturated | Maximize coverage on both existing platforms first |
| **Trade execution / order placement** | PROJECT.md: future milestone | Ensure screener reliably finds opportunities before building execution |
| **Push notifications / alerting** | Not requested; adds infrastructure complexity | Display is already real-time via SSE; the terminal and web dashboard are sufficient |
| **Dynamic threshold tuning via UI** | CONCERNS.md notes this as future; adds complexity | Use env vars and config for now; focus on finding opportunities, not configuring thresholds interactively |
| **Lowering minimum profit below 0.8%** | PROJECT.md: user explicitly wants to keep 0.8% floor | Respect this constraint; find more markets, not lower the bar |
| **Order book depth / slippage modeling** | Only needed when executing trades | Keep fee model as-is (volume-tiered, already good for screening) |

---

## Feature Dependencies

```
Kalshi date-range awareness
  → Kalshi close_time filtering post-fetch (Low, immediate)
  → Event priority scoring for short-term categories (Low-Medium)
     → Looser token matching with time-gating (depends on better event coverage first)
        → Automatic threshold relaxation for near-expiry (builds on top)

Polymarket date-range query (if Gamma API supports it)
  → Short-term market pre-fetching (direct Gamma API filter)
  → Date-range inverted index bucketing (cleaner separation of horizons)

Platform vocabulary audit
  → Synonym expansion for economic events (NFP, PCE, JOLTS)
  → Match diagnostic reporting (enables validation of synonym additions)

Display changes (independent, low complexity)
  → Opportunity ranking by time horizon (sort change)
  → Short-term vs long-term visual segmentation (rendering change)
```

---

## MVP Recommendation

Given the root cause analysis — the screener already works, it's just finding the wrong markets —
the minimum viable set of changes to find significantly more short-term arbs is:

**Priority 1 (highest leverage, lowest effort):**
1. **Kalshi event priority scoring** — add `close_time` proximity to event scoring; boost economic event categories; this changes what 300 events are fetched without any API changes
2. **Kalshi `close_time` post-fetch filtering** — after fetching markets, partition into short-term vs long-term buckets; run short-term through matching first in every cycle, not just discovery cycles
3. **Opportunity display sort** — sort by `timeToClose` ascending when `timeToClose < 168h`; user immediately sees most actionable at top

**Priority 2 (medium leverage, medium effort):**
4. **Gamma API date-range verification and implementation** — test whether `end_date_max` param exists; if yes, add a dedicated short-term Polymarket fetch pass that runs on every cycle (not just discovery)
5. **Synonym expansion for economic events** — audit NFP, PCE, PPI, JOLTS, FOMC vocabulary divergence between platforms; add to normalizer

**Defer for now:**
- Time-gated looser matching: implement only after verifying short-term events are being discovered
- Match diagnostics: useful but not blocking opportunity discovery
- Index bucketing: premature optimization until event coverage is confirmed

---

## Specific Technical Observations for Implementation

These are direct findings from code inspection, not hypotheses:

**Finding 1: The Kalshi priority keyword list actively hurts short-term discovery.**
`PRIORITY_KEYWORDS` in `kalshi.ts:157-161` heavily weights: politic, election, trump, biden — all
terms that appear in long-dated 2028 presidential election events. Short-term economic events like
"CPI January 2026" or "Fed funds rate March 2026" score 0-2 points vs political events scoring 8-12.
This means the 300-event discovery cap is filling with long-dated political events.

**Finding 2: The `maxCloseDateDeltaDays=180` gate is not the bottleneck.**
The date gate in `matcher.ts:248-253` drops pairs where close dates diverge by >180 days. Since
Polymarket and Kalshi both post the same economic events, their close dates should agree within hours.
The gate is not why short-term markets don't match — they're not being fetched in the first place.

**Finding 3: `minSharedTokens=2` may be too strict for terse Kalshi titles.**
Kalshi title example from debug log: a market like "CPI above 3% in March?" has tokens: [cpi, consumer,
price, index, above, march] = 6 tokens. Polymarket: "Will CPI be above 3.0% in March 2026?" has tokens:
[cpi, consumer, price, index, above, march, 2026] = 7 tokens. These would match. But: "Fed rate cut?"
→ tokens [federal, reserve, rate, cut] vs "Will the Fed cut rates at the March FOMC meeting?" →
[federal, reserve, cut, rates, march, fomc, meeting]. Shared = {federal, reserve, cut} = 3 tokens.
This would pass — but only if the Kalshi title is actually descriptive enough. Terse Kalshi titles
like "FOMC March Cut?" might produce only [fomc, march, cut] = 3 tokens, missing "federal" and
"reserve" entirely, leaving only "march" and "cut" as shared = 2. Passes, but barely.

**Finding 4: Discovery runs every 10 cycles (30 seconds at 3s poll), refresh runs between.**
The discovery/refresh split means Kalshi's full event catalog is only re-evaluated every 30 seconds.
For short-term markets with volatile prices, this is acceptable. But during the long discovery cycle,
short-term opportunities may be missed because matched pairs aren't updated. This is acceptable
for now but worth noting.

**Finding 5: Polymarket Gamma API offset-based pagination fetches from newest to oldest.**
The comment in `polymarket.ts:8` says: "supports active/closed filters, unlike CLOB which paginates
from oldest." This implies Gamma API returns markets in reverse-chronological (newest first) order.
Short-term markets that were recently listed would appear in early pages; long-running political
futures also appear because they remain "active". A date filter would be more targeted than hoping
short-term markets appear early.

---

## Sources

**Primary sources (HIGH confidence):**
- Codebase direct inspection: `src/apis/kalshi.ts`, `src/apis/polymarket.ts`, `src/core/matcher.ts`,
  `src/core/normalizer.ts`, `src/config.ts`, `src/index.ts`
- Evidence of actual matches: `opportunities.jsonl` (all 2028 presidential election opportunities)
- Known issues: `.planning/codebase/CONCERNS.md` (performance bottlenecks, fragile areas)
- Project requirements: `.planning/PROJECT.md` (active scope, constraints, key decisions)
- API integration details: `.planning/codebase/INTEGRATIONS.md`

**Claims needing verification (MEDIUM-LOW confidence):**
- Gamma API supports `end_date_max`/`end_date_min` query params — not confirmed from code, needs
  direct API test before building this feature
- Total number of active Kalshi markets (stated as ~1,200 in PROJECT.md but this may be the result
  of the 300-event cap, not the actual market count)
- Whether Kalshi events endpoint supports any date/status filtering beyond cursor pagination
