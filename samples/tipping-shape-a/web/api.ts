import { fetchConfig, type AppConfig } from './config'

// The relay's API as the browser sees it (server/routes.ts). The relay holds no key: it stores tips, broadcasts
// them to Arcade and reports Arcade's verdict. Whether a tip was received is the creator's wallet's call.

export interface Remittance {
  /** sha256 of the BEEF this candidate arrived with: GET /api/tips/:txid/beef?id=<beefId>. */
  beefId: string
  outputIndex: number
  satoshis: number
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  receivedAt: string
}

export interface TipStatusView {
  txid: string
  txStatus: string
  /** Arcade's verdict as the relay read it: seen-no-competitor | on-network-not-seen | pending | terminal | no-verdict. */
  verdict: string
  competingTxs: string[]
  extraInfo?: string
  /** A caveat on the verdict, e.g. a REJECTED that may not be final. */
  note?: string
  updatedAt: string
}

export interface TipRow extends TipStatusView {
  receivedAt: string
  /** Set once the creator's wallet internalized the tip and reported it, signed. */
  internalizedAt?: string
  /** Everyone who posted this transaction, with the remittance and BEEF they posted, in arrival order. */
  remittances: Remittance[]
}

export interface TipPost {
  txid: string
  /** AtomicBEEF hex, as the wallet's createAction returned it. */
  beef: string
  outputIndex: number
  satoshis: number
  remittance: { senderIdentityKey: string; derivationPrefix: string; derivationSuffix: string }
}

/** GET /api/tx/:txid: an ancestor transaction from the relay's Arcade, already re-read as a plain transaction. */
export interface AncestorTx {
  txid: string
  /** Plain (not Extended Format) transaction hex. */
  rawTx: string
  /** BUMP hex, when Arcade has the transaction's merkle path. */
  merklePath?: string
}

/** A relay answer other than 2xx; status 0 when the relay could not be reached. */
export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** From Retry-After, when the relay sent one. */
    readonly retryAfterMs?: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'RelayError'
  }

  /** Unreachable, rate-limited, or Arcade did not take it yet: the same request may succeed later. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504
  }
}

export interface RelayApi {
  /** Fresh settings, including the claim nonce. */
  config(): Promise<AppConfig>
  postTip(tip: TipPost): Promise<TipRow>
  listTips(): Promise<TipRow[]>
  getTip(txid: string): Promise<TipRow>
  /** The AtomicBEEF hex one candidate arrived with. */
  beef(txid: string, beefId: string): Promise<string>
  /** The relay's live Arcade read for a stored tip. */
  status(txid: string): Promise<TipStatusView>
  /** The relay submits the stored tip to Arcade again, then reads its status (the two-read rule's re-post). */
  rebroadcast(txid: string): Promise<TipStatusView>
  /** An ancestor transaction, from the relay's Arcade; undefined when Arcade has no rawTx for it. */
  ancestor(txid: string): Promise<AncestorTx | undefined>
  claimCreator(identityKey: string, signature: string): Promise<{ creatorIdentityKey: string }>
  markInternalized(txid: string, signature: string): Promise<TipRow>
}

// POST /api/tips waits up to 15 s for Arcade to see the transaction.
const TIMEOUT_MS = 30_000

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** The relay at `base` (same origin by default). */
export function relayApi(fetchImpl: typeof fetch = (input, init) => fetch(input, init), base = ''): RelayApi {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new RelayError(`${method} ${path}: the relay did not answer (${e instanceof Error ? e.message : String(e)})`, 0)
    }
    const text = await res.text()
    let json: any
    try {
      json = text === '' ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!res.ok) {
      const why = typeof json?.error === 'string' ? `: ${json.error}` : ''
      throw new RelayError(`${method} ${path}: HTTP ${res.status}${why}`, res.status, retryAfterMs(res.headers.get('Retry-After')), json)
    }
    return json as T
  }
  const tip = (txid: string) => `/api/tips/${encodeURIComponent(txid)}`

  return {
    config: () => fetchConfig(fetchImpl, base),
    postTip: body => call('POST', '/api/tips', body),
    listTips: () => call('GET', '/api/tips'),
    getTip: txid => call('GET', tip(txid)),
    beef: async (txid, beefId) => (await call<{ beefHex: string }>('GET', `${tip(txid)}/beef?id=${encodeURIComponent(beefId)}`)).beefHex,
    status: txid => call('GET', `${tip(txid)}/status`),
    rebroadcast: txid => call('POST', `${tip(txid)}/rebroadcast`),
    ancestor: async txid => {
      try {
        return await call<AncestorTx>('GET', `/api/tx/${encodeURIComponent(txid)}`)
      } catch (e) {
        if (e instanceof RelayError && e.status === 404) return undefined
        throw e
      }
    },
    claimCreator: (identityKey, signature) => call('POST', '/api/creator', { identityKey, signature }),
    markInternalized: (txid, signature) => call('POST', `${tip(txid)}/internalized`, { signature }),
  }
}

