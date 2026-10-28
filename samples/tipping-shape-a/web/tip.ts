import { Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { RelayError, type RelayApi, type TipRow } from './api'
import { newDerivation, payeeLockingScript } from './brc29'
import type { AppConfig, Network } from './config'
import { assertNetwork, walletNetwork } from './wallet'

// The tipper's side. The derivation is written to localStorage before createAction (which broadcasts), and the
// record stays until the relay has the tip: a remittance that was never saved, or lost after the wallet
// broadcast, makes the payment uncollectable.

export const MIN_TIP_SATS = 546
export const PENDING_PREFIX = 'tip:pending:'

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { readonly length: number }

export interface PendingTip {
  /** Its localStorage key: tip:pending:<ms>. */
  key: string
  createdAt: string
  network: Network
  /** The creator's identity key. */
  recipient: string
  senderIdentityKey: string
  satoshis: number
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /** Set once the wallet returned the transaction (it has broadcast it). */
  txid?: string
  /** AtomicBEEF hex, as the wallet returned it. */
  beef?: string
  lastError?: string
  /** The relay's HTTP status for the last refused POST, when it answered one. */
  lastStatus?: number
}

export type TipOutcome = (
  | { posted: true; txid: string; row: TipRow }
  | { posted: false; txid: string; error: string; /** The relay can never take this tip (see refusedForGood). */ permanent?: true }
) & {
  /** The wallet built the transaction but reported a problem broadcasting it (WERR_REVIEW_ACTIONS). */
  walletError?: string
}

export interface TipDeps {
  /** Default: localStorage. */
  storage?: KeyValueStore
  /** Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** POST /api/tips attempts before giving up for now (the record is kept). Default 5. */
  postAttempts?: number
}

// Waits between POST attempts when the relay sends no Retry-After; no wait is longer than MAX_WAIT_MS.
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000]
const MAX_WAIT_MS = 60_000

const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * True when the relay's last answer for this tip can never change: 413, its BEEF is larger than the relay takes.
 * Such a tip is listed with its details, never re-posted.
 */
export const refusedForGood = (t: Pick<PendingTip, 'lastStatus'>) => t.lastStatus === 413

function save(storage: KeyValueStore, record: PendingTip) {
  storage.setItem(record.key, JSON.stringify(record))
}

/** Every saved tip record, oldest first. */
export function pendingTips(storage: KeyValueStore = localStorage): PendingTip[] {
  const out: PendingTip[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key === null || !key.startsWith(PENDING_PREFIX)) continue
    try {
      out.push({ ...(JSON.parse(storage.getItem(key) ?? '') as PendingTip), key })
    } catch {
      // not ours, or damaged: leave it alone
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }))
}

/**
 * Tips `satoshis` to the creator. Checks the wallet's network first (nothing is built on a mismatch), saves the
 * derivation, has the wallet build and broadcast the payment, then hands it to the relay.
 */
