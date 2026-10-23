import { Beef, MerklePath, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { RelayError, type AncestorTx, type RelayApi, type Remittance, type TipRow, type TipStatusView } from './api'
import type { Network } from './config'
import type { KeyValueStore } from './tip'
import { assertNetwork, signText, walletNetwork } from './wallet'

// The creator's side. A tip is collected automatically, at 0-conf, once the relay's live Arcade read says
// seen-no-competitor. Which candidate (if any) pays this wallet is decided by the wallet itself:
// internalizeAction with protocol 'wallet payment' derives the BRC-29 key for self from the remittance and
// refuses an output that it does not lock to (@bsv/wallet-toolbox 2.14.9, signer/methods/internalizeAction.js:
// WERR_INVALID_PARAMETER 'paymentRemittance'). That check needs no permission, where a forSelf getPublicKey per
// sender would prompt once per tipper (the manifest grants BRC-29 for counterparty 'self' only).

/** Sign-in messages the relay verifies (server/auth.ts). */
export const claimMessage = (origin: string, identityKey: string, nonce: string) => `claim:${origin}:${identityKey.toLowerCase()}:${nonce}`
export const internalizedMessage = (origin: string, txid: string) => `internalized:${origin}:${txid.toLowerCase()}`

export type CollectResult = 'accepted' | 'not-for-me' | 'gave-up' | 'failed'

export interface CollectOutcome {
  result: CollectResult
  /** Why it is not collected ('gave-up', 'failed'): the last error of each candidate still open, or of the gate. */
  error?: string
  /** The accepted candidate's amount. */
  satoshis?: number
}

/** After the first try: 10 s, 30 s, then every 60 s, bounded. */
export const COLLECT_DELAYS_MS = [10_000, 30_000, 60_000, 60_000, 60_000]
/** The two-read dead rule: REJECTED on two reads at least this far apart, with a re-post before the second. */
export const DEAD_AFTER_MS = 20_000

export interface CollectDeps {
  /** The relay's originator (GET /api/config), named in the signed internalized report. */
  originator: string
  /** The app's network; the wallet's is read again before internalizing. */
  network: Network
  delaysMs?: number[]
  /** Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Stop between attempts (the page went away). */
  signal?: AbortSignal
}

const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/
// The relay's note on a REJECTED that may be a stale view of an accepted transaction (server/arcade.ts).
const MAY_NOT_BE_FINAL = /may not be final/

/**
 * The tip's AtomicBEEF, complete. A BEEF whose ancestors are all present is returned as is; otherwise each
 * ancestor named by txid only (or missing) comes from the relay's GET /api/tx/:txid, which reads Arcade and
 * re-reads its Extended Format rawTx as a plain transaction. It is merged as bytes, with its merkle path when
 * Arcade has one.
 */
export async function buildAtomicBeef(
  beefHex: string,
  txid: string,
  ancestor: (txid: string) => Promise<AncestorTx | undefined>,
): Promise<number[]> {
  const beef = Beef.fromString(beefHex, 'hex')
  for (let round = 0; !beef.isValid() && round < 8; round++) {
    const { txidOnly, missingInputs } = beef.sortTxs()
    const needed = [...new Set([...txidOnly, ...missingInputs])]
    if (needed.length === 0) break
    for (const id of needed) {
      const a = await ancestor(id)
      if (a === undefined) throw new Error(`Arcade has no rawTx for ancestor ${id}, so the tip's BEEF cannot be completed`)
      const bump = a.merklePath === undefined ? undefined : beef.mergeBump(MerklePath.fromHex(a.merklePath))
      const merged = beef.mergeRawTx(Utils.toArray(a.rawTx, 'hex'), bump)
      if (merged.txid !== id) throw new Error(`the relay's transaction for ancestor ${id} hashes to ${merged.txid}`)
    }
  }
  if (!beef.isValid()) throw new Error(`the BEEF for ${txid} is incomplete`)
  return beef.toBinaryAtomic(txid)
}

/**
 * True when the wallet says this remittance does not derive the output's key: the output is not ours.
 * Verified against @bsv/wallet-toolbox 2.14.9 only (WERR_INVALID_PARAMETER 'paymentRemittance'): HTTP substrates
 * carry the parameter, the wire substrate keeps only the message. Another wallet may word it differently; then the
 * candidate stays open and the run ends 'gave-up', never 'accepted'.
 */
export function isNotOurs(e: unknown): boolean {
  const err = e as { parameter?: unknown; message?: unknown }
  return err?.parameter === 'paymentRemittance' || (typeof err?.message === 'string' && /\bpaymentRemittance\b/.test(err.message))
}

const candidateKey = (c: Remittance) => [c.beefId, c.outputIndex, c.senderIdentityKey, c.derivationPrefix, c.derivationSuffix].join(' ')

/** The candidate's output exists, is P2PKH and carries the candidate's amount. Anything else is not a tip to try. */
function paysAsClaimed(atomic: number[], txid: string, c: Remittance): boolean {
  const tx = Transaction.fromAtomicBEEF(atomic)
  const out = tx.outputs[c.outputIndex]
  return tx.id('hex') === txid && out !== undefined && out.satoshis === c.satoshis && P2PKH_SCRIPT.test(out.lockingScript.toHex())
}

/**
 * Collects one tip into the wallet. Each attempt reads the relay's live status and goes on only at
 * seen-no-competitor; then it tries every candidate with that candidate's own BEEF.
 * - 'not-for-me': the wallet refused every candidate as not its own.
 * - 'failed': Arcade reported REJECTED on two reads at least 20 s apart, with a re-post between.
 * - 'gave-up': the schedule ran out; `error` says why.
 */
export async function collectTip(wallet: WalletInterface, tip: TipRow, api: RelayApi, deps: CollectDeps): Promise<CollectOutcome> {
  const delays = deps.delaysMs ?? COLLECT_DELAYS_MS
  const sleep = deps.sleep ?? sleepMs
  const { txid } = tip
  const notOurs = new Set<string>()
  const errors = new Map<string, string>() // the last error of each candidate still open
  let gate: string | undefined // why the last attempt did not reach the candidates
  let firstRejectedAt: number | undefined
  let reposted = false

  const gaveUp = (): CollectOutcome => ({ result: 'gave-up', error: errors.size > 0 ? [...new Set(errors.values())].join('; ') : gate })

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    if (deps.signal?.aborted) return gaveUp()

    let view: TipStatusView
    try {
      view = await api.status(txid)
    } catch (e) {
      gate = `the relay could not read the status: ${message(e)}`
      if (e instanceof RelayError && e.status === 404) return gaveUp() // the relay no longer has it
      continue
    }

    if (view.verdict === 'terminal' && !MAY_NOT_BE_FINAL.test(view.note ?? '')) {
      const at = Date.now()
      firstRejectedAt ??= at
      if (reposted && at - firstRejectedAt >= DEAD_AFTER_MS) {
        return { result: 'failed', error: `Arcade reported ${view.txStatus}${view.extraInfo ? ` (${view.extraInfo})` : ''} on two reads, with a re-post between` }
      }
      if (!reposted) {
        try {
          await api.rebroadcast(txid) // the re-post before the second read
          reposted = true
        } catch (e) {
          gate = `the relay could not re-post it: ${message(e)}`
          continue
        }
      }
      gate = `Arcade reports ${view.txStatus}; reading again before calling it failed`
      continue
    }
    firstRejectedAt = undefined
    reposted = false
    if (view.verdict !== 'seen-no-competitor') {
      const competing = view.competingTxs.length > 0 ? ` with ${view.competingTxs.length} competing transaction(s)` : ''
      gate = `Arcade has not seen it with no competitor yet (${view.txStatus}${competing})`
      continue
    }

    let row: TipRow
    try {
      row = await api.getTip(txid)
    } catch (e) {
      gate = `the relay could not list its candidates: ${message(e)}`
      continue
    }
    gate = undefined
    let open = 0 // candidates that may still be ours
    for (const c of row.remittances) {
      const key = candidateKey(c)
      if (notOurs.has(key)) continue
      try {
        const atomic = await buildAtomicBeef(await api.beef(txid, c.beefId), txid, id => api.ancestor(id))
        if (!paysAsClaimed(atomic, txid, c)) {
          notOurs.add(key)
          errors.delete(key)
          continue
        }
        assertNetwork(await walletNetwork(wallet), deps.network)
        const { accepted } = await wallet.internalizeAction({
          tx: atomic,
          outputs: [
            {
              outputIndex: c.outputIndex,
              protocol: 'wallet payment',
              paymentRemittance: { senderIdentityKey: c.senderIdentityKey, derivationPrefix: c.derivationPrefix, derivationSuffix: c.derivationSuffix },
            },
          ],
          description: 'Tip received',
        })
        if (accepted) {
          await reportInternalized(wallet, api, txid, deps.originator)
          return { result: 'accepted', satoshis: c.satoshis }
        }
        open++
        errors.set(key, 'the wallet did not accept it')
      } catch (e) {
        if (isNotOurs(e)) {
          notOurs.add(key)
          errors.delete(key)
          continue
        }
        // A transient failure, a BEEF the wallet could not verify yet, a network switch: try again later.
        open++
        errors.set(key, message(e))
        console.warn(`collecting ${txid}: ${message(e)}`)
      }
    }
    if (row.remittances.length > 0 && open === 0) return { result: 'not-for-me' }
  }
  return gaveUp()
}

