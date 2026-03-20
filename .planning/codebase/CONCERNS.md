# Codebase Concerns

**Analysis Date:** 2026-03-20

## Tech Debt

### Invalid Date Parsing in Normalization

**Issue:** Date normalization can produce invalid date strings that cause "Invalid time value" errors in the fetch cycle.

**Files:** `src/core/normalizer.ts`, `src/index.ts:267`

**Impact:** Crashes during market normalization. Error logs show repeated "Invalid time value" errors (2026-03-19T15:04:35 onwards), causing missed fetch cycles and gaps in data processing. The error is silently logged but disrupts the matching pipeline.

**Root cause:** `extractDates()` extracts YYYY-MM-DD strings and passes them directly to `new Date()` constructor. ISO date parsing is timezone-sensitive—dates like "2025-12-31" may be interpreted as UTC or local depending on how JavaScript's Date constructor parses them. When combined with zero-padded months/days that are out of range or malformed, this creates invalid Date objects.

**Fix approach:**
1. Validate extracted dates more strictly—use `Date.parse()` first to check validity before constructing Date object
2. Normalize all date construction to use `new Date(Date.UTC(year, month-1, day))` to ensure consistent UTC parsing
3. Add try-catch around date parsing in `extractDates()` and skip malformed dates
4. Log which date string caused the invalid value error for debugging

### Unhandled Empty Catch Blocks

**Issue:** Multiple catch blocks silently ignore errors without logging context.

**Files:**
- `src/index.ts:300` — try-catch around debug log write has bare `catch {}`
- `src/apis/polymarket.ts:28` — JSON stringify error handling
- `src/apis/kalshi.ts:144` — Error suppression without context
- `src/core/persistence.ts:85, 116, 128, 164, 178` — Database error swallowing (claims "never crash the poll loop")

**Impact:** Silent failures mask configuration errors, data corruption, and environment issues. The poll loop continues but with missing data or inconsistent state.

**Fix approach:**
- Replace bare `catch {}` with explicit error logging when silent failures are intentional (e.g., "catch { /* expected failure */ }")
- For production code paths (not debug logs), log at `warn` level with context about what operation failed
- Add counters to track how many errors are being silently swallowed per cycle

### Date Calculation Edge Case in Session Staleness

**Issue:** Session staleness calculation uses millisecond-level time math that can produce negative or infinite values.

**Files:** `src/index.ts:95-96`

**Code:**
```typescript
const cyclesSinceLastSeen = Math.round(
  (now.getTime() - tracked.lastSeenAt.getTime()) / Math.max(config.pollIntervalMs, 1000)
);
```

**Impact:** If `now.getTime()` is less than `tracked.lastSeenAt.getTime()` (clock skew, daylight saving time), the numerator is negative, producing negative cycle counts. Stale opportunities are removed too early or not at all.

**Fix approach:**
- Use `Math.abs()` on the time delta before division
- Or better: store milliseconds directly rather than converting to cycles—compare `(now - lastSeenAt) > (STALE_EXPIRY_MS)` directly

### Weakly Typed Error Type Casting

**Issue:** Error objects are cast as `any` to access `.cause` property.

**Files:** `src/apis/polymarket.ts:162`

**Code:**
```typescript
const cause = err instanceof Error && (err as any).cause ? ` — ${(err as any).cause}` : "";
```

**Impact:** Accessing `.cause` without proper typing hides the fact that this is a non-standard property. If the error object changes shape, this silently fails to extract cause information.

**Fix approach:**
- Define a type for errors with optional `.cause` property
- Use `isDOMException()` helper to check for AbortError more safely (already done for DOMException, but inconsistent)
- Consider using error codes or error classes instead of relying on dynamic `.cause`

---

## Known Bugs

### Kalshi 401 Unauthorized Loop

**Symptoms:** Repeated "Kalshi HTTP 401: Unauthorized" errors, followed by 429 backoff, but the 401 errors keep repeating indefinitely.

