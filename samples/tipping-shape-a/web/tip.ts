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
}

export type TipOutcome =
  | { posted: true; txid: string; row: TipRow }
  | { posted: false; txid: string; error: string }

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

  let result: Awaited<ReturnType<WalletInterface['createAction']>>
  try {
    result = await wallet.createAction({
      description: 'Tip to creator',
      outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 tip' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    })
  } catch (e) {
    // Kept: if the wallet broadcast before failing, this derivation is the only way to collect the payment.
    save(storage, { ...record, lastError: message(e) })
    throw e
  }
  if (result.txid === undefined || result.tx === undefined) {
    save(storage, { ...record, txid: result.txid, lastError: 'the wallet returned no transaction' })
    throw new Error(`the wallet returned no transaction${result.txid ? ` for ${result.txid}` : ''}`)
  }
  record.txid = result.txid
  record.beef = Utils.toHex(result.tx)
  const tx = Transaction.fromAtomicBEEF(result.tx)
  record.outputIndex = tx.outputs.findIndex(o => o.lockingScript.toHex() === lockingScript && o.satoshis === satoshis)
  if (tx.id('hex') !== result.txid || record.outputIndex < 0) {
    save(storage, { ...record, lastError: 'the wallet returned a transaction that does not pay the tip' })
    throw new Error(`transaction ${result.txid} does not pay the tip`)
  }
  save(storage, record)
  return postPending(record, api, deps)
}

/**
 * Hands a broadcast tip to the relay. Unreachable, rate-limited (Retry-After honoured) and not-yet-taken answers
 * are retried a few times; whatever happens the record is kept until the relay has the tip.
 */
export async function postPending(record: PendingTip, api: RelayApi, deps: TipDeps = {}): Promise<TipOutcome> {
  const storage = deps.storage ?? localStorage
  const sleep = deps.sleep ?? sleepMs
  const attempts = deps.postAttempts ?? 5
  if (record.txid === undefined || record.beef === undefined) throw new Error('this tip was never broadcast by the wallet')
  const { txid } = record
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await api.postTip({
        txid,
        beef: record.beef,
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
      save(storage, { ...record, lastError: error })
      if (!(e instanceof RelayError) || !e.transient || attempt >= attempts) return { posted: false, txid, error }
      await sleep(Math.min(e.retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1], MAX_WAIT_MS))
    }
  }
}

/** Tips the wallet broadcast that the relay does not have yet (for this network). */
export function unsentTips(network: Network, storage: KeyValueStore = localStorage): PendingTip[] {
  return pendingTips(storage).filter(t => t.network === network && t.txid !== undefined && t.beef !== undefined)
}
