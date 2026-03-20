import type { MatchedPair, ArbOpportunity, PolymarketMarket, KalshiMarket } from "../types/index.js";
import { config } from "../config.js";
import { appendOpportunity } from "./logging.js";
import { getPolymarketFee, getKalshiFee } from "./fees.js";
import { persistOpportunity } from "./persistence.js";
import { scanLog } from "./scanLog.js";

function hoursUntil(date: Date): number {
  return Math.max(0, (date.getTime() - Date.now()) / (1000 * 60 * 60));
}

function pairPassesQuotePrefilter(pair: MatchedPair): boolean {
  const poly = pair.polymarket;
  const kalshi = pair.kalshi;
  if (poly.volume + kalshi.volume < config.minVolumeUsd) return false;
  const asks = [poly.yesAsk, poly.noAsk, kalshi.yesAsk, kalshi.noAsk];
  for (const a of asks) {
    if (a <= 0 || a >= 1) return false;
  }
  return true;
}

/**
 * Confidence escalation: for higher-profit opportunities, require a proportionally
 * higher match score to reduce false-positive risk on large trades.
 * E.g., a 10% arb needs a higher match score than a 1% arb.
 */
function requiredMatchScore(grossProfitPct: number): number {
  const base = config.matchThreshold;
  const escalation = config.confidenceEscalationPerPct;
  // For every 5% gross profit above 0, add escalation to required score
  const bonus = Math.floor(grossProfitPct / 5) * escalation;
  return Math.min(0.95, base + bonus);
}

/**
 * Apply a staleness penalty to the effective profit percentage.
 * Older data = less confidence in the opportunity being real.
 */
function applyStalenessPenalty(profitPct: number, polyStaleS: number, kalshiStaleS: number): number {
  const maxStale = Math.max(polyStaleS, kalshiStaleS);
  const penalty = maxStale * config.stalePenaltyPctPerSecond;
  return Math.max(0, profitPct - penalty);
}

function computeArb(
  pair: MatchedPair,
  polyAsk: number,
  polySide: "YES" | "NO",
  kalshiAsk: number,
  kalshiSide: "YES" | "NO",
  polyStaleSeconds: number,
  kalshiStaleSeconds: number,
): ArbOpportunity | null {
  const combinedCost = polyAsk + kalshiAsk;
  if (combinedCost >= 1.0 || combinedCost <= 0) return null;

  const profitPerContract = 1.0 - combinedCost;
  const profitPct = (profitPerContract / combinedCost) * 100;

  // Volume-tier aware fees
  const polyFee = polyAsk * getPolymarketFee(pair.polymarket.volume);
  const kalshiFee = kalshiAsk * getKalshiFee(pair.kalshi.volume);
  const estimatedFeesPerContract = polyFee + kalshiFee;
  const netProfitPerContract = profitPerContract - estimatedFeesPerContract;
  const profitPctAfterFees = combinedCost > 0 ? (netProfitPerContract / combinedCost) * 100 : 0;

  const timeToClose = Math.min(
    hoursUntil(pair.polymarket.closeTime),
    hoursUntil(pair.kalshi.closeTime),
  );

  const avgPrice = combinedCost / 2;
  const maxContracts = avgPrice > 0 ? Math.floor(Math.min(pair.kalshi.volume, pair.polymarket.volume) / avgPrice) : 0;
  const estimatedMaxProfit = netProfitPerContract > 0 ? netProfitPerContract * maxContracts : 0;

  return {
    matchScore: pair.matchScore,
    combinedCost,
    profitPerContract,
    profitPct,
    estimatedFeesPerContract,
    profitPctAfterFees,
    maxContracts,
    estimatedMaxProfit,
    timeToClose,
    kalshiSide,
    polymarketSide: polySide,
    kalshiAsk,
    polymarketAsk: polyAsk,
    kalshiMarket: pair.kalshi.raw as KalshiMarket,
    polymarketMarket: pair.polymarket.raw as PolymarketMarket,
    matchedPair: pair,
    detectedAt: new Date(),
    polyStaleSeconds,
    kalshiStaleSeconds,
  };
}

