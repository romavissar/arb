import Table from "cli-table3";
import type { ArbOpportunity, SessionStats } from "../types/index.js";
import { opportunityDisplayProfitPct } from "../core/arbitrage.js";
import { config } from "../config.js";
import {
  colorProfit,
  formatCurrency,
  formatProfit,
  formatTrade,
  truncate,
  formatTime,
  formatNumber,
  header,
  dim,
  progressBar,
} from "./formatter.js";

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const MAX_ROWS = 20;

export interface RenderState {
  opportunities: ArbOpportunity[];
  matchedPairs: number;
  polymarketCount: number;
  kalshiCount: number;
  scanProgress: number;
  scanPhase: string;
  polyStaleSeconds: number;
  kalshiStaleSeconds: number;
  stats: SessionStats;
}

function staleIndicator(seconds: number, name: string): string {
  if (seconds > 10) return `  \x1b[91m[${name} STALE ${seconds}s]\x1b[0m`;
  return "";
}

function kalshiCountDisplay(count: number, totalCycles: number): string {
  // Only alarm after at least one cycle (avoid false alarm on startup)
  if (totalCycles > 0 && count === 0) {
    return `\x1b[91m${formatNumber(count)} [!]\x1b[0m`;
  }
  return formatNumber(count);
}

export function render(state: RenderState): void {
  const {
    opportunities,
    matchedPairs,
    polymarketCount,
    kalshiCount,
    scanProgress,
    scanPhase,
    polyStaleSeconds,
    kalshiStaleSeconds,
    stats,
  } = state;

  process.stdout.write(CLEAR_SCREEN);

  // Header
  const now = formatTime(new Date());
  const stale =
    staleIndicator(polyStaleSeconds, "POLY") +
    staleIndicator(kalshiStaleSeconds, "KALSHI");

  console.log(
    header(
      `  POLYMARKET ↔ KALSHI ARB SCREENER  │  Last scan: ${now}  │  Pairs matched: ${formatNumber(matchedPairs)}  │  Poly: ${formatNumber(polymarketCount)}  Kalshi: ${kalshiCountDisplay(kalshiCount, stats.totalCycles)}${stale}`
    )
  );
  console.log("");

  // Table
  const table = new Table({
    head: ["Event", "Trade", "Poly", "Kalshi", "Cost", "Profit", "Match", "Closes In"],
    colWidths: [32, 16, 8, 8, 8, 16, 7, 10],
    style: { head: ["cyan"], border: ["gray"] },
    wordWrap: true,
  });

  const displayed = opportunities.slice(0, MAX_ROWS);

  if (displayed.length === 0) {
    table.push([
      { colSpan: 8, content: dim("  No arbitrage opportunities detected yet. Scanning..."), hAlign: "center" as const },
    ]);
  }

  for (const opp of displayed) {
    const eventName = truncate(opp.matchedPair.polymarket.title, 30);
    const trade = formatTrade(opp.polymarketSide, opp.kalshiSide);
    const displayPct = opportunityDisplayProfitPct(opp);
    const netProfit = opp.profitPerContract - opp.estimatedFeesPerContract;
    const profitStr = config.minProfitUsesNet
      ? formatProfit(netProfit, displayPct)
      : formatProfit(opp.profitPerContract, displayPct);
    const hoursLeft = opp.timeToClose < 24
      ? `${opp.timeToClose.toFixed(1)}h`
      : `${Math.round(opp.timeToClose / 24)}d`;

    table.push([
      eventName,
      trade,
      formatCurrency(opp.polymarketAsk),
      formatCurrency(opp.kalshiAsk),
      formatCurrency(opp.combinedCost),
      colorProfit(displayPct, profitStr),
      `${(opp.matchScore * 100).toFixed(0)}%`,
      hoursLeft,
    ]);
  }

  console.log(table.toString());

  // Footer
  const liveCount = opportunities.filter(
    (o) => opportunityDisplayProfitPct(o) >= config.minProfitPct,
  ).length;
  const bestStr = stats.bestOpportunity
    ? `Best: +${opportunityDisplayProfitPct(stats.bestOpportunity).toFixed(1)}% on ${truncate(stats.bestOpportunity.matchedPair.polymarket.title, 30)}`
    : "No opportunities yet";

  console.log("");
  console.log(
    `  ${scanPhase}  ${progressBar(scanProgress)}  ${Math.round(scanProgress * 100)}%    Opportunities: ${liveCount} live    ${bestStr}`
  );
  console.log(
    dim(`  Cycle #${stats.totalCycles}  │  Total opps found: ${stats.totalOpportunities}  │  Session: ${formatSessionDuration(stats.startedAt)}`)
  );
}

function formatSessionDuration(startedAt: Date): string {
  const diffMs = Date.now() - startedAt.getTime();
  const mins = Math.floor(diffMs / 60000);
  const secs = Math.floor((diffMs % 60000) / 1000);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
