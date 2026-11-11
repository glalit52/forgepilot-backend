/**
 * Fixed-window rate limiter held in process memory. Good for a single API
 * instance; behind several instances each one enforces its own window, so
 * move the counter to Redis (same interface) before relying on exact limits.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private lastSweep = Date.now();

  constructor(private windowMs = 60_000) {}

  /** Returns remaining requests, or -1 when the caller is over the limit. */
  take(
    key: string,
    limit: number,
    now = Date.now(),
  ): { ok: boolean; remaining: number; resetMs: number } {
    if (now - this.lastSweep > this.windowMs) this.sweep(now);
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return {
      ok: w.count <= limit,
      remaining: Math.max(0, limit - w.count),
      resetMs: w.start + this.windowMs - now,
    };
  }

  private sweep(now: number) {
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
