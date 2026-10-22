import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Beef, P2PKH, Transaction, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk'
import { SAMPLE_ROOT, createApp } from '../server/app.js'
import { Arcade } from '../server/arcade.js'
import { loadServerConfig } from '../server/config.js'
import { openDb } from '../server/db.js'
import { relayApi, type RelayApi, type TipPost, type TipRow, type TipStatusView } from '../web/api'
import { claimCreator, collectTip } from '../web/collect'
import { MIN_TIP_SATS, sendTip, type KeyValueStore } from '../web/tip'
import { derive, GateUsageError, loadOrCreateRootKey, openGateWallet, type GateWallet } from './gate-wallet'
import { addProvenTx, WhatsOnChain } from './gate-woc'

// The testnet gate (pnpm gate <command>): the CI wallet and one real tip end to end, through the same modules the
// web app uses (web/tip.ts, web/collect.ts) against the real relay (server/), at 0-conf.
//   init     create the root key if absent; print the funding address and the two identity keys
//   address  print the same, never creating a key
//   sweep --txid <faucet txid> [--vout n]   optional: prove a faucet payment is spendable (import it into a temp
//                                           wallet, return it at once to the funding address, consolidated)
//   run [--relay <url>] [--sats n]          import the funding address's coins into fresh temp wallets, one tip
//                                           (tipper → relay → Arcade verdict → creator internalizes it), then
//                                           everything left goes back to the funding address
// The gate keeps no wallet state: between runs its coins sit at the funding address, so the key alone is enough.
// Testnet only: BSV_NETWORK=mainnet is refused (exit 2) before any key is read. Nothing prints the key.

type Env = Record<string, string | undefined>
interface Io {
  out(line: string): void
  err(line: string): void
}

const SEEN_WITHIN_MS = 20_000
const DEFAULT_SATS = 1000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function testnetOnly(env: Env): 'testnet' {
  const raw = env.BSV_NETWORK?.trim() || 'testnet'
  if (raw !== 'testnet') throw new GateUsageError(`gate runs on testnet only (BSV_NETWORK=${raw})`)
  return raw
}

/** ARCADE_URL or the public testnet Arcade; a known mainnet Arcade host is refused (the relay's own check). */
function arcadeUrlOf(env: Env): string {
  try {
    return loadServerConfig({ BSV_NETWORK: 'testnet', ARCADE_URL: env.ARCADE_URL }, () => {}).arcadeUrl
  } catch (e) {
    throw new GateUsageError(message(e))
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) throw new GateUsageError(`${name} needs a value`)
  return value
}

function wholeNumber(value: string | undefined, name: string, min: number): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
    throw new GateUsageError(`${name} must be a whole number of at least ${min}`)
  }
  return Number(value)
}

