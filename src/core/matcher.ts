import type { NormalizedMarket, MatchedPair } from "../types/index.js";
import { normalize, bigrams, extractDates } from "./normalizer.js";
import { config } from "../config.js";
import { LRUCache } from "./lruCache.js";
import { scanLog } from "./scanLog.js";
import { appendFileSync } from "fs";

// ─── Inverted index for candidate filtering ───

type InvertedIndex = Map<string, string[]>;

function buildInvertedIndex(markets: NormalizedMarket[]): InvertedIndex {
  const index: InvertedIndex = new Map();
  for (const m of markets) {
    for (const token of m.tokens) {
      let list = index.get(token);
      if (!list) {
        list = [];
        index.set(token, list);
      }
      list.push(m.id);
    }
  }
  return index;
}

function getCandidates(
  market: NormalizedMarket,
  index: InvertedIndex,
  minSharedTokens: number,
): Set<string> {
  const counts = new Map<string, number>();
  for (const token of market.tokens) {
    const ids = index.get(token);
    if (!ids) continue;
    for (const id of ids) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const candidates = new Set<string>();
  for (const [id, count] of counts) {
    if (count >= minSharedTokens) candidates.add(id);
  }
  return candidates;
}

function extractYears(text: string): Set<number> {
  const years = new Set<number>();
  const re = /\b(20\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    years.add(parseInt(m[1]!, 10));
  }
  return years;
}

/** Cheap gate: if both titles contain explicit years, require at least one in common. */
function yearsCompatible(titleA: string, titleB: string): boolean {
  const ya = extractYears(titleA);
  const yb = extractYears(titleB);
  if (ya.size === 0 || yb.size === 0) return true;
  for (const y of ya) {
    if (yb.has(y)) return true;
  }
  return false;
}

// ─── Similarity functions ───

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bigramSimilarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  let intersection = 0;
  for (const item of ba) {
    if (bb.has(item)) intersection++;
  }
  const union = ba.size + bb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dateScore(a: NormalizedMarket, b: NormalizedMarket): number {
  const datesA = extractDates(a.normalizedTitle);
  const datesB = extractDates(b.normalizedTitle);

  // Also consider close times
  const allA = [...datesA, a.closeTime];
  const allB = [...datesB, b.closeTime];

  let bestScore = 0;
  for (const da of allA) {
    for (const db of allB) {
      const diffDays = Math.abs(da.getTime() - db.getTime()) / (1000 * 60 * 60 * 24);
      // Gradual decay: 1.0 within 3 days, declining to 0.2 at 365 days
      if (diffDays <= 3) bestScore = Math.max(bestScore, 1.0);
      else if (diffDays <= 14) bestScore = Math.max(bestScore, 0.8);
      else if (diffDays <= 30) bestScore = Math.max(bestScore, 0.6);
      else if (diffDays <= 90) bestScore = Math.max(bestScore, 0.4);
      else if (diffDays <= 365) bestScore = Math.max(bestScore, 0.2);
    }
  }
  return bestScore;
}

// ─── Match cache ───

const matchCache = new LRUCache<string, MatchedPair>(config.matchCacheMaxSize);
/** market id → last structureChecksum (title + close; not every quote tick). */
const checksumCache = new Map<string, string>();

function compositeKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

// ─── Normalize markets in-place ───

export function applyNormalization(markets: NormalizedMarket[]): void {
  for (const m of markets) {
    if (m.normalizedTitle) continue; // already normalized
    const result = normalize(m.title);
    m.normalizedTitle = result.normalized;
    m.tokens = result.tokens;
  }
}

// ─── Main matching function ───

export function matchMarkets(
  polymarkets: NormalizedMarket[],
  kalshiMarkets: NormalizedMarket[],
): MatchedPair[] {
  // Normalize all markets
  applyNormalization(polymarkets);
  applyNormalization(kalshiMarkets);

  // DEBUG: dump normalization stats to file
  const dbg = (msg: string) => { try { appendFileSync('match-debug.log', msg + '\n'); } catch {} };
  dbg(`\n=== matchMarkets called: ${polymarkets.length} poly, ${kalshiMarkets.length} kalshi ===`);
  const polyTokenCounts = polymarkets.map(m => m.tokens.size);
  const kalshiTokenCounts = kalshiMarkets.map(m => m.tokens.size);
  const avgPolyTokens = polyTokenCounts.length ? (polyTokenCounts.reduce((a,b) => a+b, 0) / polyTokenCounts.length).toFixed(1) : '0';
  const avgKalshiTokens = kalshiTokenCounts.length ? (kalshiTokenCounts.reduce((a,b) => a+b, 0) / kalshiTokenCounts.length).toFixed(1) : '0';
  dbg(`Token stats: Poly avg=${avgPolyTokens} tokens/market (${polymarkets.length} markets), Kalshi avg=${avgKalshiTokens} tokens/market (${kalshiMarkets.length} markets)`);
  scanLog("debug", "match", `Token stats: Poly avg=${avgPolyTokens} tokens/market (${polymarkets.length} markets), Kalshi avg=${avgKalshiTokens} tokens/market (${kalshiMarkets.length} markets)`);
  // Sample some titles for debug
  if (kalshiMarkets.length > 0) {
    const sample = kalshiMarkets.slice(0, 3);
    for (const m of sample) {
      dbg(`Kalshi sample: "${m.title}" → normalized: "${m.normalizedTitle}" → tokens: [${[...m.tokens].join(', ')}]`);
      scanLog("debug", "match", `Kalshi sample: "${m.title}" → normalized: "${m.normalizedTitle}" → tokens: [${[...m.tokens].join(', ')}]`);
    }
  }
  if (polymarkets.length > 0) {
    const sample = polymarkets.slice(0, 3);
    for (const m of sample) {
      dbg(`Poly sample: "${m.title}" → normalized: "${m.normalizedTitle}" → tokens: [${[...m.tokens].join(', ')}]`);
      scanLog("debug", "match", `Poly sample: "${m.title}" → normalized: "${m.normalizedTitle}" → tokens: [${[...m.tokens].join(', ')}]`);
    }
  }

  // Determine which markets changed
  const changedPoly = new Set<string>();
  const changedKalshi = new Set<string>();

  for (const m of polymarkets) {
    const prev = checksumCache.get(m.id);
    if (prev !== m.structureChecksum) {
      changedPoly.add(m.id);
      checksumCache.set(m.id, m.structureChecksum);
    }
  }
  for (const m of kalshiMarkets) {
    const prev = checksumCache.get(m.id);
    if (prev !== m.structureChecksum) {
      changedKalshi.add(m.id);
      checksumCache.set(m.id, m.structureChecksum);
    }
  }

  // Build inverted index for kalshi markets
  const kalshiIndex = buildInvertedIndex(kalshiMarkets);
  const indexDebug = `Kalshi inverted index: ${kalshiIndex.size} unique tokens, top tokens: ${[...kalshiIndex.entries()].sort((a,b) => b[1].length - a[1].length).slice(0, 10).map(([t, ids]) => `${t}(${ids.length})`).join(', ')}`;
  dbg(indexDebug);
  scanLog("debug", "match", indexDebug);
  const kalshiById = new Map(kalshiMarkets.map((m) => [m.id, m]));
  const polyById = new Map(polymarkets.map((m) => [m.id, m]));

  // Active market IDs for cache invalidation
  const activeIds = new Set([
    ...polymarkets.map((m) => m.id),
    ...kalshiMarkets.map((m) => m.id),
  ]);

  // Invalidate cache entries for closed/resolved markets
  for (const key of matchCache.keys()) {
    const [idA, idB] = key.split("||");
    if (!activeIds.has(idA) || !activeIds.has(idB)) {
      matchCache.delete(key);
    }
  }

  // For each polymarket, find candidates and score
  const threshold = config.matchThreshold;
  const newMatches: MatchedPair[] = [];

  const minShared = config.minSharedTokens;
  let candidatesEvaluated = 0;
  let yearGateDropped = 0;
  let dateGateDropped = 0;
  let belowThreshold = 0;
  let cacheHits = 0;

  let totalCandidatesFound = 0;
  for (const poly of polymarkets) {
    const candidates = getCandidates(poly, kalshiIndex, minShared);
    totalCandidatesFound += candidates.size;

    for (const kalshiId of candidates) {
      const key = compositeKey(poly.id, kalshiId);

      // Skip re-matching if neither market changed and we have a cached match
      if (!changedPoly.has(poly.id) && !changedKalshi.has(kalshiId) && matchCache.has(key)) {
        cacheHits++;
        continue;
      }

      candidatesEvaluated++;
      const kalshi = kalshiById.get(kalshiId);
      if (!kalshi) continue;

      if (config.matcherYearGate && !yearsCompatible(poly.title, kalshi.title)) {
        yearGateDropped++;
        continue;
      }

      // Check close date delta
      const closeDelta = Math.abs(poly.closeTime.getTime() - kalshi.closeTime.getTime());
      const closeDeltaDays = closeDelta / (1000 * 60 * 60 * 24);
      if (closeDeltaDays > config.maxCloseDateDeltaDays) {
        dateGateDropped++;
        continue;
      }

      // Compute weighted score
      const j = jaccard(poly.tokens, kalshi.tokens);
      const b = bigramSimilarity(poly.normalizedTitle, kalshi.normalizedTitle);
      const d = dateScore(poly, kalshi);
      const finalScore = 0.45 * j + 0.30 * b + 0.25 * d;

      if (finalScore >= threshold) {
        const match: MatchedPair = {
          id: key,
          polymarket: poly,
          kalshi: kalshi,
          matchScore: finalScore,
          matchedAt: new Date(),
        };
        matchCache.set(key, match);
        newMatches.push(match);
        dbg(`MATCH (${(finalScore*100).toFixed(1)}%): "${poly.title}" <-> "${kalshi.title}" | j=${j.toFixed(2)} b=${b.toFixed(2)} d=${d.toFixed(2)} closeDelta=${closeDeltaDays.toFixed(1)}d | polyYes=${poly.yesAsk} kalshiYes=${kalshi.yesAsk}`);
        scanLog("success", "match", `Matched: "${poly.title.slice(0, 50)}" <-> "${kalshi.title.slice(0, 50)}"`, `score: ${(finalScore * 100).toFixed(1)}% (jaccard=${j.toFixed(2)} bigram=${b.toFixed(2)} date=${d.toFixed(2)})`);
      } else {
        belowThreshold++;
        // Log near-misses (top 20 closest to threshold) for debugging
        if (finalScore >= threshold - 0.25) {
          dbg(`Near-miss (${(finalScore*100).toFixed(1)}%): "${poly.title.slice(0,60)}" <-> "${kalshi.title.slice(0,60)}" | j=${j.toFixed(2)} b=${b.toFixed(2)} d=${d.toFixed(2)} closeDelta=${closeDeltaDays.toFixed(1)}d`);
        }
        // Remove from cache if score dropped below threshold
        matchCache.delete(key);
      }
    }
  }

  dbg(`Matching complete: ${totalCandidatesFound} total candidates, ${candidatesEvaluated} evaluated, ${newMatches.length} new matches | cache: ${cacheHits}, year-gate: ${yearGateDropped}, date-gate: ${dateGateDropped}, threshold: ${belowThreshold}`);
  scanLog("info", "match", `Matching complete: ${totalCandidatesFound} total candidates, ${candidatesEvaluated} evaluated, ${newMatches.length} new matches`, `cache hits: ${cacheHits}, year-gate dropped: ${yearGateDropped}, date-gate: ${dateGateDropped}, below threshold: ${belowThreshold}`);

  // Refresh object references so cached pairs always carry latest quotes after discovery.
  for (const match of matchCache.values()) {
    const p = polyById.get(match.polymarket.id);
    const k = kalshiById.get(match.kalshi.id);
    if (p) match.polymarket = p;
    if (k) match.kalshi = k;
  }

  // Return all cached matches (includes both new and unchanged)
  return Array.from(matchCache.values());
}

export function getMatchCacheSize(): number {
  return matchCache.size;
}

export function getMatchedPairs(): MatchedPair[] {
  return Array.from(matchCache.values());
}

// Refresh-mode helper: update cached matched pairs with fresh market quotes.
// This intentionally skips fuzzy matching; it only syncs the cached references.
export function syncMatchedPairs(
  polymarkets: NormalizedMarket[],
  kalshiMarkets: NormalizedMarket[],
): MatchedPair[] {
  applyNormalization(polymarkets);
  applyNormalization(kalshiMarkets);

  const polyById = new Map(polymarkets.map((m) => [m.id, m]));
  const kalshiById = new Map(kalshiMarkets.map((m) => [m.id, m]));

  const activeIds = new Set<string>([...polyById.keys(), ...kalshiById.keys()]);

  // Remove matches if either side is no longer present.
  for (const key of matchCache.keys()) {
    const [idA, idB] = key.split("||");
    if (!activeIds.has(idA) || !activeIds.has(idB)) {
      matchCache.delete(key);
    }
  }

  // Sync cached references + update structure checksum cache for future discovery invalidation.
  for (const m of polymarkets) checksumCache.set(m.id, m.structureChecksum);
  for (const m of kalshiMarkets) checksumCache.set(m.id, m.structureChecksum);

  for (const match of matchCache.values()) {
    const latestPoly = polyById.get(match.polymarket.id);
    if (latestPoly) match.polymarket = latestPoly;

    const latestKalshi = kalshiById.get(match.kalshi.id);
    if (latestKalshi) match.kalshi = latestKalshi;
  }

  return Array.from(matchCache.values());
}
