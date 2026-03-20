# Testing Patterns

**Analysis Date:** 2026-03-20

## Test Infrastructure Status

**Testing Framework:** None currently configured

**Observation:**
- No test files found in codebase (no `.test.ts`, `.spec.ts`, or `__tests__` directories)
- No test framework installed (no `jest`, `vitest`, `mocha` in `package.json`)
- No test configuration file (no `jest.config.js`, `vitest.config.ts`)
- No test scripts in `package.json` (only `dev`, `build`, `start`)
- TypeScript compilation includes source files only (no test pattern)

**Status:** Testing infrastructure not present. Codebase is production CLI tool without automated tests.

## Why Tests Are Absent

Given the codebase context:
1. **Single-entry CLI** - `src/index.ts` runs as main execution loop; hard to unit test without heavy mocking
2. **Heavy I/O** - External API calls to Polymarket/Kalshi are core functionality (fetch, normalize, match)
3. **Stateful polling** - Long-running loop with in-memory state tracking; difficult to test in isolation
4. **Real-time output** - Rendering, logging, web server output; not easily verifiable
5. **Early stage** - Project is 3.8K lines across 19 files; testing may be deferred until more stable

## Testing Opportunity Areas

If tests were to be added, priority order:

### High Priority (Pure Logic, No I/O)

**1. `src/core/arbitrage.ts`** - Arbitrage detection logic
- Pure function: `detectArbitrage(pairs, polyStaleSeconds, kalshiStaleSeconds): ArbOpportunity[]`
- Testable internal functions: `computeArb()`, `passesFilters()`, `requiredMatchScore()`, `applyStalenessPenalty()`
- Would require: Test fixtures for `MatchedPair[]` inputs, assertions on returned opportunities
- Example test:
  ```typescript
  it("rejects opportunities below minProfitPct after staleness penalty", () => {
    const pair = createTestMatchedPair({ polyVolume: 5000, kalshiVolume: 5000 });
    const results = detectArbitrage([pair], 600, 0); // 10 min stale poly data
    expect(results).toHaveLength(0);
  });
  ```

**2. `src/core/matcher.ts`** - Market matching algorithm
- Core function: `matchMarkets(poly, kalshi): MatchedPair[]`
- Testable helpers: `jaccard()`, `yearsCompatible()`, `buildInvertedIndex()`, `getCandidates()`
- Would require: Fixture markets with known similarity scores
- Example test:
  ```typescript
  it("uses inverted index to find candidate pairs efficiently", () => {
    const poly = [createPolymarket("BTC year 2025")];
    const kalshi = [createKalshiMarket("Bitcoin 2025")];
    const results = matchMarkets(poly, kalshi);
    expect(results).toHaveLength(1);
  });
  ```

**3. `src/core/normalizer.ts`** - Title/token normalization
- Functions: `normalize()`, `bigrams()`, `extractDates()` (signature inferred from usage)
- Testable: Abbreviation expansion, name mapping, stop word removal, date extraction
- Would require: Text fixtures representing various market title formats
- Example test:
  ```typescript
  it("expands abbreviations consistently", () => {
    const text = normalize("Will Trump win the 2024 US election?");
    expect(text).toContain("united states");
    expect(text).not.toContain("US");
  });
  ```

**4. `src/core/fees.ts`** - Fee tier lookup
- Functions: `getPolymarketFee(volume)`, `getKalshiFee(volume)`
- Testable: Fee tiers applied correctly based on volume thresholds
- Example test:
  ```typescript
  it("applies higher fee tiers for lower volumes", () => {
    const lowVolFee = getPolymarketFee(500);
    const highVolFee = getPolymarketFee(100000);
    expect(highVolFee).toBeLessThan(lowVolFee);
  });
  ```

**5. `src/core/lruCache.ts`** - LRU cache data structure
- Methods: `get()`, `set()`, `delete()`, `keys()`, `values()` fully testable
- Testable: Eviction order, capacity limits, reuse ordering
- Example test:
  ```typescript
  it("evicts least-recently-used entry when full", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // Move "a" to recently used
    cache.set("c", 3); // Should evict "b" (least recent)
    expect(cache.has("b")).toBe(false);
  });
  ```

**6. `src/core/rateLimit.ts`** - Token bucket and adaptive rate limiter
- Classes: `TokenBucket`, `AdaptiveRateLimiter` fully testable without I/O
- Testable: Rate limiting math, token refill, adaptive bumping on success/429
- Example test:
  ```typescript
  it("increases RPS after sustained success", async () => {
    const limiter = new AdaptiveRateLimiter(bucket, 1, 3, 2, 0.5, 0.5);
    for (let i = 0; i < 5; i++) limiter.recordSuccess();
    expect(limiter.effectiveRps).toBe(2); // bumped after 2 successes
  });
  ```

**7. `src/core/metrics.ts`** - Cycle latency percentile calculation
- Class: `RollingCycleLatency` with `push()` and `summary()`
- Testable: Percentile calculations (p50, p95) against known datasets
- Example test:
  ```typescript
  it("calculates p50 and p95 correctly", () => {
    const rolling = new RollingCycleLatency(10);
    [100, 200, 300, 400, 500].forEach(ms => rolling.push(ms));
    const { p50_ms, p95_ms } = rolling.summary();
    expect(p50_ms).toBe(300);
    expect(p95_ms).toBeGreaterThan(400);
  });
  ```

### Medium Priority (Mostly Logic, Some Mocking)

**8. `src/core/checksums.ts`** - Checksum generation
- Functions: `createChecksum()`, `createStructureChecksum()` deterministic
- Testable: String formats, edge cases (null titles, extreme prices)

