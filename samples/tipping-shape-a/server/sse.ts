import type express from 'express'

const KEEPALIVE_MS = 15_000

/**
 * Server-sent events to the creator page. Headers go out at once (flushHeaders), and a comment line every 15 s
 * keeps proxies from closing an idle stream. X-Accel-Buffering: no tells nginx not to buffer it.
 */
export class Broadcaster {
  private readonly clients = new Set<express.Response>()

  add(res: express.Response): void {
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
    })
  }

  emit(event: 'tip' | 'status', data: object): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) this.write(res, message)
  }

  private write(res: express.Response, chunk: string): void {
    if (!res.writableEnded && !res.destroyed) res.write(chunk)
  }
}
