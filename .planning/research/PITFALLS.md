# Domain Pitfalls: Prediction Market Arb Screener

**Domain:** Cross-platform prediction market arbitrage (Polymarket + Kalshi)
**Researched:** 2026-03-20
**Evidence base:** Source code audit (`src/apis/kalshi.ts`, `src/apis/polymarket.ts`, `src/core/matcher.ts`, `src/core/arbitrage.ts`), runtime logs (`errors.log`, `match-debug.log`), and discovered opportunity data (`opportunities.jsonl`)

---

## Critical Pitfalls

Mistakes that cause zero discovery or require structural rewrites.

---

### Pitfall 1: Kalshi "Public" API Now Requires Authentication

**What goes wrong:**
The code assumes `https://api.elections.kalshi.com/trade-api/v2` endpoints (`/events`, `/markets`) are publicly accessible without credentials. The README says "No API key required for read-only discovery." In practice, every single call to these endpoints now returns `HTTP 401 Unauthorized`.

**Evidence from logs:**
```
[2026-03-19T15:07:05.023Z] Kalshi fetch error: Kalshi HTTP 401: Unauthorized
[2026-03-19T15:07:11.772Z] Kalshi fetch error: Kalshi HTTP 401: Unauthorized
... (50+ consecutive 401s, every ~7 seconds)
```
The 401s fire on `/markets` fetches during the per-event loop. When every event's market fetch returns 401, the system returns zero Kalshi markets. Zero markets = zero matched pairs = zero arb opportunities. This is the single largest blocker.

**Why it happens:**
Kalshi updated their API access policy after the screener was written. The v2 API at `api.elections.kalshi.com` now enforces authentication even for read-only GET requests. The code has no auth path — `KALSHI_API_KEY` is optional in `.env` and is never sent in the `HEADERS` object (`{ "Accept": "application/json" }` only).

**Consequences:**
Zero Kalshi market data. Matching runs against an empty set. The screener silently "succeeds" at fetching 0 markets with no hard failure — the error is swallowed per-event and the fetch function just returns an empty array.

**Prevention:**
- Implement Kalshi API key authentication: add `Authorization: Bearer <key>` header when `KALSHI_API_KEY` is set.
- Fail fast and loudly when the first Kalshi API call returns 401 — do not silently continue with zero markets.
- Add a startup health check that validates Kalshi connectivity before entering the poll loop.
- Alert the operator when Kalshi market count drops to zero on consecutive discovery cycles.

**Warning signs:**
- `errors.log` filling with `Kalshi HTTP 401: Unauthorized`
- `match-debug.log` showing `0 selected events` or `Discovery complete: 0 active markets`
- Zero or near-zero matched pairs despite successful Polymarket fetch
- `opportunities.jsonl` stops receiving entries

**Phase:** Address in Phase 1 (Kalshi API optimization). This is the primary blocker.

---

### Pitfall 2: Structural False Positives — Matching Incompatible Market Types

**What goes wrong:**
The fuzzy matcher pairs Polymarket "Will X win?" individual-candidate markets against Kalshi "Who will win?" categorical/combo markets. These appear to be the same event but are structurally incompatible: a Polymarket YES on "Will Pete Buttigieg win the 2028 election?" (price: $0.0165) vs. Kalshi NO on a combo market (price: $0.78) produces a combined cost of $0.7965 and a calculated profit of 25.5% — but it's not a real arbitrage. They resolve differently.

**Evidence from opportunities.jsonl:**
```json
{"event":"Will Pete Buttigieg win the 2028 US Presidential Election?",
 "polymarketSide":"YES","kalshiSide":"NO",
 "polymarketAsk":0.0165,"kalshiAsk":0.78,
 "combinedCost":0.7965,"profitPct":25.549...,"matchScore":0.762...}
```
The pattern repeats for every long-shot 2028 candidate (Wes Moore 26.7%, Gretchen Whitmer 26.5%, Josh Shapiro 24.3%, AOC 20.8%, etc.). All have near-identical structure: poly YES at ~$0.01–$0.20, kalshi NO at $0.78. These are not real arbs — Kalshi's "Who will win?" market resolves YES for only one candidate; Polymarket's individual markets can all resolve NO simultaneously.

