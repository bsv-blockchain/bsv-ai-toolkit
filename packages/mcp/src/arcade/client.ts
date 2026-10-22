import type { TransactionStatus } from '../types.js'
import { classify400, verdictOf } from './classify.js'

export interface ArcadeClientOptions {
  baseUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

type NotFound = { notFound: true }

function parseBody(text: string): any {
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

// Minimal Arcade client: POST /tx, GET /tx/{txid}, GET /policy, GET /health.
// Every request carries AbortSignal.timeout(timeoutMs). A 2xx from POST /tx is provisional; callers re-read status.
export class ArcadeClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: ArcadeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 10000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
  }

  private async getJson(path: string): Promise<any> {
    const res = await this.request(path)
    const text = await res.text()
    if (!res.ok) throw new Error(`Arcade GET ${path} answered ${res.status}: ${text.slice(0, 200)}`)
    return parseBody(text)
  }

  // Never throws on HTTP errors. Network error or timeout → UNREACHABLE (transient).
  async submit(hex: string, h: { callbackUrl?: string; callbackToken?: string; fullStatusUpdates?: boolean } = {}): Promise<{ postStatus: number; body: any; transient: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
    if (h.callbackUrl !== undefined) headers['X-CallbackUrl'] = h.callbackUrl
    if (h.callbackToken !== undefined) headers['X-CallbackToken'] = h.callbackToken
    if (h.fullStatusUpdates !== undefined) headers['X-FullStatusUpdates'] = h.fullStatusUpdates ? 'true' : 'false'
    let postStatus: number
    let body: any
    try {
      const res = await this.request('/tx', { method: 'POST', headers, body: hex.trim() })
      postStatus = res.status
      body = parseBody(await res.text())
    } catch {
      return { postStatus: 0, body: { error: 'UNREACHABLE' }, transient: true }
    }
    // 503 is backpressure (nothing queued); other 5xx and 429 are safe to retry because submission is idempotent.
    const transient =
      postStatus === 429 || postStatus >= 500 || (postStatus >= 400 && postStatus < 500 && classify400(body).kind === 'transient-476')
    return { postStatus, body, transient }
  }

  async status(txid: string, callbackToken?: string): Promise<TransactionStatus | NotFound> {
    const query = callbackToken === undefined ? '' : `?callbackToken=${encodeURIComponent(callbackToken)}`
    const path = `/tx/${encodeURIComponent(txid)}${query}`
    const res = await this.request(path)
    const text = await res.text()
    if (res.status === 404) return { notFound: true }
    if (!res.ok) throw new Error(`Arcade GET /tx/${txid} answered ${res.status}: ${text.slice(0, 200)}`)
    return parseBody(text) as TransactionStatus
  }

  async policy(): Promise<{ policy: any; timestamp: string; satPerKb: number }> {
    const json = await this.getJson('/policy')
    const { satoshis, bytes } = json.policy.miningFee
    return { policy: json.policy, timestamp: json.timestamp, satPerKb: (satoshis * 1000) / bytes }
  }

  health(): Promise<any> {
    return this.getJson('/health')
  }

  // Polls GET /tx/{txid} until the verdict is seen-no-competitor or terminal, or until timeoutMs elapses,
  // then returns the last status read. No poll starts after the deadline, so the wall time is bounded by
  // timeoutMs plus one request timeout. A failed poll is skipped; if every poll failed, the last error is thrown.
  async waitForSeen(txid: string, timeoutMs: number, intervalMs = 1000): Promise<TransactionStatus | NotFound> {
    const deadline = Date.now() + timeoutMs
    let last: TransactionStatus | NotFound | undefined
    let lastError: unknown
    for (;;) {
      try {
        last = await this.status(txid)
      } catch (e) {
        lastError = e
      }
      if (last && !('notFound' in last)) {
        const v = verdictOf(last)
        if (v === 'seen-no-competitor' || v === 'terminal') return last
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)))
    }
    if (last) return last
    throw lastError
  }
}