**Files:** `src/apis/kalshi.ts:125-149`

**Trigger:** Running without valid `KALSHI_API_KEY` or with expired/invalid auth token. Errors logged from 2026-03-19T15:06:58 onwards in errors.log.

**Current behavior:** The fetch loop catches the 401, appends error, but then immediately retries without backoff or state change. The adaptive rate limiter only kicks in on 429, not 401. Result: rapid loop of 401 errors filling the error log.

**Workaround:** Run in `DEMO_MODE=true` to bypass Kalshi API entirely, or ensure `KALSHI_API_KEY` is valid before starting.

**Fix approach:**
- Detect 401 separately from other 4xx errors—treat it as a configuration issue, not a transient failure
- Log once and skip Kalshi discovery for the session, or prompt user to verify API key
- Add exponential backoff on repeated 401s to avoid error log spam

### Polymarket Timeout Without Fallback

**Symptoms:** "Polymarket fetch timeout" logged at 2026-03-19T15:00:18. Cycle completes but with empty polymarket markets list.

**Files:** `src/apis/polymarket.ts:157-164`, `src/index.ts:194-196`

**Trigger:** Polymarket API slow or unreachable. Timeout is 5000ms (hardcoded via `REQUEST_TIMEOUT_MS`). The catch block returns empty array `[]`, so the cycle continues with no Polymarket data.

**Impact:** Cycles without Polymarket data still attempt matching against Kalshi-only data, produce no arbitrage opportunities, and waste bandwidth. Discovery mode restarts (potentially unnecessary if it was already successful), refresh mode silently uses stale data.

**Fix approach:**
- Distinguish between "timeout" (network issue, retry) vs "no markets" (API change, alert)
- Accumulate timeouts across cycles—if 3+ consecutive timeouts, pause discovery or alert user
- Log the URL, timeout duration, and how many bytes were received before timeout
- Consider fallback to cached Polymarket data if fetch fails

---

## Security Considerations

### Environment Configuration via `dotenv` with No Validation

**Risk:** Malformed configuration values can cause runtime crashes or unexpected behavior.

**Files:** `src/config.ts`

**Current validation:**
- Integer parsing throws error on `NaN`
- Float parsing throws error on `NaN`
- Boolean parsing uses string comparison (safe)
- No validation of ranges or constraints

**Missing:**
- No check that `KALSHI_API_KEY` is non-empty before using it (falls back to public API, but no warning)
- No validation that rate limits are sensible (could set `KALSHI_RATE_MAX_RPS=0.01` and hang forever)
- No check that `MIN_PROFIT_PCT` is positive
- No check that poll interval is >= 100ms (could cause CPU spin)

**Fix approach:**
- Add range validation for rate limits: `kalshiRateMinRps` must be > 0 and <= `kalshiRateMaxRps`
- Add floor on `pollIntervalMs`: warn if < 500ms
- Validate that `DISCOVERY_INTERVAL_CYCLES` > 0
- Log which config came from env vs defaults on startup

### Database File Permissions Not Hardened

**Risk:** SQLite database file `arb-screener.db` contains historical opportunity data. No explicit file mode is set.

**Files:** `src/core/persistence.ts:4`

**Current:** Database created by `better-sqlite3` with default system umask (typically 0644 on Unix = readable by all users).

**Impact:** If the screener runs on a shared system, other users can read opportunity history and metadata (event names, profit percentages, timing). Not a direct security issue unless the system is untrusted, but poor practice for financial data.

**Fix approach:**
- After `initDb()`, explicitly set file permissions: `chmod 0600 arb-screener.db` on Unix
- Document that this tool should not be run on shared systems or requires file-level access controls
- Consider adding optional encryption flag for the SQLite database

### No Input Validation on Web API Responses

**Risk:** SSE server pushes market titles directly to browser without sanitization.

**Files:** `src/web/server.ts:63-112` (serializeState)

