# External Integrations

**Analysis Date:** 2026-03-20

## APIs & External Services

**Polymarket (Gamma API):**
- Service: Polymarket prediction market trading data
- What it's used for: Fetching active binary outcome markets (Yes/No questions) with real-time pricing and volume
- SDK/Client: undici `fetch()` implementation
- Endpoint: `https://gamma-api.polymarket.com`
- Auth: None required (public read API)
- Endpoints used:
  - `GET /markets` - List active markets with pagination (limit, offset)
  - Query params: `active=true`, `closed=false` to filter only active markets
  - Supports batch condition ID lookups for refresh mode
- Implementation: `src/apis/polymarket.ts`

**Kalshi (Elections API):**
- Service: Kalshi prediction market trading data
- What it's used for: Fetching events and markets with pricing to compare against Polymarket for arbitrage opportunities
- SDK/Client: undici `fetch()` implementation
- Endpoint: `https://api.elections.kalshi.com/trade-api/v2`
- Auth: Optional `KALSHI_API_KEY` env var (defaults to public read API)
- Endpoints used:
  - `GET /events` - List prediction market events with cursor pagination
  - `GET /markets` - List markets for specific events with pricing and volume
  - Supports concurrent market fetches per event (configurable concurrency)
- Implementation: `src/apis/kalshi.ts`
- Special features:
  - Adaptive rate limiting that scales from 1.5-4 RPS based on 429 responses
  - Discovery rotation through lower-priority events
  - Event priority scoring based on category and keywords
  - Sports events automatically filtered out

## Data Storage

**Databases:**
- SQLite 3 (better-sqlite3 12.8.0)
  - Connection: Local file at `arb-screener.db`
  - Client: better-sqlite3 with prepared statements
  - WAL mode enabled for concurrent read/write
  - Stores opportunity history and session tracking
  - Schema in `src/core/persistence.ts`

**File Storage:**
- Local filesystem only
  - Database: `arb-screener.db` (+ WAL files `arb-screener.db-wal` and shared memory `arb-screener.db-shm`)
  - Logging: `errors.log` (append-only error log)
  - Logging: `metrics.log` (append-only performance metrics with rolling p50/p95)
  - Logging: `match-debug.log` (debug data for matching algorithm)
  - Data: `opportunities.jsonl` (newline-delimited JSON of detected arbitrage opportunities)

**Caching:**
- In-memory LRU cache for matched market pairs (configurable max size, default 5000)
- Implemented in `src/core/matcher.ts`
- Token bucket rate limiting for API calls

## Authentication & Identity

**Auth Provider:**
- None - All APIs are public read-only
- Kalshi API key is optional (`KALSHI_API_KEY` env var)
  - If provided: Used for authenticated requests to `https://api.elections.kalshi.com`
  - If omitted: Falls back to public elections API

**Custom Auth:**
- No authentication layer - designed as internal arbitrage detection tool

## Monitoring & Observability

**Error Tracking:**
- None (no external service)
- Custom append-only error logging to `errors.log`
- Errors logged via `src/core/logging.ts` appendError function

**Logs:**
- `errors.log` - Exception and API error tracking
- `metrics.log` - Cycle-by-cycle performance metrics (HTTP status codes, latency percentiles, bytes received)
- `match-debug.log` - Debug output for market matching algorithm
- In-memory scan log with SSE streaming to web clients
  - Log entries: timestamp, severity, source, message, optional details

**Metrics Captured:**
- Per-cycle latency (fetch, normalize, match, arbitrage detection, render times)
- HTTP 429 (rate limit) hits per API
- Bytes received from each API
- Rolling p50/p95 cycle latency over configurable window
- Market counts (Polymarket, Kalshi)
- Matched pair count
- Opportunity detection counts

## CI/CD & Deployment

**Hosting:**
- Self-hosted Node.js process
- No cloud platform integration

**CI Pipeline:**
- None detected

**Build Process:**
- `npm run build` compiles TypeScript to `dist/`
- `npm run start` runs compiled JavaScript from `dist/index.js`
- `npm run dev` runs with tsx watch mode for development

## Environment Configuration

**Required env vars:**
- Optional: `KALSHI_API_KEY` (for authenticated Kalshi API access)
- Optional: `DEMO_MODE=true` (enables simulated Kalshi data instead of API calls)
- Optional: `WEB_PORT` (HTTP server port, default 3847)

**Optional but important tuning vars:**
- `POLL_INTERVAL_MS` - Cycle frequency (default 3000ms)
- `MIN_PROFIT_PCT` - Minimum arbitrage threshold (default 0.8%)
- `MATCH_THRESHOLD` - Fuzzy match confidence (default 0.70)
- `POLYMARKET_BUCKET_MAX/REFILL_RPS` - Rate limiter tokens
- `KALSHI_RATE_MIN_RPS/MAX_RPS` - Kalshi adaptive rate limits

**Secrets location:**
- `.env` file (git-ignored)
- Environment variables at runtime

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- Server-Sent Events (SSE) streaming to web clients at `GET /events` endpoint
  - Event type "state": Real-time arbitrage opportunity updates
  - Event type "log": Live scan log entries
- Implemented in `src/web/server.ts`

## Rate Limiting Strategy

**Polymarket (Token Bucket):**
- Max burst: configurable (default 10 tokens)
- Sustained rate: configurable (default 10 RPS)
- Implements exponential backoff on HTTP 429
- Respects Retry-After header

**Kalshi (Adaptive Token Bucket):**
- Base rate: 1.5 RPS (minimum)
- Dynamic range: 1.5-4 RPS based on success/failure
- On 429: Scales down by 0.75x, backs off with exponential jitter
- On success streak: Bumps up by 0.25 RPS after 25 successes
- Retries up to 5 times with exponential backoff (max 30s)

## Data Normalization

**Market Integration:**
- Polymarket: Parses Gamma API format (condition ID, outcome prices, volume, end date)
- Kalshi: Parses Elections API format (event ticker, market ticker, prices, close time)
- Both normalized to common `NormalizedMarket` format in `src/core/normalizer.ts`
- Checksum-based change detection (price/volume checksums and structure checksums for matching)

---

*Integration audit: 2026-03-20*
