import { writeSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Beef, MerklePath, P2PKH, Transaction, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk'
import { SAMPLE_ROOT, createApp } from '../server/app.js'
import { Arcade } from '../server/arcade.js'
import { plainHexFromArcadeRawTx } from '../server/beef.js'
import { loadServerConfig } from '../server/config.js'
import { openDb } from '../server/db.js'
import { relayApi, type RelayApi, type TipPost, type TipRow, type TipStatusView } from '../web/api'
import { claimCreator, collectTip } from '../web/collect'
import { MIN_TIP_SATS, sendTip, type KeyValueStore } from '../web/tip'
import { derive, gateDataDir, GateUsageError, loadOrCreateRootKey, openGateWallet, type GateWallet } from './gate-wallet'

// The testnet gate (pnpm gate <command>): the CI wallet and one real tip end to end, through the same modules the
// web app uses (web/tip.ts, web/collect.ts) against the real relay (server/), at 0-conf.
//   init     create the root key if absent; print the funding address and the two identity keys
//   address  print the same, never creating a key
//   sweep --txid <faucet txid> [--vout n]   move the faucet's payment to the funding address into the tipper wallet
//   run [--relay <url>] [--sats n]          one tip, tipper → relay → Arcade verdict → creator internalizes it
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

// ---------------------------------------------------------------------------------------------------------------
// WhatsOnChain: the one allowed use is the faucet tx Arcade never saw (and its proof). One process-wide gate keeps
// calls ≥ 350 ms apart; every call has a timeout; 429 backs off.

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/test'
const WOC_GAP_MS = 350
let wocQueue: Promise<unknown> = Promise.resolve()
let wocNextAt = 0

function wocGate<T>(call: () => Promise<T>): Promise<T> {
  const run = wocQueue.then(async () => {
    const wait = wocNextAt - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await call()
    } finally {
      wocNextAt = Date.now() + WOC_GAP_MS
    }
  })
  wocQueue = run.catch(() => {})
  return run
}

/** GET from WhatsOnChain testnet, gated; undefined on 404. */
async function wocGet(path: string): Promise<string | undefined> {
  for (let attempt = 1; ; attempt++) {
    const res = await wocGate(() => fetch(`${WOC_BASE}${path}`, { signal: AbortSignal.timeout(10_000) }))
    const text = await res.text()
    if (res.status === 429 && attempt < 4) {
      await sleep(2_000 * attempt)
      continue
    }
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`WhatsOnChain GET ${path} answered HTTP ${res.status}`)
    return text.trim()
  }
}

export interface TscProof {
  index: number
  txOrId: string
  /** The block hash. */
  target: string
  /** Sibling hashes from the leaf level up; '*' duplicates the node itself. */
  nodes: string[]
}

/** A TSC merkle proof (WhatsOnChain /tx/{txid}/proof/tsc) as a BUMP for the block at `blockHeight`. */
export function tscToMerklePath(tsc: TscProof, blockHeight: number): MerklePath {
  const HASH = /^[0-9a-f]{64}$/i
  if (!Number.isSafeInteger(tsc.index) || tsc.index < 0 || !HASH.test(tsc.txOrId) || !Array.isArray(tsc.nodes)) {
    throw new Error('the TSC proof is not a proof for a txid')
  }
  type Leaf = { offset: number; hash?: string; txid?: boolean; duplicate?: boolean }
  const leaf = (offset: number, node: string): Leaf => {
    if (node === '*') return { offset, duplicate: true }
    if (!HASH.test(node)) throw new Error('the TSC proof has a node that is not a hash')
    return { offset, hash: node.toLowerCase() }
  }
  // Level h holds the sibling of the path's node at h; level 0 also holds the tx itself.
  const path: Leaf[][] = tsc.nodes.map((node, height) => [leaf((tsc.index >> height) ^ 1, node)])
  if (path.length === 0) path.push([])
  path[0].push({ offset: tsc.index, hash: tsc.txOrId.toLowerCase(), txid: true })
  path[0].sort((a, b) => a.offset - b.offset)
  return new MerklePath(blockHeight, path)
}

interface FaucetTx {
  tx: Transaction
  source: 'Arcade' | 'WhatsOnChain'
}

/**
 * The faucet transaction with its merkle path. Arcade first (its rawTx is Extended Format, re-read as plain); only
 * when Arcade never saw it, WhatsOnChain. The proof comes from Arcade when it has one, else from WhatsOnChain's TSC
 * proof checked against the block's merkle root. Either way the hex must hash to `txid`.
 */
