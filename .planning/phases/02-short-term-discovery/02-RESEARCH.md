# Phase 02: Short-Term Discovery - Research

**Researched:** 2026-03-20
**Domain:** Prediction market API date-filtering, discovery scheduling, ticker parsing
**Confidence:** HIGH

---

## Summary

Phase 2 transforms the discovery pipeline from a single-speed, unordered scan into a two-speed, priority-aware system where short-term markets (≤7 days) are surfaced before longer-dated ones. The work falls into four self-contained areas: (1) parse Kalshi event ticker date suffixes locally without extra API calls, (2) rebalance `eventPriorityScore()` to boost economic events with imminent close dates, (3) implement a two-speed discovery cadence (short-term pass every 2 cycles, full discovery every 10), and (4) add Polymarket `end_date_max` query filtering to pre-scope the short-term fetch.

The current codebase already has `status=open` on the Kalshi `/markets` call (DISC-05 is effectively done — confirmed in `kalshi.ts` line 298). The three remaining areas require new code: ticker date parsing (DISC-01), priority score rebalancing (DISC-02/03), the two-cadence scheduler (DISC-04), and Polymarket date filtering (DISC-06).

**Primary recommendation:** Add a `parseKalshiEventCloseDate(ticker: string): Date | null` utility, extend `eventPriorityScore` to accept a `closeDate`, gate the short-term pass at ≤7 days using the parsed date, and introduce a `SHORT_TERM_PASS_CYCLES=2` cycle counter alongside the existing `DISCOVERY_INTERVAL_CYCLES=10`.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DISC-01 | Parse event ticker suffix (e.g. `-26MAR2717`) to close date locally — no extra API call | Regex against DDMMMYY pattern; confirmed Kalshi ticker format from community examples |
| DISC-02 | `eventPriorityScore()` boosts short-term economic events (CPI, NFP, FOMC, PCE, JOLTS) over long-dated political events | Extend existing function with `daysToClose` parameter; add economic keyword set |
| DISC-03 | Short-term events (≤7 days) discovered and matched before longer-dated events in each cycle | Sort by `daysToClose ASC, score DESC`; process short-term subset first in `matchMarkets` call |
| DISC-04 | Two-speed cadence — short-term pass every 2 cycles, full discovery every 10 | Add `SHORT_TERM_PASS_CYCLES` config key; add second cycle counter in `index.ts` poll loop |
| DISC-05 | Kalshi requests include `status=open` filter | Already implemented in `kalshi.ts:298` — verify and mark complete |
| DISC-06 | Polymarket fetch prioritizes short-term markets via `end_date_max` if supported, else client-side filter | Gamma API confirms `end_date_max` parameter exists (ISO string format); add to short-term pass URL |
</phase_requirements>

---

## Codebase Baseline (Phase 1 Output)

These facts were read directly from source — HIGH confidence.

### What already exists

| File | Relevant state |
|------|----------------|
| `src/apis/kalshi.ts` | `fetchAllKalshiMarketsDirect()` paginates `/markets?status=open&limit=200`. DISC-05 is done. |
| `src/apis/kalshi.ts` | `eventPriorityScore(e: KalshiEvent)` scores by category + keyword set. Takes only `KalshiEvent` — no close-date awareness. |
| `src/apis/kalshi.ts` | `selectDiscoveryEvents()` sorts by score then alpha. No short-term prioritization. |
| `src/apis/polymarket.ts` | `fetchAllPolymarketMarkets()` paginates without date filter — fetches entire active universe. |
| `src/index.ts` | `doDiscovery = matchedPairs.length === 0 \|\| totalCycles % discoveryIntervalCycles === 0` — single speed. |
| `src/config.ts` | `discoveryIntervalCycles` defaults to 10. No `SHORT_TERM_PASS_CYCLES` yet. |
| `src/types/index.ts` | `KalshiMarket.close_time` is ISO string. `NormalizedMarket.closeTime` is `Date`. |

### What does NOT yet exist

- Ticker date parsing function
- `daysToClose` awareness in `eventPriorityScore`
- Short-term-first sort in `selectDiscoveryEvents`
- A second cycle counter for the short-term pass
- `end_date_max` on Polymarket requests

---

## Architecture Patterns

