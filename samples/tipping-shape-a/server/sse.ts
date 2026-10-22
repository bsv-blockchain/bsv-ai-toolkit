import type express from 'express'

const KEEPALIVE_MS = 15_000
const MAX_CLIENTS = 200
// So one client (by addressKey) cannot take every slot.
const MAX_PER_ADDRESS = 4
// A client this far behind is not reading; drop it (EventSource reconnects) rather than buffer without limit.
const MAX_BUFFERED_BYTES = 64 * 1024

export interface BroadcasterOptions {
  maxClients?: number
  maxPerAddress?: number
  maxBufferedBytes?: number
}

/**
 * Server-sent events to the creator page. Headers go out at once (flushHeaders), and a comment line every 15 s
 * keeps proxies from closing an idle stream. X-Accel-Buffering: no tells nginx not to buffer it.
 */
export class Broadcaster {
  private readonly clients = new Set<express.Response>()
  private readonly perAddress = new Map<string, number>()
  private readonly maxClients: number
  private readonly maxPerAddress: number
  private readonly maxBufferedBytes: number

  constructor(opts: BroadcasterOptions = {}) {
    this.maxClients = opts.maxClients ?? MAX_CLIENTS
    this.maxPerAddress = opts.maxPerAddress ?? MAX_PER_ADDRESS
    this.maxBufferedBytes = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES
  }

  get size(): number {
    return this.clients.size
  }

  /**
   * Opens an event stream on `res` for a client at `address` (its rate-limit key), or answers 503 when the relay
   * already serves maxClients streams, or 429 when that address already holds maxPerAddress of them.
   */
  add(res: express.Response, address = 'unknown'): void {
    if (this.clients.size >= this.maxClients) {
      res.status(503).set('Retry-After', '30').json({ error: 'too many event streams; retry later' })
      return
    }
    const held = this.perAddress.get(address) ?? 0
    if (held >= this.maxPerAddress) {
      res.status(429).set('Retry-After', '30').json({ error: 'too many event streams from this address' })
      return
    }
    this.perAddress.set(address, held + 1)
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    this.clients.add(res)
    const timer = setInterval(() => this.write(res, ': keepalive\n\n'), KEEPALIVE_MS)
    res.on('close', () => {
      clearInterval(timer)
      this.clients.delete(res)
      const left = (this.perAddress.get(address) ?? 1) - 1
      if (left > 0) this.perAddress.set(address, left)
      else this.perAddress.delete(address)
    })
  }

  emit(event: 'tip' | 'status', data: object): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) this.write(res, message)
  }

  private write(res: express.Response, chunk: string): void {
    if (res.writableEnded || res.destroyed) return
    if (res.writableLength >= this.maxBufferedBytes) {
      this.clients.delete(res)
      res.destroy()
      return
    }
    res.write(chunk)
  }
}