**Why it happens:**
The matching algorithm scores titles on token overlap and bigram similarity. "Will Gavin Newsom win the 2028 US Presidential Election?" matches against "Who will run for the 2028 Democratic presidential nomination?" because they share tokens: `presidential`, `2028`, `democratic`. The `matchScore` reaches 0.78–1.0 (well above the 0.60 threshold) but the underlying contract structures are incompatible.

**Consequences:**
Operator sees high-profit opportunities (10–27%) that cannot be executed. If an automated trading system is built on this screener, it will lose money on every "arb" it attempts. Trust in the screener is destroyed once false positives are acted upon.

**Prevention:**
- Add a market-type compatibility check before calling `computeArb`. Kalshi multi-outcome categorical markets (ticker patterns like `KX2028DRUN-28`, `KX2028RRUN-28`) should never be matched against Polymarket single-outcome binary markets.
- Detect Kalshi "combo" or "who will win" markets by checking `mutually_exclusive: true` on the event or by inspecting the event ticker prefix. These events contain multiple markets that together cover 100% probability — no single market is a binary yes/no equivalent of a Polymarket question.
- When a Kalshi event has `mutually_exclusive: true`, require that the matched Polymarket market is also a mutually-exclusive set (not a single binary question).
- Add a cross-validation check: if `poly.yesAsk + poly.noAsk` is significantly different from `kalshi.yesAsk + kalshi.noAsk`, flag as potential type mismatch.

**Warning signs:**
- Many high-profit (>10%) opportunities discovered in the same cycle, all on the same event type
- Multiple Kalshi markets from the same event all matching against different Polymarket markets
- Kalshi YES prices near $0.00–$0.15 paired with Polymarket NO near $0.80 (or vice versa) on long-shot candidates
- `matchScore` above 0.75 but combined prices suspiciously far from $1.00

**Phase:** Address in Phase 2 (matching quality). Must be resolved before building any execution layer.

---

### Pitfall 3: Silent Zero-Market Failure — No Circuit Breaker on Empty Discovery

**What goes wrong:**
When the Kalshi API returns 401 (or any other error) for every market fetch, `fetchAllKalshiMarkets()` returns an empty array rather than throwing. The main poll loop calls `matchMarkets(polyMarkets, [])` — which completes successfully with zero matches. The screener continues running, consuming Polymarket API quota, and reporting metrics normally. The operator sees "0 opportunities" but no alarm.

**Evidence from code:**
In `kalshi.ts`, each event's market fetch is wrapped in a try/catch that calls `appendError()` and breaks the per-event loop — but returns the (empty) `markets` array. The outer `fetchMarketsForEventsBatch` uses `Promise.allSettled` and continues on failures. The system never surfaces "Kalshi is completely broken" as a distinct state.

**Why it happens:**
Resilience code designed to handle transient errors (single 429, single 5xx) was extended to swallow auth failures (401), which are persistent and indicate a configuration problem, not a transient outage.

**Consequences:**
Hours of wasted runtime. Polymarket API quota consumed. Operator concludes "there are no arb opportunities" when the real issue is "Kalshi data is completely absent."

**Prevention:**
- Track consecutive Kalshi failures with a counter. If >= N consecutive discovery cycles return zero markets, emit a loud startup-time warning and set a `kalshiHealthy: false` flag visible in the dashboard.
- Distinguish 401 (auth failure — stop retrying, alert immediately) from 429 (rate limit — backoff) from 5xx (transient — retry).
- On 401, do not retry with exponential backoff — it will never recover without a config change. Log once at ERROR level and halt Kalshi fetching for that session.
- Show Kalshi market count prominently in the dashboard header. Zero should appear in red.

**Warning signs:**
- `errors.log` contains 401 errors (not 429)
- Kalshi market count in metrics is 0 but screener is not reporting an error
- Dashboard shows "0 opportunities" across many cycles with no explanation

**Phase:** Address in Phase 1 alongside auth fix.

---

## Moderate Pitfalls

---

### Pitfall 4: Kalshi Market Title Construction Loses Specificity