**Current:** Market titles from API responses are included in JSON serialization with no sanitization. The HTML template uses server-side string interpolation.

**Impact:** If Polymarket or Kalshi API returns a malicious title (e.g., containing HTML/JS), it could be reflected in the JSON and parsed by the browser. Low risk because data is in JSON (not HTML context), but indicates missing validation layer.

**Fix approach:**
- Sanitize all market titles on ingestion (strip control characters, limit length to 200 chars)
- Use `.textContent` instead of `.innerHTML` in HTML template
- Add Content-Security-Policy header to web responses

---

## Performance Bottlenecks

### Full Market Index Rebuilt Every Discovery Cycle

**Problem:** Building inverted index is O(n*m) where n = markets, m = tokens per market.

**Files:** `src/core/matcher.ts:12-25`

**Impact:** Discovery mode matches 1000+ Polymarket markets against 1000+ Kalshi markets. The index is rebuilt from scratch every `DISCOVERY_INTERVAL_CYCLES` (default 10 cycles). Metrics show `match_ms` can be 500-1000ms even in refresh mode if index is rebuilt.

**Current approach:**
- `buildInvertedIndex()` iterates all markets and tokenizes each one
- `matchMarkets()` rebuilds index for Kalshi, then for Polymarket, then iterates all pairs
- No caching or incremental updates between discovery cycles

**Fix approach:**
- Cache the inverted index across cycles—invalidate only when market counts change significantly
- Or: Use a persistent index (in-memory Map) that's updated incrementally as new markets arrive in refresh cycles
- Measure actual performance: if `match_ms` is < 50ms and not growing, this is premature optimization

### Match Cache LRU Eviction No Metrics

**Problem:** Cache misses are silent and unmeasured.

**Files:** `src/core/lruCache.ts`, `src/core/matcher.ts:18`

**Impact:** Cache hit/miss ratio is unknown. If most matches are being evicted before revisit, the cache is wasting memory and CPU.

**Current behavior:** `getMatchCacheSize()` returns raw size, but no metrics on evictions or hit rate.

**Fix approach:**
- Add `cacheHits` and `cacheMisses` counters to LRU cache
- Log hit rate to metrics.log each cycle: `match_cache_hit_rate: 0.85`
- If hit rate < 0.5, recommend increasing `MATCH_CACHE_MAX_SIZE`

### No Early Exit in Matching Loop

**Problem:** Similarity scoring runs all 4 similarity functions even when one fails to meet threshold.

**Files:** `src/core/matcher.ts:149-170` (similarity scoring section not fully shown in read, but pattern evident)

**Impact:** Pairs that obviously don't match (0% token overlap) are scored for bigrams, dates, year compatibility anyway.

**Fix approach:**
- Bail early from similarity scoring if token Jaccard < 0.3
- Gate expensive date extraction behind token similarity pass

---

## Fragile Areas

### Market Title Matching Assumes Specific Formats

**Issue:** Normalization and matching rely on heuristics that may break with API changes.

**Files:** `src/core/normalizer.ts`, `src/core/matcher.ts`

**Why fragile:**
- Hardcoded abbreviation list (if API starts using "POTUS" instead of "President", no match)
- Month/quarter parsing assumes specific formats ("December 31, 2025" but not "31 Dec 2025")
- Name map is manually curated—new politician names aren't added automatically
- Stop word list may exclude important tokens if API changes wording

**Safe modification:**
- Add comments explaining which token is critical (e.g., "must contain date")
- Add test fixtures for real API responses from both platforms
- Log skipped markets and why (failed normalization) to identify pattern breaks early

**Test coverage gaps:**
- No unit tests for `normalize()` function
- No test fixtures for edge cases: non-English text, missing close dates, malformed prices
- No integration tests that verify Polymarket + Kalshi data can be matched

### Sync State Between Fetch and Match Is Implicit

**Issue:** `matchedPairs` array is global and mutated across discovery/refresh cycles with no explicit state machine.

