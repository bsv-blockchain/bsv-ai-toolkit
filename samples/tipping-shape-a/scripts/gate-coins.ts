import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Beef, P2PKH, Transaction, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import type { Arcade, Outcome } from '../server/arcade.js'
import { payeeLockingScript } from '../web/brc29'
import type { KeyValueStore, PendingTip } from '../web/tip'
import { homeOf, type GateWallet } from './gate-wallet'
import { addProvenTx, type WhatsOnChain } from './gate-woc'

// The gate's coins. Between runs every coin sits at the funding address (P2PKH of the root key), so the key alone
// is enough on any machine. A command works in a run dir under ~/.bsv-gate/runs/: it imports the coins into fresh
// wallets there, and at the end returns everything to the funding address. The run dir is deleted only once
// nothing can be lost with it: every sweep-back (and anything the toolbox left unfinished) reads
// seen-no-competitor on our Arcade, both wallets are empty, and a tip that went out has been collected. Otherwise
// it stays, with `gate recover --dir <path>` to finish the job: its wallet storage is the only record of the
// derivations that spend those coins.

type Env = Record<string, string | undefined>
export interface Io {
  out(line: string): void
  err(line: string): void
}

export interface Row {
  step: string
  txid?: string
  bytes?: number
  fee?: number
  txStatus?: string
  verdict?: string
  ms?: number
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Room for the import, tip and sweep-back fees at the toolbox's 100 sat/kB. */
export const FEE_RESERVE_SATS = 500
/** How long to wait for Arcade's seen-no-competitor on each read. */
export const SEEN_WITHIN_MS = 20_000
/** The label on every sweep-back action, so a later `recover` finds and re-checks them. */
export const SWEEP_LABEL = 'gate sweep back'
/** The label Setup.fundWalletFromP2PKHOutpoints puts on each import (wallet-toolbox 2.14.9, fundWalletP2PKH.js). */
export const IMPORT_LABEL = 'p2pkh-funding'
// Toolbox action states in which the transaction may not have reached the network.
const UNFINISHED = new Set(['unprocessed', 'sending', 'unsigned', 'nosend', 'nonfinal'])

export class GateFailure extends Error {}

/** Throws when the coins the gate can use do not cover the tip plus fees. */
export function checkFunding(o: { address: string; usable: number; unusable: number; sats: number }): void {
  const needed = o.sats + FEE_RESERVE_SATS
  if (o.usable >= needed) return
  throw new GateFailure(
    `the funding address ${o.address} holds ${o.usable} usable sats (${o.unusable} more not yet usable); the gate needs at least ${needed} (a ${o.sats}-sat tip plus fees). Fund it from https://bsvfaucet.com`,
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Run dirs

const RUN_MARKER = 'run.json'
const TIP_FILE = 'tip.json'
const LOCK_FILE = 'run.lock'

/** Writes JSON atomically, owner-only. */
function writeJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * A new run dir under ~/.bsv-gate/runs/ (0700), locked by this process and marked with the funding address it
 * belongs to.
 */
export function createRunDir(fundingAddress: string, env: Env = process.env): string {
  const runs = join(homeOf(env), '.bsv-gate', 'runs')
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(runs, 'run-'))
  lockRunDir(dir)
  writeJson(join(dir, RUN_MARKER), { kind: 'bsv-gate-run', fundingAddress, createdAt: new Date().toISOString() })
  return dir
}

/** True while a process with this pid exists (EPERM: it exists, under another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes the run dir's lock ({ pid, startedAt }) for this process. A lock whose process is gone is stale and taken
 * over; a lock held by a live process refuses: its run (or recover) is still working on the dir.
 */
export function lockRunDir(dir: string): void {
  const path = join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      } finally {
        closeSync(fd)
      }
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let held: { pid?: unknown; startedAt?: unknown } = {}
    try {
      held = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // unreadable: treated as stale
    }
    if (typeof held.pid === 'number' && held.pid !== process.pid && alive(held.pid)) {
      throw new Error(`${dir} is in use by a live gate process (pid ${held.pid}, since ${String(held.startedAt)}); let it finish first`)
    }
    unlinkSync(path) // stale: its process is gone
  }
  throw new Error(`${dir} is being locked by another gate process`)
}

/** Releases this process's lock on the run dir (a kept dir must be free for `gate recover`). */
export function unlockRunDir(dir: string): void {
  const path = join(dir, LOCK_FILE)
  try {
    if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path)
  } catch {
    // no lock, or not ours
  }
}