export function detectArbitrage(
  pairs: MatchedPair[],
  polyStaleSeconds: number = 0,
  kalshiStaleSeconds: number = 0,
): ArbOpportunity[] {
  const opportunities: ArbOpportunity[] = [];
  let pairsEvaluated = 0;
  let prefilterSkipped = 0;
  let arbCandidatesChecked = 0;
  let filterRejected = 0;

  scanLog("info", "arb", `Evaluating ${pairs.length} matched pairs for arbitrage`);

  for (const pair of pairs) {
    if (!pairPassesQuotePrefilter(pair)) {
      prefilterSkipped++;
      continue;
    }
    pairsEvaluated++;

    const poly = pair.polymarket;
    const kalshi = pair.kalshi;

    const arbA = computeArb(pair, poly.noAsk, "NO", kalshi.yesAsk, "YES", polyStaleSeconds, kalshiStaleSeconds);
    const arbB = computeArb(pair, poly.yesAsk, "YES", kalshi.noAsk, "NO", polyStaleSeconds, kalshiStaleSeconds);

    for (const arb of [arbA, arbB]) {
      if (!arb) continue;
      arbCandidatesChecked++;
      if (!passesFilters(arb, pair)) {
        filterRejected++;
        scanLog("debug", "arb", `Rejected: "${poly.title.slice(0, 40)}" P:${arb.polymarketSide}+K:${arb.kalshiSide}`, `profit=${arb.profitPct.toFixed(1)}% match=${(arb.matchScore*100).toFixed(0)}% ttc=${arb.timeToClose.toFixed(0)}h`);
        continue;
      }
      opportunities.push(arb);
      scanLog("success", "arb", `Found: "${poly.title.slice(0, 40)}" P:${arb.polymarketSide}+K:${arb.kalshiSide} +${arb.profitPct.toFixed(1)}%`, `cost=$${arb.combinedCost.toFixed(2)} net=${arb.profitPctAfterFees.toFixed(1)}% match=${(arb.matchScore*100).toFixed(0)}%`);

      appendOpportunity({
        event: poly.title,
        polymarketSide: arb.polymarketSide,
        kalshiSide: arb.kalshiSide,
        polymarketAsk: arb.polymarketAsk,
        kalshiAsk: arb.kalshiAsk,
        combinedCost: arb.combinedCost,
        profitPctGross: arb.profitPct,
        profitPctAfterFees: arb.profitPctAfterFees,
        estimatedFeesPerContract: arb.estimatedFeesPerContract,
        matchScore: arb.matchScore,
      });

      // Persist to SQLite
      persistOpportunity({
        event: poly.title,
        polymarketSide: arb.polymarketSide,
        kalshiSide: arb.kalshiSide,
        polymarketAsk: arb.polymarketAsk,
        kalshiAsk: arb.kalshiAsk,
        combinedCost: arb.combinedCost,
        profitPctGross: arb.profitPct,
        profitPctAfterFees: arb.profitPctAfterFees,
        estimatedFees: arb.estimatedFeesPerContract,
        matchScore: arb.matchScore,
        maxContracts: arb.maxContracts,
        estimatedMaxProfit: arb.estimatedMaxProfit,
        timeToCloseHours: arb.timeToClose,
        polyStaleSeconds,
        kalshiStaleSeconds,
      });
    }
  }

  scanLog("info", "arb", `Arb scan complete: ${opportunities.length} opportunities from ${pairsEvaluated} pairs`, `prefilter skipped: ${prefilterSkipped}, candidates checked: ${arbCandidatesChecked}, filter rejected: ${filterRejected}`);

  opportunities.sort((a, b) => {
    const pa = config.minProfitUsesNet ? a.profitPctAfterFees : a.profitPct;
    const pb = config.minProfitUsesNet ? b.profitPctAfterFees : b.profitPct;
    return pb - pa;
  });
  return opportunities;
}

/** Use for UI / session "best" when MIN_PROFIT_USES_NET toggles gross vs net. */
export function opportunityDisplayProfitPct(o: ArbOpportunity): number {
  return config.minProfitUsesNet ? o.profitPctAfterFees : o.profitPct;
}

function passesFilters(arb: ArbOpportunity, pair: MatchedPair): boolean {
  if (arb.timeToClose < 2) return false;

  const combinedVolume = pair.polymarket.volume + pair.kalshi.volume;
  if (combinedVolume < config.minVolumeUsd) return false;

  // Apply staleness penalty to the profit used for threshold check
  const rawProfit = config.minProfitUsesNet ? arb.profitPctAfterFees : arb.profitPct;
  const effectiveProfit = applyStalenessPenalty(rawProfit, arb.polyStaleSeconds, arb.kalshiStaleSeconds);
  if (effectiveProfit < config.minProfitPct) return false;

  // Confidence escalation: higher-profit opps need higher match scores
  const requiredScore = requiredMatchScore(arb.profitPct);
  if (arb.matchScore < requiredScore) return false;

  if (arb.polymarketAsk <= 0 || arb.polymarketAsk >= 1) return false;
  if (arb.kalshiAsk <= 0 || arb.kalshiAsk >= 1) return false;

  return true;
}