function printIdentities(io: Io, rootKeyHex: string) {
  const d = derive(rootKeyHex)
  io.out(`funding address: ${d.fundingAddress}`)
  io.out(`tipper identity: ${d.tipperIdentityKey}`)
  io.out(`creator identity: ${d.creatorIdentityKey}`)
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

// ---------------------------------------------------------------------------------------------------------------
// Coins. Between runs every gate coin sits at the funding address (P2PKH of the root key), so the key alone is
// enough on any machine: a command imports the coins into fresh wallets in a temp dir, and returns whatever is
// left to the funding address before the temp dir goes.

/** Room for the import, tip and sweep-back fees at the toolbox's 100 sat/kB. */
export const FEE_RESERVE_SATS = 500
/** At most this many coins are imported per run (largest first); sweep-back consolidates them. */
const MAX_COINS = 20

export class GateFailure extends Error {}

/** Throws when the coins the gate can use do not cover the tip plus fees. */
export function checkFunding(o: { address: string; usable: number; unusable: number; sats: number }): void {
  const needed = o.sats + FEE_RESERVE_SATS
  if (o.usable >= needed) return
  throw new GateFailure(
    `the funding address ${o.address} holds ${o.usable} usable sats (${o.unusable} more not yet usable); the gate needs at least ${needed} (a ${o.sats}-sat tip plus fees). Fund it from https://bsvfaucet.com`,
  )
}

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
async function gatherCoins(
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

/** Imports the coins into `wallet` with Setup.fundWalletFromP2PKHOutpoints, signed by the root key; one row each. */
async function importCoins(wallet: GateWallet, rootKeyHex: string, coins: Coins, rows: Row[]): Promise<void> {
  if (coins.outpoints.length === 0) return
  const { Setup } = await import('@bsv/wallet-toolbox')
  const results = await Setup.fundWalletFromP2PKHOutpoints(broadcastNow(wallet.wallet), coins.outpoints, Setup.getKeyPair(rootKeyHex), coins.beef.toBinary())
  for (const r of results) rows.push({ step: `import ${r.outpoint}`, txid: r.txid, verdict: r.success ? 'imported' : `failed: ${r.error ?? 'no txid'}` })
}

// An output of this amount takes everything the wallet can fund (wallet-toolbox's sendMax sentinel; the module is
// CommonJS-only, so it is required rather than imported).
const maxPossibleSatoshis = (): number =>
  (createRequire(import.meta.url)('@bsv/wallet-toolbox/out/src/storage/methods/maxPossibleSatoshis') as { maxPossibleSatoshis: number }).maxPossibleSatoshis

/** Sends everything in `wallet` to the funding address (one P2PKH output, no change); a row with its Arcade status. */
async function sweepBack(wallet: GateWallet, name: string, fundingAddress: string, arcade: Arcade, rows: Row[]): Promise<void> {
  if ((await wallet.wallet.balance()) === 0) {
    rows.push({ step: `sweep-back ${name}`, verdict: 'empty' })
    return
  }
  const t0 = performance.now()
  const car = await wallet.wallet.createAction({
    description: 'gate sweep-back',
    outputs: [{ lockingScript: new P2PKH().lock(fundingAddress).toHex(), satoshis: maxPossibleSatoshis(), outputDescription: 'back to the funding address' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  })
  if (car.txid === undefined || car.tx === undefined) throw new Error('the wallet returned no transaction')
  const tx = Transaction.fromAtomicBEEF(car.tx)
  const read = await arcade.read(car.txid, SEEN_WITHIN_MS).catch(() => undefined)
  rows.push({
    step: `sweep-back ${name}`,
    txid: car.txid,
    bytes: tx.toBinary().length,
    fee: tx.getFee(),
    txStatus: read?.txStatus ?? 'unknown to Arcade',
    verdict: read?.verdict ?? 'no-verdict',
    ms: Math.round(performance.now() - t0),
  })
  const left = await wallet.wallet.balance()
  if (left > 0) throw new Error(`${left} sats are still in the ${name} wallet`)
}

/**
 * Returns what is left in each wallet to the funding address (best effort: every wallet is tried), closes them, and
 * deletes the temp data dir. A wallet that could not be emptied keeps the dir: its storage is the only record of
 * those coins. Returns why, when something was left behind.
 */
async function returnCoinsAndClean(
  wallets: Array<[string, GateWallet | undefined]>,
  dataDir: string,
  fundingAddress: string,
  arcade: Arcade,
  rows: Row[],
  io: Io,
): Promise<string | undefined> {
  const stranded: string[] = []
  for (const [name, w] of wallets) {
    if (w === undefined) continue
    try {
      await sweepBack(w, name, fundingAddress, arcade, rows)
    } catch (e) {
      stranded.push(`${name}: ${message(e)}`)
      rows.push({ step: `sweep-back ${name}`, verdict: 'failed' })
    }
  }
  for (const [, w] of wallets) await w?.close().catch(e => io.err(`closing a wallet: ${message(e)}`))
  if (stranded.length === 0) {
    rmSync(dataDir, { recursive: true, force: true })
    return undefined
  }
  io.err(`kept ${dataDir}: it holds the only record of coins that did not go back to ${fundingAddress}`)
  return `sweep-back failed (${stranded.join('; ')})`
}

async function sweep(argv: string[], env: Env, io: Io): Promise<number> {
  const { rootKeyHex } = loadOrCreateRootKey({ create: false, env })
  const txid = flag(argv, '--txid')?.toLowerCase()
  if (txid === undefined || !/^[0-9a-f]{64}$/.test(txid)) throw new GateUsageError('sweep needs --txid <the faucet txid, 64 hex characters>')
  const vout = wholeNumber(flag(argv, '--vout'), '--vout', 0)
  const arcadeUrl = arcadeUrlOf(env)
  const arcade = new Arcade(arcadeUrl)
  const woc = new WhatsOnChain()
  const { fundingAddress } = derive(rootKeyHex)
  const fundingScript = new P2PKH().lock(fundingAddress).toHex()

  // Which outputs of the faucet tx pay the funding address (all of them unless --vout).
  const probe = await addProvenTx(new Beef(), txid, arcade, woc)
  const outputs = probe.findTxid(txid)?.tx?.outputs ?? []
  const vouts = vout !== undefined ? [vout] : outputs.flatMap((o, i) => (o.lockingScript.toHex() === fundingScript ? [i] : []))
  if (vouts.length === 0) throw new GateUsageError(`no output of ${txid} pays the funding address ${fundingAddress}`)
  const coins = await gatherCoins(
    vouts.map(v => ({ txid, vout: v })),
    fundingScript,
    arcade,
    woc,
    probe,
  )
  coins.skipped.forEach(line => io.err(`skipped ${line}`))
  if (coins.outpoints.length === 0) throw new GateFailure(`no output of ${txid} can be imported`)

  const rows: Row[] = []
  const dataDir = mkdtempSync(join(tmpdir(), 'bsv-gate-'))
  let tipper: GateWallet | undefined
  let failure: string | undefined
  try {
    tipper = await openGateWallet(rootKeyHex, 'tipper', 'testnet', arcadeUrl, dataDir)
    await importCoins(tipper, rootKeyHex, coins, rows)
  } catch (e) {
    failure = message(e)
  }
  failure = (await returnCoinsAndClean([['tipper', tipper]], dataDir, fundingAddress, arcade, rows, io)) ?? failure
  tableLines(rows).forEach(line => io.out(line))
  if (failure === undefined && rows.some(r => r.verdict?.startsWith('failed'))) failure = 'an import failed'
  if (failure !== undefined) {
    io.err(`gate sweep failed: ${failure}`)
    return 1
  }
  return 0
}

// ---------------------------------------------------------------------------------------------------------------
// run

interface Relay {
  base: string
  inProcess: boolean
  close(): Promise<void>
}

/** The real relay (server/app.ts) on a free loopback port, its creator fixed to the gate's creator identity. */
async function startRelay(arcadeUrl: string, creatorIdentityKey: string, io: Io): Promise<Relay> {
  const server = http.createServer()
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok())
  })
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  const cfg = loadServerConfig(
    { BSV_NETWORK: 'testnet', ARCADE_URL: arcadeUrl, PUBLIC_ORIGIN: base, CREATOR_IDENTITY_KEY: creatorIdentityKey, TRUST_PROXY: 'false', PORT: String(port) },
    line => io.err(line),
  )
  const db = openDb(':memory:')
  server.on('request', createApp(cfg, { db, arcade: new Arcade(cfg.arcadeUrl) }))
  return {
    base,
    inProcess: true,
    close: () =>
      new Promise<void>(done => {
        server.close(() => {
          db.close()
          done()
        })
        server.closeAllConnections()
      }),
  }
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>()
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: k => void m.delete(k),
    key: i => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

interface Row {
  step: string
  txid?: string
  bytes?: number
  fee?: number
  txStatus?: string
  verdict?: string
  ms?: number
}

const cell = (v: string | number | undefined) => (v === undefined ? '' : String(v))
const tableLines = (rows: Row[]) => [
  '| step | txid | bytes | fee sats | txStatus | verdict | ms |',
  '|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.step} | ${cell(r.txid)} | ${cell(r.bytes)} | ${cell(r.fee)} | ${cell(r.txStatus)} | ${cell(r.verdict)} | ${cell(r.ms)} |`),
]

/** docs/evals in the kit repo (two levels above the sample); in a standalone copy, the sample's own docs/evals. */
function evalsDir(): string {
  const repo = resolve(SAMPLE_ROOT, '..', '..')
  return existsSync(join(repo, 'pnpm-workspace.yaml')) ? join(repo, 'docs', 'evals') : join(SAMPLE_ROOT, 'docs', 'evals')
}

async function run(argv: string[], env: Env, io: Io): Promise<number> {
  const { rootKeyHex } = loadOrCreateRootKey({ create: false, env })
  if (env.BSV_MCP_NETWORK_TESTS !== '1') {
    throw new GateUsageError('gate run spends testnet coins through Arcade: set BSV_MCP_NETWORK_TESTS=1 to run it')
  }
  const sats = wholeNumber(flag(argv, '--sats'), '--sats', MIN_TIP_SATS) ?? DEFAULT_SATS
  const relayUrl = flag(argv, '--relay')
  if (relayUrl !== undefined && !/^https?:\/\/[^/]+\/?$/.test(relayUrl)) throw new GateUsageError('--relay must be an origin such as http://127.0.0.1:8080')
  const arcadeUrl = arcadeUrlOf(env)
  const arcade = new Arcade(arcadeUrl)
  const woc = new WhatsOnChain()
  const { fundingAddress } = derive(rootKeyHex)
  const started = new Date()
  const rows: Row[] = []
  let failure: string | undefined
  let probeTxid: string | undefined

  // Fresh wallets every run, in a temp dir that is deleted once their coins are back at the funding address.
  const dataDir = mkdtempSync(join(tmpdir(), 'bsv-gate-'))
  let tipper: GateWallet | undefined
  let creator: GateWallet | undefined
  let relay: Relay | undefined
  try {
    // 1. The coins at the funding address (WhatsOnChain's address listing; each tx from Arcade first, hash-checked).
    const listed = (await woc.unspent(fundingAddress)).sort((a, b) => b.satoshis - a.satoshis).slice(0, MAX_COINS)
    const coins = await gatherCoins(listed, new P2PKH().lock(fundingAddress).toHex(), arcade, woc)
    coins.skipped.forEach(line => io.err(`skipped ${line}`))
    checkFunding({ address: fundingAddress, usable: coins.total, unusable: coins.unusable, sats })

    // 2. Into a fresh tipper wallet.
    tipper = await openGateWallet(rootKeyHex, 'tipper', 'testnet', arcadeUrl, dataDir)
    creator = await openGateWallet(rootKeyHex, 'creator', 'testnet', arcadeUrl, dataDir)
    await importCoins(tipper, rootKeyHex, coins, rows)
    const balance = await tipper.wallet.balance()
    if (balance < sats + FEE_RESERVE_SATS) throw new GateFailure(`the tipper wallet holds ${balance} sats after the import (needs ${sats + FEE_RESERVE_SATS})`)

    // 3. The tip and its collection.
    relay = relayUrl === undefined ? await startRelay(arcadeUrl, creator.identityKey, io) : { base: relayUrl.replace(/\/$/, ''), inProcess: false, close: async () => {} }
    probeTxid = await tipAndCollect(tipper, creator, relay, sats, rows, io)
  } catch (e) {
    failure = message(e)
    probeTxid = undefined
  }
  await relay?.close()

  // 4 and 5. Everything left in both wallets goes back to the funding address, also after a failure; then the temp dir goes.
  const left = await returnCoinsAndClean([['creator', creator], ['tipper', tipper]], dataDir, fundingAddress, arcade, rows, io)
  if (left !== undefined) failure = failure === undefined ? left : `${failure}; ${left}`

  const table = tableLines(rows)
  table.forEach(line => io.out(line))
  // A time suffix, so a later run on the same day never overwrites an earlier record.
  const file = join(evalsDir(), `gate-${started.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '')}.md`)
  mkdirSync(evalsDir(), { recursive: true })
  writeFileSync(
    file,
    [
      `# Gate run ${started.toISOString()}`,
      '',
      `- network: testnet`,
      `- arcade: ${arcadeUrl}`,
      `- relay: ${relay === undefined ? 'not started' : relay.inProcess ? 'in-process' : relay.base}`,
      `- funding address: ${fundingAddress}`,
      `- tip: ${sats} sats`,
      `- result: ${failure === undefined ? 'pass' : `FAIL: ${failure}`}`,
      '',
      ...table,
      '',
    ].join('\n'),
  )
  io.err(`wrote ${file}`)
  if (failure !== undefined) {
    io.err(`gate run failed: ${failure}`)
    return 1
  }
  io.out(`probeTxid: ${probeTxid}`)
  return 0
}

/**
 * One tip through the web app's own modules against `relay`: web/tip.ts's sendTip (derivation saved first, BRC-29
 * output to the creator, createAction with randomizeOutputs:false and acceptDelayedBroadcast:false, POST /api/tips),
 * the relay's Arcade verdict within 20 s, then web/collect.ts's collectTip (the candidate's own BEEF,
 * internalizeAction, the signed internalized report). Returns the tip's txid; throws GateFailure on a failed step.
 */
async function tipAndCollect(tipper: GateWallet, creator: GateWallet, relay: Relay, sats: number, rows: Row[], io: Io): Promise<string> {
  const api = relayApi((input, init) => fetch(input, init), relay.base)
  // Timings around the relay POST; the call itself is the real one.
  let posted: TipPost | undefined
  let postStartedAt = 0
  let postEndedAt = 0
  const timedApi: RelayApi = {
    ...api,
    postTip: async body => {
      posted = body
      postStartedAt ||= performance.now()
      try {
        return await api.postTip(body)
      } finally {
        postEndedAt = performance.now()
      }
    },
  }

  const cfg = await api.config()
  if (cfg.network !== 'testnet') throw new GateFailure(`the relay at ${relay.base} is on ${cfg.network}`)
  const role = await claimCreator(creator.wallet, creator.identityKey, api)
  if (role.role !== 'creator') throw new GateFailure(`the relay's creator is ${role.creatorIdentityKey}, not the gate's creator ${creator.identityKey}`)

  const t0 = performance.now()
  const outcome = await sendTip(tipper.wallet, cfg, creator.identityKey, sats, timedApi, { storage: memoryStore(), postAttempts: 3 })
  const txid = outcome.txid
  if (posted !== undefined) {
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(posted.beef, 'hex'))
    rows.push({ step: 'tipper createAction', txid, bytes: tx.toBinary().length, fee: tx.getFee(), ms: Math.round(postStartedAt - t0) })
  }
  if (!outcome.posted) throw new GateFailure(`the relay did not take the tip: ${outcome.error}`)
  if (outcome.walletError !== undefined) io.err(`the tipper wallet reported: ${outcome.walletError}`)
  rows.push({ step: 'relay POST /api/tips', txid, txStatus: outcome.row.txStatus, verdict: outcome.row.verdict, ms: Math.round(postEndedAt - postStartedAt) })

  let view: TipStatusView = outcome.row
  while (view.verdict !== 'seen-no-competitor' && performance.now() - postStartedAt < SEEN_WITHIN_MS) {
    await sleep(1_000)
    try {
      view = await api.status(txid)
    } catch (e) {
      io.err(`status read: ${message(e)}`)
    }
  }
  rows.push({ step: 'relay status', txid, txStatus: view.txStatus, verdict: view.verdict, ms: Math.round(performance.now() - postStartedAt) })
  if (view.verdict !== 'seen-no-competitor') throw new GateFailure(`Arcade did not report seen-no-competitor within ${SEEN_WITHIN_MS / 1000} s (${view.txStatus})`)

  const c0 = performance.now()
  const row: TipRow = await api.getTip(txid)
  const collected = await collectTip(creator.wallet, row, api, { originator: cfg.originator, network: 'testnet', delaysMs: [2_000, 5_000, 10_000] })
  rows.push({ step: 'creator internalizeAction', txid, verdict: collected.result, ms: Math.round(performance.now() - c0) })
  if (collected.result !== 'accepted') throw new GateFailure(`the creator wallet did not collect the tip: ${collected.result}${collected.error ? ` (${collected.error})` : ''}`)
  const reported = await api.getTip(txid)
  rows.push({ step: 'relay internalized report', txid, verdict: reported.internalizedAt !== undefined ? 'reported' : 'not reported' })
  if (reported.internalizedAt === undefined) throw new GateFailure("the relay did not record the creator's signed internalized report")
  return txid
}

// ---------------------------------------------------------------------------------------------------------------

/** The gate CLI. Returns the exit code: 0 pass, 1 a failed step or assertion, 2 a usage or safety refusal. */
export async function main(argv: string[], env: Env = process.env, io: Io = stdio): Promise<number> {
  const [command, ...rest] = argv
  try {
    testnetOnly(env) // before anything reads a key
    switch (command) {
      case 'init':
        printIdentities(io, loadOrCreateRootKey({ create: true, env }).rootKeyHex)
        return 0
      case 'address':
        printIdentities(io, loadOrCreateRootKey({ create: false, env }).rootKeyHex)
        return 0
      case 'sweep':
        return await sweep(rest, env, io)
      case 'run':
        return await run(rest, env, io)
      default:
        throw new GateUsageError('usage: gate init | address | sweep --txid <txid> [--vout n] | run [--relay <url>] [--sats n]')
    }
  } catch (e) {
    io.err(`gate: ${message(e)}`)
    return e instanceof GateUsageError ? 2 : 1
  }
}

// Written synchronously, so process.exit cannot cut the output short on a pipe.
const stdio: Io = {
  out: line => void writeSync(1, `${line}\n`),
  err: line => void writeSync(2, `${line}\n`),
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The toolbox keeps timers and sockets open; exit once the command is done.
  main(process.argv.slice(2)).then(code => process.exit(code))
}
