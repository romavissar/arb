# Technology Stack

**Analysis Date:** 2026-03-20

## Languages

**Primary:**
- TypeScript 5.9.3 - All source code in `src/` directory
- JavaScript ES2022 - Target and runtime module output

**Secondary:**
- SQL - SQLite schema in `src/core/persistence.ts`

## Runtime

**Environment:**
- Node.js (ES2022 target with NodeNext module resolution)
- Configured for native ESM imports (type: "module" in package.json)

**Package Manager:**
- npm
- Lockfile: present (`package-lock.json`)

## Frameworks

**Core:**
- Node.js built-in modules only - `node:http`, `node:fs`, `node:path` for HTTP server and file I/O

**Build/Dev:**
- TypeScript 5.9.3 - Compilation with strict mode enabled
- tsx 4.21.0 - Development watch mode runner (`npm run dev`)
- esbuild - Underlying TypeScript compiler used by tsx

## Key Dependencies

**Critical:**
- better-sqlite3 12.8.0 - Local SQLite database at `arb-screener.db` for opportunity history and session tracking
  - Uses WAL mode and NORMAL synchronous pragma for performance
  - Statically typed with @types/better-sqlite3 7.6.13

**Infrastructure:**
- dotenv 17.3.1 - Environment variable loading from `.env` file
- undici 7.24.4 - High-performance HTTP client (fetch API implementation)
- cli-table3 0.6.5 - Terminal table rendering for market opportunities display
- @colors/colors - Terminal color output for CLI formatting
- @types/node 25.5.0 - TypeScript definitions for Node.js APIs

## Configuration

**Environment:**
- Loaded via `dotenv` in `src/config.ts`
- Environment variables parsed on startup with type validation (string/int/float/bool)
- Fallback values provided for all settings

**Key Configuration Variables:**
- API Keys: `KALSHI_API_KEY` (optional for public read API)
- Rate Limiting: `POLYMARKET_BUCKET_MAX`, `POLYMARKET_BUCKET_REFILL_RPS`, `KALSHI_RATE_MIN_RPS`, `KALSHI_RATE_MAX_RPS`
- Discovery: `DISCOVERY_INTERVAL_CYCLES`, `POLYMARKET_DISCOVERY_MAX_PAGES`, `KALSHI_EVENTS_DISCOVERY_MAX_PAGES`
- Filtering: `MIN_PROFIT_PCT`, `MIN_VOLUME_USD`, `MATCH_THRESHOLD`, `MAX_CLOSE_DATE_DELTA_DAYS`
- Fees: `POLY_TAKER_FEE_BPS`, `KALSHI_TAKER_FEE_BPS`, `USE_TIERED_FEES`
- Monitoring: `METRICS_ROLLING_CYCLES`, `POLL_INTERVAL_MS`, `REQUEST_TIMEOUT_MS`
- Features: `DEMO_MODE` (simulated data), `MATCHER_YEAR_GATE`, `MIN_PROFIT_USES_NET`

**Build:**
- `tsconfig.json` with:
  - Strict type checking enabled
  - ES2022 target
  - NodeNext module resolution
  - Source maps for debugging
  - Output to `dist/` directory

## Platform Requirements

**Development:**
- Node.js runtime with npm
- TypeScript compilation step required
- TSConfig ES2022 target compatibility

**Production:**
- Node.js runtime with compiled JavaScript distribution
- SQLite 3 support (built into better-sqlite3)
- File system access for database and log files
- HTTP network access for external prediction market APIs
- Default web server port: 3847 (configurable via `WEB_PORT` env var)

---

*Stack analysis: 2026-03-20*
