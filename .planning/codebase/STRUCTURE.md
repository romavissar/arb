# Codebase Structure

**Analysis Date:** 2026-03-20

## Directory Layout

```
arb-screener-v2/
├── src/                    # All TypeScript source
│   ├── index.ts            # Main poll loop & orchestration
│   ├── config.ts           # Environment config parsing
│   ├── types/              # Shared type definitions
│   │   └── index.ts
│   ├── apis/               # Exchange API clients
│   │   ├── polymarket.ts
│   │   ├── kalshi.ts
│   │   └── kalshiDemo.ts
│   ├── core/               # Core business logic
│   │   ├── normalizer.ts   # Text processing & token extraction
│   │   ├── matcher.ts      # Market matching algorithm
│   │   ├── arbitrage.ts    # Arb detection & profit calculation
│   │   ├── fees.ts         # Volume-tiered fee lookup
│   │   ├── rateLimit.ts    # Token bucket & adaptive rate limiter
│   │   ├── persistence.ts  # SQLite session/opportunity storage
│   │   ├── checksums.ts    # Quote/structure fingerprinting
│   │   ├── lruCache.ts     # Generic LRU cache
│   │   ├── logging.ts      # File append utilities
│   │   ├── scanLog.ts      # Structured event log
│   │   ├── metrics.ts      # Rolling window statistics
│   │   └── [other utilities]
│   ├── display/            # Terminal UI
│   │   ├── renderer.ts     # TUI rendering
│   │   └── formatter.ts    # Color/format utilities
│   └── web/                # Web dashboard API
│       └── server.ts       # HTTP + SSE server
├── dist/                   # Compiled JavaScript (generated)
├── node_modules/           # Dependencies
├── package.json            # Project metadata & scripts
├── tsconfig.json           # TypeScript compilation config
├── arb-screener.db         # SQLite database (runtime-created)
├── errors.log              # Error log (append-only)
├── opportunities.jsonl     # Opportunity archive (JSONL)
└── metrics.log             # Cycle metrics (JSONL)
```

## Directory Purposes

**`src/`:**
- Purpose: All TypeScript source code
- Contains: 3.8K lines across 20 files
- Key files: Entry point, config, types, API clients, core logic

**`src/apis/`:**
- Purpose: Exchange API integration
- Contains: Polymarket Gamma API client, Kalshi public trade API client, demo data generator
- Key files: `polymarket.ts` (248 lines), `kalshi.ts` (429 lines)

**`src/core/`:**
- Purpose: Arbitrage detection pipeline and supporting utilities
- Contains: Matching, normalization, fee/rate management, persistence, logging
- Key files: `matcher.ts` (343 lines), `normalizer.ts` (164 lines), `arbitrage.ts` (205 lines)

**`src/display/`:**
- Purpose: Terminal UI rendering
- Contains: Color formatting, table layouts, progress indicators
- Key files: `renderer.ts` (132 lines), `formatter.ts` (58 lines)

**`src/web/`:**
- Purpose: Real-time web dashboard backend
- Contains: HTTP server, SSE streaming, state serialization
- Key files: `server.ts` (899 lines)

**`src/types/`:**
- Purpose: Shared TypeScript interfaces used across layers
- Contains: Market types (Polymarket, Kalshi, Normalized), arbitrage types, config
- Key files: `index.ts` (183 lines)

**`dist/`:**
- Purpose: Compiled JavaScript output
- Generated: Yes (by `npm run build`)
- Committed: No (.gitignore)

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main application entry point, poll loop orchestration, opportunity tracking
- `src/web/server.ts`: Web server for dashboard, started as background service

**Configuration:**
- `src/config.ts`: Environment variable parsing with type coercion and defaults
- `.env`: Runtime environment variables (not committed, see `.env.example`)
- `tsconfig.json`: TypeScript compiler options (ES2022, strict mode, NodeNext modules)

**Core Logic:**
- `src/core/arbitrage.ts`: Arb detection and profit calculation
- `src/core/matcher.ts`: Market matching with fuzzy text similarity
- `src/core/normalizer.ts`: Text normalization and token extraction
- `src/core/fees.ts`: Volume-tiered fee schedules (Polymarket, Kalshi)

**Persistence:**
- `src/core/persistence.ts`: SQLite database schema and queries
- `arb-screener.db`: SQLite database file (WAL mode for concurrent access)
- `arb-screener.db-shm`: SQLite shared memory file (WAL)
- `arb-screener.db-wal`: SQLite write-ahead log (WAL)