/** Tells the relay, signed, that this wallet internalized the tip. The money is already ours if this fails. */
export async function reportInternalized(wallet: WalletInterface, api: RelayApi, txid: string, originator: string): Promise<boolean> {
  try {
    await api.markInternalized(txid, await signText(wallet, internalizedMessage(originator, txid)))
    return true
  } catch (e) {
    console.warn(`could not tell the relay that ${txid} was received: ${message(e)}`)
    return false
  }
}

export type CreatorRole = { role: 'creator' } | { role: 'not-creator'; creatorIdentityKey: string }

/**
 * Claims the creator page for this identity key (signed, with the relay's current nonce), or checks that it is
 * already ours. Another creator's page is 'not-creator'.
 */
export async function claimCreator(wallet: WalletInterface, identityKey: string, api: RelayApi): Promise<CreatorRole> {
  const cfg = await api.config() // the nonce, read right before signing
  const mine = identityKey.toLowerCase()
  if (cfg.creatorIdentityKey !== undefined) {
    return cfg.creatorIdentityKey.toLowerCase() === mine ? { role: 'creator' } : { role: 'not-creator', creatorIdentityKey: cfg.creatorIdentityKey }
  }
  const signature = await signText(wallet, claimMessage(cfg.originator, mine, cfg.claimNonce))
  try {
    await api.claimCreator(mine, signature)
    return { role: 'creator' }
  } catch (e) {
    if (!(e instanceof RelayError) || e.status !== 409) throw e
    const now = await api.config() // someone else claimed it first
    return now.creatorIdentityKey !== undefined && now.creatorIdentityKey.toLowerCase() !== mine
      ? { role: 'not-creator', creatorIdentityKey: now.creatorIdentityKey }
      : { role: 'creator' }
  }
}

