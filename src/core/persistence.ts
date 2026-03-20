import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), "arb-screener.db");

let db: Database.Database;

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      polymarket_side TEXT NOT NULL,
      kalshi_side TEXT NOT NULL,
      polymarket_ask REAL NOT NULL,
      kalshi_ask REAL NOT NULL,
      combined_cost REAL NOT NULL,
      profit_pct_gross REAL NOT NULL,
      profit_pct_after_fees REAL NOT NULL,
      estimated_fees REAL NOT NULL,
      match_score REAL NOT NULL,
      max_contracts INTEGER NOT NULL DEFAULT 0,
      estimated_max_profit REAL NOT NULL DEFAULT 0,
      time_to_close_hours REAL NOT NULL DEFAULT 0,
      poly_stale_seconds REAL NOT NULL DEFAULT 0,
      kalshi_stale_seconds REAL NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      total_cycles INTEGER NOT NULL DEFAULT 0,
      total_opportunities INTEGER NOT NULL DEFAULT 0,
      best_profit_pct REAL,
      best_event TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_opp_detected_at ON opportunities(detected_at);
    CREATE INDEX IF NOT EXISTS idx_opp_profit ON opportunities(profit_pct_gross);
  `);
}

const insertOppStmt = () => db.prepare(`
  INSERT INTO opportunities (
    event, polymarket_side, kalshi_side, polymarket_ask, kalshi_ask,
    combined_cost, profit_pct_gross, profit_pct_after_fees, estimated_fees,
    match_score, max_contracts, estimated_max_profit, time_to_close_hours,
    poly_stale_seconds, kalshi_stale_seconds, detected_at
  ) VALUES (
    @event, @polymarketSide, @kalshiSide, @polymarketAsk, @kalshiAsk,
    @combinedCost, @profitPctGross, @profitPctAfterFees, @estimatedFees,
    @matchScore, @maxContracts, @estimatedMaxProfit, @timeToCloseHours,
    @polyStaleSeconds, @kalshiStaleSeconds, @detectedAt
  )
`);

let _insertOpp: Database.Statement | null = null;

export function persistOpportunity(data: {
  event: string;
  polymarketSide: string;
  kalshiSide: string;
  polymarketAsk: number;
  kalshiAsk: number;
  combinedCost: number;
  profitPctGross: number;
  profitPctAfterFees: number;
  estimatedFees: number;
  matchScore: number;
  maxContracts: number;
  estimatedMaxProfit: number;
  timeToCloseHours: number;
  polyStaleSeconds: number;
  kalshiStaleSeconds: number;
}): void {
  try {
    if (!_insertOpp) _insertOpp = insertOppStmt();
    _insertOpp.run({ ...data, detectedAt: new Date().toISOString() });
  } catch {
    // Never crash the poll loop
  }
}

let _sessionId: number | null = null;

export function startSession(): number {
  const result = db.prepare(
    `INSERT INTO sessions (started_at) VALUES (@startedAt)`
  ).run({ startedAt: new Date().toISOString() });
  _sessionId = Number(result.lastInsertRowid);
  return _sessionId;
}

export function updateSession(stats: {
  totalCycles: number;
  totalOpportunities: number;
  bestProfitPct: number | null;
  bestEvent: string | null;
}): void {
  if (_sessionId === null) return;
  try {
    db.prepare(`
      UPDATE sessions SET
        total_cycles = @totalCycles,
        total_opportunities = @totalOpportunities,
        best_profit_pct = @bestProfitPct,
        best_event = @bestEvent
      WHERE id = @id
    `).run({ ...stats, id: _sessionId });
  } catch {
    // ignore
  }
}

export function endSession(): void {
  if (_sessionId === null) return;
  try {
    db.prepare(`UPDATE sessions SET ended_at = @endedAt WHERE id = @id`).run({
      endedAt: new Date().toISOString(),
      id: _sessionId,
    });
  } catch {
    // ignore
  }
}

export interface HistoricalStats {
  totalSessions: number;
  totalOpportunitiesAllTime: number;
  bestProfitPctAllTime: number | null;
  bestEventAllTime: string | null;
  last24hOpportunities: number;
}

export function getHistoricalStats(): HistoricalStats {
  try {
    const sessRow = db.prepare(`
      SELECT COUNT(*) as cnt, SUM(total_opportunities) as total_opps,
             MAX(best_profit_pct) as best_pct
      FROM sessions
    `).get() as { cnt: number; total_opps: number | null; best_pct: number | null };

    const bestRow = db.prepare(`
      SELECT best_event FROM sessions WHERE best_profit_pct = (SELECT MAX(best_profit_pct) FROM sessions)
    `).get() as { best_event: string | null } | undefined;

    const recentRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM opportunities WHERE detected_at > datetime('now', '-1 day')
    `).get() as { cnt: number };

    return {
      totalSessions: sessRow.cnt,
      totalOpportunitiesAllTime: sessRow.total_opps ?? 0,
      bestProfitPctAllTime: sessRow.best_pct,
      bestEventAllTime: bestRow?.best_event ?? null,
      last24hOpportunities: recentRow.cnt,
    };
  } catch {
    return {
      totalSessions: 0,
      totalOpportunitiesAllTime: 0,
      bestProfitPctAllTime: null,
      bestEventAllTime: null,
      last24hOpportunities: 0,
    };
  }
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    // ignore
  }
}