**What goes wrong:**
The `buildTitle()` function in `kalshi.ts` constructs market titles as `"${event.title} - ${market.yes_sub_title}"`. For multi-outcome Kalshi events, the sub-title contains the specific outcome (e.g., "Between 20% and 29.99%"). The full title becomes "What will the US tariff rate on China be on July 1? - Between 20% and 29.99%". This title then gets normalized and the percentage range tokens (`20`, `29`, `99`) are treated as meaningful match tokens, causing cross-matches with Polymarket markets that happen to contain similar numbers.

**Evidence from match-debug.log:**
```
Kalshi sample: "What will the US tariff rate on China be on July 1? - Between 20% and 29.99%"
→ normalized: "what united states tariff rate china 2026-07-01 between 20 29 99"
→ tokens: [what, united, states, tariff, rate, china, 2026-07-01, between, 20, 29, 99]
```
The number tokens `20`, `29`, `99` are low-information for matching purposes but count toward `minSharedTokens` and inverted index hits, potentially surfacing false candidate pairs.

**Prevention:**
- Strip numeric range tokens (bare integers from percentage ranges like "20", "29.99", "99") from the token set used for inverted index lookup. Keep them in the normalized title for bigram scoring but exclude from the candidate gate.
- Alternatively, treat Kalshi multi-outcome sub-title tokens separately from event-level tokens, giving them lower weight.
- For Kalshi categorical markets, prefer matching on the event title only when the sub-title is a numeric range or percentage.

**Phase:** Address in Phase 2 (matching quality).

---

### Pitfall 5: Polymarket Gamma Prices Are Indicative, Not Executable

**What goes wrong:**
Polymarket's Gamma API returns `outcomePrices` which are mid-prices derived from the CLOB order book, not the actual best ask price. Real execution requires hitting the best ask on the CLOB, which will be higher than the Gamma mid. For arbs near the 0.8% minimum threshold, the actual executable price may eliminate the opportunity entirely.

**Evidence from code and README:**
The README explicitly states: "Gamma prices ≠ CLOB best ask — list data uses Gamma `outcomePrices` (mid/indicative)."

The issue is that `normalizePolymarket()` uses `yesToken.price` directly as the ask price in `yesAsk: yesToken.price`. This is the mid, not the ask. For a market at $0.50 mid with a typical spread of 1–3 cents, the actual ask is $0.51–$0.53.

**Prevention:**
- Apply a configurable "Gamma ask premium" to all Polymarket prices before arb calculation (e.g., `POLY_GAMMA_PREMIUM_PCT=0.5` adds 0.5% to all Polymarket asks).
- For opportunities above a threshold profit (e.g., >5%), implement a second-stage CLOB quote validation before surfacing them as actionable.
- Document the known discrepancy in the dashboard so operators understand displayed profits are optimistic.
- Do not surface gross profits below ~2% as "actionable" without CLOB validation, since the spread alone may consume the edge.

**Phase:** Address in Phase 2 (arb quality). Does not affect discovery volume, but affects actionability.

---

### Pitfall 6: The `minSharedTokens=2` Gate Blocks Valid Matches on Short Market Titles

**What goes wrong:**
The inverted index candidate gate requires `minSharedTokens` (default: 2) matching tokens between a Polymarket market and any Kalshi market before even computing similarity. Markets with short, specific titles often have only 2–4 meaningful tokens after stop-word removal. If the platforms phrase the same event using different vocabulary, they will share fewer than 2 tokens and never be evaluated — even with perfect paraphrase matching potential via bigrams.

**Evidence from match-debug.log:**
```
Poly sample: "BitBoy convicted?" → normalized: "bitboy convicted" → tokens: [bitboy, convicted]
```
A Kalshi market titled "Will BitBoy be convicted?" would normalize to: `bitboy`, `convicted` — exactly 2 shared tokens, which passes the gate. But "Will Ben Armstrong face criminal conviction?" → `ben`, `armstrong`, `criminal`, `conviction` — zero overlap with `[bitboy, convicted]`, so it never gets scored despite being the same event.

**Prevention:**
- Lower `minSharedTokens` to 1 as a trial, measure the increase in `candidatesEvaluated` in metrics to assess computational cost before committing.
- Add synonyms/aliases for common prediction market entities (crypto personalities, political figures) to the normalizer so different phrasings converge to the same tokens.
- Consider a secondary matching pass for markets that share at least one high-IDF token (rare tokens like `bitboy`, `zelensky`, `tariff`) even if they fail the 2-token gate.

