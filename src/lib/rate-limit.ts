export interface RateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  lockedUntil?: number;
}

/**
 * In-memory login limiter keyed by client IP (single-instance deployment).
 * 5 failures within 15 minutes lock the key for 15 minutes; a success clears it.
 */
export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.lockMs = opts.lockMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Seconds until the key is unlocked, or 0 when requests are allowed. */
  retryAfter(key: string): number {
    const e = this.entries.get(key);
    if (!e?.lockedUntil) return 0;
    const left = e.lockedUntil - this.now();
    if (left <= 0) {
      this.entries.delete(key);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  recordFailure(key: string): void {
    const t = this.now();
    const e = this.entries.get(key) ?? { failures: [] };
    e.failures = e.failures.filter((f) => t - f < this.windowMs);
    e.failures.push(t);
    if (e.failures.length >= this.maxFailures) e.lockedUntil = t + this.lockMs;
    this.entries.set(key, e);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired entries; called periodically. */
  sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) {
      const locked = e.lockedUntil !== undefined && e.lockedUntil > t;
      const recent = e.failures.some((f) => t - f < this.windowMs);
      if (!locked && !recent) this.entries.delete(k);
    }
  }

  /** Start a background sweep that does not keep the process alive. */
  startSweeper(intervalMs = 5 * 60_000): () => void {
    const timer = setInterval(() => this.sweep(), intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  get size(): number {
    return this.entries.size;
  }
}