### Pattern 1: Kalshi Ticker Date Parsing (DISC-01)

**What:** Event tickers follow the pattern `SERIES-DDMMMYY[HH]` where `DDMMMYY` encodes the close date. Example: `FOMC-26MAR27` → March 26, 2027. An optional 2-digit hour may trail the year (`FOMC-26MAR2717` → same date, 17:00 UTC). The `KalshiMarket` response already includes `close_time` as an ISO string — the ticker parsing is a *fallback* for `KalshiEvent` objects which lack a direct `close_time` field.

**Where to implement:** New function in `src/apis/kalshi.ts`.

**Regex pattern:**
```typescript
// Source: reverse-engineered from observed Kalshi ticker patterns
// Confidence: MEDIUM — confirmed structure from community examples, not official docs
const TICKER_DATE_RE = /[-_](\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})?$/i;

const MONTH_MAP: Record<string, number> = {
  JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5,
  JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11,
};

export function parseKalshiEventCloseDate(ticker: string): Date | null {
  const m = TICKER_DATE_RE.exec(ticker.toUpperCase());
  if (!m) return null;
  const day = parseInt(m[1]!, 10);
  const month = MONTH_MAP[m[2]!] ?? -1;
  const year = 2000 + parseInt(m[3]!, 10);
  if (month === -1 || day < 1 || day > 31) return null;
  // If an hour suffix is present use it; default to end-of-day 23:59 UTC
  const hour = m[4] ? parseInt(m[4], 10) : 23;
  return new Date(Date.UTC(year, month, day, hour, 59, 59));
}
```

**When to use:** In `selectDiscoveryEvents()` to compute `daysToClose` for scoring and ordering. Note: `KalshiMarket` already has `close_time` — use that directly; parsing is only needed for `KalshiEvent` objects.

### Pattern 2: Rebalanced `eventPriorityScore` with Short-Term Boost (DISC-02/03)

**What:** Extend the existing scoring function to accept an optional `closeDate` and apply a time-urgency multiplier. Economic events within 7 days get the highest priority, ahead of long-dated political events regardless of category score.

**Where to implement:** `src/apis/kalshi.ts` — modify `eventPriorityScore`.

```typescript
// Confidence: HIGH — direct extension of existing code pattern
const SHORT_TERM_ECONOMIC_KEYWORDS = new Set([
  "cpi", "nfp", "non-farm", "nonfarm", "fomc", "pce",
  "jolts", "gdp", "inflation", "unemployment", "payroll",
]);

function eventPriorityScore(e: KalshiEvent, closeDate?: Date | null): number {
  const hay = `${e.category} ${e.title} ${e.sub_title}`.toLowerCase();
  let score = 0;
  if (PRIORITY_CATEGORIES.has(e.category?.toLowerCase() ?? "")) score += 6;
  for (const kw of PRIORITY_KEYWORDS) {
    if (hay.includes(kw)) score += 2;
  }

  // Short-term boost: events closing within 7 days rank above long-dated events
  if (closeDate) {
    const daysToClose = (closeDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysToClose >= 0 && daysToClose <= 7) {
      score += 20; // dominates base score, ensures short-term floats to top
      // Extra boost for short-term economic events
      for (const kw of SHORT_TERM_ECONOMIC_KEYWORDS) {
        if (hay.includes(kw)) { score += 5; break; }
      }
    }
  }
  return score;
}
```

**Ordering in `selectDiscoveryEvents`:** Sort by `score DESC, daysToClose ASC` so short-term events within the same score tier appear first.

### Pattern 3: Two-Speed Discovery Cadence (DISC-04)

**What:** Introduce a short-term pass that runs every 2 cycles. A short-term pass fetches only Kalshi markets for events with parsed `daysToClose ≤ 7` and Polymarket markets filtered via `end_date_max`. Full discovery (all markets, all events) continues every 10 cycles.

**Where to implement:** `src/index.ts` — extend the `pollCycle()` decision logic.

```typescript
// Confidence: HIGH — extends existing pattern in index.ts
const SHORT_TERM_PASS_CYCLES = config.shortTermPassCycles; // default 2

const doShortTermPass = stats.totalCycles % SHORT_TERM_PASS_CYCLES === 0
  && stats.totalCycles % config.discoveryIntervalCycles !== 0; // don't double-run

const doDiscovery = matchedPairs.length === 0
  || stats.totalCycles % config.discoveryIntervalCycles === 0;
```