**Phase:** Address in Phase 2 (matching quality). Low risk of performance regression if monitored via metrics.

---

### Pitfall 7: Close Date Gate Prematurely Eliminates Valid Short-Term Matches

**What goes wrong:**
The `maxCloseDateDeltaDays` config (default: 180 days) should be permissive, but the date gate in `matcher.ts` compares `poly.closeTime` to `kalshi.closeTime` directly. Polymarket's `endDate` and Kalshi's `close_time` do not always represent the same concept: Polymarket may close a market at a specific time on resolution day; Kalshi may close at market open or midnight. A 1–2 day difference can exist for structurally identical markets, which is fine — but if a platform uses UTC vs. local time inconsistently, a 3-day apparent delta can occur for same-day markets.

More critically, the normalizer's `normalizeDates()` function converts "Dec 31" (no year) to the current year. If either platform title contains a partial date and the other contains a full date, the date score in `dateScore()` will be computed against the wrong year — potentially yielding a low score that drags the composite match below threshold.

**Prevention:**
- When parsing partial dates in `normalizeDates()`, check whether the resolved date is in the past; if so, assume next year, not current year.
- Log all date-gate rejections with the computed delta to `match-debug.log` to identify systematic mismatches.
- Consider treating close dates as a soft signal (weight already at 0.25) rather than a hard gate, or widen the hard gate to 365 days while tightening the soft scoring.

**Phase:** Address in Phase 2 (matching quality).

---

### Pitfall 8: Discovery Rotation Skips Events Deterministically

**What goes wrong:**
`selectDiscoveryEvents()` caps at `kalshiMaxEventsDiscovery` (default: 300). High-priority events (those matching `PRIORITY_CATEGORIES` or `PRIORITY_KEYWORDS`) always fill the cap first. Low-priority events use a rotation index to cycle through. However, the rotation index (`discoveryRotationIndex`) increments once per full discovery run. If discovery runs every 10 cycles (`DISCOVERY_INTERVAL_CYCLES=10`) and there are 500 low-priority events, each event gets fetched roughly once per 500/N discovery runs — potentially never within a normal session.

Critically, sports events are entirely excluded (`isSportsEventCategory`) and some prediction markets (e.g., "Will [athlete] win [award]?") exist on both platforms. If Kalshi categorizes an event as "Sports" but Polymarket doesn't, it will never be matched.

**Prevention:**
- Log the total number of Kalshi events before filtering and the number excluded by sports filter, to understand what's being dropped.
- Make the sports exclusion configurable (`KALSHI_EXCLUDE_SPORTS=true`) rather than hardcoded — the user may want sports markets.
- Review the `PRIORITY_KEYWORDS` list; tokens like "reserve" and "federal" appear 189+ and 233+ times in the inverted index (too common to be useful priority signals).

**Phase:** Address in Phase 1 (discovery volume). The sports filter exclusion is a quick win.

---

## Minor Pitfalls

---

### Pitfall 9: `no_ask` Defaulting to Zero Silently Removes Markets

**What goes wrong:**
`parsePrice()` in `kalshi.ts` returns `0` when both `yes_ask_dollars` and `yes_ask` are absent or zero. `normalizeKalshi()` returns `null` when `yes_ask <= 0 || no_ask <= 0`. Kalshi markets that are deeply one-sided (e.g., near-certain YES at $0.99, NO at $0.01) may return `no_ask: 0` or `no_ask_dollars: "0.0000"` in the API response when the market is illiquid on that side.

**Prevention:**
- Log the number of Kalshi markets filtered out by the zero-price gate per discovery cycle.
- Consider treating `no_ask = 0` as `no_ask = 0.01` (minimum tick) rather than discarding, to still be able to match the market and detect arb on the tradeable side.

**Phase:** Low priority; address opportunistically in Phase 2.

---

### Pitfall 10: LRU Match Cache Evicts Valid Pairs During Large Discovery Runs

