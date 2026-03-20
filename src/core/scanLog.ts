/**
 * Global scan activity log. Every module pushes structured entries here.
 * The web server streams them to the dashboard in real time via SSE.
 */

export type ScanLogLevel = "info" | "warn" | "error" | "success" | "debug";

export type ScanLogCategory =
  | "fetch-poly"
  | "fetch-kalshi"
  | "normalize"
  | "match"
  | "arb"
  | "cycle"
  | "system";

export interface ScanLogEntry {
  ts: string;
  level: ScanLogLevel;
  cat: ScanLogCategory;
  msg: string;
  detail?: string;
}

type Listener = (entry: ScanLogEntry) => void;

const listeners: Listener[] = [];

/** Max entries kept in memory for late-joining web clients. */
const MAX_BUFFER = 500;
const buffer: ScanLogEntry[] = [];

export function onScanLog(fn: Listener): void {
  listeners.push(fn);
}

export function getScanLogBuffer(): ScanLogEntry[] {
  return buffer;
}

export function clearScanLog(): void {
  buffer.length = 0;
}

function emit(entry: ScanLogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  for (const fn of listeners) {
    try { fn(entry); } catch { /* never crash */ }
  }
}

export function scanLog(
  level: ScanLogLevel,
  cat: ScanLogCategory,
  msg: string,
  detail?: string,
): void {
  emit({
    ts: new Date().toISOString(),
    level,
    cat,
    msg,
    detail,
  });
}
