import { config } from "./config.js";
import {
  fetchAllPolymarketMarkets,
  fetchPolymarketMarketsByConditionIds,
  normalizePolymarket,
  resetPolymarketFetchStats,
  getPolymarketFetchStats,
} from "./apis/polymarket.js";
import {
  fetchAllKalshiMarkets,
  fetchKalshiMarketsForEventTickersWithTargets,
  normalizeKalshi,
  resetKalshiFetchStats,
  getKalshiFetchStats,
  getKalshiEffectiveRps,
  isKalshiDisabled,
} from "./apis/kalshi.js";
import { generateDemoKalshiMarkets } from "./apis/kalshiDemo.js";
import { matchMarkets, getMatchCacheSize, syncMatchedPairs, getMatchedPairs } from "./core/matcher.js";
import { detectArbitrage, opportunityDisplayProfitPct } from "./core/arbitrage.js";
import { render, type RenderState } from "./display/renderer.js";
import { startWebServer, pushState } from "./web/server.js";
import { appendError, appendMetricLine } from "./core/logging.js";
import { appendFileSync } from "fs";
import { RollingCycleLatency } from "./core/metrics.js";
import {
  initDb, startSession, updateSession, endSession, closeDb, getHistoricalStats,
} from "./core/persistence.js";
import { scanLog, clearScanLog } from "./core/scanLog.js";
import type { NormalizedMarket, ArbOpportunity, TrackedOpportunity, SessionStats, MatchedPair, PolymarketMarket, KalshiMarket, KalshiApiStatus } from "./types/index.js";

// ─── Session state ───

const stats: SessionStats = {
  totalCycles: 0,
  totalOpportunities: 0,
  bestOpportunity: null,
  startedAt: new Date(),
};

const rollingLatency = new RollingCycleLatency(config.metricsRollingCycles);

let lastPolyFetch = Date.now();
let lastKalshiFetch = Date.now();
let running = true;
let matchedPairs: MatchedPair[] = [];

// ─── Persistent opportunity tracker ───
// Keeps all opportunities across cycles, updating live ones and marking stale ones

const trackedOpportunities = new Map<string, TrackedOpportunity>();

/** Max cycles an opportunity can be "not seen" before being removed entirely */
const STALE_EXPIRY_CYCLES = 20;

function oppKey(arb: ArbOpportunity): string {
  return `${arb.matchedPair.id}|${arb.polymarketSide}|${arb.kalshiSide}`;
}

function updateTrackedOpportunities(cycleOpps: ArbOpportunity[]): TrackedOpportunity[] {
  const now = new Date();
  const seenThisCycle = new Set<string>();

  // Update or insert opportunities found this cycle
  for (const arb of cycleOpps) {
    const key = oppKey(arb);
    seenThisCycle.add(key);

    const existing = trackedOpportunities.get(key);
    if (existing) {
      existing.current = arb;
      existing.lastSeenAt = now;
      existing.consecutiveCycles++;
      existing.live = true;
      existing.peakProfitPct = Math.max(existing.peakProfitPct, opportunityDisplayProfitPct(arb));
    } else {
      trackedOpportunities.set(key, {
        key,
        current: arb,
        firstSeenAt: now,
        lastSeenAt: now,
        consecutiveCycles: 1,
        live: true,
        peakProfitPct: opportunityDisplayProfitPct(arb),
      });
    }
  }

  // Mark opportunities NOT seen this cycle as stale, remove very old ones
  for (const [key, tracked] of trackedOpportunities) {
    if (!seenThisCycle.has(key)) {
      tracked.live = false;
      tracked.consecutiveCycles = 0;

      // Remove if expired (close time passed or not seen for too long)
      const cyclesSinceLastSeen = Math.round(
        (now.getTime() - tracked.lastSeenAt.getTime()) / Math.max(config.pollIntervalMs, 1000)
      );
      if (cyclesSinceLastSeen > STALE_EXPIRY_CYCLES || tracked.current.timeToClose <= 0) {
        trackedOpportunities.delete(key);
      }
    }
  }

  // Return all tracked opportunities sorted by profit desc
  return Array.from(trackedOpportunities.values());
}