/** True when the run dir holds SQLite storage of the named wallet. */
const walletFileIn = (dir: string, name: string) => readdirSync(dir).some(f => f.startsWith(`${name}-`) && f.endsWith('.sqlite'))

/** Throws unless `dir` is a run dir of this funding address. */
export function checkRunDir(dir: string, fundingAddress: string): void {
  let marker: { kind?: unknown; fundingAddress?: unknown }
  try {
    marker = JSON.parse(readFileSync(join(dir, RUN_MARKER), 'utf8'))
  } catch {
    throw new Error(`${dir} is not a gate run dir (no readable ${RUN_MARKER})`)
  }
  if (marker.kind !== 'bsv-gate-run') throw new Error(`${dir} is not a gate run dir`)
  if (marker.fundingAddress !== fundingAddress) throw new Error(`${dir} belongs to the funding address ${String(marker.fundingAddress)}, not ${fundingAddress}: wrong key?`)
}

// ---------------------------------------------------------------------------------------------------------------
// The tip in flight. Its remittance (public values: no key) is written to the run dir before the tip is broadcast
// and kept until the creator wallet holds it, so a failure anywhere after the broadcast can still collect it.

export interface SavedTip {
  txid?: string
  /** AtomicBEEF hex, as the tipper's createAction returned it. */
  beef?: string
  outputIndex: number
  satoshis: number
  recipient: string
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  collected?: boolean
}

export function readSavedTip(dir: string): SavedTip | undefined {
  const path = join(dir, TIP_FILE)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as SavedTip
}

/** The tipper surface the saved-tip checks need (a toolbox Wallet, or a fake in tests). */
export type TipperWallet = Pick<GateWallet, 'beef'> & { wallet: Pick<Wallet, 'listActions' | 'getPublicKey'> }

/** The tipper's actions other than imports and sweep-backs: the tip, if it was ever made. */
async function tipActions(tipper: TipperWallet): Promise<string[]> {
  const { actions } = await tipper.wallet.listActions({ labels: [], includeLabels: true, limit: 1000 })
  return actions.filter(a => !(a.labels ?? []).some(l => l === IMPORT_LABEL || l === SWEEP_LABEL)).map(a => a.txid)
}

/**
 * True when a tip may have gone out and is not in the creator wallet yet. A write-ahead without a txid (the process
 * stopped between the broadcast and the second write) counts too, unless the tipper wallet holds nothing but
 * imports and sweep-backs; with the tipper wallet unreadable, it counts whenever that wallet's storage exists.
 */
async function tipOpen(t: SavedTip | undefined, dir: string, tipper: TipperWallet | undefined): Promise<boolean> {
  if (t === undefined || t.collected) return false
  if (t.txid !== undefined) return true
  if (tipper === undefined) return walletFileIn(dir, 'tipper')
  return (await tipActions(tipper)).length > 0
}

/**
 * Fills in a write-ahead that has no txid from the tipper wallet: the one tip action whose transaction pays the
 * saved derivation's output. Returns the completed record, or the record unchanged when no action matches.
 */
async function completeSavedTip(t: SavedTip, dir: string, tipper: TipperWallet): Promise<SavedTip> {
  const lockingScript = await payeeLockingScript(tipper.wallet as unknown as Parameters<typeof payeeLockingScript>[0], t.recipient, t.derivationPrefix, t.derivationSuffix)
  for (const txid of await tipActions(tipper)) {
    let beef: Beef
    try {
      beef = Beef.fromBinary(await tipper.beef(txid))
    } catch {
      continue // no transaction in storage for it
    }
    const outputIndex = beef.findAtomicTransaction(txid)?.outputs.findIndex(o => o.lockingScript.toHex() === lockingScript && o.satoshis === t.satoshis) ?? -1
    if (outputIndex < 0) continue
    const done: SavedTip = { ...t, txid, beef: Utils.toHex(beef.toBinaryAtomic(txid)), outputIndex }
    writeJson(join(dir, TIP_FILE), done)
    return done
  }
  return t
}

export function markTipCollected(dir: string): void {
  const t = readSavedTip(dir)
  if (t !== undefined) writeJson(join(dir, TIP_FILE), { ...t, collected: true })
}

