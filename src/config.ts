import { config as dotenvConfig } from "dotenv";
import type { Config } from "./types/index.js";

dotenvConfig();

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return parsed;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid float for ${key}: ${raw}`);
  }
  return parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function envBpsAsFraction(key: string, defaultBps: number): number {
  const bps = envInt(key, defaultBps);
  return bps / 10_000;
}

export const config: Config = {
  kalshiApiKey: envStr("KALSHI_API_KEY", ""),
  demoMode: envBool("DEMO_MODE", false),
  pollIntervalMs: envInt("POLL_INTERVAL_MS", 3000),
  discoveryIntervalCycles: envInt("DISCOVERY_INTERVAL_CYCLES", 10),
  minProfitPct: envFloat("MIN_PROFIT_PCT", 0.8),
  minVolumeUsd: envInt("MIN_VOLUME_USD", 1000),
  matchThreshold: envFloat("MATCH_THRESHOLD", 0.60),
  maxCloseDateDeltaDays: envInt("MAX_CLOSE_DATE_DELTA_DAYS", 180),
  minSharedTokens: envInt("MIN_SHARED_TOKENS", 2),
  matcherYearGate: envBool("MATCHER_YEAR_GATE", true),
  polymarketPageSize: envInt("POLYMARKET_PAGE_SIZE", 500),
  polymarketBucketMax: envInt("POLYMARKET_BUCKET_MAX", 10),
  polymarketBucketRefillRps: envFloat("POLYMARKET_BUCKET_REFILL_RPS", 10),
  polymarketDiscoveryMaxPages: envInt("POLYMARKET_DISCOVERY_MAX_PAGES", 60),
  polymarketConditionIdsBatchSize: envInt("POLYMARKET_CONDITION_IDS_BATCH_SIZE", 200),
  kalshiPageSize: envInt("KALSHI_PAGE_SIZE", 200),
  kalshiRateMinRps: envFloat("KALSHI_RATE_MIN_RPS", 1.5),
  kalshiRateMaxRps: envFloat("KALSHI_RATE_MAX_RPS", 4),
  kalshiAdaptiveSuccessBeforeBump: envInt("KALSHI_ADAPTIVE_SUCCESS_BEFORE_BUMP", 25),
  kalshiAdaptiveBumpRps: envFloat("KALSHI_ADAPTIVE_BUMP_RPS", 0.25),
  kalshiAdaptiveDecayOn429: envFloat("KALSHI_ADAPTIVE_DECAY_ON429", 0.75),
  requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 5000),
  kalshiEventsDiscoveryMaxPages: envInt("KALSHI_EVENTS_DISCOVERY_MAX_PAGES", 20),
  kalshiMaxEventsDiscovery: envInt("KALSHI_MAX_EVENTS_DISCOVERY", 300),
  kalshiMarketsMaxPagesPerEventDiscovery: envInt("KALSHI_MARKETS_MAX_PAGES_PER_EVENT_DISCOVERY", 3),
  kalshiMarketsMaxPagesPerEventRefresh: envInt("KALSHI_MARKETS_MAX_PAGES_PER_EVENT_REFRESH", 10),
  polymarketTakerFeeFraction: envBpsAsFraction("POLY_TAKER_FEE_BPS", 50),
  kalshiTakerFeeFraction: envBpsAsFraction("KALSHI_TAKER_FEE_BPS", 30),
  minProfitUsesNet: envBool("MIN_PROFIT_USES_NET", false),
  metricsRollingCycles: envInt("METRICS_ROLLING_CYCLES", 60),
  useTieredFees: envBool("USE_TIERED_FEES", true),
  matchCacheMaxSize: envInt("MATCH_CACHE_MAX_SIZE", 5000),
  kalshiDiscoveryConcurrency: envInt("KALSHI_DISCOVERY_CONCURRENCY", 5),
  kalshiExcludeSports: envBool("KALSHI_EXCLUDE_SPORTS", true),
  confidenceEscalationPerPct: envFloat("CONFIDENCE_ESCALATION_PER_PCT", 0.02),
  stalePenaltyPctPerSecond: envFloat("STALE_PENALTY_PCT_PER_SECOND", 0.1),
};
