# Polymarket ↔ Kalshi Arbitrage Screener

A real-time terminal tool that monitors Polymarket and Kalshi prediction markets, matches equivalent events across platforms, and surfaces arbitrage opportunities where buying complementary positions costs less than $1.00 (guaranteed profit).

## Prerequisites

- Node.js 18+ (uses native `fetch`)
- Optional: Kalshi API key (the screener can use Kalshi’s **public** read endpoints without auth for market discovery)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env (see Performance tuning below)
```

### Kalshi API (optional)

1. Sign up at [kalshi.com](https://kalshi.com)
2. Go to **Settings → API** if you need authenticated endpoints later
3. For **read-only discovery**, leave `KALSHI_API_KEY` unset and use `DEMO_MODE=false`; the client uses `https://api.elections.kalshi.com/trade-api/v2`.

**Polymarket** uses the **Gamma** REST API (`gamma-api.polymarket.com`) for market lists and mid/outcome prices — not the CLOB order book. Prices are **indicative** (see Known limitations). No API key required.

## Usage

```bash
# Development (hot-reload)
npm run dev

# Production
npm run build
npm start
```

## Reading the Display

```
╔══════════════════════════════════════════════════════════════════════╗
║ Event          │ Trade         │ Poly  │ Kalshi │ Cost  │ Profit   ║
╠════════════════╪═══════════════╪═══════╪════════╪═══════╪══════════╣
║ Trump midterms │ P:NO  + K:YES │ $0.43 │ $0.41  │ $0.84 │ +16¢ 19%║
╚══════════════════════════════════════════════════════════════════════╝
```

- **Event**: The matched prediction market question
- **Trade**: Which side to buy on each platform (P = Polymarket, K = Kalshi)
- **Poly / Kalshi**: Ask price on each platform
- **Cost**: Combined cost of both positions (< $1.00 = arb exists)
- **Profit**: Per-contract profit in cents and as a percentage
- **Match**: Confidence that the two markets are the same event (70%+ required)
- **Closes In**: Time until the earlier market closes

### Color Coding

| Color        | Meaning                |
|--------------|------------------------|
| Bright green | Profit > 5%            |
| Yellow       | Profit 1–5%            |
| Dim white    | Profit 0.8–1%          |
| Gray         | Negative (shown for context) |

### Stale Data

A `[STALE Xs]` indicator appears when platform data is older than 10 seconds. Opportunities from stale data are hidden.

## Configuration

All settings are in `.env`. See `.env.example` for descriptions.

Key thresholds:
- `MIN_PROFIT_PCT` — minimum profit % to list (gross by default; set `MIN_PROFIT_USES_NET=true` to apply to **after-fee** edge)
- `POLY_TAKER_FEE_BPS` / `KALSHI_TAKER_FEE_BPS` — rough taker fees for net profit (defaults 50 / 30 bps per leg)
- `MATCH_THRESHOLD` — minimum fuzzy match score
- `MIN_VOLUME_USD` — skip thin markets
- `MIN_SHARED_TOKENS` — inverted-index gate before similarity scoring
- `MATCHER_YEAR_GATE` — drop obvious cross-year false positives when both titles contain years

## Performance tuning

The screener runs **discovery** (full universe + matching) every `DISCOVERY_INTERVAL_CYCLES` poll cycles, and **refresh** (only matched `condition_ids` / Kalshi event tickers) in between — so steady-state latency is dominated by refresh.

### Recommended `.env` profiles

**Balanced (default in `.env.example`)**  
Reasonable discovery depth + adaptive Kalshi rate. Good starting point.

**`fast_refresh`** — prioritize low cycle time after first matches:

```env
POLL_INTERVAL_MS=2000
DISCOVERY_INTERVAL_CYCLES=20
KALSHI_MAX_EVENTS_DISCOVERY=120
KALSHI_MARKETS_MAX_PAGES_PER_EVENT_DISCOVERY=2
POLYMARKET_DISCOVERY_MAX_PAGES=30
KALSHI_RATE_MIN_RPS=1
KALSHI_RATE_MAX_RPS=3
```

**`max_discovery`** — prioritize coverage (slower, more 429 risk; adaptive limiter will back off):

```env
DISCOVERY_INTERVAL_CYCLES=15
KALSHI_MAX_EVENTS_DISCOVERY=400
KALSHI_EVENTS_DISCOVERY_MAX_PAGES=25
POLYMARKET_DISCOVERY_MAX_PAGES=80
KALSHI_RATE_MIN_RPS=1.5
KALSHI_RATE_MAX_RPS=4
```

**`honest_net_edges`** — show/filter on after-fee profit:

```env
MIN_PROFIT_USES_NET=true
MIN_PROFIT_PCT=0.5
POLY_TAKER_FEE_BPS=50
KALSHI_TAKER_FEE_BPS=30
```

### Metrics (`metrics.log`)

Each poll cycle appends one JSON line with phase timings (`poly_fetch_ms`, `kalshi_fetch_ms`, `normalize_ms`, `match_ms`, `arb_ms`, `render_ms`), HTTP 429 counts, approximate response bytes, effective Kalshi bucket RPS, and rolling `rolling_p50_ms` / `rolling_p95_ms` over the last `METRICS_ROLLING_CYCLES` cycles. Use this to see whether you are network-bound, match-bound, or rate-limited.

## Logging

- `opportunities.jsonl` — every detected opportunity (one JSON per line; includes gross and after-fee fields when logged)
- `errors.log` — API errors and timeouts
- `metrics.log` — structured per-cycle performance metrics

## Known Limitations

- **No trade execution** — this is a screener only; it shows indicative prices
- **Gamma prices ≠ CLOB best ask** — list data uses Gamma `outcomePrices` (mid/indicative). Executable arb requires CLOB (or similar) per-market quotes; see `prompts/optimization_speed_1.md` for a second-stage quote flag idea
- **Matching is heuristic** — the fuzzy matcher may occasionally pair unrelated markets (~5% false positive rate target)
- **Fees are estimated** — `POLY_TAKER_FEE_BPS` / `KALSHI_TAKER_FEE_BPS` approximate net edge when `MIN_PROFIT_USES_NET=true`; real fees depend on tier and order type
- **No WebSocket streaming** — uses REST polling; prices may move between polls

## Architecture

```
src/
  index.ts              # Main poll loop
  config.ts             # Environment config
  apis/
    polymarket.ts       # Polymarket Gamma API client (+ refresh by condition_ids)
    kalshi.ts           # Kalshi public v2 REST client (adaptive rate limit)
  core/
    normalizer.ts       # Text normalization (dates, names, abbreviations)
    matcher.ts          # Fuzzy matching with inverted index
    arbitrage.ts        # Arb detection, scoring, filtering
    rateLimit.ts        # Token bucket + adaptive Kalshi limiter
    metrics.ts          # Rolling latency helpers
    checksums.ts        # Change detection
    logging.ts          # File logging (errors + opportunities + metrics)
  display/
    formatter.ts        # ANSI colors, number formatting
    renderer.ts         # Live terminal table
  web/
    server.ts           # Optional browser UI + SSE
  types/
    index.ts            # All TypeScript interfaces
```