**Files:** `src/index.ts:45`, `src/index.ts:306-319`

**Why fragile:**
- Discovery mode calls `matchMarkets()` which replaces entire array
- Refresh mode calls `syncMatchedPairs()` which updates pairs in place
- If a matched pair exists in Polymarket but disappears from Kalshi, the sync doesn't remove it (only updates)
- Race condition possible if web UI reads `matchedPairs` while it's being updated

**Safe modification:**
- Make `matchedPairs` immutable—create new array rather than mutating in place
- Add explicit state transitions: `state = "fetching"` → `"matching"` → `"displaying"`
- Protect `matchedPairs` with a mutex or read-write lock if web server will read it concurrently

**How to test:**
- Unit test `syncMatchedPairs()` with pairs that are in matched set but missing from one platform
- Add race condition test: while poll loop is running, hammer the web API endpoint

### SQLite Crash Recovery Not Tested

**Issue:** Database uses WAL mode but no recovery testing exists.

**Files:** `src/core/persistence.ts:8-11`

**Why fragile:**
- WAL mode can leave `.db-shm` and `.db-wal` files on crash
- If process crashes mid-transaction, next start may have inconsistent state
- No explicit `PRAGMA integrity_check` on startup

**Safe modification:**
- On `initDb()`, verify database integrity: `db.exec("PRAGMA integrity_check")`
- If corrupt, back up the database and start fresh
- Document WAL mode behavior in README

---

## Scaling Limits

### Memory Usage Unbounded in Match Cache

**Resource:** `matchCacheMaxSize` config

**Current capacity:** Default 5000 entries, each entry is a MatchedPair object (easily 1KB per pair = 5MB)

**Limit:** If screener discovers 10,000+ unique markets per platform, the LRU cache will evict at high rate, reducing effectiveness. Memory usage will plateau but may exceed available heap on low-memory systems.

**Scaling path:**
- Profile actual memory usage with `MATCH_CACHE_MAX_SIZE=10000`
- Consider using a persistent store (SQLite) for long-term match cache with TTL
- Or: Use a two-tier cache (hot in-memory LRU + cold disk-backed)

### Opportunity Tracking Map Unbounded Growth

**Resource:** `trackedOpportunities` Map in `src/index.ts:50`

**Current behavior:** Opportunities are removed only after `STALE_EXPIRY_CYCLES` (20 cycles = ~60 seconds at 3s poll). With 100 opps/cycle, this accumulates to 2000 entries before cleanup.

**Limit:** If screener runs for days with high opportunity rate (200+/min during volatile markets), the map could grow to 10K+ entries. No automatic cleanup on process restart.

**Scaling path:**
- Set TTL on opportunity entries—remove older than N hours regardless of cycle count
- Or: Periodically compact the map, moving old entries to the database
- Add a metric: `tracked_opportunities_count` to metrics.log

### Kalshi Discovery Concurrency Hard-Coded

**Resource:** `KALSHI_DISCOVERY_CONCURRENCY` config (default 5)

**Current:** 5 concurrent fetches of Kalshi events. With 300 events to discover, this takes 60 HTTP requests.

**Limit:** If Kalshi returns 1000 events, discovery takes >3 minutes. If API has lower rate limits than expected, this hits 429s.

**Scaling path:**
- Make concurrency tunable per-event-count: if events < 100, use 10; if > 500, use 3
- Or: Implement queue-based discovery (pull events gradually across multiple cycles)
- Track actual time-to-discovery in metrics.log

---

## Dependencies at Risk

### `better-sqlite3` Native Module

**Risk:** Native binding dependency may fail to build on unsupported platforms.

**Files:** `package.json:20`

**Impact:** If user is on an ARM-based Mac that wasn't supported at the time `^12.8.0` was released, or on Windows, npm install may fail. No fallback to pure JS SQLite.

