// A minimal Arcade client for the relay: POST /tx (EF hex) and GET /tx/{txid}. The rules mirror @bsv/mcp's
// arcade client and arcade_submit tool (copied, not imported, so this folder stands alone):
// - a 2xx (or "already known") from POST /tx is provisional; the verdict comes from re-reading GET /tx/{txid}
// - final for the app = SEEN_ON_NETWORK or later with no competing tx; never wait for MINED
// - only HTTP 400/422 or an ARC code 460-476 is a verdict on the transaction; any other 4xx is about the request
// - a REJECTED that blames a parent or the inputs keeps the verdict 'terminal' but may not be final
// Every request carries AbortSignal.timeout.

export type Verdict = 'seen-no-competitor' | 'on-network-not-seen' | 'pending' | 'terminal' | 'no-verdict'

export interface ArcadeStatus {
  txid?: string
  txStatus: string
  competingTxs?: string[]
  extraInfo?: string
  status?: number
  [k: string]: unknown
}

/** What the relay stores for a tip after talking to Arcade. `transient`: nothing reached Arcade; retrying is safe. */
export interface Outcome {
  txStatus: string
  verdict: Verdict
  competingTxs: string[]
  extraInfo?: string
  note?: string
  transient: boolean
}

const SEEN = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED', 'STUMP_PROCESSING', 'IMMUTABLE'])
const TERMINAL = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'])
const ON_NETWORK_NOT_SEEN = new Set(['RECEIVED', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK'])
const NON_FINAL = new Set(['UNKNOWN', 'PENDING_RETRY'])

export function verdictOf(s: { txStatus: string; competingTxs?: string[] }): Verdict {
  if (TERMINAL.has(s.txStatus)) return 'terminal'
  if ((s.competingTxs ?? []).length > 0) return 'pending'
  if (SEEN.has(s.txStatus)) return 'seen-no-competitor'
  if (ON_NETWORK_NOT_SEEN.has(s.txStatus)) return 'on-network-not-seen'
  if (NON_FINAL.has(s.txStatus)) return 'pending'
  return 'no-verdict' // a txStatus outside the documented twelve
}

export const REJECTED_MAY_NOT_BE_FINAL = 'may not be final for a tx the network already accepted; re-read status'
const ALREADY_KNOWN = /(?<![\w-])(TX_EXISTS|txn-already-known)(?![\w-])/

function rejectedMayNotBeFinal(txStatus: string, extraInfo: unknown): boolean {
  if (txStatus !== 'REJECTED' || typeof extraInfo !== 'string') return false
  return /^\s*parent rejected/i.test(extraInfo) || /missingorspent|utxo_spent|already spent/i.test(extraInfo)
}

// The error strings an Arcade/ARC error body may carry, most specific first.
function errorTexts(body: any): string[] {
  return [body?.extraInfo, body?.reason, body?.detail, body?.error, body?.title].filter((v): v is string => typeof v === 'string' && v !== '')
}

function parseBody(text: string): any {
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

function outcome(s: ArcadeStatus, note?: string): Outcome {
  const o: Outcome = { txStatus: s.txStatus, verdict: verdictOf(s), competingTxs: s.competingTxs ?? [], transient: false }
  if (typeof s.extraInfo === 'string' && s.extraInfo !== '') o.extraInfo = s.extraInfo
  const n = note ?? (rejectedMayNotBeFinal(s.txStatus, s.extraInfo) ? REJECTED_MAY_NOT_BE_FINAL : undefined)
  if (n !== undefined) o.note = n
  return o
}

export class Arcade {
  readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 10000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
  }

  /** POST /tx with EF (or raw) hex as text/plain. Never throws on an HTTP error; no answer → postStatus 0, transient. */
  async submit(hex: string): Promise<{ postStatus: number; body: any; transient: boolean }> {
    const tx = hex.trim()
    if (/^(0100beef|0200beef|01010101)/i.test(tx)) throw new Error('Arcade POST /tx takes EF or raw hex, never BEEF')
    let postStatus: number
    let body: any
    try {
      const res = await this.request('/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: tx })
      postStatus = res.status
      body = parseBody(await res.text())
    } catch {
      return { postStatus: 0, body: { error: 'UNREACHABLE' }, transient: true }
    }
    // 429 and 5xx are safe to retry (submission is idempotent); ARC 476 is a locktime that is not final yet.
    const transient = postStatus === 429 || postStatus >= 500 || (postStatus >= 400 && postStatus < 500 && body?.status === 476)
    return { postStatus, body, transient }
  }

  /** GET /tx/{txid}. 404 → { notFound: true } (this Arcade was never given the txid); other errors throw. */
  async status(txid: string): Promise<ArcadeStatus | { notFound: true }> {
    const res = await this.request(`/tx/${encodeURIComponent(txid)}`)
    const text = await res.text()
    if (res.status === 404) return { notFound: true }
    if (!res.ok) throw new Error(`Arcade GET /tx/${txid} answered ${res.status}: ${text.slice(0, 200)}`)
    const s = parseBody(text)
    if (typeof s?.txStatus !== 'string') throw new Error(`Arcade GET /tx/${txid} answered without a txStatus`)
    return s as ArcadeStatus
  }

  /** Polls status until seen-no-competitor or terminal, or until timeoutMs; returns the last read. */
  async waitForSeen(txid: string, timeoutMs: number, intervalMs = 1000): Promise<ArcadeStatus | { notFound: true }> {
    const deadline = Date.now() + timeoutMs
    let last: ArcadeStatus | { notFound: true } | undefined
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
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)))
    }
    if (last) return last
    throw lastError
  }

  /** Submits EF hex and decides from GET /tx/{txid} (polled up to waitMs). Never throws for Arcade's answers. */
  async broadcast(efHex: string, txid: string, waitMs: number): Promise<Outcome> {
    const { postStatus, body, transient } = await this.submit(efHex)
    const pending = (txStatus: string, note?: string, isTransient = false): Outcome => {
      const o: Outcome = { txStatus, verdict: 'pending', competingTxs: [], transient: isTransient }
      const info = errorTexts(body)[0]
      if (info !== undefined && postStatus !== 0) o.extraInfo = info
      if (note !== undefined) o.note = note
      return o
    }
    const is2xx = postStatus >= 200 && postStatus < 300
    if (postStatus >= 400 && postStatus < 500 && postStatus !== 429) {
      const arcCode = typeof body?.status === 'number' ? body.status : undefined
      const validation = postStatus === 400 || postStatus === 422 || (arcCode !== undefined && arcCode >= 460 && arcCode <= 476)
      if (!validation) return pending('UNKNOWN', `Arcade answered HTTP ${postStatus}: check ARCADE_URL; this is not a transaction verdict`)
      if (arcCode === 476) return pending('UNKNOWN', 'locktime not final yet (ARC 476); retry later', true)
      if (!errorTexts(body).some(t => ALREADY_KNOWN.test(t))) {
        const blames = errorTexts(body).some(t => rejectedMayNotBeFinal('REJECTED', t))
        return outcome({ txStatus: 'REJECTED', extraInfo: errorTexts(body)[0] }, blames ? REJECTED_MAY_NOT_BE_FINAL : undefined)
      }
      // Already known: treat as submitted and read its status below.
    } else if (!is2xx) {
      // No answer, backpressure (503), rate limit or a server error: nothing to read; re-posting is safe.
      if (postStatus === 0) return pending('UNREACHABLE', 'no response from Arcade (network error or timeout)', true)
      return pending(postStatus === 503 ? 'UNREACHABLE' : 'UNKNOWN', `Arcade answered HTTP ${postStatus}; retry`, transient)
    }
    try {
      const o = await this.read(txid, waitMs)
      return o ?? pending('UNKNOWN', `Arcade answered ${postStatus} to POST /tx but has no status for it yet; re-read status`)
    } catch (e) {
      // The POST got through, so this is not transient: the next status read decides.
      return pending('UNKNOWN', `status re-read failed: ${e instanceof Error ? e.message : String(e)}; re-read status`)
    }
  }

  /** The current outcome (polled up to waitMs); undefined when this Arcade was never given the txid. Throws when Arcade cannot be read. */
  async read(txid: string, waitMs = 0): Promise<Outcome | undefined> {
    const s = waitMs > 0 ? await this.waitForSeen(txid, waitMs) : await this.status(txid)
    return 'notFound' in s ? undefined : outcome(s)
  }
}
