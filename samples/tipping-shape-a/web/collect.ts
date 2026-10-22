import { Beef, MerklePath, Transaction, type WalletInterface } from '@bsv/sdk'
import { RelayError, type ArcadeTxStatus, type RelayApi, type Remittance, type TipRow } from './api'
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

/** After the first try: 10 s, 30 s, then every 60 s, bounded. */
export const COLLECT_DELAYS_MS = [10_000, 30_000, 60_000, 60_000, 60_000]

export interface CollectDeps {
  /** The relay's originator (GET /api/config), named in the signed internalized report. */
  originator: string
  /** The app's network; the wallet's is read again before internalizing. */
  network: Network
  /** Arcade's GET /tx/{txid}, for ancestors a BEEF names by txid only. */
  arcadeStatus: (txid: string) => Promise<ArcadeTxStatus | undefined>
  delaysMs?: number[]
  /** Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Stop between attempts (the page went away). */
  signal?: AbortSignal
}

const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/
// The relay's note on a REJECTED that may be a stale view of an accepted transaction (server/arcade.ts).
const MAY_NOT_BE_FINAL = /may not be final/

/**
 * The tip's AtomicBEEF, complete. A BEEF whose ancestors are all present is returned as is; otherwise each
 * ancestor named by txid only (or missing) is read from Arcade, whose rawTx is Extended Format: it is re-read as
 * a plain transaction (fromHexEF, then toBinary) and merged as bytes, with its merkle path when Arcade has one.
 */
export async function buildAtomicBeef(
  beefHex: string,
  txid: string,
  arcadeStatus: (txid: string) => Promise<ArcadeTxStatus | undefined>,
): Promise<number[]> {
  const beef = Beef.fromString(beefHex, 'hex')
  for (let round = 0; !beef.isValid() && round < 8; round++) {
    const { txidOnly, missingInputs } = beef.sortTxs()
    const needed = [...new Set([...txidOnly, ...missingInputs])]
    if (needed.length === 0) break
    for (const id of needed) {
      const s = await arcadeStatus(id)
      if (s?.rawTx === undefined) throw new Error(`Arcade has no rawTx for ancestor ${id}; the tip's BEEF cannot be completed`)
      const plain = Transaction.fromHexEF(s.rawTx)
      if (plain.id('hex') !== id) throw new Error(`Arcade's rawTx for ${id} hashes to ${plain.id('hex')}`)
      const bump = s.merklePath === undefined ? undefined : beef.mergeBump(MerklePath.fromHex(s.merklePath))
      beef.mergeRawTx(plain.toBinary(), bump)
    }
  }
  if (!beef.isValid()) throw new Error(`the BEEF for ${txid} is incomplete`)
  return beef.toBinaryAtomic(txid)
}

/** True when the wallet says this remittance does not derive the output's key: the output is not ours. */
export function isNotOurs(e: unknown): boolean {
  const err = e as { parameter?: unknown; message?: unknown }
  // HTTP substrates carry the parameter; the wire substrate keeps only the message.
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
 * seen-no-competitor; then it tries every candidate with that candidate's own BEEF. 'not-for-me' when the wallet
 * refuses every candidate as not its own; 'failed' on a final REJECTED; 'gave-up' once the schedule runs out.
 */
export async function collectTip(wallet: WalletInterface, tip: TipRow, api: RelayApi, deps: CollectDeps): Promise<CollectResult> {
  const delays = deps.delaysMs ?? COLLECT_DELAYS_MS
  const sleep = deps.sleep ?? sleepMs
  const { txid } = tip
  const notOurs = new Set<string>()

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    if (deps.signal?.aborted) return 'gave-up'

    let verdict: string
    let note: string | undefined
    try {
      ;({ verdict, note } = await api.status(txid))
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return 'gave-up' // the relay no longer has it
      continue
    }
    if (verdict === 'terminal' && !MAY_NOT_BE_FINAL.test(note ?? '')) return 'failed'
    if (verdict !== 'seen-no-competitor') continue

    let row: TipRow
    try {
      row = await api.getTip(txid)
    } catch {
      continue
    }
    let open = 0 // candidates that may still be ours
    for (const c of row.remittances) {
      const key = candidateKey(c)
      if (notOurs.has(key)) continue
      try {
        const atomic = await buildAtomicBeef(await api.beef(txid, c.beefId), txid, deps.arcadeStatus)
        if (!paysAsClaimed(atomic, txid, c)) {
          notOurs.add(key)
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
          await report(wallet, api, txid, deps.originator)
          return 'accepted'
        }
        open++
      } catch (e) {
        if (isNotOurs(e)) notOurs.add(key)
        else open++ // a transient failure, or a BEEF the wallet could not verify yet: try again later
      }
    }
    if (row.remittances.length > 0 && open === 0) return 'not-for-me'
  }
  return 'gave-up'
}

/** Tells the relay, signed, that this wallet internalized the tip. The money is already ours if this fails. */
async function report(wallet: WalletInterface, api: RelayApi, txid: string, originator: string) {
  try {
    await api.markInternalized(txid, await signText(wallet, internalizedMessage(originator, txid)))
  } catch (e) {
    console.warn(`could not tell the relay that ${txid} was received: ${e instanceof Error ? e.message : String(e)}`)
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

export interface CollectorOptions {
  wallet: WalletInterface
  identityKey: string
  api: RelayApi
  deps: CollectDeps
  /** Where this wallet's collected txids are remembered. Default: localStorage. */
  storage?: KeyValueStore
  onChange?: (txid: string, state: CollectState) => void
  /** Default: collectTip. */
  collect?: typeof collectTip
}

/**
 * Runs collectTip for every tip the page hears of, once per txid at a time. A tip event is ignored when it
 * carries no candidate this Collector has not seen; a new candidate (a front-run, then the honest post) runs the
 * tip again after a run that did not collect it. Tips this wallet already collected are skipped.
 */
export class Collector {
  readonly states = new Map<string, CollectState>()
  private readonly known = new Map<string, Set<string>>()
  private readonly running = new Set<string>()
  private readonly rerun = new Set<string>()
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
  private set(txid: string, state: CollectState) {
    this.states.set(txid, state)
    this.opts.onChange?.(txid, state)
  }

  onTip(row: TipRow): void {
    const { txid } = row
    if (this.states.get(txid) === 'accepted') return
    if (this.collectedTxids().includes(txid)) {
      this.set(txid, 'accepted')
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

  /** Stops scheduling attempts (the page is closing). */
  stop(): void {
    this.abort.abort()
  }

  private async run(row: TipRow): Promise<void> {
    const { txid } = row
    this.running.add(txid)
    this.set(txid, 'collecting')
    let result: CollectResult
    try {
      result = await (this.opts.collect ?? collectTip)(this.opts.wallet, row, this.opts.api, { ...this.opts.deps, signal: this.abort.signal })
    } catch (e) {
      console.warn(`collecting ${txid} stopped: ${e instanceof Error ? e.message : String(e)}`)
      result = 'gave-up'
    }
    this.running.delete(txid)
    if (this.abort.signal.aborted) return
    if (result === 'accepted') this.storage.setItem(this.collectedKey, JSON.stringify([...this.collectedTxids(), txid]))
    this.set(txid, result)
    if (this.rerun.delete(txid) && result !== 'accepted' && result !== 'failed') void this.run(row)
  }
}
