export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /** Adjust rate at runtime (e.g. adaptive backoff). */
  setRefillRate(tokensPerSecond: number): void {
    this.refill();
    this.refillRate = Math.max(0.05, tokensPerSecond);
  }

  setMaxTokens(n: number): void {
    this.refill();
    this.maxTokens = Math.max(1, n);
    this.tokens = Math.min(this.tokens, this.maxTokens);
  }

  get rate(): number {
    return this.refillRate;
  }

  get capacity(): number {
    return this.maxTokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    this.refill();
    this.tokens -= 1;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Wraps a TokenBucket: gently increase RPS after sustained success, decay on 429.
 * Callers still await acquire() once per HTTP request (concurrency 1 per host).
 */
export class AdaptiveRateLimiter {
  private successStreak = 0;
  private currentRps: number;
  private readonly minRps: number;
  private readonly maxRps: number;

  constructor(
    private readonly bucket: TokenBucket,
    minRps: number,
    maxRps: number,
    private readonly successBeforeBump: number,
    private readonly bumpRps: number,
    private readonly decayOn429: number,
  ) {
    this.minRps = minRps;
    this.maxRps = maxRps;
    this.currentRps = minRps;
    this.bucket.setMaxTokens(Math.max(1, Math.ceil(minRps)));
    this.bucket.setRefillRate(minRps);
  }

  async acquire(): Promise<void> {
    return this.bucket.acquire();
  }

  recordSuccess(): void {
    this.successStreak++;
    if (this.successStreak >= this.successBeforeBump) {
      this.successStreak = 0;
      this.currentRps = Math.min(this.maxRps, this.currentRps + this.bumpRps);
      this.bucket.setRefillRate(this.currentRps);
      this.bucket.setMaxTokens(Math.max(1, Math.ceil(this.currentRps)));
    }
  }

  record429(): void {
    this.successStreak = 0;
    this.currentRps = Math.max(this.minRps, this.currentRps - this.decayOn429);
    this.bucket.setRefillRate(this.currentRps);
    this.bucket.setMaxTokens(Math.max(1, Math.ceil(this.currentRps)));
  }

  get effectiveRps(): number {
    return this.currentRps;
  }
}