**9. `src/display/formatter.ts`** - Text formatting functions
- Functions: `formatCurrency()`, `formatProfit()`, `truncate()`, `progressBar()`, color functions
- Testable: Output format consistency, edge cases (negative values, long strings)
- Would require: Snapshot testing or exact string assertions
- Example test:
  ```typescript
  it("formats currency with two decimal places", () => {
    expect(formatCurrency(1.5)).toBe("$1.50");
    expect(formatCurrency(1000.1)).toBe("$1000.10");
  });
  ```

**10. `src/config.ts`** - Environment variable parsing
- Functions: `envStr()`, `envInt()`, `envFloat()`, `envBool()`, `envBpsAsFraction()`
- Testable: Correct type coercion, fallback defaults, error handling
- Would require: Isolated env var fixtures per test
- Example test:
  ```typescript
  it("throws on invalid integer", () => {
    process.env.TEST_INT = "not-a-number";
    expect(() => envInt("TEST_INT", 0)).toThrow();
  });
  ```

### Low Priority (Heavy I/O, Integration-level)

**11. `src/apis/polymarket.ts`** - Polymarket API client
- Functions: `fetchAllPolymarketMarkets()`, `fetchPolymarketMarketsByConditionIds()`, `normalizePolymarket()`
- Issue: Requires mocking HTTP client or using live API (slow, unreliable)
- Would require: HTTP mock library (e.g., `msw`, `nock`) or API contract testing
- Lower priority: Already has internal logging and error recovery

**12. `src/apis/kalshi.ts`** - Kalshi API client
- Same issues as Polymarket — async HTTP dependencies
- Lower priority: Complex pagination and adaptive rate limiting hard to test in isolation

**13. `src/web/server.ts`** - HTTP server and UI
- Functions: `startWebServer()`, `pushState()`, request handling
- Issue: Requires HTTP server setup, SSE streaming, DOM manipulation in browser
- Would require: HTTP testing library (e.g., `supertest`) and browser testing framework
- Lower priority: Not critical business logic

**14. `src/index.ts`** - Main poll loop
- Issue: Long-running async loop with multiple state mutations
- Would require: Heavy mocking of all dependencies (APIs, DB, display, logging)
- Lower priority: Integration testing better suited than unit testing

## Recommended Testing Setup (If Added)

### Framework Choice
**Vitest** recommended for this Node.js/TypeScript codebase:
- No browser/DOM dependencies in core logic (pure functions)
- Fast execution (file-watching preferred for dev loop)
- Good TypeScript support out-of-the-box
- Simple configuration

**Alternative:** Jest (heavier but more ecosystem maturity)

### Configuration Template

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/index.ts',        // Main loop hard to test
        'src/web/server.ts',   // UI server hard to test
        'src/apis/**',         // External API clients (integration)
      ],
    },
  },
});
```

### Test File Organization

```
src/
├── core/
│   ├── arbitrage.ts
│   ├── __tests__/
│   │   └── arbitrage.test.ts       # Tests co-located with module
│   ├── matcher.ts
│   ├── __tests__/
│   │   └── matcher.test.ts
│   └── ...
├── display/
│   ├── formatter.ts
│   ├── __tests__/
│   │   └── formatter.test.ts
│   └── ...
└── ...
```

**Naming convention:** `[module].test.ts` or `[module].spec.ts` (choose one)

### Test Fixture Pattern

Example from `src/core/__tests__/fixtures.ts`:

```typescript
import type { NormalizedMarket, MatchedPair } from "../../types/index.js";

export function createTestNormalizedMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  const base: NormalizedMarket = {
    id: "test_market_1",
    source: "polymarket",
    title: "Test Market",
    normalizedTitle: "test market",
    tokens: new Set(["test", "market"]),
    yesAsk: 0.5,
    noAsk: 0.5,
    volume: 10000,
    closeTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
    checksum: "0.5000_0.5000_10000",
    structureChecksum: "test market|" + new Date().getTime(),
    raw: { /* mock raw data */ },
  };
  return { ...base, ...overrides };
}

export function createTestMatchedPair(overrides?: Partial<MatchedPair>): MatchedPair {
  return {
    id: "test_pair_1",
    polymarket: createTestNormalizedMarket({ source: "polymarket" }),
    kalshi: createTestNormalizedMarket({ source: "kalshi" }),
    matchScore: 0.85,
    matchedAt: new Date(),
    ...overrides,
  };
}
```

## Current Testing Approach

**Informal Testing:**
- Manual CLI execution: `npm run dev` runs against real APIs
- Demo mode: `DEMO_MODE=true` uses generated data instead of live API calls (in `src/apis/kalshiDemo.ts`)
- Logging inspection: Review `errors.log`, `opportunities.jsonl`, `metrics.log` output
- Web dashboard: Real-time observation of opportunities and scan logs via browser

**Quality Checks (No Automated):**
- TypeScript compilation (`npm run build`) enforces type safety
- Code review before commit (assumed, no pre-commit hooks observed)

## Adding Tests: Priority Checklist

If implementing tests, target in this order:

1. **Start with pure logic** (arbitrage.ts, matcher.ts, normalizer.ts)
   - No external dependencies
   - High business value (core algorithm correctness)
   - Fast to run

2. **Add data structure tests** (lruCache.ts, rateLimit.ts, metrics.ts)
   - Encapsulated state
   - Clear input/output contract
   - Edge case coverage easy to verify

3. **Add formatter tests** (display/formatter.ts)
   - String output deterministic
   - Snapshot testing suitable
   - Good first integration point

4. **Config tests last** (config.ts)
   - Requires env var mocking
   - Lower business risk (fallbacks work)

5. **Skip for now:**
   - API client tests (integration/contract testing separate concern)
   - Main loop tests (too stateful; worth refactoring first)
   - Web server tests (browser testing; low priority)

---

*Testing analysis: 2026-03-20*