export type CollectState = 'collecting' | CollectResult

export interface CollectInfo {
  state: CollectState
  error?: string
  /** The amount this wallet received. */
  satoshis?: number
}

export interface CollectorOptions {
  wallet: WalletInterface
  identityKey: string
  api: RelayApi
  deps: CollectDeps
  /** Where this wallet's collected txids are remembered. Default: localStorage. */
  storage?: KeyValueStore
  onChange?: (txid: string, info: CollectInfo) => void
  /** Default: collectTip. */
  collect?: typeof collectTip
}

/**
 * Runs collectTip for every tip the page hears of, once per txid at a time.
 * - A tip event is ignored when it carries no candidate this Collector has not seen; a new candidate (a front-run,
 *   then the honest post) runs the tip again after a run that did not collect it.
 * - Tips this wallet already collected are skipped; if the relay never got the signed report, it is sent again.
 * - A tip that gave up runs again on a later seen-no-competitor status, or when the event stream reopens.
 */
export class Collector {
  readonly states = new Map<string, CollectState>()
  readonly info = new Map<string, CollectInfo>()
  private readonly rows = new Map<string, TipRow>()
  private readonly known = new Map<string, Set<string>>()
  private readonly running = new Set<string>()
  private readonly rerun = new Set<string>()
  private readonly reported = new Set<string>()
  private readonly abort = new AbortController()

