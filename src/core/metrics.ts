/**
 * Lightweight per-cycle metrics + rolling latency summaries for tuning.
 */

export interface CyclePhaseMetrics {
  cycle: number;
  discovery: boolean;
  poly_fetch_ms: number;
  kalshi_fetch_ms: number;
  normalize_ms: number;
  match_ms: number;
  arb_ms: number;
  render_ms: number;
  poly_http_429: number;
  kalshi_http_429: number;
  poly_bytes_in: number;
  kalshi_bytes_in: number;
  cycle_total_ms: number;
  /** Kalshi token-bucket effective RPS after adaptive adjustment (if used). */
  kalshi_bucket_rps?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.round((p / 100) * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))] ?? 0;
}

export class RollingCycleLatency {
  private readonly samples: number[] = [];
  constructor(private readonly maxSamples: number) {}

  push(totalMs: number): void {
    this.samples.push(totalMs);
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }

  summary(): { n: number; p50_ms: number; p95_ms: number } {
    const n = this.samples.length;
    if (n === 0) return { n: 0, p50_ms: 0, p95_ms: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      n,
      p50_ms: Math.round(percentile(sorted, 50)),
      p95_ms: Math.round(percentile(sorted, 95)),
    };
  }
}
