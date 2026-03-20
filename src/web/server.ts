import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ArbOpportunity, TrackedOpportunity, SessionStats } from "../types/index.js";
import { opportunityDisplayProfitPct } from "../core/arbitrage.js";
import { config } from "../config.js";
import { onScanLog, getScanLogBuffer, type ScanLogEntry } from "../core/scanLog.js";

const PORT = parseInt(process.env.WEB_PORT ?? "3847", 10);

// ─── Shared state pushed from main loop ───

export interface WebState {
  opportunities: TrackedOpportunity[];
  matchedPairs: number;
  polymarketCount: number;
  kalshiCount: number;
  scanPhase: string;
  scanProgress: number;
  polyStaleSeconds: number;
  kalshiStaleSeconds: number;
  stats: SessionStats;
  demoMode: boolean;
  kalshiApiStatus: string;  // "unknown" | "ok" | "auth_error" | "unreachable"
}

let currentState: WebState = {
  opportunities: [],
  matchedPairs: 0,
  polymarketCount: 0,
  kalshiCount: 0,
  scanPhase: "Starting...",
  scanProgress: 0,
  polyStaleSeconds: 0,
  kalshiStaleSeconds: 0,
  stats: { totalCycles: 0, totalOpportunities: 0, bestOpportunity: null, startedAt: new Date() },
  demoMode: false,
  kalshiApiStatus: "unknown",
};

const sseClients = new Set<ServerResponse>();

export function pushState(state: WebState): void {
  currentState = state;
  const json = JSON.stringify(serializeState(state));
  for (const res of sseClients) {
    try {
      res.write(`event: state\ndata: ${json}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Push scan log entries to all SSE clients in real time
onScanLog((entry: ScanLogEntry) => {
  const json = JSON.stringify(entry);
  for (const res of sseClients) {
    try {
      res.write(`event: log\ndata: ${json}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
});

function serializeState(s: WebState): Record<string, unknown> {
  return {
    opportunities: s.opportunities.map((t) => {
      const o = t.current;
      return {
        event: o.matchedPair.polymarket.title,
        polymarketSide: o.polymarketSide,
        kalshiSide: o.kalshiSide,
        polymarketAsk: o.polymarketAsk,
        kalshiAsk: o.kalshiAsk,
        combinedCost: o.combinedCost,
        profitPerContract: o.profitPerContract,
        profitPctGross: o.profitPct,
        profitPctAfterFees: o.profitPctAfterFees,
        profitPctDisplay: opportunityDisplayProfitPct(o),
        profitPerContractDisplay: config.minProfitUsesNet
          ? o.profitPerContract - o.estimatedFeesPerContract
          : o.profitPerContract,
        estimatedFeesPerContract: o.estimatedFeesPerContract,
        matchScore: o.matchScore,
        timeToClose: o.timeToClose,
        maxContracts: o.maxContracts,
        estimatedMaxProfit: o.estimatedMaxProfit,
        detectedAt: o.detectedAt,
        polyStaleSeconds: o.polyStaleSeconds,
        kalshiStaleSeconds: o.kalshiStaleSeconds,
        // Tracking metadata
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastSeenAt,
        consecutiveCycles: t.consecutiveCycles,
        live: t.live,
        peakProfitPct: t.peakProfitPct,
      };
    }),
    matchedPairs: s.matchedPairs,
    polymarketCount: s.polymarketCount,
    kalshiCount: s.kalshiCount,
    scanPhase: s.scanPhase,
    scanProgress: s.scanProgress,
    polyStaleSeconds: s.polyStaleSeconds,
    kalshiStaleSeconds: s.kalshiStaleSeconds,
    totalCycles: s.stats.totalCycles,
    totalOpportunities: s.stats.totalOpportunities,
    bestProfitPct: s.stats.bestOpportunity ? opportunityDisplayProfitPct(s.stats.bestOpportunity) : null,
    minProfitUsesNet: config.minProfitUsesNet,
    bestEvent: s.stats.bestOpportunity?.matchedPair.polymarket.title ?? null,
    startedAt: s.stats.startedAt,
    demoMode: s.demoMode,
    kalshiApiStatus: s.kalshiApiStatus,
  };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(serializeState(currentState)));
    return;
  }

  if (req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // Send current state
    res.write(`event: state\ndata: ${JSON.stringify(serializeState(currentState))}\n\n`);
    // Send buffered log entries so late joiners see recent history
    for (const entry of getScanLogBuffer()) {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Serve the HTML UI
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML_PAGE);
}

export function startWebServer(): void {
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Web UI: http://localhost:${PORT}\n`);
  });
}