/**
 * The KeyValueStore web/tip.ts's sendTip writes its pending record to: every write (the write-ahead before
 * createAction, then the record with the txid and AtomicBEEF) also goes to <dir>/tip.json, which outlives
 * sendTip's removeItem once the relay has the tip.
 */
export function savedTipStore(dir: string): KeyValueStore {
  const m = new Map<string, string>()
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v)
      const r = JSON.parse(v) as PendingTip
      const saved: SavedTip = {
        txid: r.txid,
        beef: r.beef,
        outputIndex: r.outputIndex,
        satoshis: r.satoshis,
        recipient: r.recipient,
        senderIdentityKey: r.senderIdentityKey,
        derivationPrefix: r.derivationPrefix,
        derivationSuffix: r.derivationSuffix,
      }
      writeJson(join(dir, TIP_FILE), saved)
    },
    removeItem: k => void m.delete(k),
    key: i => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

/**
 * Collects the saved tip straight into the creator wallet (internalizeAction with its BEEF and remittance), when it
 * went out and is not collected yet. Used after a failure in the tip stage, and by `gate recover`.
 */
export async function collectSavedTip(creator: Pick<GateWallet, 'wallet'>, dir: string, rows: Row[], tipper?: TipperWallet): Promise<void> {
  let t = readSavedTip(dir)
  if (t === undefined || t.collected) return
  if (t.txid === undefined && tipper !== undefined) t = await completeSavedTip(t, dir, tipper)
  if (t.txid === undefined) return
  if (t.beef === undefined || t.outputIndex < 0) throw new Error(`the saved tip ${t.txid} has no transaction to collect`)
  const { actions } = await creator.wallet.listActions({ labels: [], limit: 1000 })
  if (!actions.some(a => a.txid === t.txid)) {
    const { accepted } = await creator.wallet.internalizeAction({
      tx: Utils.toArray(t.beef, 'hex'),
      outputs: [
        {
          outputIndex: t.outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: { senderIdentityKey: t.senderIdentityKey, derivationPrefix: t.derivationPrefix, derivationSuffix: t.derivationSuffix },
        },
      ],
      description: 'Tip received',
    })
    if (!accepted) throw new Error(`the creator wallet did not accept the saved tip ${t.txid}`)
  }
  markTipCollected(dir)
  rows.push({ step: 'creator internalizeAction (saved tip)', txid: t.txid, verdict: 'accepted' })
}

// ---------------------------------------------------------------------------------------------------------------
// In: the funding address's coins into a wallet

interface Coins {
  /** Every coin's transaction with a merkle path or the Arcade-known ancestry down to one. */
  beef: Beef
  outpoints: string[]
  total: number
  /** Sats in coins that cannot be imported yet (in no block and unknown to Arcade), with the reasons. */
  unusable: number
  skipped: string[]
}

/** The given outputs that pay the funding address and can be proven now. */
export async function gatherCoins(
  candidates: Array<{ txid: string; vout: number; satoshis?: number }>,
  fundingScript: string,
  arcade: Arcade,
  woc: WhatsOnChain,
  beef = new Beef(),
): Promise<Coins> {
  const coins: Coins = { beef, outpoints: [], total: 0, unusable: 0, skipped: [] }
  const byTxid = new Map<string, typeof candidates>()
  for (const c of candidates) byTxid.set(c.txid, [...(byTxid.get(c.txid) ?? []), c])
  for (const [txid, outs] of byTxid) {
    try {
      await addProvenTx(coins.beef, txid, arcade, woc)
    } catch (e) {
      coins.unusable += outs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0)
      coins.skipped.push(`${txid}: ${message(e)}`)
      continue
    }
    const tx = coins.beef.findTxid(txid)?.tx
    for (const { vout } of outs) {
      const out = tx?.outputs[vout]
      if (out === undefined || out.lockingScript.toHex() !== fundingScript || typeof out.satoshis !== 'number') {
        coins.skipped.push(`${txid}.${vout}: does not pay the funding address`)
        continue
      }
      coins.outpoints.push(`${txid}.${vout}`)
      coins.total += out.satoshis
    }
  }
  return coins
}

