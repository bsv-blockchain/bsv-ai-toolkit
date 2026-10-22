import { isIPv4, isIPv6 } from 'node:net'

// An in-memory token bucket per client address: `burst` requests at once, refilled at `perMinute`.
// One relay process, so memory is the right place; a restart forgets every bucket, which is harmless.

/**
 * The key a client is limited by: an IPv4 address as is (also when IPv4-mapped in IPv6), and an IPv6 address by
 * its /64 prefix, since one subscriber usually holds a whole /64 and could rotate through it.
 */
export function addressKey(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown'
  const bare = ip.replace(/%.*$/, '') // drop an IPv6 zone id
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)
  if (mapped && isIPv4(mapped[1])) return mapped[1]
  if (isIPv4(bare) || !isIPv6(bare)) return bare
  return `${ipv6Groups(bare).slice(0, 4).join(':')}::/64`
}

// The eight 16-bit groups of a valid IPv6 address, lowercase without leading zeros.
function ipv6Groups(ip: string): string[] {
  let text = ip
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number)
    text = text.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map(g => parseInt(g, 16).toString(16))
}

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