// ─── Inline HTML ───

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arb Screener</title>
<style>
  :root {
    --bg: #0a0e17;
    --surface: #111827;
    --border: #1e293b;
    --text: #e2e8f0;
    --text-dim: #64748b;
    --green: #22c55e;
    --green-bright: #4ade80;
    --yellow: #eab308;
    --red: #ef4444;
    --cyan: #06b6d4;
    --purple: #a78bfa;
    --orange: #f97316;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .header {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .header h1 {
    font-size: 16px;
    font-weight: 700;
    color: var(--cyan);
    letter-spacing: 0.5px;
  }
  .header-stats {
    display: flex;
    gap: 20px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .header-stats .val { color: var(--text); font-weight: 600; }
  .stale { color: var(--red) !important; font-weight: 700; }
  .demo-badge {
    background: var(--purple);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.5px;
  }
  .progress-bar {
    width: 100%;
    height: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .progress-bar .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--cyan), var(--green));
    transition: width 0.3s ease;
  }
  .container { padding: 16px 24px; }
  .scan-status {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scan-status .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  thead th {
    text-align: left;
    padding: 10px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    border-bottom: 2px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg);
  }
  tbody tr {
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
  }
  tbody tr:hover { background: rgba(6, 182, 212, 0.05); }
  td {
    padding: 10px 12px;
    white-space: nowrap;
  }
  .event-name {
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .trade-badge {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(6, 182, 212, 0.1);
    border: 1px solid rgba(6, 182, 212, 0.2);
    color: var(--cyan);
    font-weight: 600;
  }
  .price { font-variant-numeric: tabular-nums; }
  .profit-positive-high { color: var(--green-bright); font-weight: 700; }
  .profit-positive { color: var(--yellow); font-weight: 600; }
  .profit-marginal { color: var(--text-dim); }
  .profit-negative { color: #475569; }
  .match-score {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
  }
  .match-high { background: rgba(34,197,94,0.15); color: var(--green); }
  .match-mid { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .match-low { background: rgba(100,116,139,0.15); color: var(--text-dim); }
  .sort-controls {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .sort-controls label {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .sort-btn {
    font-family: inherit;
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.15s;
    font-weight: 600;
  }
  .sort-btn.active {
    border-color: var(--cyan);
    color: var(--cyan);
    background: rgba(6,182,212,0.1);
  }
  .sort-btn:hover { border-color: var(--text-dim); }
  .opp-stale { opacity: 0.45; }
  .opp-stale td { font-style: italic; }
  .live-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    flex-shrink: 0;
  }
  .live-dot.live { background: var(--green); }
  .live-dot.stale { background: var(--red); }
  .first-seen {
    font-size: 10px;
    color: var(--text-dim);
    display: block;
    margin-top: 2px;
  }
  .peak-badge {
    font-size: 9px;
    color: var(--text-dim);
    display: block;
  }
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-dim);
  }
  .empty-state .icon { font-size: 36px; margin-bottom: 12px; }
  .empty-state p { font-size: 14px; }
  .footer {
    padding: 12px 24px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .footer .best { color: var(--green); font-weight: 600; }

  /* ─── Scan Log Panel ─── */
  .log-panel {
    border-top: 1px solid var(--border);
  }
  .log-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 24px;
    cursor: pointer;
    user-select: none;
    background: var(--surface);
    border: none;
    width: 100%;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.3px;
    transition: background 0.15s;
  }
  .log-toggle:hover { background: #1a2332; }
  .log-toggle .toggle-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .log-toggle .arrow {
    display: inline-block;
    transition: transform 0.2s;
    color: var(--cyan);
    font-size: 14px;
  }
  .log-toggle .arrow.open { transform: rotate(90deg); }
  .log-toggle .log-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    font-weight: 700;
    min-width: 20px;
    text-align: center;
  }
  .log-badge-info { background: rgba(6,182,212,0.2); color: var(--cyan); }
  .log-badge-error { background: rgba(239,68,68,0.2); color: var(--red); }
  .log-badge-success { background: rgba(34,197,94,0.2); color: var(--green); }
  .log-filters {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .log-filter-btn {
    font-family: inherit;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.15s;
    font-weight: 600;
  }
  .log-filter-btn.active {
    border-color: var(--cyan);
    color: var(--cyan);
    background: rgba(6,182,212,0.1);
  }
  .log-filter-btn:hover { border-color: var(--text-dim); }
  .log-body {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease;
    background: #080c14;
  }
  .log-body.open {
    max-height: 600px;
    overflow-y: auto;
  }
  .log-body::-webkit-scrollbar { width: 6px; }
  .log-body::-webkit-scrollbar-track { background: transparent; }
  .log-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  .log-entry {
    display: flex;
    align-items: flex-start;
    padding: 4px 24px;
    font-size: 11px;
    line-height: 1.5;
    border-bottom: 1px solid rgba(30,41,59,0.4);
    gap: 10px;
    transition: background 0.1s;
  }
  .log-entry:hover { background: rgba(6,182,212,0.03); }
  .log-entry .log-ts {
    color: #475569;
    white-space: nowrap;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .log-entry .log-cat {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 700;
    text-transform: uppercase;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 70px;
    text-align: center;
  }
  .cat-fetch-poly { background: rgba(167,139,250,0.15); color: var(--purple); }
  .cat-fetch-kalshi { background: rgba(249,115,22,0.15); color: var(--orange); }
  .cat-normalize { background: rgba(6,182,212,0.15); color: var(--cyan); }
  .cat-match { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .cat-arb { background: rgba(34,197,94,0.15); color: var(--green); }
  .cat-cycle { background: rgba(100,116,139,0.15); color: var(--text-dim); }
  .cat-system { background: rgba(239,68,68,0.15); color: var(--red); }
  .log-entry .log-msg { color: var(--text); flex: 1; }
  .log-entry .log-detail {
    color: #475569;
    font-size: 10px;
    flex-shrink: 0;
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .log-entry.level-error .log-msg { color: var(--red); }
  .log-entry.level-warn .log-msg { color: var(--yellow); }
  .log-entry.level-success .log-msg { color: var(--green-bright); }
  .log-entry.level-debug .log-msg { color: #475569; }
  .log-entry.level-debug { opacity: 0.6; }

  @media (max-width: 768px) {
    .header { padding: 12px 16px; }
    .container { padding: 12px 8px; }
    table { font-size: 11px; }
    td, th { padding: 6px 6px; }
    .event-name { max-width: 160px; }
    .log-entry { padding: 4px 8px; font-size: 10px; }
    .log-entry .log-detail { display: none; }
    .log-toggle { padding: 10px 16px; }
  }
</style>
</head>
<body>
  <div class="header">
    <div style="display:flex;align-items:center;gap:12px">
      <h1>POLYMARKET &harr; KALSHI ARB SCREENER</h1>
      <span class="demo-badge" id="demoBadge" style="display:none">DEMO</span>
    </div>
    <div class="header-stats">
      <span>Last scan: <span class="val" id="lastScan">--:--:--</span></span>
      <span>Matched: <span class="val" id="matchedPairs">0</span></span>
      <span>Poly: <span class="val" id="polyCount">0</span></span>
      <span>Kalshi: <span class="val" id="kalshiCount">0</span></span>
      <span id="polyStale"></span>
      <span id="kalshiStale"></span>
    </div>
  </div>
  <div class="progress-bar"><div class="fill" id="progressFill" style="width:0%"></div></div>
  <div class="container">
    <div class="scan-status">
      <div class="dot" id="dot"></div>
      <span id="scanPhase">Connecting...</span>
    </div>
    <div class="sort-controls">
      <label>Sort by:</label>
      <button class="sort-btn active" data-sort="profit">% Profit</button>
      <button class="sort-btn" data-sort="expiry">Expiry</button>
      <button class="sort-btn" data-sort="firstSeen">First Seen</button>
      <button class="sort-btn" data-sort="match">Match Score</button>
      <button class="sort-btn" data-sort="maxProfit">Est. Max $</button>
      <span style="margin-left:auto;font-size:11px;color:var(--text-dim)">
        Live: <span class="val" id="liveCount">0</span> &middot;
        Stale: <span class="val" id="staleCount">0</span> &middot;
        Total: <span class="val" id="allOppCount">0</span>
      </span>
    </div>
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Event</th>
          <th>Trade</th>
          <th>Poly Ask</th>
          <th>Kalshi Ask</th>
          <th>Cost</th>
          <th>Profit</th>
          <th>Match</th>
          <th>Closes In</th>
          <th>Est. Max $</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="empty-state" id="emptyState">
      <div class="icon">&#x1F50D;</div>
      <p>Scanning for arbitrage opportunities...</p>
    </div>
  </div>
  <div class="footer">
    <span>Cycle #<span id="cycle">0</span> &middot; Total opps: <span id="totalOpps">0</span></span>
    <span id="bestOpp">--</span>
    <span id="sessionTime">0m 0s</span>
  </div>

  <!-- ─── Live Scan Log Panel ─── -->
  <div class="log-panel">
    <button class="log-toggle" id="logToggle">
      <div class="toggle-left">
        <span class="arrow" id="logArrow">&#9654;</span>
        <span>LIVE SCAN LOG</span>
        <span class="log-badge log-badge-info" id="logCount">0</span>
        <span class="log-badge log-badge-success" id="logSuccessCount">0</span>
        <span class="log-badge log-badge-error" id="logErrorCount">0</span>
      </div>
      <div class="log-filters" id="logFilters">
        <button class="log-filter-btn active" data-filter="all">All</button>
        <button class="log-filter-btn" data-filter="fetch-poly">Poly</button>
        <button class="log-filter-btn" data-filter="fetch-kalshi">Kalshi</button>
        <button class="log-filter-btn" data-filter="normalize">Norm</button>
        <button class="log-filter-btn" data-filter="match">Match</button>
        <button class="log-filter-btn" data-filter="arb">Arb</button>
        <button class="log-filter-btn" data-filter="cycle">Cycle</button>
      </div>
    </button>
    <div class="log-body" id="logBody">
      <div id="logEntries"></div>
    </div>
  </div>

<script>
const $ = (id) => document.getElementById(id);

function fmt$(n) { return '$' + n.toFixed(2); }
function fmtPct(n) { return n.toFixed(1) + '%'; }
function fmtProfit(cents, pct) {
  const sign = cents >= 0 ? '+' : '';
  return sign + Math.round(cents * 100) + String.fromCharCode(162) + ' (' + fmtPct(pct) + ')';
}
function profitClass(pct) {
  if (pct > 5) return 'profit-positive-high';
  if (pct >= 1) return 'profit-positive';
  if (pct >= 0.8) return 'profit-marginal';
  return 'profit-negative';
}
function matchClass(score) {
  if (score >= 0.85) return 'match-high';
  if (score >= 0.75) return 'match-mid';
  return 'match-low';
}
function fmtTime(hours) {
  if (hours < 24) return hours.toFixed(1) + 'h';
  return Math.round(hours / 24) + 'd';
}
function fmtClock(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour12: false });
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// ─── Opportunities table with persistent tracking + sorting ───
let currentSort = 'profit';
let lastData = null;

function sortOpps(opps, sortKey) {
  const sorted = [...opps];
  switch (sortKey) {
    case 'profit':
      sorted.sort((a, b) => b.profitPctDisplay - a.profitPctDisplay);
      break;
    case 'expiry':
      sorted.sort((a, b) => a.timeToClose - b.timeToClose);
      break;
    case 'firstSeen':
      sorted.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());
      break;
    case 'match':
      sorted.sort((a, b) => b.matchScore - a.matchScore);
      break;
    case 'maxProfit':
      sorted.sort((a, b) => b.estimatedMaxProfit - a.estimatedMaxProfit);
      break;
  }
  return sorted;
}

function fmtAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm ago';
}

function renderOpps(opps) {
  const tbody = $('tbody');
  const empty = $('emptyState');

  if (opps.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const sorted = sortOpps(opps, currentSort);

  let html = '';
  for (const o of sorted) {
    const mc = matchClass(o.matchScore);
    const pc = profitClass(o.profitPctDisplay);
    const rowClass = o.live ? '' : ' class="opp-stale"';
    const dotClass = o.live ? 'live' : 'stale';
    const dotTitle = o.live ? 'Live (' + o.consecutiveCycles + ' cycles)' : 'Stale (last seen ' + fmtAgo(o.lastSeenAt) + ')';
    const peakStr = o.peakProfitPct > o.profitPctDisplay + 0.1 ? '<span class="peak-badge">peak: +' + fmtPct(o.peakProfitPct) + '</span>' : '';

    html += '<tr' + rowClass + '>' +
      '<td><span class="live-dot ' + dotClass + '" title="' + dotTitle + '"></span></td>' +
      '<td class="event-name" title="' + o.event.replace(/"/g, '&quot;') + '">' +
        o.event.slice(0, 50) +
        '<span class="first-seen">Found ' + fmtAgo(o.firstSeenAt) + '</span>' +
      '</td>' +
      '<td><span class="trade-badge">P:' + o.polymarketSide + ' + K:' + o.kalshiSide + '</span></td>' +
      '<td class="price">' + fmt$(o.polymarketAsk) + '</td>' +
      '<td class="price">' + fmt$(o.kalshiAsk) + '</td>' +
      '<td class="price">' + fmt$(o.combinedCost) + '</td>' +
      '<td class="' + pc + '">' + fmtProfit(o.profitPerContractDisplay, o.profitPctDisplay) + peakStr + '</td>' +
      '<td><span class="match-score ' + mc + '">' + Math.round(o.matchScore * 100) + '%</span></td>' +
      '<td>' + fmtTime(o.timeToClose) + '</td>' +
      '<td>' + fmt$(o.estimatedMaxProfit) + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

function updateState(data) {
  $('lastScan').textContent = fmtClock(new Date());
  $('matchedPairs').textContent = data.matchedPairs.toLocaleString();
  $('polyCount').textContent = data.polymarketCount.toLocaleString();
  // Red alarm when Kalshi count is zero after first cycle
  const kalshiEl = $('kalshiCount');
  if (data.totalCycles > 0 && data.kalshiCount === 0) {
    kalshiEl.style.color = 'var(--red)';
    kalshiEl.style.fontWeight = '700';
    kalshiEl.textContent = data.kalshiCount + ' [!]';
  } else {
    kalshiEl.style.color = '';
    kalshiEl.style.fontWeight = '';
    kalshiEl.textContent = data.kalshiCount.toLocaleString();
  }
  $('scanPhase').textContent = data.scanPhase;
  $('progressFill').style.width = Math.round(data.scanProgress * 100) + '%';
  $('cycle').textContent = data.totalCycles;
  $('totalOpps').textContent = data.totalOpportunities;
  $('sessionTime').textContent = fmtDuration(Date.now() - new Date(data.startedAt).getTime());

  if (data.demoMode) $('demoBadge').style.display = 'inline';

  const ps = $('polyStale');
  const ks = $('kalshiStale');
  ps.textContent = data.polyStaleSeconds > 10 ? '[POLY STALE ' + Math.round(data.polyStaleSeconds) + 's]' : '';
  ps.className = data.polyStaleSeconds > 10 ? 'stale' : '';
  ks.textContent = data.kalshiStaleSeconds > 10 ? '[KALSHI STALE ' + Math.round(data.kalshiStaleSeconds) + 's]' : '';
  ks.className = data.kalshiStaleSeconds > 10 ? 'stale' : '';

  if (data.bestProfitPct !== null) {
    $('bestOpp').innerHTML = 'Best: <span class="best">+' + fmtPct(data.bestProfitPct) + '</span> on ' + (data.bestEvent || '').slice(0, 40);
  }

  const opps = data.opportunities || [];
  lastData = opps;

  // Update counts
  const liveCount = opps.filter(o => o.live).length;
  const staleCount = opps.filter(o => !o.live).length;
  $('liveCount').textContent = liveCount;
  $('staleCount').textContent = staleCount;
  $('allOppCount').textContent = opps.length;

  renderOpps(opps);
}

// Sort button handlers
document.querySelector('.sort-controls').addEventListener('click', (e) => {
  const btn = e.target.closest('.sort-btn');
  if (!btn) return;
  currentSort = btn.dataset.sort;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === currentSort));
  if (lastData) renderOpps(lastData);
});

// ─── Scan Log ───
const MAX_LOG_ENTRIES = 1000;
const logEntries = [];
let logOpen = false;
let activeFilter = 'all';
let totalCount = 0;
let successCount = 0;
let errorCount = 0;
let autoScroll = true;

const catLabel = {
  'fetch-poly': 'POLY',
  'fetch-kalshi': 'KALSHI',
  'normalize': 'NORM',
  'match': 'MATCH',
  'arb': 'ARB',
  'cycle': 'CYCLE',
  'system': 'SYSTEM',
};

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderLogEntry(entry) {
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 1 }) : '';
  const catCls = 'cat-' + (entry.cat || 'system');
  const label = catLabel[entry.cat] || entry.cat || '?';
  const detail = entry.detail ? '<span class="log-detail" title="' + esc(entry.detail) + '">' + esc(entry.detail) + '</span>' : '';
  return '<div class="log-entry level-' + (entry.level || 'info') + '" data-cat="' + (entry.cat || '') + '">'
    + '<span class="log-ts">' + ts + '</span>'
    + '<span class="log-cat ' + catCls + '">' + label + '</span>'
    + '<span class="log-msg">' + esc(entry.msg || '') + '</span>'
    + detail
    + '</div>';
}

function addLogEntry(entry) {
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();

  totalCount++;
  if (entry.level === 'success') successCount++;
  if (entry.level === 'error' || entry.level === 'warn') errorCount++;

  $('logCount').textContent = totalCount;
  $('logSuccessCount').textContent = successCount;
  $('logErrorCount').textContent = errorCount;

  if (!logOpen) return;

  // Check if entry passes current filter
  if (activeFilter !== 'all' && entry.cat !== activeFilter) return;

  const container = $('logEntries');
  const body = $('logBody');
  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

  container.insertAdjacentHTML('beforeend', renderLogEntry(entry));

  // Trim rendered DOM if too many
  while (container.children.length > MAX_LOG_ENTRIES) {
    container.removeChild(container.firstChild);
  }

  // Auto-scroll if user was at bottom
  if (wasAtBottom && autoScroll) {
    body.scrollTop = body.scrollHeight;
  }
}

function rebuildLog() {
  const container = $('logEntries');
  const filtered = activeFilter === 'all'
    ? logEntries
    : logEntries.filter(e => e.cat === activeFilter);

  container.innerHTML = filtered.map(renderLogEntry).join('');

  if (autoScroll) {
    const body = $('logBody');
    body.scrollTop = body.scrollHeight;
  }
}

// Toggle panel
$('logToggle').addEventListener('click', (e) => {
  // Don't toggle if clicking a filter button
  if (e.target.closest('.log-filter-btn')) return;

  logOpen = !logOpen;
  $('logBody').classList.toggle('open', logOpen);
  $('logArrow').classList.toggle('open', logOpen);

  if (logOpen) rebuildLog();
});

// Filter buttons
$('logFilters').addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = e.target.closest('.log-filter-btn');
  if (!btn) return;

  activeFilter = btn.dataset.filter;

  // Update active state
  $('logFilters').querySelectorAll('.log-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === activeFilter);
  });

  if (logOpen) rebuildLog();
});

// ─── SSE connection with auto-reconnect ───
function connect() {
  const es = new EventSource('/api/events');
  $('dot').style.background = 'var(--green)';

  es.addEventListener('state', (e) => {
    try { updateState(JSON.parse(e.data)); } catch {}
  });

  es.addEventListener('log', (e) => {
    try { addLogEntry(JSON.parse(e.data)); } catch {}
  });

  es.onerror = () => {
    $('dot').style.background = 'var(--red)';
    es.close();
    setTimeout(connect, 2000);
  };
}
connect();
</script>
</body>
</html>`;