  constructor(private readonly opts: CollectorOptions) {}

  private get storage(): KeyValueStore {
    return this.opts.storage ?? localStorage
  }
  private get collectedKey() {
    return `tip:collected:${this.opts.identityKey.toLowerCase()}`
  }
  private collectedTxids(): string[] {
    try {
      const list = JSON.parse(this.storage.getItem(this.collectedKey) ?? '[]')
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }
  private set(txid: string, info: CollectInfo) {
    this.states.set(txid, info.state)
    this.info.set(txid, info)
    this.opts.onChange?.(txid, info)
  }

  onTip(row: TipRow): void {
    const { txid } = row
    this.rows.set(txid, row)
    if (this.states.get(txid) === 'accepted') return
    if (this.collectedTxids().includes(txid)) {
      this.set(txid, { state: 'accepted' })
      if (row.internalizedAt === undefined && !this.reported.has(txid)) {
        this.reported.add(txid)
        void reportInternalized(this.opts.wallet, this.opts.api, txid, this.opts.deps.originator)
      }
      return
    }
    const keys = this.known.get(txid) ?? new Set<string>()
    let fresh = !this.known.has(txid)
    for (const c of row.remittances) {
      const key = candidateKey(c)
      if (keys.has(key)) continue
      keys.add(key)
      fresh = true
    }
    this.known.set(txid, keys)
    if (!fresh) return
    if (this.running.has(txid)) this.rerun.add(txid)
    else void this.run(row)
  }

  /** A live status from the relay: a tip that gave up runs again once it reads seen-no-competitor. */
  onStatus(view: TipStatusView): void {
    if (view.verdict === 'seen-no-competitor') this.retry(view.txid)
  }

  /** Runs again every tip that gave up (the event stream reopened). */
  retryGaveUp(): void {
    for (const [txid, state] of this.states) if (state === 'gave-up') this.retry(txid)
  }

  /** Stops scheduling attempts (the page is closing). */
  stop(): void {
    this.abort.abort()
  }

  private retry(txid: string) {
    const row = this.rows.get(txid)
    if (row !== undefined && this.states.get(txid) === 'gave-up' && !this.running.has(txid)) void this.run(row)
  }

  private async run(row: TipRow): Promise<void> {
    const { txid } = row
    this.running.add(txid)
    this.set(txid, { state: 'collecting' })
    let outcome: CollectOutcome
    try {
      outcome = await (this.opts.collect ?? collectTip)(this.opts.wallet, row, this.opts.api, { ...this.opts.deps, signal: this.abort.signal })
    } catch (e) {
      console.warn(`collecting ${txid} stopped: ${message(e)}`)
      outcome = { result: 'gave-up', error: message(e) }
    }
    this.running.delete(txid)
    // Remembered even when the page is closing: the wallet has the money, and a reload must not collect it again.
    // A browser that refuses the write (storage full or blocked) must not hide that: the tip still shows as collected.
    if (outcome.result === 'accepted') {
      try {
        this.storage.setItem(this.collectedKey, JSON.stringify([...this.collectedTxids(), txid]))
      } catch (e) {
        console.warn(`${txid} is collected, but this browser did not store that (${message(e)}); a reload may try it again`)
      }
    }
    if (this.abort.signal.aborted) return
    if (outcome.result === 'gave-up') console.warn(`${txid} not collected yet: ${outcome.error ?? 'no reason given'}`)
    this.set(txid, { state: outcome.result, error: outcome.error, satoshis: outcome.satoshis })
    if (this.rerun.delete(txid) && outcome.result !== 'accepted' && outcome.result !== 'failed') void this.run(this.rows.get(txid) ?? row)
  }
}