**Cycle modes:**
- Cycle 1: Full discovery (initial run)
- Cycle 2: Short-term pass
- Cycle 4: Short-term pass
- Cycle 6: Short-term pass
- Cycle 8: Short-term pass
- Cycle 10: Full discovery (overrides short-term)
- Cycle 12: Short-term pass
- ...

### Pattern 4: Polymarket `end_date_max` Filter (DISC-06)

**What:** The Gamma API accepts `end_date_max` as an ISO string to return only markets closing before that date. Use this for the short-term pass to reduce pages fetched.

**Confirmed:** MEDIUM confidence — multiple community SDK sources list `end_date_max` as a valid parameter; official docs URL returns SSL error so direct confirmation is blocked.

```typescript
// In fetchAllPolymarketMarkets() — add optional parameter
export async function fetchAllPolymarketMarkets(
  opts: { endDateMax?: Date } = {}
): Promise<PolymarketMarket[]> {
  // ...
  const url = new URL(`${BASE_URL}/markets`);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  if (opts.endDateMax) {
    url.searchParams.set("end_date_max", opts.endDateMax.toISOString());
  }
  // ...
}
```

**Fallback:** If `end_date_max` is not honored by the API (returns too many results), apply client-side filter in `parseGammaMarket()` — check `endDate` against the cutoff before pushing to output array.

### Recommended Project Structure Changes

```
src/
├── apis/
│   ├── kalshi.ts        # +parseKalshiEventCloseDate(), rebalanced eventPriorityScore
│   └── polymarket.ts    # +end_date_max parameter to fetchAllPolymarketMarkets
├── index.ts             # +shortTermPassCycles counter, three-mode cycle decision
└── config.ts            # +shortTermPassCycles env var (SHORT_TERM_PASS_CYCLES, default 2)
```

---

## Standard Stack

No new libraries are required. All work is TypeScript logic changes within the existing codebase.

| What | Implementation | Notes |
|------|---------------|-------|
| Ticker date parsing | Pure regex + `Date.UTC()` | No library needed |
| Short-term filter | `Date.now()` comparison | Standard JS Date arithmetic |
| Polymarket `end_date_max` | `URL.searchParams.set()` | Already used throughout |
| Kalshi `min_close_ts` | Optional enhancement | Unix timestamp (int64 seconds) — available but not needed if `close_time` is reliable |

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Date math for "≤7 days" | Custom calendar library | `(closeDate.getTime() - Date.now()) / 86_400_000` | JS Date is sufficient for this precision |
| Ticker format validation | Regex library | Native JS RegExp | Single pattern, no edge cases needing full parser |
| API date parameter format | Custom serializer | `.toISOString()` | ISO 8601 is what Gamma API expects |

---

## Common Pitfalls

### Pitfall 1: Ticker Suffix Hour Confusion
**What goes wrong:** Some Kalshi tickers end in `DDMMMYYHH` where `HH` is a UTC hour, not part of the year. E.g. `FOMC-26MAR2717` means March 26, 2027 at 17:00 UTC — not year 2717.
**Why it happens:** The year portion is always 2 digits (`YY`); any trailing 2 digits after the year are the hour.
**How to avoid:** The regex must capture the hour group separately and treat it as optional: `/[-_](\d{2})(MON|...)(\d{2})(\d{2})?$/`.
**Warning signs:** Parsed year > 2100 or NaN close time.

### Pitfall 2: Applying `end_date_max` to the Full Discovery Pass
**What goes wrong:** If `end_date_max` is sent on full discovery, long-dated markets that form valid arb pairs are missed entirely.
**Why it happens:** Short-term filtering belongs only on the short-term pass.
**How to avoid:** Only pass `endDateMax` when `doShortTermPass && !doDiscovery`.

### Pitfall 3: Double-Running Discovery + Short-Term Pass on Same Cycle
**What goes wrong:** On cycle 10, both `doDiscovery` and `doShortTermPass` conditions are true, causing two full fetches.
**Why it happens:** Both cadence counters fire on cycle 10 (10 is divisible by 2).
**How to avoid:** `doShortTermPass` must be gated as `... && !doDiscovery` (see Pattern 3 above).