**Migration plan:**
- Add build instructions for problematic platforms
- Or: Migrate to `sql.js` (pure JavaScript, slower but always works)
- Or: Document minimum Node.js version and platform requirements clearly

### `undici` HTTP Client Version

**Files:** `package.json:25`

**Note:** `undici` is used implicitly via Node.js 18+ native `fetch`. The dependency is pinned but updates infrequently.

**Risk:** If a CVE is discovered in HTTP handling, upgrade path depends on Node.js LTS version bump.

**Mitigation:** Keep Node.js up-to-date; `undici` security updates are included in Node.js patches.

### Transitive Dependencies Not Audited

**Files:** `package-lock.json`

**Risk:** No `npm audit` or security scanning in CI/CD.

**Fix approach:**
- Run `npm audit` as part of build pipeline
- Fail on high-severity vulnerabilities
- Document that this is a single-user dev tool, not production-grade

---

## Missing Critical Features

### No Trade Execution

**Problem:** This is a screener only—no way to actually execute arbitrage trades.

**Files:** README.md explicitly states "No trade execution" (line 133)

**Impact:** Detected opportunities are informational only. No way to programmatically place orders on Polymarket or Kalshi.

**Blocks:** Any attempt to actually trade the opportunities.

**Future path:** Add optional integration with Polymarket CLOB REST API and Kalshi trading endpoints (behind a flag, after manual review).

### No WebSocket Streaming

**Problem:** REST polling only; prices may move between polls.

**Files:** README.md line 137

**Impact:** With 3-second poll interval, a 10-second gap between data and execution is possible. Fast-moving markets will have slippage.

**Blocks:** Real-time arbitrage trading on highly volatile events.

**Future path:** Implement WebSocket clients for both platforms (if available) for sub-second latency.

### No Persistent Preferences

**Problem:** All config is environment-only; no way to save or toggle settings in the UI.

**Files:** `src/config.ts`

**Impact:** Changing tuning parameters requires editing `.env` and restarting the process.

**Blocks:** Dynamic optimization or rapid experimentation.

**Future path:** Add optional SQLite config table; allow web UI to update tunable parameters without restart.

---

## Test Coverage Gaps

### No Unit Tests for Core Matching Logic

**What's not tested:**
- `normalize()` function with edge cases (non-ASCII, missing dates, very long titles)
- `matchMarkets()` with empty market lists
- Fuzzy scoring functions with identical/completely different markets

**Files:** `src/core/normalizer.ts`, `src/core/matcher.ts`

**Risk:** Regressions in matching logic go undetected until production (high opportunity cost).

**Priority:** High—matching is the core logic

### No Integration Tests

**What's not tested:**
- Full poll cycle from fetch → normalize → match → arb detect
- Database persistence across restarts
- Web UI SSE server with multiple concurrent clients

**Files:** All of `src/`

**Risk:** Config changes that break the full pipeline aren't caught until manual testing.

**Priority:** Medium—good for onboarding and regression prevention

### No Stress Tests

**What's not tested:**
- 10,000+ market matching performance
- 1000+ concurrent opportunities tracked
- Web UI with 100 rapid market updates

**Files:** `src/core/matcher.ts`, `src/index.ts`, `src/web/server.ts`

**Risk:** Performance degradation under load isn't discovered until deployment.

**Priority:** Low—only matters at scale

---

## Data Integrity Concerns

### Checksums Not Used for Deduplication

**Issue:** Checksums are computed but only used in debug logging.

**Files:** `src/core/checksums.ts`, `src/apis/polymarket.ts:93`, `src/apis/kalshi.ts:112`

**Current:** Each normalization creates a checksum, but it's never compared across cycles. If the same market is fetched twice, it's treated as new both times.

**Impact:** Opportunity log may contain duplicates if market prices don't change but fetch succeeds. Metrics overcount opportunities.

**Fix approach:**
- Use `structureChecksum` to deduplicate markets within a cycle (skip if already seen)
- Use `checksum` to detect price changes (log only if changed)
- Add dedup count to metrics.log