export async function sendTip(
  wallet: WalletInterface,
  cfg: AppConfig,
  creatorIdentityKey: string,
  satoshis: number,
  api: RelayApi,
  deps: TipDeps = {},
): Promise<TipOutcome> {
  if (!Number.isSafeInteger(satoshis) || satoshis < MIN_TIP_SATS) throw new Error(`a tip is at least ${MIN_TIP_SATS} sats`)
  assertNetwork(await walletNetwork(wallet), cfg.network)
  const storage = deps.storage ?? localStorage
  const now = deps.now ?? Date.now

  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true })
  const { derivationPrefix, derivationSuffix } = newDerivation()
  const lockingScript = await payeeLockingScript(wallet, creatorIdentityKey, derivationPrefix, derivationSuffix)
  let at = now()
  while (storage.getItem(`${PENDING_PREFIX}${at}`) !== null) at++
  const record: PendingTip = {
    key: `${PENDING_PREFIX}${at}`,
    createdAt: new Date(at).toISOString(),
    network: cfg.network,
    recipient: creatorIdentityKey,
    senderIdentityKey,
    satoshis,
    outputIndex: 0,
    derivationPrefix,
    derivationSuffix,
  }
  save(storage, record) // write-ahead: createAction broadcasts before it returns

  let result: { txid?: string; tx?: number[] | Uint8Array }
  let walletError: string | undefined
  try {
    result = await wallet.createAction({
      description: 'Tip to creator',
      outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 tip' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    })
  } catch (e) {
    // WERR_REVIEW_ACTIONS: the wallet built and signed the transaction but its own broadcast did not fully succeed
    // (it may still retry). It carries the txid and the AtomicBEEF, so the relay can take it to Arcade.
    const { txid, tx, reviewActionResults } = e as { txid?: unknown; tx?: unknown; reviewActionResults?: Array<{ status?: unknown }> }
    const status = reviewActionResults?.[0]?.status
    walletError = `${message(e)}${typeof status === 'string' ? ` (${status})` : ''}`
    const signed = Array.isArray(tx) || tx instanceof Uint8Array ? Array.from(tx as ArrayLike<number>) : undefined
    if (typeof txid !== 'string' || signed === undefined) {
      // Kept, and listed on the page: if the wallet broadcast before failing, this derivation is the only way to
      // collect the payment.
      save(storage, { ...record, txid: typeof txid === 'string' ? txid : undefined, lastError: walletError })
      throw e
    }
    result = { txid, tx: signed }
  }
  if (result.txid === undefined || result.tx === undefined) {
    save(storage, { ...record, txid: result.txid, lastError: 'the wallet returned no transaction' })
    throw new Error(`the wallet returned no transaction${result.txid ? ` for ${result.txid}` : ''}`)
  }
  const bytes = Array.from(result.tx)
  record.txid = result.txid
  record.beef = Utils.toHex(bytes)
  const tx = Transaction.fromAtomicBEEF(bytes)
  record.outputIndex = tx.outputs.findIndex(o => o.lockingScript.toHex() === lockingScript && o.satoshis === satoshis)
  if (tx.id('hex') !== result.txid || record.outputIndex < 0) {
    // Listed on the page with this error, and never handed to the relay: its remittance would not match.
    save(storage, { ...record, outputIndex: -1, lastError: 'the wallet returned a transaction that does not pay the planned tip' })
    throw new Error(`transaction ${result.txid} does not pay the tip`)
  }
  if (walletError !== undefined) record.lastError = `the wallet reported: ${walletError}`
  save(storage, record)
  const out = await postPending(record, api, deps)
  return walletError === undefined ? out : { ...out, walletError }
}

/**
 * Hands a broadcast tip to the relay. Unreachable, rate-limited (Retry-After honoured) and not-yet-taken answers
 * are retried a few times; whatever happens the record is kept until the relay has the tip.
 */
export async function postPending(record: PendingTip, api: RelayApi, deps: TipDeps = {}): Promise<TipOutcome> {
  const storage = deps.storage ?? localStorage
  const sleep = deps.sleep ?? sleepMs
  const attempts = deps.postAttempts ?? 5
  const { txid, beef } = record
  if (txid === undefined || beef === undefined || record.outputIndex < 0) throw new Error('this tip has no transaction the relay could take')
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await api.postTip({
        txid,
        beef,
        outputIndex: record.outputIndex,
        satoshis: record.satoshis,
        remittance: {
          senderIdentityKey: record.senderIdentityKey,
          derivationPrefix: record.derivationPrefix,
          derivationSuffix: record.derivationSuffix,
        },
      })
      storage.removeItem(record.key)
      return { posted: true, txid, row }
    } catch (e) {
      const error = message(e)
      const lastStatus = e instanceof RelayError ? e.status : undefined
      save(storage, { ...record, lastError: error, lastStatus })
      if (refusedForGood({ lastStatus })) return { posted: false, txid, error, permanent: true }
      if (!(e instanceof RelayError) || !e.transient || attempt >= attempts) return { posted: false, txid, error }
      await sleep(Math.min(e.retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1], MAX_WAIT_MS))
    }
  }
}

const resumable = (t: PendingTip) => t.txid !== undefined && t.beef !== undefined && t.outputIndex >= 0 && !refusedForGood(t)

/**
 * Tips the wallet returned a transaction for that the relay does not have yet (this network): re-post these. A tip
 * the relay refused for good (refusedForGood) is not one of them.
 */
export function resumableTips(network: Network, storage: KeyValueStore = localStorage): PendingTip[] {
  return pendingTips(storage).filter(t => t.network === network && resumable(t))
}

/**
 * Tips that cannot be re-posted (this network): the wallet failed or the page closed before it returned a
 * transaction, its transaction does not pay the planned output, or the relay refused it for good. Shown on the page,
 * never dropped silently.
 */
export function stuckTips(network: Network, storage: KeyValueStore = localStorage): PendingTip[] {
  return pendingTips(storage).filter(t => t.network === network && !resumable(t))
}

/** Deletes a saved tip record (the user chose to forget it). */
export function forgetTip(key: string, storage: KeyValueStore = localStorage): void {
  if (key.startsWith(PENDING_PREFIX)) storage.removeItem(key)
}

/**
 * A saved record's collect details as JSON, for the user to keep before forgetting it: with these the creator can
 * collect the tip by hand. Nothing secret: only the creator's wallet can derive the key they name.
 * Undefined when the record holds no derivation.
 */
export function tipDetails(record: PendingTip): string | undefined {
  const { txid, derivationPrefix, derivationSuffix, recipient, satoshis, outputIndex, senderIdentityKey } = record
  if (!derivationPrefix || !derivationSuffix) return undefined
  return JSON.stringify({ txid: txid ?? null, derivationPrefix, derivationSuffix, recipient, satoshis, outputIndex, senderIdentityKey }, null, 2)
}

/**
 * The question asked before a saved record is forgotten. It carries the record's details (tipDetails), so they are
 * on screen before a yes deletes them; a record without a derivation has none, and the question says so.
 */
export function forgetQuestion(record: PendingTip): string {
  const which = record.txid === undefined ? `this ${record.satoshis}-sat tip` : `the tip in transaction ${record.txid}`
  const details = tipDetails(record)
  if (details === undefined) return `Forget ${which}? This record holds no details the creator could collect it with.`
  return (
    `Forget ${which}? If your wallet sent it, this record may be the only copy of the details the creator needs ` +
    `to collect it. Use Copy details first to keep them. The details:\n\n${details}`
  )
}

/** Forgets `record` only when `ask` (window.confirm on the page) says yes. True when it was deleted. */
export function forgetWithConsent(record: PendingTip, ask: (question: string) => boolean, storage: KeyValueStore = localStorage): boolean {
  if (!ask(forgetQuestion(record))) return false
  forgetTip(record.key, storage)
  return true
}
