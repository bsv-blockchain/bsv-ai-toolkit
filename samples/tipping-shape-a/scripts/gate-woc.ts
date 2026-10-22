import { Beef, MerklePath, Transaction } from '@bsv/sdk'
import type { Arcade } from '../server/arcade.js'
import { plainHexFromArcadeRawTx } from '../server/beef.js'

// Where the gate's funding coins come from. Arcade first for every txid; WhatsOnChain (testnet) only for what
// Arcade cannot answer: the funding address's coin listing (an address listing, an allowed use), a faucet tx
// Arcade never saw, and merkle proofs Arcade does not hold. Every WhatsOnChain call goes through one process-wide
// gate (≥ 350 ms apart), has a timeout, and backs off on 429. Every transaction must hash to its txid.

export const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/test'
const WOC_GAP_MS = 350
const WOC_TIMEOUT_MS = 10_000
const HASH = /^[0-9a-f]{64}$/i

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let wocQueue: Promise<unknown> = Promise.resolve()
let wocNextAt = 0

/** Runs `call` after every earlier WhatsOnChain call, at least WOC_GAP_MS after the last one finished. */
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

export interface Utxo {
  txid: string
  vout: number
  satoshis: number
  /** 0 while unconfirmed. */
  height: number
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

/** WhatsOnChain testnet, every call behind the one gate. */
export class WhatsOnChain {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  /** GET `path`; undefined on 404. */
  async get(path: string): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      const res = await wocGate(() => this.fetchImpl(`${WOC_BASE}${path}`, { signal: AbortSignal.timeout(WOC_TIMEOUT_MS) }))
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

  private async json(path: string): Promise<unknown> {
    const body = await this.get(path)
    if (body === undefined || body === '') return undefined
    try {
      return JSON.parse(body)
    } catch {
      throw new Error(`WhatsOnChain GET ${path} answered something that is not JSON`)
    }
  }

  /** The address's unspent outputs, confirmed and not. */
  async unspent(address: string): Promise<Utxo[]> {
    const body = await this.json(`/address/${encodeURIComponent(address)}/unspent`)
    const list = Array.isArray(body) ? body : Array.isArray((body as { result?: unknown })?.result) ? (body as { result: unknown[] }).result : []
    return list.flatMap(raw => {
      const u = raw as { tx_hash?: unknown; tx_pos?: unknown; value?: unknown; height?: unknown }
      if (typeof u.tx_hash !== 'string' || !HASH.test(u.tx_hash) || !Number.isSafeInteger(u.tx_pos) || !Number.isSafeInteger(u.value)) return []
      return [{ txid: u.tx_hash.toLowerCase(), vout: u.tx_pos as number, satoshis: u.value as number, height: Number.isSafeInteger(u.height) ? (u.height as number) : 0 }]
    })
  }

  /** The transaction's hex, or undefined when WhatsOnChain does not know it. */
  txHex(txid: string): Promise<string | undefined> {
    return this.get(`/tx/${txid}/hex`)
  }

  /** The merkle path from the TSC proof, checked against the block's merkle root; undefined when not in a block. */
  async proof(txid: string): Promise<MerklePath | undefined> {
    const parsed = await this.json(`/tx/${txid}/proof/tsc`)
    const tsc = (Array.isArray(parsed) ? parsed[0] : parsed) as TscProof | null | undefined
    if (tsc === undefined || tsc === null || typeof tsc.target !== 'string') return undefined
    if (!HASH.test(tsc.target)) throw new Error(`the TSC proof for ${txid} names no block hash`)
    const block = (await this.json(`/block/hash/${tsc.target}`)) as { height?: unknown; merkleroot?: unknown } | undefined
    if (typeof block?.height !== 'number' || typeof block.merkleroot !== 'string') throw new Error(`WhatsOnChain has no header for block ${tsc.target}`)
    const path = tscToMerklePath(tsc, block.height)
    if (path.computeRoot(txid) !== block.merkleroot) throw new Error(`the TSC proof for ${txid} does not compute block ${tsc.target}'s merkle root`)
    return path
  }
}

export interface SourceTx {
  /** With its merkle path when it is in a block. */
  tx: Transaction
  source: 'Arcade' | 'WhatsOnChain'
}

/**
 * A transaction by txid: Arcade's rawTx (Extended Format, re-read as plain) when Arcade knows it, else WhatsOnChain's
 * hex. The hex must hash to `txid`. The merkle path is Arcade's when it has one, else the WhatsOnChain TSC proof.
 */
export async function fetchSourceTx(txid: string, arcade: Arcade, woc: WhatsOnChain): Promise<SourceTx> {
  let s: Awaited<ReturnType<Arcade['status']>>
  try {
    s = await arcade.status(txid)
  } catch (e) {
    throw new Error(`Arcade could not be read for ${txid}: ${message(e)}`)
  }
  let hex: string
  let source: SourceTx['source']
  let proof: MerklePath | undefined
  if (!('notFound' in s) && typeof s.rawTx === 'string' && s.rawTx !== '') {
    hex = plainHexFromArcadeRawTx(s.rawTx, txid)
    source = 'Arcade'
    if (typeof s.merklePath === 'string' && s.merklePath !== '') proof = MerklePath.fromHex(s.merklePath)
  } else {
    // The documented exception: a transaction Arcade never saw (a faucet payment).
    const fetched = await woc.txHex(txid)
    if (fetched === undefined) throw new Error(`neither Arcade nor WhatsOnChain knows ${txid} yet; try again in a minute`)
    hex = fetched
    source = 'WhatsOnChain'
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error(`${source} sent something that is not transaction hex for ${txid}`)
  const tx = Transaction.fromHex(hex)
  if (tx.id('hex') !== txid) throw new Error(`${source}'s transaction for ${txid} hashes to ${tx.id('hex')}`)
  if (proof === undefined) proof = await woc.proof(txid)
  else proof.computeRoot(txid) // throws when the path does not contain txid
  if (proof !== undefined) tx.merklePath = proof
  return { tx, source }
}

const MAX_DEPTH = 8
const MAX_TXS = 64

/**
 * Merges `txid` into `beef` with everything a wallet needs to verify it: a merkle path, or, for a transaction not
 * in a block yet that Arcade knows (an earlier gate run's sweep-back), its inputs' transactions, recursively.
 * A transaction in no block that only WhatsOnChain knows is refused: the gate never walks a WhatsOnChain ancestry.
 */
export async function addProvenTx(beef: Beef, txid: string, arcade: Arcade, woc: WhatsOnChain, depth = 0, seen = new Set<string>()): Promise<Beef> {
  if (seen.has(txid) || beef.findTxid(txid)?.tx !== undefined) return beef
  seen.add(txid)
  if (seen.size > MAX_TXS) throw new Error(`more than ${MAX_TXS} unconfirmed ancestors; wait for a block`)
  const { tx, source } = await fetchSourceTx(txid, arcade, woc)
  if (tx.merklePath === undefined) {
    if (source !== 'Arcade') throw new Error(`${txid} is not in a block yet and Arcade never saw it; try again after the next block`)
    if (depth >= MAX_DEPTH) throw new Error(`${txid} has more than ${MAX_DEPTH} unconfirmed generations; wait for a block`)
    for (const input of tx.inputs) {
      if (input.sourceTXID === undefined) throw new Error(`an input of ${txid} names no source txid`)
      await addProvenTx(beef, input.sourceTXID, arcade, woc, depth + 1, seen)
    }
  }
  beef.mergeTransaction(tx)
  return beef
}