### Pitfall 4: Short-Term Markets Missing `closeTime` After Normalization
**What goes wrong:** `normalizeKalshi()` reads `m.close_time` directly. If the field is empty string for a market returned by short-term path, `closeTime` becomes `Invalid Date` and falls out of the ≤7-day window check silently.
**Why it happens:** Short-term path may encounter markets from events where `close_time` wasn't populated.
**How to avoid:** Guard `normalizeKalshi` — if `close_time` is empty, fall back to `parseKalshiEventCloseDate(m.event_ticker)` before defaulting to epoch 0.

### Pitfall 5: DISC-05 Already Done — Don't Regress It
**What goes wrong:** Refactoring `fetchAllKalshiMarketsDirect` for the two-speed cadence accidentally removes `url.searchParams.set("status", "open")`.
**Why it happens:** Code restructuring during the short-term pass extraction.
**How to avoid:** Both full-discovery and short-term paths must preserve `status=open`. Write the integration test to assert it.

### Pitfall 6: `eventPriorityScore` Uses `KalshiEvent` But Short-Term Pass Skips Events API
**What goes wrong:** The new short-term score boost requires a `closeDate`, but the current direct-markets path (`fetchAllKalshiMarketsDirect`) does NOT use `KalshiEvent` objects — it paginates `/markets` directly and gets `close_time` on the market level.
**Why it happens:** Phase 1 replaced the event fan-out with direct `/markets` pagination. `eventPriorityScore` is called in `selectDiscoveryEvents` which still uses `KalshiEvent` objects (from `fetchAllEvents`). This function is currently unused in the direct-markets path.
**Resolution:** For short-term Kalshi filtering, sort the returned `KalshiMarket[]` directly by `close_time` after fetching — no event-level scoring needed. The `eventPriorityScore` rebalancing applies only if/when the events-based path is used (which may be invoked for sports filtering).

---

## Key API Facts (Verified)

### Kalshi `/markets` endpoint parameters (MEDIUM confidence — via community SDK + docs search)
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | `"open"` \| `"closed"` \| `"settled"` — already set to `"open"` |
| `min_close_ts` | int64 | Unix timestamp (seconds) — filter markets closing after this time |
| `max_close_ts` | int64 | Unix timestamp (seconds) — filter markets closing before this time |
| `limit` | int | Page size (1-1000, default 100) |
| `cursor` | string | Pagination cursor |
| `event_ticker` | string | Filter to specific event |

**For DISC-03:** Pass `max_close_ts = Math.floor((Date.now() + 7 * 86400 * 1000) / 1000)` on the short-term pass to let Kalshi do server-side date filtering. This is preferable to client-side filtering — reduces bytes transferred.

### Polymarket Gamma `/markets` endpoint parameters (MEDIUM confidence — community SDKs, docs SSL unavailable)
| Parameter | Format | Description |
|-----------|--------|-------------|
| `end_date_max` | ISO 8601 string | Return markets closing before this date |
| `end_date_min` | ISO 8601 string | Return markets closing after this date |
| `active` | bool string | `"true"` — already set |
| `closed` | bool string | `"false"` — already set |

**For DISC-06:** Use `end_date_max` = 7 days from now as ISO string. If the API returns fewer than expected results, fall back to client-side `endDate` comparison in `parseGammaMarket`.

### Kalshi ticker date suffix format (MEDIUM confidence — community examples, not official docs)
- Pattern: `{SERIES}-{DD}{MON}{YY}` or `{SERIES}-{DD}{MON}{YY}{HH}`
- Month abbreviations: `JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC`
- Year: 2-digit, assume 20xx
- Hour: optional 2-digit UTC hour suffix (for intra-day markets like FOMC announcement times)
- Examples: `FOMC-26MAR27`, `CPI-12APR2717`, `KXINFL-15MAY27`

---

## Code Examples