// ─── Graceful shutdown ───

function printSummary(): void {
  console.log("\n\n--- Session Summary ---");
  console.log(`  Total cycles:        ${stats.totalCycles}`);
  console.log(`  Total opportunities: ${stats.totalOpportunities}`);
  if (stats.bestOpportunity) {
    const p = opportunityDisplayProfitPct(stats.bestOpportunity);
    console.log(
      `  Best opportunity:    +${p.toFixed(1)}% on "${stats.bestOpportunity.matchedPair.polymarket.title}"`,
    );
  }
  const duration = (Date.now() - stats.startedAt.getTime()) / 1000;
  console.log(`  Session duration:    ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);

  // Show historical stats
  const hist = getHistoricalStats();
  console.log(`\n--- Historical (all sessions) ---`);
  console.log(`  Total sessions:      ${hist.totalSessions}`);
  console.log(`  All-time opps:       ${hist.totalOpportunitiesAllTime}`);
  console.log(`  Last 24h opps:       ${hist.last24hOpportunities}`);
  if (hist.bestProfitPctAllTime !== null) {
    console.log(`  Best all-time:       +${hist.bestProfitPctAllTime.toFixed(1)}% on "${hist.bestEventAllTime ?? "unknown"}"`);
  }
  console.log("--- End ---\n");

  endSession();
  closeDb();
}

process.on("SIGINT", () => {
  running = false;
  printSummary();
  process.exit(0);
});

process.on("SIGTERM", () => {
  running = false;
  printSummary();
  process.exit(0);
});

// ─── Main poll loop ───

async function pollCycle(): Promise<void> {
  const cycleStart = Date.now();
  stats.totalCycles++;

  const doDiscovery = matchedPairs.length === 0 || stats.totalCycles % config.discoveryIntervalCycles === 0;

  scanLog("info", "cycle", `Cycle #${stats.totalCycles} starting — ${doDiscovery ? "DISCOVERY" : "REFRESH"} mode`);

  let polyFetchMs = 0;
  let kalshiFetchMs = 0;
  let normalizeMs = 0;
  let matchMs = 0;
  let arbMs = 0;
  let renderMs = 0;

  // Render scanning state
  const renderState: RenderState = {
    opportunities: [],
    matchedPairs: getMatchCacheSize(),
    polymarketCount: 0,
    kalshiCount: 0,
    scanProgress: 0.1,
    scanPhase: "Fetching markets...",
    polyStaleSeconds: (Date.now() - lastPolyFetch) / 1000,
    kalshiStaleSeconds: (Date.now() - lastKalshiFetch) / 1000,
    stats,
  };

  let polyRaw: Awaited<ReturnType<typeof fetchAllPolymarketMarkets>> = [];
  let kalshiRaw: Awaited<ReturnType<typeof fetchAllKalshiMarkets>> = [];

  try {
    resetPolymarketFetchStats();
    resetKalshiFetchStats();

    renderState.scanPhase = "Fetching markets...";
    renderState.scanProgress = 0.2;
    render(renderState);

    const polyPromise = doDiscovery
      ? (async () => {
          const t = Date.now();
          const r = await fetchAllPolymarketMarkets().catch((err) => {
            appendError(`Polymarket fetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
          polyFetchMs = Date.now() - t;
          return r;
        })()
      : (async () => {
          const t = Date.now();
          const conditionIds = Array.from(
            new Set(matchedPairs.map((p) => (p.polymarket.raw as PolymarketMarket).condition_id)),
          );
          const r = await fetchPolymarketMarketsByConditionIds(conditionIds).catch((err) => {
            appendError(`Polymarket refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
          polyFetchMs = Date.now() - t;
          return r;
        })();

    const kalshiPromise = doDiscovery
      ? (config.demoMode
          ? (async () => {
              const t = Date.now();
              const r = generateDemoKalshiMarkets();
              kalshiFetchMs = Date.now() - t;
              return r;
            })()
          : (async () => {
              const t = Date.now();
              const r = await fetchAllKalshiMarkets().catch((err) => {
                appendError(`Kalshi fetch failed: ${err instanceof Error ? err.message : String(err)}`);
                return [];
              });
              kalshiFetchMs = Date.now() - t;
              return r;
            })())
      : (async () => {
          const t = Date.now();
          if (config.demoMode) {
            const r = generateDemoKalshiMarkets();
            kalshiFetchMs = Date.now() - t;
            return r;
          }
          const targetByEvent = new Map<string, Set<string>>();
          for (const p of matchedPairs) {
            const k = p.kalshi.raw as KalshiMarket;
            const ev = k.event_ticker;
            const tick = k.ticker;
            if (!ev || !tick) continue;
            let set = targetByEvent.get(ev);
            if (!set) {
              set = new Set<string>();
              targetByEvent.set(ev, set);
            }
            set.add(tick);
          }
          const r = await fetchKalshiMarketsForEventTickersWithTargets(targetByEvent).catch((err) => {
            appendError(`Kalshi refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
          kalshiFetchMs = Date.now() - t;
          return r;
        })();

    const [polyResult, kalshiResult] = await Promise.all([polyPromise, kalshiPromise]);

    polyRaw = polyResult;
    kalshiRaw = kalshiResult;

    if (polyRaw.length > 0) lastPolyFetch = Date.now();
    if (kalshiRaw.length > 0 || config.demoMode) lastKalshiFetch = Date.now();
  } catch (err) {
    appendError(`Fetch cycle error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const polyStats = getPolymarketFetchStats();
  const kalshiStats = getKalshiFetchStats();

  renderState.scanPhase = "Normalizing...";
  renderState.scanProgress = 0.4;
  render(renderState);

  scanLog("info", "normalize", `Normalizing ${polyRaw.length} Polymarket + ${kalshiRaw.length} Kalshi raw markets`);

  const tNorm = Date.now();
  const polyMarkets: NormalizedMarket[] = polyRaw
    .map(normalizePolymarket)
    .filter((m): m is NormalizedMarket => m !== null);

  const kalshiMarkets: NormalizedMarket[] = kalshiRaw
    .map(normalizeKalshi)
    .filter((m): m is NormalizedMarket => m !== null);
  normalizeMs = Date.now() - tNorm;

  scanLog("info", "normalize", `Normalized: ${polyMarkets.length} Poly + ${kalshiMarkets.length} Kalshi (${normalizeMs}ms)`, `skipped: ${polyRaw.length - polyMarkets.length} Poly, ${kalshiRaw.length - kalshiMarkets.length} Kalshi`);
  try {
    appendFileSync('match-debug.log', `\n[INDEX] Raw: ${polyRaw.length} poly, ${kalshiRaw.length} kalshi → Normalized: ${polyMarkets.length} poly, ${kalshiMarkets.length} kalshi\n`);
    if (kalshiMarkets.length > 0) {
      appendFileSync('match-debug.log', `[INDEX] Sample Kalshi titles:\n`);
      kalshiMarkets.slice(0, 5).forEach(m => appendFileSync('match-debug.log', `  "${m.title}" (yes=${m.yesAsk} no=${m.noAsk} vol=${m.volume})\n`));
    }
    if (polyMarkets.length > 0) {
      appendFileSync('match-debug.log', `[INDEX] Sample Poly titles:\n`);
      polyMarkets.slice(0, 5).forEach(m => appendFileSync('match-debug.log', `  "${m.title}" (yes=${m.yesAsk} no=${m.noAsk} vol=${m.volume})\n`));
    }
  } catch {}

  renderState.polymarketCount = polyMarkets.length;
  renderState.kalshiCount = kalshiMarkets.length;

  const tMatch = Date.now();
  if (doDiscovery) {
    renderState.scanPhase = "Matching markets...";
    renderState.scanProgress = 0.6;
    render(renderState);

    matchedPairs = matchMarkets(polyMarkets, kalshiMarkets);
  } else {
    renderState.scanPhase = "Syncing matched pairs...";
    renderState.scanProgress = 0.6;
    render(renderState);

    matchedPairs = syncMatchedPairs(polyMarkets, kalshiMarkets);
    if (matchedPairs.length === 0) matchedPairs = getMatchedPairs();
  }
  matchMs = Date.now() - tMatch;

  renderState.matchedPairs = matchedPairs.length;

  renderState.scanPhase = "Detecting arbitrage...";
  renderState.scanProgress = 0.8;
  render(renderState);

  const polyStaleS = (Date.now() - lastPolyFetch) / 1000;
  const kalshiStaleS = (Date.now() - lastKalshiFetch) / 1000;

  const tArb = Date.now();
  // Always run arb detection — staleness is handled via penalty, not blocking
  const cycleOpps = detectArbitrage(matchedPairs, polyStaleS, kalshiStaleS);
  arbMs = Date.now() - tArb;

  // Update persistent tracker — accumulates across cycles
  const allTracked = updateTrackedOpportunities(cycleOpps);

  // Count only NEW opportunities (first time seen this session)
  for (const opp of cycleOpps) {
    const key = oppKey(opp);
    const tracked = trackedOpportunities.get(key);
    if (tracked && tracked.consecutiveCycles === 1) {
      stats.totalOpportunities++;
    }
  }
  for (const opp of cycleOpps) {
    if (
      !stats.bestOpportunity ||
      opportunityDisplayProfitPct(opp) > opportunityDisplayProfitPct(stats.bestOpportunity)
    ) {
      stats.bestOpportunity = opp;
    }
  }

  // Persist session progress periodically
  if (stats.totalCycles % 5 === 0) {
    updateSession({
      totalCycles: stats.totalCycles,
      totalOpportunities: stats.totalOpportunities,
      bestProfitPct: stats.bestOpportunity ? opportunityDisplayProfitPct(stats.bestOpportunity) : null,
      bestEvent: stats.bestOpportunity?.matchedPair.polymarket.title ?? null,
    });
  }

  const cycleMs = Date.now() - cycleStart;
  scanLog("success", "cycle", `Cycle #${stats.totalCycles} complete in ${cycleMs}ms — ${cycleOpps.length} new, ${allTracked.length} total tracked`, `fetch: ${polyFetchMs + kalshiFetchMs}ms, norm: ${normalizeMs}ms, match: ${matchMs}ms, arb: ${arbMs}ms`);

  renderState.opportunities = allTracked.filter(t => t.live).map(t => t.current);
  renderState.scanPhase = `Scan complete (${cycleMs}ms)`;
  renderState.scanProgress = 1.0;
  renderState.polyStaleSeconds = (Date.now() - lastPolyFetch) / 1000;
  renderState.kalshiStaleSeconds = (Date.now() - lastKalshiFetch) / 1000;

  const tRender = Date.now();
  render(renderState);
  renderMs = Date.now() - tRender;

  rollingLatency.push(cycleMs);
  const roll = rollingLatency.summary();

  appendMetricLine({
    type: "cycle",
    cycle: stats.totalCycles,
    discovery: doDiscovery,
    poly_fetch_ms: polyFetchMs,
    kalshi_fetch_ms: kalshiFetchMs,
    normalize_ms: normalizeMs,
    match_ms: matchMs,
    arb_ms: arbMs,
    render_ms: renderMs,
    poly_http_429: polyStats.http429,
    kalshi_http_429: kalshiStats.http429,
    poly_bytes_in: polyStats.bytesIn,
    kalshi_bytes_in: kalshiStats.bytesIn,
    cycle_total_ms: cycleMs,
    kalshi_bucket_rps: config.demoMode ? null : getKalshiEffectiveRps(),
    rolling_n: roll.n,
    rolling_p50_ms: roll.p50_ms,
    rolling_p95_ms: roll.p95_ms,
  });

  pushState({
    opportunities: allTracked,
    matchedPairs: renderState.matchedPairs,
    polymarketCount: renderState.polymarketCount,
    kalshiCount: renderState.kalshiCount,
    scanPhase: renderState.scanPhase,
    scanProgress: renderState.scanProgress,
    polyStaleSeconds: renderState.polyStaleSeconds,
    kalshiStaleSeconds: renderState.kalshiStaleSeconds,
    stats,
    demoMode: config.demoMode,
    kalshiApiStatus: isKalshiDisabled() ? "auth_error" : (kalshiRaw.length > 0 || config.demoMode ? "ok" : "unreachable"),
  });
}

// ─── Startup health check ───

async function checkKalshiHealth(): Promise<KalshiApiStatus> {
  if (config.demoMode) {
    console.log("  Kalshi API:       SKIP (demo mode)");
    return "ok";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1&status=open";
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    clearTimeout(timeout);
    if (res.ok) {
      const body = await res.json() as { markets?: unknown[] };
      const count = Array.isArray(body.markets) ? body.markets.length : 0;
      console.log(`  Kalshi API:       OK (public endpoint reachable, got ${count} market(s))`);
      return "ok";
    } else if (res.status === 401) {
      console.log(`  Kalshi API:       FAIL (HTTP 401 — endpoint requires auth)`);
      return "auth_error";
    } else {
      console.log(`  Kalshi API:       FAIL (HTTP ${res.status})`);
      return "unreachable";
    }
  } catch (err) {
    clearTimeout(timeout);
    console.log(`  Kalshi API:       FAIL (${err instanceof Error ? err.message : String(err)})`);
    return "unreachable";
  }
}

// ─── Entry point ───

async function main(): Promise<void> {
  console.log("Starting Polymarket ↔ Kalshi Arbitrage Screener...\n");

  // Initialize persistence
  initDb();
  startSession();

  const hist = getHistoricalStats();
  if (hist.totalSessions > 1) {
    console.log(`Resuming — ${hist.totalSessions - 1} prior session(s), ${hist.totalOpportunitiesAllTime} all-time opps, ${hist.last24hOpportunities} in last 24h`);
    if (hist.bestProfitPctAllTime !== null) {
      console.log(`All-time best: +${hist.bestProfitPctAllTime.toFixed(1)}%\n`);
    }
  }

  if (config.demoMode) {
    console.log("DEMO MODE — using simulated Kalshi data.\n");
  } else if (!config.kalshiApiKey) {
    console.log("No KALSHI_API_KEY — using public Kalshi read API (api.elections.kalshi.com).\n");
  }

  console.log(`Metrics: append-only metrics.log (rolling p50/p95 over last ${config.metricsRollingCycles} cycles)`);
  console.log(`Persistence: arb-screener.db (SQLite — opportunity history + session tracking)`);
  console.log(`Fees: ${config.useTieredFees ? "volume-tiered" : "flat"} schedule`);
  console.log(`Match cache: LRU max ${config.matchCacheMaxSize} entries`);
  console.log(`Kalshi concurrency: ${config.kalshiDiscoveryConcurrency} parallel event fetches\n`);

  console.log("\n--- Startup Health Check ---");
  const kalshiHealthStatus = await checkKalshiHealth();
  console.log("----------------------------\n");

  if (kalshiHealthStatus !== "ok" && !config.demoMode) {
    console.log("WARNING: Kalshi API not healthy. Kalshi markets may not be discovered.\n");
  }

  startWebServer();

  await pollCycle();

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    if (!running) break;
    await pollCycle();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  endSession();
  closeDb();
  process.exit(1);
});
