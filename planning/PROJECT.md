# Polymarket ↔ Kalshi Arbitrage Screener

## What This Is

A real-time arbitrage screener that monitors Polymarket and Kalshi prediction markets to find cross-platform arbitrage opportunities — where buying complementary YES/NO positions costs less than $1.00, guaranteeing profit regardless of outcome. Currently a terminal + web dashboard tool; will evolve into an automated trading system.

## Core Value

Find the maximum number of real, actionable arbitrage opportunities across both platforms — prioritizing short-term markets (≤7 days to expiry) where arbs are most likely to be executable and profitable.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ Polymarket Gamma API integration with paginated discovery and token-bucket rate limiting — existing
- ✓ Kalshi v2 public REST API integration with adaptive rate limiting and 429 backoff — existing
- ✓ Text normalization pipeline (abbreviation expansion, name normalization, date parsing, tokenization) — existing
- ✓ Fuzzy cross-platform market matching (inverted index + Jaccard/bigram/date weighted scoring) — existing
- ✓ LRU cache for matched pairs with checksum-based invalidation — existing
- ✓ Arbitrage detection across all YES/NO combos with volume-tiered fee calculation — existing
- ✓ Staleness penalty and confidence escalation for high-profit matches — existing
- ✓ SQLite persistence for opportunities and sessions — existing
- ✓ File-based logging (opportunities.jsonl, errors.log, metrics.log) — existing
- ✓ Terminal table rendering with ANSI colors, sorted by profit % — existing
- ✓ Web dashboard with SSE real-time updates — existing
- ✓ Configurable poll loop with discovery/refresh cycle separation — existing
- ✓ Demo mode with simulated Kalshi data — existing
- ✓ Graceful shutdown with session summary — existing

### Active

<!-- Current scope. Building toward these. -->

- [x] Kalshi API optimization — maximize market discovery without hitting rate limits (Validated in Phase 01: API Connectivity & Observability)
- [ ] Short-term market prioritization — fetch and match markets expiring within 7 days first
- [ ] Improved opportunity volume — find significantly more arb opportunities per session
- [ ] Display ranking by time horizon — short-term opportunities shown first, then longer-dated

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Trade execution / bot integration — future milestone, need reliable screening first
- WebSocket feeds — would help latency but not the current bottleneck (market coverage is)
- Embedding-based matching — current fuzzy matching works, coverage is the constraint
- Order book depth / slippage modeling — only needed when executing trades
- Push notifications / alerts — not needed until screening is reliable and comprehensive
- Additional platforms beyond Polymarket + Kalshi — focus on these two first
- Lowering profit threshold below 0.8% — user wants to keep current minimum

## Context

- The screener currently finds very few opportunities (1 after an hour of running)
- Phase 01 complete — Kalshi API now uses direct `/markets?status=open` cursor pagination instead of broken event fan-out. 401 circuit breaker prevents cascading failures. Health check and zero-count alarms added.
- ~30K Polymarket markets and ~1,200 Kalshi markets are discovered per cycle
- Only 3 matched pairs found across 763K candidates evaluated — matching or discovery may be too restrictive
- Short-term markets are the priority because they're closest to resolution and most likely to have price discrepancies
- Long-term goal is automated high-frequency trading bots — but first the screener must reliably find opportunities

## Constraints

- **Rate Limits**: Must respect both platform rate limits — Polymarket (10 RPS), Kalshi (adaptive 1.5–4 RPS)
- **Tech Stack**: TypeScript/Node.js, no framework changes — keep it lean
- **Data Source**: Polymarket uses Gamma API (indicative prices, not CLOB) — acceptable for screening
- **No Auth Available**: User does not have a Kalshi API key; must use unauthenticated public endpoints only

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep min profit at 0.8% | User preference — only show worthwhile opportunities | — Pending |
| Rank short-term higher (not filter) | Still want to see longer-dated arbs, just prioritize short-term | — Pending |
| Focus on coverage before execution | No point building bots if screener can't find arbs | — Pending |
| Investigate Kalshi API first | Likely bottleneck — only 1,200 markets vs 30K Polymarket | ✓ Done (Phase 01) |

---
*Last updated: 2026-03-20 after Phase 01 completion*