### Short-Term Pass Cadence (src/index.ts)
```typescript
// Source: extension of existing doDiscovery pattern in index.ts:157
const SHORT_TERM_WINDOW_DAYS = 7;
const shortTermCutoff = new Date(Date.now() + SHORT_TERM_WINDOW_DAYS * 24 * 60 * 60 * 1000);

const doDiscovery = matchedPairs.length === 0
  || stats.totalCycles % config.discoveryIntervalCycles === 0;

const doShortTermPass = !doDiscovery
  && stats.totalCycles % config.shortTermPassCycles === 0;
```

### Sorting KalshiMarket[] by Close Time (short-term first)
```typescript
// For the short-term pass: after fetching, sort by close_time ascending
const shortTermMarkets = allRawMarkets
  .filter(m => {
    const ct = new Date(m.close_time).getTime();
    return ct > Date.now() && ct <= shortTermCutoff.getTime();
  })
  .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
```

### Config Extension (src/config.ts)
```typescript
// Add to Config interface in types/index.ts
shortTermPassCycles: number;

// Add to config object in config.ts
shortTermPassCycles: envInt("SHORT_TERM_PASS_CYCLES", 2),
```

### Kalshi `max_close_ts` on short-term pass
```typescript
// In fetchAllKalshiMarketsDirect — add optional opts parameter
const url = new URL(`${BASE_URL}/markets`);
url.searchParams.set("limit", String(config.kalshiPageSize));
url.searchParams.set("status", "open"); // DISC-05 — keep this
if (opts?.maxCloseTs) {
  url.searchParams.set("max_close_ts", String(Math.floor(opts.maxCloseTs / 1000)));
}
if (cursor) url.searchParams.set("cursor", cursor);
```

---

## DISC-05 Status: Already Implemented

Reading `src/apis/kalshi.ts` line 298:
```typescript
url.searchParams.set("status", "open");
```

This is in `fetchAllKalshiMarketsDirect()` — the function that `fetchAllKalshiMarkets()` delegates to. DISC-05 is done. The planner should add a verification task to confirm this holds after phase 2 refactoring.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None detected — no jest.config, vitest.config, or test directory |
| Config file | Wave 0 must create `vitest.config.ts` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DISC-01 | `parseKalshiEventCloseDate` parses `-26MAR27` → 2027-03-26 | unit | `npx vitest run tests/kalshi-ticker.test.ts` | Wave 0 |
| DISC-01 | Returns null for malformed tickers | unit | `npx vitest run tests/kalshi-ticker.test.ts` | Wave 0 |
| DISC-01 | Parses hour suffix `26MAR2717` → hour 17 UTC | unit | `npx vitest run tests/kalshi-ticker.test.ts` | Wave 0 |
| DISC-02 | Short-term economic event scores > long-dated political event | unit | `npx vitest run tests/priority-score.test.ts` | Wave 0 |
| DISC-02 | Economic keywords (CPI, NFP, FOMC, PCE, JOLTS) each add score | unit | `npx vitest run tests/priority-score.test.ts` | Wave 0 |
| DISC-03 | Short-term markets appear first in sorted output | unit | `npx vitest run tests/discovery-order.test.ts` | Wave 0 |
| DISC-04 | Short-term pass fires on cycle 2, not cycle 10 | unit | `npx vitest run tests/cadence.test.ts` | Wave 0 |
| DISC-04 | Full discovery fires on cycle 10, not cycle 2 | unit | `npx vitest run tests/cadence.test.ts` | Wave 0 |
| DISC-05 | Kalshi URL includes `status=open` | unit | `npx vitest run tests/kalshi-url.test.ts` | Wave 0 |
| DISC-06 | Polymarket URL includes `end_date_max` on short-term pass | unit | `npx vitest run tests/polymarket-url.test.ts` | Wave 0 |
| DISC-06 | Full discovery Polymarket URL does NOT include `end_date_max` | unit | `npx vitest run tests/polymarket-url.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/kalshi-ticker.test.ts` — covers DISC-01 ticker parsing
- [ ] `tests/priority-score.test.ts` — covers DISC-02 score rebalancing
- [ ] `tests/discovery-order.test.ts` — covers DISC-03 short-term ordering
- [ ] `tests/cadence.test.ts` — covers DISC-04 cycle cadence logic
- [ ] `tests/kalshi-url.test.ts` — covers DISC-05 status=open verification
- [ ] `tests/polymarket-url.test.ts` — covers DISC-06 end_date_max parameter
- [ ] `vitest.config.ts` — test framework config (Vitest chosen: no bundler config needed, native TS support)
- [ ] Framework install: `npm install --save-dev vitest` — no test runner detected in package.json

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Events fan-out (300+ requests) | Direct `/markets?status=open` pagination (~6-10 requests) | Phase 1 decision — preserve in phase 2 |
| Single-speed discovery every 10 cycles | Two-speed: short-term every 2, full every 10 | Phase 2 goal |
| No date ordering in candidates | Short-term markets processed first | Increases hit rate for actionable arbs |