### Close Time Timezone Issues

**Issue:** Close times are parsed as UTC but may be intended as market-local time.

**Files:** `src/apis/polymarket.ts:81-82`, `src/apis/kalshi.ts:97-98`

**Impact:** If Polymarket closes "2025-12-31 at midnight" and that's midnight ET (UTC-5), the parsed close time is 5 hours off. This affects `timeToClose` calculation and stale data penalty.

**Risk:** Market pair is considered about-to-expire when it actually has 5 more hours.

**Fix approach:**
- Verify with API docs whether close times are UTC or market-local
- If market-local, convert to UTC before creating NormalizedMarket
- Log timezone assumption in config output on startup

---

## Observability Gaps

### No Distributed Tracing

**Issue:** Poll cycles are opaque—can't correlate which fetch produced which match produced which opportunity.

**Files:** `src/index.ts`, `src/core/matcher.ts`, `src/core/arbitrage.ts`

**Impact:** When investigating why a specific opportunity was missed, tracing through logs is manual and time-consuming.

**Fix approach:**
- Add cycle ID (UUID or counter) to all log entries
- Log opportunity with cycle ID, allowing correlation back to fetch/match/arb phases
- Example: `[CYCLE:42] poly_market="Trump 2024" matches kalshi_market="Trump Win" with score=0.85`

### Metrics Don't Track Quality

**Issue:** Metrics track latency and HTTP stats but not opportunity quality.

**Files:** `src/core/metrics.ts`

**Current:** p50/p95 cycle latency, 429 counts, bytes in

**Missing:**
- Match false-positive rate (opps that disappear next cycle)
- Average match score (low score = risky matches)
- Net profit distribution (how much money could be made)
- Fee impact (actual fees vs estimated)

**Fix approach:**
- Add optional daily summary: `opps_found: 143, opps_sustained: 87 (61%), avg_match_score: 0.82, median_net_profit_pct: 1.2`
- Log to separate `daily-summary.jsonl`

---

## Configuration Anti-Patterns

### Silent Fallback to Public API on Missing Auth

**Issue:** If `KALSHI_API_KEY` is missing, screener silently falls back to public API without clear indication.

**Files:** `src/index.ts:436-438`

**Message:** "No KALSHI_API_KEY — using public Kalshi read API"

**Problem:** This message appears after startup is complete. Early log scanners might miss it. Also, public API may have lower rate limits or different data availability.

**Fix approach:**
- Print this at the TOP of startup, before any API calls
- If public API hits 401, log explicitly: "Kalshi public API denied—auth required. Set KALSHI_API_KEY or use DEMO_MODE=true"

### Environment Parsing Throws at Startup

**Issue:** Invalid config values throw errors and crash the app during startup.

**Files:** `src/config.ts:15, 25`

**Current:** `throw new Error()` for invalid ints/floats

**Better:** Load config, validate, print all errors at once, then exit. Currently, first error stops processing.

**Fix approach:**
- Collect all validation errors in an array
- At end, if any errors exist, print them all and exit with code 1
- Example: "Config errors: KALSHI_RATE_MIN_RPS must be > 0 (got -1.5), POLL_INTERVAL_MS must be >= 100ms (got 50)"

---

## Summary by Priority

**CRITICAL (fix immediately):**
1. Invalid date parsing causing crashes (`src/core/normalizer.ts`)
2. Kalshi 401 error loop (`src/apis/kalshi.ts`)

**HIGH (affects core functionality):**
3. Empty catch blocks hiding errors
4. No unit tests for matching logic
5. Market title matching fragility

**MEDIUM (operational issues):**
6. Database recovery untested
7. No tracing/correlation across phases
8. Missing quality metrics

**LOW (nice-to-have improvements):**
9. Checksum deduplication
10. Memory scaling analysis
11. Timezone handling documentation

---

*Concerns audit: 2026-03-20*
