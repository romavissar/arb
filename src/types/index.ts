// ─── Polymarket Types ───

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
}

export interface PolymarketMarket {
  condition_id: string;
  question: string;
  tokens: PolymarketToken[];
  volume: number;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
}

export interface PolymarketResponse {
  data: PolymarketMarket[];
  next_cursor: string;
}

// ─── Kalshi Types ───

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_ask: number;
  no_ask: number;
  volume: number;
  close_time: string;
  status: string;
  event_ticker: string;
}

export interface KalshiResponse {
  markets: KalshiMarket[];
  cursor: string;
}

// ─── Normalized Market ───

export interface NormalizedMarket {
  id: string;
  source: "polymarket" | "kalshi";
  title: string;
  normalizedTitle: string;
  tokens: Set<string>;
  yesAsk: number;
  noAsk: number;
  volume: number;
  closeTime: Date;
  /** Price/volume fingerprint for quote updates. */
  checksum: string;
  /** Title + close time — rematch when structure changes, not on every quote tick. */
  structureChecksum: string;
  raw: PolymarketMarket | KalshiMarket;
}

// ─── Matching Types ───

export interface MatchedPair {
  id: string;
  polymarket: NormalizedMarket;
  kalshi: NormalizedMarket;
  matchScore: number;
  matchedAt: Date;
}

// ─── Arbitrage Types ───

export interface ArbOpportunity {
  matchScore: number;
  combinedCost: number;
  profitPerContract: number;
  /** Gross edge % (before estimated platform fees). */
  profitPct: number;
  /** Estimated combined taker fees per $1 nominal (both legs), as a decimal fraction of notional. */
  estimatedFeesPerContract: number;
  /** Profit % after subtracting `estimatedFeesPerContract` from gross edge. */
  profitPctAfterFees: number;
  maxContracts: number;
  estimatedMaxProfit: number;
  timeToClose: number;
  kalshiSide: "YES" | "NO";
  polymarketSide: "YES" | "NO";
  kalshiAsk: number;
  polymarketAsk: number;
  kalshiMarket: KalshiMarket;
  polymarketMarket: PolymarketMarket;
  matchedPair: MatchedPair;
  detectedAt: Date;
  /** Seconds since last Polymarket data fetch when this opportunity was detected. */
  polyStaleSeconds: number;
  /** Seconds since last Kalshi data fetch when this opportunity was detected. */
  kalshiStaleSeconds: number;
}

// ─── Tracked (persistent) opportunity wrapper ───

export interface TrackedOpportunity {
  /** Stable key: compositeKey(poly_id, kalshi_id) + side combo */
  key: string;
  /** Latest arb snapshot (updated each cycle if still live) */
  current: ArbOpportunity;
  /** When this opportunity was first detected */
  firstSeenAt: Date;
  /** When this opportunity was last confirmed still live */
  lastSeenAt: Date;
  /** Number of consecutive cycles this opportunity has been live */
  consecutiveCycles: number;
  /** Whether the opportunity was found in the most recent cycle */
  live: boolean;
  /** Peak profit % ever observed for this opportunity */
  peakProfitPct: number;
}

// ─── Session Stats ───

export interface SessionStats {
  totalCycles: number;
  totalOpportunities: number;
  bestOpportunity: ArbOpportunity | null;
  startedAt: Date;
}

// ─── API Status ───

export type KalshiApiStatus = "unknown" | "ok" | "auth_error" | "unreachable";

// ─── Config ───

export interface Config {
  kalshiApiKey: string;
  demoMode: boolean;
  pollIntervalMs: number;
  // How often to re-run full discovery (matching across the entire fetched universe).
  // Refresh cycles only update quotes for already-matched pairs.
  discoveryIntervalCycles: number;
  minProfitPct: number;
  minVolumeUsd: number;
  matchThreshold: number;
  maxCloseDateDeltaDays: number;
  /** Minimum shared normalized tokens for candidate pairs (default 2). */
  minSharedTokens: number;
  /** If true, drop pairs where explicit years in titles disagree (cheap prune). */
  matcherYearGate: boolean;
  polymarketPageSize: number;
  polymarketBucketMax: number;
  polymarketBucketRefillRps: number;
  // Max number of /markets pages to fetch during initial discovery.
  polymarketDiscoveryMaxPages: number;
  // Chunk size for Gamma condition_ids filtering during refresh.
  polymarketConditionIdsBatchSize: number;
  kalshiPageSize: number;
  /** Adaptive rate: min / max effective RPS for Kalshi HTTP. */
  kalshiRateMinRps: number;
  kalshiRateMaxRps: number;
  kalshiAdaptiveSuccessBeforeBump: number;
  kalshiAdaptiveBumpRps: number;
  kalshiAdaptiveDecayOn429: number;
  requestTimeoutMs: number;
  // Kalshi discovery caps
  kalshiEventsDiscoveryMaxPages: number;
  kalshiMaxEventsDiscovery: number;
  kalshiMarketsMaxPagesPerEventDiscovery: number;
  // Kalshi refresh caps (when fetching markets for a small set of already-matched events)
  kalshiMarketsMaxPagesPerEventRefresh: number;
  /** Estimated taker fee as fraction per leg (e.g. 0.005 = 0.5%). */
  polymarketTakerFeeFraction: number;
  kalshiTakerFeeFraction: number;
  /** If true, MIN_PROFIT_PCT applies to profitPctAfterFees instead of gross profitPct. */
  minProfitUsesNet: boolean;
  /** Rolling window size for p50/p95 cycle latency in metrics.log summaries. */
  metricsRollingCycles: number;
  /** Use volume-tiered fee schedules instead of flat BPS rates. */
  useTieredFees: boolean;
  /** Max match cache entries (LRU eviction when exceeded). */
  matchCacheMaxSize: number;
  /** Concurrency limit for Kalshi event market fetches during discovery. */
  kalshiDiscoveryConcurrency: number;
  /** If true, exclude sports-category markets from Kalshi discovery (controlled by KALSHI_EXCLUDE_SPORTS env var). */
  kalshiExcludeSports: boolean;
  /** Required match score increase per 5% gross profit above baseline (confidence escalation). */
  confidenceEscalationPerPct: number;
  /** Stale data penalty: reduce effective profit by this % per second of staleness. */
  stalePenaltyPctPerSecond: number;
}