---

## Open Questions

1. **Does Kalshi `/markets?max_close_ts=X` work unauthenticated?**
   - What we know: `status=open` works unauthenticated (confirmed in phase 1). `max_close_ts` is documented in community SDKs.
   - What's unclear: Whether the public endpoint honors `max_close_ts` without auth or silently ignores it.
   - Recommendation: First task in phase 2 should test this empirically with a live curl. If ignored, fall back to client-side filtering of the already-fetched response.

2. **Does Polymarket `end_date_max` return IS0 8601 or does it need a different format?**
   - What we know: Community SDKs show ISO strings like `"2024-01-01"` (date-only). `Date.toISOString()` returns full ISO with time.
   - What's unclear: Whether Gamma API accepts `2026-03-27T00:00:00.000Z` or requires date-only `2026-03-27`.
   - Recommendation: Try full ISO first; fall back to `YYYY-MM-DD` substring if that fails. Implement client-side fallback regardless.

3. **`eventPriorityScore` is currently unused in the direct-markets path**
   - What we know: Phase 1 bypassed the events API for main discovery. `selectDiscoveryEvents` is only called for sports filtering.
   - What's unclear: Whether the planner should wire up event-level scoring to the direct-markets path or just sort by `close_time` directly.
   - Recommendation: For DISC-02/03, sort `KalshiMarket[]` directly by `close_time` ascending for the short-term pass. No need to resurrect the events fan-out.

---

## Sources

### Primary (HIGH confidence)
- `src/apis/kalshi.ts` — direct code read; `status=open` at line 298 confirms DISC-05 done
- `src/apis/polymarket.ts` — direct code read; no `end_date_max` yet; `endDate` field confirmed in `GammaMarket` interface
- `src/index.ts` — direct code read; `discoveryIntervalCycles` pattern at line 157
- `src/config.ts` — direct code read; all current config keys

### Secondary (MEDIUM confidence)
- [ammario/kalshi Go SDK market.go](https://github.com/ammario/kalshi/blob/main/market.go) — confirms `max_close_ts` and `min_close_ts` as int64 Unix timestamps; `status` enum values
- [Kalshi Get Markets docs search](https://docs.kalshi.com/api-reference/market/get-markets) — confirms parameter names (SSL expired, searched via WebSearch)
- [HuakunShen/polymarket-kit](https://github.com/HuakunShen/polymarket-kit) — lists `end_date_max`, `end_date_min` as valid Gamma API params with ISO string format
- [Polymarket Gamma API docs search](https://docs.polymarket.com/developers/gamma-markets-api/get-markets) — confirms end date params (SSL expired, confirmed via WebSearch)
- Community ticker examples: `HIGHNY-22NOV28`, `USDJPY-22NOV2918` — confirm `DDMMMYY[HH]` suffix pattern

### Tertiary (LOW confidence)
- WebSearch result summary for Kalshi ticker format — not from official docs, but consistent across multiple sources

---

## Metadata

**Confidence breakdown:**
- DISC-05 already done: HIGH — read directly from source
- Ticker date parsing pattern: MEDIUM — confirmed by community examples, regex needs empirical validation
- Kalshi `max_close_ts` filter: MEDIUM — documented in SDK, unauthenticated behavior unconfirmed
- Polymarket `end_date_max` filter: MEDIUM — confirmed in community SDKs, not verified against live API due to SSL issue
- Priority score rebalancing: HIGH — direct extension of existing code, no external dependencies
- Two-speed cadence: HIGH — straightforward extension of existing `doDiscovery` pattern

**Research date:** 2026-03-20
**Valid until:** 2026-04-19 (Kalshi/Polymarket API parameters are stable; ticker format is de-facto stable)
