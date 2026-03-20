import { appendFileSync } from "node:fs";
import { join } from "node:path";

const ERROR_LOG = join(process.cwd(), "errors.log");
const OPP_LOG = join(process.cwd(), "opportunities.jsonl");
const METRICS_LOG = join(process.cwd(), "metrics.log");

export function appendError(message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    appendFileSync(ERROR_LOG, line);
  } catch {
    // Never let logging crash the poll loop
  }
}

export function appendOpportunity(data: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() }) + "\n";
    appendFileSync(OPP_LOG, line);
  } catch {
    // Never let logging crash the poll loop
  }
}

/** One JSON line per cycle; safe to tail for p50/p95 tuning. */
export function appendMetricLine(data: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() }) + "\n";
    appendFileSync(METRICS_LOG, line);
  } catch {
    // Never let logging crash the poll loop
  }
}
