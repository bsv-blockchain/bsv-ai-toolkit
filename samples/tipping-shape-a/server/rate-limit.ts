// An in-memory token bucket per client address: `burst` requests at once, refilled at `perMinute`.
// One relay process, so memory is the right place; a restart forgets every bucket, which is harmless.

const SWEEP_ABOVE = 10_000

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(
    private readonly burst: number,
    private readonly perMinute: number,
  ) {}

  /** Takes one token for `key` at time `now` (ms); false when the bucket is empty. */
  take(key: string, now: number): boolean {
    if (this.buckets.size > SWEEP_ABOVE) this.sweep(now)
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) * this.perMinute) / 60_000)
    b.at = now
    const ok = b.tokens >= 1
    if (ok) b.tokens -= 1
    this.buckets.set(key, b)
    return ok
  }

  /** Seconds until `key` has a token again. */
  retryAfter(key: string): number {
    const b = this.buckets.get(key)
    return b === undefined ? 0 : Math.ceil(((1 - b.tokens) * 60) / this.perMinute)
  }

  // Forget buckets that have refilled: they behave exactly like a new one.
  private sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) * this.perMinute) / 60_000 >= this.burst) this.buckets.delete(key)
    }
  }
}