/** The wallet, with every createAction (and the signAction that completes it) broadcast now, not by the Monitor. */
function broadcastNow(wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get(target, prop) {
      if (prop === 'createAction') {
        return (args: CreateActionArgs, originator?: string) =>
          target.createAction({ ...args, options: { ...args.options, acceptDelayedBroadcast: false } }, originator)
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Imports the coins into `wallet` with Setup.fundWalletFromP2PKHOutpoints, signed by the root key; one row each. */
export async function importCoins(wallet: GateWallet, rootKeyHex: string, coins: Coins, rows: Row[]): Promise<void> {
  if (coins.outpoints.length === 0) return
  const { Setup } = await import('@bsv/wallet-toolbox')
  const results = await Setup.fundWalletFromP2PKHOutpoints(broadcastNow(wallet.wallet), coins.outpoints, Setup.getKeyPair(rootKeyHex), coins.beef.toBinary())
  for (const r of results) rows.push({ step: `import ${r.outpoint}`, txid: r.txid, verdict: r.success ? 'imported' : `failed: ${r.error ?? 'no txid'}` })
}

// ---------------------------------------------------------------------------------------------------------------
// Out: everything back to the funding address, checked on Arcade

// An output of this amount takes everything the wallet can fund (wallet-toolbox's sendMax sentinel; the module is
// CommonJS-only, so it is required rather than imported).
const maxPossibleSatoshis = (): number =>
  (createRequire(import.meta.url)('@bsv/wallet-toolbox/out/src/storage/methods/maxPossibleSatoshis') as { maxPossibleSatoshis: number }).maxPossibleSatoshis

/**
 * Posts a wallet transaction straight to Arcade as EF, after each of its unproven ancestors in the BEEF (parents
 * first; "already known" is fine), then reads its status (up to `waitMs`).
 */
export async function postChain(arcade: Arcade, beefBin: number[], txid: string, waitMs: number): Promise<Outcome> {
  const beef = Beef.fromBinary(beefBin)
  beef.sortTxs()
  for (const btx of beef.txs) {
    if (btx.txid === txid || btx.isTxidOnly || btx.bumpIndex !== undefined) continue
    const ancestor = await arcade.broadcast(beef.findAtomicTransaction(btx.txid)!.toHexEF(), btx.txid, 0)
    if (ancestor.verdict === 'terminal') {
      throw new Error(`Arcade refused ancestor ${btx.txid} (${ancestor.txStatus}${ancestor.extraInfo ? `: ${ancestor.extraInfo}` : ''})`)
    }
  }
  const subject = beef.findAtomicTransaction(txid)
  if (subject === undefined) throw new Error(`the wallet's BEEF for ${txid} does not hold it`)
  return arcade.broadcast(subject.toHexEF(), txid, waitMs)
}

/** The wallet surface the sweep-back needs (a toolbox Wallet, or a fake in tests). */
export type SettleWallet = Pick<GateWallet, 'beef'> & { wallet: Pick<Wallet, 'balance' | 'createAction' | 'listActions'> }

/** Arcade's read of a wallet transaction; when it is not seen-no-competitor, one direct re-post of its chain. */
async function confirmOnArcade(w: SettleWallet, txid: string, arcade: Arcade, waitMs: number): Promise<{ outcome?: Outcome; tx?: Transaction; error?: string }> {
  let tx: Transaction | undefined
  let beefBin: number[] | undefined
  try {
    beefBin = await w.beef(txid)
    tx = Beef.fromBinary(beefBin).findAtomicTransaction(txid)
  } catch {
    // no BEEF in storage: only Arcade's read can tell
  }
  let outcome = await arcade.read(txid, waitMs).catch(() => undefined)
  if (outcome?.verdict === 'seen-no-competitor' || beefBin === undefined) return { outcome, tx }
  try {
    outcome = await postChain(arcade, beefBin, txid, waitMs)
  } catch (e) {
    return { outcome, tx, error: message(e) }
  }
  return { outcome, tx }
}

/**
 * Returns everything in `w` to the funding address and checks it: re-posts what the toolbox left unfinished, sends
 * the balance in one output (sendMax, no change), then every sweep-back this wallet ever made, and every unfinished
 * action, must read seen-no-competitor on Arcade (after one direct re-post) and the balance must be 0. Returns the
 * problems; none means the wallet is settled.
 */
export async function settleWallet(
  w: SettleWallet,
  name: string,
  fundingAddress: string,
  arcade: Arcade,
  rows: Row[],
  waitMs = SEEN_WITHIN_MS,
): Promise<string[]> {
  const unfinished = (await w.wallet.listActions({ labels: [], limit: 1000 })).actions.filter(a => UNFINISHED.has(a.status)).map(a => a.txid)
  const t0 = performance.now()
  let createError: string | undefined
  if ((await w.wallet.balance()) > 0) {
    try {
      await w.wallet.createAction({
        description: 'gate sweep-back',
        labels: [SWEEP_LABEL],
        outputs: [{ lockingScript: new P2PKH().lock(fundingAddress).toHex(), satoshis: maxPossibleSatoshis(), outputDescription: 'back to the funding address' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      })
    } catch (e) {
      // A broadcast the toolbox could not finish still leaves a labelled action: it is checked (and re-posted) below.
      createError = `${name}: the sweep-back did not complete in the wallet (${message(e)})`
    }
  }
  const problems: string[] = []
  const sweeps = (await w.wallet.listActions({ labels: [SWEEP_LABEL], limit: 1000 })).actions.filter(a => a.status !== 'failed').map(a => a.txid)
  for (const txid of new Set([...unfinished, ...sweeps])) {
    const { outcome, tx, error } = await confirmOnArcade(w, txid, arcade, waitMs)
    if (sweeps.includes(txid)) {
      rows.push({
        step: `sweep-back ${name}`,
        txid,
        bytes: tx?.toBinary().length,
        fee: tx?.getFee(),
        txStatus: outcome?.txStatus ?? 'unknown to Arcade',
        verdict: outcome?.verdict ?? 'no-verdict',
        ms: Math.round(performance.now() - t0),
      })
    }
    if (outcome?.verdict !== 'seen-no-competitor') {
      problems.push(`${name}: ${txid} is not seen on Arcade (${outcome?.txStatus ?? 'unknown to Arcade'}${error ? `; ${error}` : ''})`)
    }
  }
  if (sweeps.length === 0) rows.push({ step: `sweep-back ${name}`, verdict: 'empty' })
  const left = await w.wallet.balance()
  if (left > 0) problems.push(`${name}: ${left} sats are still in the wallet`)
  // A toolbox error on a sweep-back that Arcade then saw (after the direct re-post) is no longer a problem.
  return problems.length > 0 && createError !== undefined ? [createError, ...problems] : problems
}

/** Everything returnCoinsAndClean uses of a gate wallet (a GateWallet, or a fake in tests). */
export type GateCoinWallet = SettleWallet & TipperWallet & Pick<GateWallet, 'close'>

/**
 * Settles every wallet (each is tried, whatever happened before), closes them, and deletes the run dir only when
 * nothing can be lost with it: every wallet settled and no tip left uncollected. Returns why the dir was kept.
 */
export async function returnCoinsAndClean(
  wallets: Array<[string, GateCoinWallet | undefined]>,
  dir: string,
  fundingAddress: string,
  arcade: Arcade,
  rows: Row[],
  io: Io,
  waitMs = SEEN_WITHIN_MS,
): Promise<string | undefined> {
  const problems: string[] = []
  for (const [name, w] of wallets) {
    if (w === undefined) {
      // Not opened (busy, corrupt, a failed migration): if it has storage here, that storage may hold coins.
      if (walletFileIn(dir, name)) problems.push(`${name}: its wallet in ${dir} could not be opened`)
      continue
    }
    try {
      problems.push(...(await settleWallet(w, name, fundingAddress, arcade, rows, waitMs)))
    } catch (e) {
      problems.push(`${name}: ${message(e)}`)
      rows.push({ step: `sweep-back ${name}`, verdict: 'failed' })
    }
  }
  const tip = readSavedTip(dir)
  try {
    if (await tipOpen(tip, dir, wallets.find(([name]) => name === 'tipper')?.[1])) {
      problems.push(`the tip ${tip?.txid ?? '(txid not recorded)'} may have gone out but is not in the creator wallet (its record: ${join(dir, TIP_FILE)})`)
    }
  } catch (e) {
    problems.push(`the saved tip could not be checked: ${message(e)}`)
  }
  for (const [, w] of wallets) await w?.close().catch(e => io.err(`closing a wallet: ${message(e)}`))
  if (problems.length === 0) {
    rmSync(dir, { recursive: true, force: true })
    return undefined
  }
  unlockRunDir(dir)
  io.err(`kept ${dir}: it holds the only record of coins not yet back at ${fundingAddress}; finish with: pnpm gate recover --dir ${dir}`)
  return problems.join('; ')
}