async function fetchFaucetTx(txid: string, arcade: Arcade): Promise<FaucetTx> {
  let s: Awaited<ReturnType<Arcade['status']>>
  try {
    s = await arcade.status(txid)
  } catch (e) {
    throw new Error(`Arcade could not be read for ${txid}: ${message(e)}`)
  }
  let hex: string
  let source: FaucetTx['source']
  let proof: MerklePath | undefined
  if (!('notFound' in s) && typeof s.rawTx === 'string' && s.rawTx !== '') {
    hex = plainHexFromArcadeRawTx(s.rawTx, txid)
    source = 'Arcade'
    if (typeof s.merklePath === 'string' && s.merklePath !== '') proof = MerklePath.fromHex(s.merklePath)
  } else {
    const fetched = await wocGet(`/tx/${txid}/hex`)
    if (fetched === undefined) throw new Error(`neither Arcade nor WhatsOnChain knows ${txid} yet; try again in a minute`)
    hex = fetched
    source = 'WhatsOnChain'
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error(`${source} sent something that is not transaction hex for ${txid}`)
  const tx = Transaction.fromHex(hex)
  if (tx.id('hex') !== txid) throw new Error(`${source}'s transaction for ${txid} hashes to ${tx.id('hex')}`)

  if (proof === undefined) {
    // Arcade has no merkle path for it (it never saw the faucet tx mined): the TSC proof, if the block exists.
    const body = await wocGet(`/tx/${txid}/proof/tsc`)
    const parsed = body === undefined || body === '' ? undefined : JSON.parse(body)
    const tsc = (Array.isArray(parsed) ? parsed[0] : parsed) as TscProof | null | undefined
    if (tsc === undefined || tsc === null || typeof tsc.target !== 'string') {
      throw new Error(`${txid} has no merkle proof yet (not in a block); run sweep again once it is`)
    }
    if (!/^[0-9a-f]{64}$/i.test(tsc.target)) throw new Error('the TSC proof names no block hash')
    const blockBody = await wocGet(`/block/hash/${tsc.target}`)
    const block = blockBody === undefined ? undefined : (JSON.parse(blockBody) as { height?: unknown; merkleroot?: unknown })
    if (typeof block?.height !== 'number' || typeof block.merkleroot !== 'string') throw new Error(`WhatsOnChain has no header for block ${tsc.target}`)
    proof = tscToMerklePath(tsc, block.height)
    if (proof.computeRoot(txid) !== block.merkleroot) throw new Error(`the TSC proof for ${txid} does not compute block ${tsc.target}'s merkle root`)
  } else {
    proof.computeRoot(txid) // throws when the path does not contain txid
  }
  tx.merklePath = proof
  return { tx, source }
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

async function sweep(argv: string[], env: Env, io: Io): Promise<number> {
  const { rootKeyHex } = loadOrCreateRootKey({ create: false, env })
  const txid = flag(argv, '--txid')?.toLowerCase()
  if (txid === undefined || !/^[0-9a-f]{64}$/.test(txid)) throw new GateUsageError('sweep needs --txid <the faucet txid, 64 hex characters>')
  const vout = wholeNumber(flag(argv, '--vout'), '--vout', 0)
  const arcadeUrl = arcadeUrlOf(env)
  const arcade = new Arcade(arcadeUrl)
  const { fundingAddress } = derive(rootKeyHex)

  const { tx, source } = await fetchFaucetTx(txid, arcade)
  const fundingScript = new P2PKH().lock(fundingAddress).toHex()
  const vouts = vout !== undefined ? [vout] : tx.outputs.flatMap((o, i) => (o.lockingScript.toHex() === fundingScript ? [i] : []))
  if (vouts.length === 0) throw new GateUsageError(`no output of ${txid} pays the funding address ${fundingAddress}`)
  const beef = new Beef()
  beef.mergeTransaction(tx)
  io.out(`faucet tx ${txid} from ${source}, outputs ${vouts.join(', ')}`)

  const { Setup } = await import('@bsv/wallet-toolbox')
  const tipper = await openGateWallet(rootKeyHex, 'tipper', 'testnet', arcadeUrl, gateDataDir(env))
  let failed = 0
  try {
    const results = await Setup.fundWalletFromP2PKHOutpoints(
      broadcastNow(tipper.wallet),
      vouts.map(i => `${txid}.${i}`),
      Setup.getKeyPair(rootKeyHex),
      beef.toBinary(),
    )
    io.out('| outpoint | sats | result | txid | txStatus | verdict |')
    io.out('|---|---|---|---|---|---|')
    for (const r of results) {
      const sats = tx.outputs[Number(r.outpoint.split('.')[1])]?.satoshis ?? ''
      if (!r.success || r.txid === undefined) {
        failed++
        io.out(`| ${r.outpoint} | ${sats} | failed: ${r.error ?? 'no txid'} | | | |`)
        continue
      }
      let read: Awaited<ReturnType<Arcade['read']>>
      try {
        read = await arcade.read(r.txid, SEEN_WITHIN_MS)
      } catch (e) {
        read = undefined
        io.err(`Arcade status for ${r.txid}: ${message(e)}`)
      }
      if (read?.verdict !== 'seen-no-competitor') failed++
      io.out(`| ${r.outpoint} | ${sats} | imported | ${r.txid} | ${read?.txStatus ?? 'unknown to Arcade'} | ${read?.verdict ?? 'no-verdict'} |`)
    }
    io.out(`tipper wallet balance: ${await tipper.wallet.balance()} sats`)
  } finally {
    await tipper.close()
  }
  return failed === 0 ? 0 : 1
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

class GateFailure extends Error {}

async function run(argv: string[], env: Env, io: Io): Promise<number> {
  const { rootKeyHex } = loadOrCreateRootKey({ create: false, env })
  if (env.BSV_MCP_NETWORK_TESTS !== '1') {
    throw new GateUsageError('gate run spends testnet coins through Arcade: set BSV_MCP_NETWORK_TESTS=1 to run it')
  }
  const sats = wholeNumber(flag(argv, '--sats'), '--sats', MIN_TIP_SATS) ?? DEFAULT_SATS
  const relayUrl = flag(argv, '--relay')
  if (relayUrl !== undefined && !/^https?:\/\/[^/]+\/?$/.test(relayUrl)) throw new GateUsageError('--relay must be an origin such as http://127.0.0.1:8080')
  const arcadeUrl = arcadeUrlOf(env)
  const dataDir = gateDataDir(env)
  const started = new Date()
  const rows: Row[] = []
  let failure: string | undefined
  let probeTxid: string | undefined

  const tipper = await openGateWallet(rootKeyHex, 'tipper', 'testnet', arcadeUrl, dataDir)
  let creator: GateWallet | undefined
  let relay: Relay | undefined
  try {
    creator = await openGateWallet(rootKeyHex, 'creator', 'testnet', arcadeUrl, dataDir)
    const balance = await tipper.wallet.balance()
    if (balance < sats + 100) {
      throw new GateFailure(
        `the tipper wallet holds ${balance} sats (needs ${sats} plus fees). Its storage is local (${dataDir}): on a new machine it starts empty; run \`pnpm gate sweep --txid <faucet txid>\` there`,
      )
    }
    relay = relayUrl === undefined ? await startRelay(arcadeUrl, creator.identityKey, io) : { base: relayUrl.replace(/\/$/, ''), inProcess: false, close: async () => {} }
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

    // The tipper: web/tip.ts's sendTip, as the Tip button runs it (derivation saved first, BRC-29 output to the
    // creator, createAction with randomizeOutputs:false and acceptDelayedBroadcast:false, POST /api/tips).
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

    // The relay's Arcade verdict, within 20 s of handing it the tip.
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

    // The creator: web/collect.ts's collectTip (the candidate's own BEEF, internalizeAction, signed report).
    const c0 = performance.now()
    const row: TipRow = await api.getTip(txid)
    const collected = await collectTip(creator.wallet, row, api, { originator: cfg.originator, network: 'testnet', delaysMs: [2_000, 5_000, 10_000] })
    rows.push({ step: 'creator internalizeAction', txid, verdict: collected.result, ms: Math.round(performance.now() - c0) })
    if (collected.result !== 'accepted') throw new GateFailure(`the creator wallet did not collect the tip: ${collected.result}${collected.error ? ` (${collected.error})` : ''}`)
    const reported = await api.getTip(txid)
    rows.push({ step: 'relay internalized report', txid, verdict: reported.internalizedAt !== undefined ? 'reported' : 'not reported' })
    if (reported.internalizedAt === undefined) throw new GateFailure('the relay did not record the creator\'s signed internalized report')
    probeTxid = txid
  } catch (e) {
    failure = message(e)
  } finally {
    await relay?.close()
    await creator?.close()
    await tipper.close()
  }

  const table = tableLines(rows)
  table.forEach(line => io.out(line))
  const date = started.toISOString().slice(0, 10)
  const file = join(evalsDir(), `gate-${date}.md`)
  mkdirSync(evalsDir(), { recursive: true })
  writeFileSync(
    file,
    [
      `# Gate run ${started.toISOString()}`,
      '',
      `- network: testnet`,
      `- arcade: ${arcadeUrl}`,
      `- relay: ${relay?.inProcess === false ? relay.base : 'in-process'}`,
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