**Logging & Metrics:**
- `src/core/logging.ts`: Append-only file writers (errors, opportunities, metrics)
- `src/core/scanLog.ts`: In-memory event log with listener pattern
- `errors.log`: Timestamped error messages
- `opportunities.jsonl`: JSONL archive of detected opportunities
- `metrics.log`: Cycle metrics (timing, fetch stats, rate limits, rolling stats)

**Testing:**
- No test files present in codebase (no `.test.ts` or `.spec.ts` files)

## Naming Conventions

**Files:**
- camelCase for module files: `polymarket.ts`, `normalizer.ts`, `rateLimit.ts`
- Lowercase directory names: `src/apis/`, `src/core/`, `src/display/`, `src/web/`
- PascalCase for main exports (classes/types): `TokenBucket`, `AdaptiveRateLimiter`, `LRUCache`

**Functions:**
- camelCase: `fetchAllPolymarketMarkets()`, `normalizePolymarket()`, `matchMarkets()`
- Getter pattern for simple accessors: `getPolymarketFee()`, `getMatchCacheSize()`
- `create*` for constructors/factories: `createChecksum()`, `createStructureChecksum()`
- Private helper prefix (optional): `recordPolyBody()`, `getCandidates()`

**Variables:**
- camelCase: `matchedPairs`, `trackedOpportunities`, `currentState`
- Constants: `UPPERCASE_WITH_UNDERSCORES`: `MAX_BUFFER = 500`, `STALE_EXPIRY_CYCLES = 20`
- Single-letter loops (acceptable): `for (const m of markets)`, `for (const p of pair)`

**Types:**
- PascalCase: `NormalizedMarket`, `MatchedPair`, `ArbOpportunity`, `TrackedOpportunity`
- Interface prefix `I` not used
- Generic suffixes for variants: `Response`, `Request`, `Stats`
- Discriminated unions (e.g., `source: "polymarket" | "kalshi"`)

**Exports:**
- Named exports preferred: `export function fetchPolymarket()`, `export interface NormalizedMarket`
- Re-exported types from `src/types/index.ts` for cross-module consistency
- No barrel files except implicit `index.ts` in type module

## Where to Add New Code

**New Feature (e.g., new exchange):**
- Primary code: `src/apis/[exchange].ts` (client + normalization)
- Types: Add to `src/types/index.ts`
- Integrate: Reference in `src/index.ts` polling logic (lines 152-415)
- Fees: Add tier lookup function in `src/core/fees.ts`

**New Matching Strategy:**
- Implementation: `src/core/matcher.ts` (expand scoring functions, add similarity metric)
- Configuration: Add to `Config` interface in `src/types/index.ts`, `src/config.ts` with env var
- Testing: Manual via metrics.log analysis or scan log inspection

**New Arbitrage Filter/Calculation:**
- Implementation: `src/core/arbitrage.ts` (extend `detectArbitrage()`, `computeArb()`)
- Configuration: Add to `Config` in `src/types/index.ts`, parse in `src/config.ts`
- Persistence: Extend SQLite schema in `src/core/persistence.ts` if tracking new metrics

**Utilities/Helpers:**
- Shared helpers: `src/core/[utility].ts` (e.g., `src/core/lruCache.ts`, `src/core/rateLimit.ts`)
- Type coercion: Add to `src/config.ts` (follow `envStr()`, `envInt()` pattern)
- Text processing: Add to `src/core/normalizer.ts` (maintain abbreviations, months, name map)

**Observability/Logging:**
- Add to `src/core/scanLog.ts` if adding new event type (extend `ScanLogCategory` discriminated union)
- Append-only file logging: Use pattern from `src/core/logging.ts` (wrap in try-catch)
- Web dashboard state: Extend `WebState` interface in `src/web/server.ts`

## Special Directories

**`.planning/`:**
- Purpose: GSD documentation and planning artifacts
- Generated: Yes (by GSD commands)
- Committed: Yes

**`.env` (not in repo):**
- Purpose: Runtime environment configuration
- Contains: API keys, rate limits, feature flags
- Committed: No (.gitignore) — see `.env.example` template

**`dist/` (generated):**
- Purpose: Compiled JavaScript from TypeScript
- Generated: Yes (by `npm run build`)
- Committed: No (.gitignore)

---

*Structure analysis: 2026-03-20*