**What goes wrong:**
`matchCacheMaxSize` defaults to 5000. With 30K Polymarket and 1.2K Kalshi markets producing potentially hundreds of candidate pairs per cycle, the LRU cache can evict valid matches if a later discovery run happens to score slightly below threshold and the cache entry is pushed out. The next time those two markets are evaluated, the checksums will have changed (new close time data, different volume), so the cache won't be reused anyway — but this means correctly matched pairs can disappear from the display between cycles.

**Prevention:**
- Monitor cache hit/miss ratio in metrics. If hit rate is low, the cache is not helping.
- Increase `MATCH_CACHE_MAX_SIZE` proportionally to the number of active markets × expected match rate.

**Phase:** Low priority; address if cache churn is observed in metrics.

---

### Pitfall 11: Polymarket Offset-Based Pagination Can Miss Markets

**What goes wrong:**
Polymarket discovery uses `offset`-based pagination (not cursor-based). If a new active market is created or an existing market becomes active between page fetches, the offset shifts and one page of markets may be skipped entirely. This is a known limitation of offset pagination with a frequently-changing dataset.

**Evidence from code:**
```typescript
offset += data.length;
```
The offset advances by the number of records returned, not by a stable cursor. If 3 markets are inserted between page 2 and page 3 requests, page 3 will start 3 records too late and miss those markets.

**Prevention:**
- Sort Polymarket requests by a stable field (e.g., `endDate` ascending or `conditionId` lexicographic) to make pagination more deterministic.
- Run discovery frequently enough (short `DISCOVERY_INTERVAL_CYCLES`) that any missed markets are caught in the next cycle.
- Accept this as a known limitation for now — it affects at most one page per cycle and the screener already re-discovers every N cycles.

**Phase:** Low priority for now; accept the limitation until coverage is otherwise improved.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Kalshi API auth implementation | 401 loop without circuit breaker | Distinguish 401 from 429 in error handling; add startup health check |
| Short-term market prioritization | Prioritizing short-term may miss the only overlapping markets (many are long-dated) | Implement ranking (not filtering) so long-term markets still appear |
| Kalshi market title construction | Numeric sub-title tokens pollute the inverted index | Strip pure-numeric range tokens before indexing |
| Matching threshold tuning | Lowering threshold increases false positives from incompatible market types | Fix structural false positive detection before touching the threshold |
| Arb detection with new matches | Structural false positives from categorical vs. binary market type mismatch | Add market-type compatibility check before `computeArb()` |
| Demo mode validation | Demo mode generates synthetic Kalshi data that will not reproduce real 401 failures | Always test auth changes against real API, not demo mode |

---

## Summary of Root Causes for "Very Few Opportunities Found"

Based on direct log and code evidence, the low opportunity count has three distinct causes stacked together:

1. **Auth failure (most impactful):** Kalshi returns 401 in recent sessions, yielding zero markets and zero matches. This is the primary blocker.
2. **Structural false positives (second most impactful):** When Kalshi auth was working (earlier session, first 15 lines of `opportunities.jsonl`), the screener found 15+ "opportunities" in one cycle — but all were Polymarket individual-candidate markets matched against Kalshi categorical combo markets. These are not executable arbs. Fixing auth without fixing this will produce noisy false signals.
3. **Matching gap (third issue):** The `match-debug.log` shows the closest valid near-miss at 69.2% — "Trump out as President before GTA VI?" vs. "Donald Trump out as President? - Before August 1, 2026". With a threshold of 60%, this should have matched. Investigating why it registered as a near-miss rather than a match is warranted.

---

## Sources

- `src/apis/kalshi.ts` — Direct code audit, auth header construction, error handling
- `src/apis/polymarket.ts` — Gamma API integration, offset pagination
- `src/core/matcher.ts` — Inverted index, candidate gate, scoring weights
- `src/core/arbitrage.ts` — Price prefilter, passesFilters logic
- `src/core/normalizer.ts` — Token pipeline, date normalization
- `src/config.ts` — Default values for all thresholds
- `errors.log` — Runtime evidence of persistent 401s on Kalshi
- `match-debug.log` — Token stats, near-miss analysis, inverted index composition
- `opportunities.jsonl` — Evidence of structural false positive pattern
- Confidence: HIGH for pitfalls 1, 2, 3 (direct runtime evidence); MEDIUM for pitfalls 4–8 (code analysis); LOW for pitfall 11 (theoretical, common pagination issue)
