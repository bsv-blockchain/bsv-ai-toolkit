import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Beef,
  KeyDeriver,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Random,
  Transaction,
  UnlockingScript,
  Utils,
  WalletError,
  WERR_INVALID_PARAMETER,
  WERR_REVIEW_ACTIONS,
  type CreateActionArgs,
  type InternalizeActionArgs,
  type WalletInterface,
} from '@bsv/sdk'
import { validateCreateActionArgs, validateInternalizeActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.js'
import { Arcade } from '../server/arcade.js'
import { internalizedMessage, verifyCreatorSignature } from '../server/auth.js'
import { loadServerConfig } from '../server/config.js'
import { openDb } from '../server/db.js'
import { relayApi, RelayError, type AncestorTx, type RelayApi, type TipRow, type TipStatusView } from '../web/api'
import { BRC29, newDerivation, payeeLockingScript } from '../web/brc29'
import { buildAtomicBeef, claimCreator, collectTip, Collector, type CollectDeps, type CollectOutcome } from '../web/collect'
import { TipList } from '../web/components/TipList'
import type { AppConfig } from '../web/config'
import { Creator } from '../web/pages/Creator'
import { Tipper, Unfinished } from '../web/pages/Tipper'
import { forgetQuestion, forgetTip, forgetWithConsent, pendingTips, postPending, resumableTips, sendTip, stuckTips, tipDetails, type KeyValueStore } from '../web/tip'
import { assertNetwork, login, TIPS_PROTOCOL } from '../web/wallet'

const SAMPLE = fileURLToPath(new URL('..', import.meta.url))
const ARCADE = 'https://arcade-testnet-us-1.bsvblockchain.tech'
const ORIGIN = 'http://localhost:5173' // PUBLIC_ORIGIN's development default
const quiet = () => {}

/** A Map-backed localStorage. */
class MemoryStorage implements KeyValueStore {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}

type Call = { method: string; args: any }

/**
 * A fake BRC-100 wallet: real key derivation and signatures (ProtoWallet over a random in-memory key), a
 * createAction that builds and signs a real AtomicBEEF, and an internalizeAction that checks the output the way
 * @bsv/wallet-toolbox 2.14.9 does (derive the BRC-29 key for self from the remittance, compare the locking script,
 * throw WERR_INVALID_PARAMETER('paymentRemittance') on a mismatch). Every call is recorded.
 */
class FakeWallet {
  readonly calls: Call[] = []
  readonly accepted: InternalizeActionArgs[] = []
  readonly key = PrivateKey.fromRandom()
  private readonly proto = new ProtoWallet(this.key)
  private readonly deriver = new KeyDeriver(this.key)
  network: 'testnet' | 'mainnet' = 'testnet'
  /** Errors internalizeAction throws first, in order. */
  internalizeErrors: unknown[] = []
  beforeCreateAction?: (args: CreateActionArgs) => void
  permissionsAnswer?: Promise<{ publicKey: string }>

  get identityKey() {
    return this.key.toPublicKey().toString()
  }
  callsTo(method: string) {
    return this.calls.filter(c => c.method === method)
  }
  private record(method: string, args?: unknown) {
    this.calls.push({ method, args })
  }
  async connectToSubstrate() {
    this.record('connectToSubstrate')
  }
  async isAuthenticated() {
    this.record('isAuthenticated')
    throw new Error('Invalid isAuthenticated result') // as @bsv/sdk 3.2.1 does on a locked wallet
  }
  async waitForAuthentication(args: object) {
    this.record('waitForAuthentication', args)
    return { authenticated: true as const }
  }
  async getNetwork(args: object) {
    this.record('getNetwork', args)
    return { network: this.network }
  }
  async getPublicKey(args: any) {
    this.record('getPublicKey', args)
    if (args.keyID === 'permissions' && this.permissionsAnswer) return this.permissionsAnswer
    return this.proto.getPublicKey(args)
  }
  async createSignature(args: any) {
    this.record('createSignature', args)
    return this.proto.createSignature(args)
  }
  async createAction(args: CreateActionArgs) {
    validateCreateActionArgs(args)
    this.record('createAction', args)
    this.beforeCreateAction?.(args)
    const outputs = args.outputs ?? []
    const source = new Transaction()
    source.addInput({ sourceTXID: Utils.toHex(Random(32)), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    source.addOutput({ lockingScript: new P2PKH().lock(this.key.toAddress('testnet')), satoshis: outputs.reduce((s, o) => s + o.satoshis, 0) + 2000 })
    source.merklePath = new MerklePath(900000, [[{ offset: 0, hash: source.id('hex'), txid: true }]])
    const child = new Transaction()
    child.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(this.key) })
    for (const o of outputs) child.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis })
    child.addOutput({ lockingScript: new P2PKH().lock(this.key.toAddress('testnet')), satoshis: 1900 })
    await child.sign()
    return { txid: child.id('hex'), tx: child.toAtomicBEEF() }
  }
  async internalizeAction(args: InternalizeActionArgs) {
    validateInternalizeActionArgs(args)
    this.record('internalizeAction', args)
    if (this.internalizeErrors.length) throw this.internalizeErrors.shift()
    const tx = Transaction.fromAtomicBEEF(args.tx)
    for (const o of args.outputs) {
      const p = o.paymentRemittance!
      const priv = this.deriver.derivePrivateKey(BRC29, `${p.derivationPrefix} ${p.derivationSuffix}`, p.senderIdentityKey)
      if (tx.outputs[o.outputIndex].lockingScript.toHex() !== new P2PKH().lock(priv.toAddress()).toHex()) {
        throw new WERR_INVALID_PARAMETER('paymentRemittance', 'locked by script conforming to BRC-29')
      }
    }
    this.accepted.push(args)
    return { accepted: true as const }
  }
}
const asWallet = (w: FakeWallet) => w as unknown as WalletInterface

const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  network: 'testnet',
  originator: ORIGIN,
  claimNonce: '0'.repeat(32),
  ...over,
})

const sha256 = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')

/** A real tip from `tipper` to `creator`: the AtomicBEEF hex and the relay row with one candidate. */
async function makeTip(tipper: FakeWallet, creatorIdentityKey: string, satoshis = 1000) {
  const { derivationPrefix, derivationSuffix } = newDerivation()
  const lockingScript = await payeeLockingScript(asWallet(tipper), creatorIdentityKey, derivationPrefix, derivationSuffix)
  const { txid, tx } = await tipper.createAction({
    description: 'Tip to creator',
    outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 tip' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  })
  const beef = Utils.toHex(tx!)
  const remittance = { senderIdentityKey: tipper.identityKey, derivationPrefix, derivationSuffix }
  const row: TipRow = {
    txid: txid!,
    txStatus: 'SEEN_ON_NETWORK',
    verdict: 'seen-no-competitor',
    competingTxs: [],
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    remittances: [{ beefId: sha256(beef), outputIndex: 0, satoshis, ...remittance, receivedAt: new Date().toISOString() }],
  }
  return { txid: txid!, beef, row, remittance }
}

type FakeRelay = RelayApi & { calls: Call[] }

/** An in-memory relay API for one tip: statuses are answered in order (the last repeats). */
function fakeRelay(
  row: TipRow,
  beefs: Record<string, string>,
  statuses: Array<Partial<TipStatusView> | Error> = [{}],
  ancestors: Record<string, AncestorTx> = {},
): FakeRelay {
  const calls: Call[] = []
  let s = 0
  const rec = (method: string, args?: unknown) => calls.push({ method, args })
  const { remittances: _r, receivedAt: _a, internalizedAt: _i, ...baseView } = row
  let last: TipStatusView = baseView
  return {
    calls,
    async config() {
      rec('config')
      return config()
    },
    async postTip(tip) {
      rec('postTip', tip)
      return row
    },
    async listTips() {
      rec('listTips')
      return [row]
    },
    async getTip(txid) {
      rec('getTip', txid)
      return row
    },
    async beef(txid, beefId) {
      rec('beef', { txid, beefId })
      const hex = beefs[beefId]
      if (hex === undefined) throw new RelayError('no such beef', 404)
      return hex
    },
    async status(txid) {
      rec('status', txid)
      const next = statuses[Math.min(s++, statuses.length - 1)]
      if (next instanceof Error) throw next
      return (last = { ...baseView, ...next })
    },
    async rebroadcast(txid) {
      rec('rebroadcast', txid)
      return last
    },
    async ancestor(txid) {
      rec('ancestor', txid)
      return ancestors[txid]
    },
    async claimCreator(identityKey, signature) {
      rec('claimCreator', { identityKey, signature })
      return { creatorIdentityKey: identityKey }
    },
    async markInternalized(txid, signature) {
      rec('markInternalized', { txid, signature })
      return { ...row, internalizedAt: new Date().toISOString() }
    },
  }
}
const relayCalls = (r: FakeRelay, method: string) => r.calls.filter(c => c.method === method)

const collectDeps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
  originator: ORIGIN,
  network: 'testnet',
  sleep: async () => {},
  ...over,
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('wallet.ts', () => {
  it('login never calls isAuthenticated and fires the permission trigger without awaiting it', async () => {
    const w = new FakeWallet()
    w.permissionsAnswer = new Promise(() => {}) // the grouped prompt is still open
    const session = await login(w as any)
    expect(session).toEqual({ wallet: w, identityKey: w.identityKey, network: 'testnet' })
    expect(w.callsTo('isAuthenticated')).toHaveLength(0)
    expect(w.calls.map(c => c.method)).toEqual(['connectToSubstrate', 'waitForAuthentication', 'getPublicKey', 'getNetwork', 'getPublicKey'])
    expect(w.calls[2].args).toEqual({ identityKey: true })
    expect(w.calls[4].args).toEqual({ protocolID: TIPS_PROTOCOL, keyID: 'permissions', counterparty: 'self' })
  })

  it('a refused permission trigger does not fail login', async () => {
    const w = new FakeWallet()
    w.permissionsAnswer = Promise.reject(new Error('user denied'))
    await expect(login(w as any)).resolves.toMatchObject({ identityKey: w.identityKey })
  })

  it('TIPS_PROTOCOL is the manifest protocol and obeys the SDK name rule (C10)', () => {
    expect(TIPS_PROTOCOL).toEqual([1, 'bsv tipping demo tips'])
    expect(TIPS_PROTOCOL[1]).toMatch(/^[a-z0-9 ]+$/)
  })

  it('network mismatch blocks the tip path', () => {
    expect(() => assertNetwork('mainnet', 'testnet')).toThrow('wallet is on mainnet, app is on testnet')
    expect(() => assertNetwork('testnet', 'testnet')).not.toThrow()
    const w = new FakeWallet()
    const html = renderToString(
      createElement(Tipper, { config: config({ creatorIdentityKey: w.identityKey }), initialSession: { wallet: asWallet(w), identityKey: w.identityKey, network: 'mainnet' } }),
    )
    expect(html).toContain('wallet is on mainnet')
    expect(html).toMatch(/<fieldset disabled=""/)
    const ok = renderToString(
      createElement(Tipper, { config: config({ creatorIdentityKey: w.identityKey }), initialSession: { wallet: asWallet(w), identityKey: w.identityKey, network: 'testnet' } }),
    )
    expect(ok).not.toContain('wallet is on')
    expect(ok).not.toMatch(/<fieldset disabled=""/)
  })
})

describe('Creator page', () => {
  it('keeps a retry control when the creator claim has not succeeded', () => {
    const w = new FakeWallet()
    const session = { wallet: asWallet(w), identityKey: w.identityKey, network: 'testnet' as const }
    expect(renderToString(createElement(Creator, { config: config(), initialSession: session }))).toContain('Try again')
    expect(renderToString(createElement(Creator, { config: config() }))).not.toContain('Try again')
  })
})

describe('brc29.ts', () => {
  it('newDerivation draws 16 random bytes each, base64', () => {
    const a = newDerivation()
    const b = newDerivation()
    expect(Utils.toArray(a.derivationPrefix, 'base64')).toHaveLength(16)
    expect(Utils.toArray(a.derivationSuffix, 'base64')).toHaveLength(16)
    expect(a.derivationPrefix).not.toBe(b.derivationPrefix)
  })

  it('payeeLockingScript locks to the key only the creator can derive for self', async () => {
    const tipper = new FakeWallet()
    const creator = PrivateKey.fromRandom()
    const { derivationPrefix: p, derivationSuffix: s } = newDerivation()
    const lock = await payeeLockingScript(asWallet(tipper), creator.toPublicKey().toString(), p, s)
    const own = new KeyDeriver(creator).derivePrivateKey(BRC29, `${p} ${s}`, tipper.identityKey)
    expect(lock).toBe(new P2PKH().lock(own.toAddress()).toHex())
    expect(tipper.callsTo('getPublicKey')[0].args).toEqual({ protocolID: [2, '3241645161d8'], keyID: `${p} ${s}`, counterparty: creator.toPublicKey().toString() })
  })
})

describe('tip.ts', () => {
  const creatorKey = PrivateKey.fromRandom().toPublicKey().toString()
  const okRelay = (): FakeRelay => {
    const relay = fakeRelay({} as TipRow, {})
    relay.postTip = async tip => {
      relay.calls.push({ method: 'postTip', args: tip })
      return { txid: tip.txid, verdict: 'seen-no-competitor' } as TipRow
    }
    return relay
  }

  it('sendTip persists the derivation before createAction', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    const w = new FakeWallet()
    let before: { saved: ReturnType<typeof pendingTips>; lock: string } | undefined
    w.beforeCreateAction = args => {
      before = { saved: pendingTips(localStorage), lock: args.outputs![0].lockingScript }
    }
    const relay = okRelay()
    const out = await sendTip(asWallet(w), config(), creatorKey, 1500, relay)
    expect(before!.saved).toHaveLength(1)
    const [saved] = before!.saved
    expect(saved).toMatchObject({ recipient: creatorKey, satoshis: 1500, outputIndex: 0, senderIdentityKey: w.identityKey, network: 'testnet' })
    expect(saved.txid).toBeUndefined()
    // What was saved re-derives the locking script the wallet then paid.
    expect(await payeeLockingScript(asWallet(w), creatorKey, saved.derivationPrefix, saved.derivationSuffix)).toBe(before!.lock)
    expect(out).toMatchObject({ posted: true, txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const posted = relayCalls(relay, 'postTip')[0].args
    expect(posted.remittance).toEqual({ senderIdentityKey: w.identityKey, derivationPrefix: saved.derivationPrefix, derivationSuffix: saved.derivationSuffix })
    expect(posted).toMatchObject({ outputIndex: 0, satoshis: 1500, txid: out.txid })
    expect(Transaction.fromAtomicBEEF(Utils.toArray(posted.beef, 'hex')).id('hex')).toBe(out.txid)
    expect(pendingTips(storage)).toEqual([]) // cleared once the relay has it
  })

  it('sendTip passes randomizeOutputs false and acceptDelayedBroadcast false', async () => {
    const w = new FakeWallet()
    await sendTip(asWallet(w), config(), creatorKey, 546, okRelay(), { storage: new MemoryStorage() })
    const [{ args }] = w.callsTo('createAction')
    expect(args.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false })
    expect(args.outputs).toEqual([{ lockingScript: expect.stringMatching(/^76a914[0-9a-f]{40}88ac$/), satoshis: 546, outputDescription: 'BRC-29 tip' }])
  })

  it('sendTip refuses before building anything on a network mismatch or below 546 sats', async () => {
    const w = new FakeWallet()
    w.network = 'mainnet'
    const storage = new MemoryStorage()
    await expect(sendTip(asWallet(w), config(), creatorKey, 1000, okRelay(), { storage })).rejects.toThrow('wallet is on mainnet, app is on testnet')
    await expect(sendTip(asWallet(new FakeWallet()), config(), creatorKey, 545, okRelay(), { storage })).rejects.toThrow(/at least 546/)
    expect(w.callsTo('createAction')).toHaveLength(0)
    expect(w.callsTo('getPublicKey')).toHaveLength(0)
    expect(storage.length).toBe(0)
  })

  it('a refused relay POST after broadcast keeps the remittance and retries honouring Retry-After', async () => {
    const w = new FakeWallet()
    const storage = new MemoryStorage()
    const relay = okRelay()
    const answers = [new RelayError('too many', 429, 7000), new RelayError('Arcade did not take it', 502), new RelayError('unreachable', 0)]
    const ok = relay.postTip
    relay.postTip = async tip => {
      const next = answers.shift()
      if (next) {
        relay.calls.push({ method: 'postTip', args: tip })
        expect(pendingTips(storage)[0]).toMatchObject({ txid: tip.txid, beef: tip.beef }) // kept while refused
        throw next
      }
      return ok(tip)
    }
    const sleeps: number[] = []
    const out = await sendTip(asWallet(w), config(), creatorKey, 1000, relay, { storage, sleep: async ms => void sleeps.push(ms) })
    expect(out.posted).toBe(true)
    expect(sleeps[0]).toBe(7000) // Retry-After
    expect(sleeps).toHaveLength(3)
    expect(relayCalls(relay, 'postTip')).toHaveLength(4)
    expect(pendingTips(storage)).toEqual([])
  })

  it('a relay that keeps refusing gives up after a bound, keeps the tip, and a later resume posts it', async () => {
    const w = new FakeWallet()
    const storage = new MemoryStorage()
    const relay = okRelay()
    const ok = relay.postTip
    relay.postTip = async tip => {
      relay.calls.push({ method: 'postTip', args: tip })
      throw new RelayError('POST /api/tips: HTTP 502', 502)
    }
    const sleeps: number[] = []
    const out = await sendTip(asWallet(w), config(), creatorKey, 1000, relay, { storage, sleep: async ms => void sleeps.push(ms) })
    expect(out).toMatchObject({ posted: false, txid: expect.stringMatching(/^[0-9a-f]{64}$/), error: expect.stringContaining('502') })
    expect(relayCalls(relay, 'postTip').length).toBeLessThanOrEqual(5)
    expect(sleeps.every(ms => ms <= 60_000)).toBe(true)
    const [kept] = pendingTips(storage)
    expect(kept).toMatchObject({ txid: out.txid, lastError: expect.stringContaining('502') })

    // 413 is not retried, and the tip is still kept.
    relay.postTip = async () => {
      throw new RelayError('POST /api/tips: HTTP 413: request body too large', 413)
    }
    sleeps.length = 0
    expect(await postPending(kept, relay, { storage, sleep: async ms => void sleeps.push(ms) })).toMatchObject({ posted: false, error: expect.stringContaining('413') })
    expect(sleeps).toEqual([])
    expect(pendingTips(storage)).toHaveLength(1)

    relay.postTip = ok
    expect(await postPending(pendingTips(storage)[0], relay, { storage })).toMatchObject({ posted: true, txid: out.txid })
    expect(pendingTips(storage)).toEqual([])
  })
  it('a 413 is permanent: the tip is listed as one the relay cannot take, offers Copy details, and is never re-posted', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    const w = new FakeWallet()
    const relay = okRelay()
    relay.postTip = async tip => {
      relay.calls.push({ method: 'postTip', args: tip })
      throw new RelayError('POST /api/tips: HTTP 413: request body too large', 413)
    }
    const out = await sendTip(asWallet(w), config(), creatorKey, 1000, relay, { storage })
    expect(out).toMatchObject({ posted: false, permanent: true, error: expect.stringContaining('413') })
    expect(relayCalls(relay, 'postTip')).toHaveLength(1)

    // Not re-posted on the next visit: listed instead, with what to do.
    expect(resumableTips('testnet', storage)).toEqual([])
    const [refused] = stuckTips('testnet', storage)
    expect(refused).toMatchObject({ txid: out.txid, lastStatus: 413 })
    const list = Unfinished({ records: [refused], network: 'testnet', onForget: () => {}, onCopy: () => {} })
    const item = elementsOf(list).find(e => e.type === 'li')!
    expect(textOf(item)).toMatch(/the relay cannot take this tip/)
    expect(textOf(item)).toMatch(/Copy details/)
    expect(textOf(item)).not.toMatch(/HTTP 413: request body too large/)
    expect(elementsOf(list).filter(e => e.type === 'button').map(b => textOf(b))).toEqual(['Copy details', 'Forget'])
    const html = renderToString(
      createElement(Tipper, { config: config({ creatorIdentityKey: creatorKey }), initialSession: { wallet: asWallet(w), identityKey: w.identityKey, network: 'testnet' } }),
    )
    expect(html).toContain('the relay cannot take this tip')

    // A transient failure stays resumable.
    relay.postTip = async () => {
      throw new RelayError('POST /api/tips: HTTP 502', 502)
    }
    await postPending(refused, relay, { storage, postAttempts: 1 })
    expect(resumableTips('testnet', storage).map(t => t.txid)).toEqual([out.txid])
  })

  it('a wallet broadcast problem that carries the transaction still hands the tip to the relay', async () => {
    const w = new FakeWallet()
    const storage = new MemoryStorage()
    const relay = okRelay()
    const create = w.createAction.bind(w)
    // wallet-toolbox: an undelayed broadcast that is not all 'unproven' throws WERR_REVIEW_ACTIONS(ndrs, swrs, txid, tx).
    w.createAction = async args => {
      const r = await create(args)
      throw new WERR_REVIEW_ACTIONS([{ txid: r.txid!, status: 'serviceError' }], [{ txid: r.txid!, status: 'failed' }], r.txid, r.tx)
    }
    const out = await sendTip(asWallet(w), config(), creatorKey, 1000, relay, { storage })
    expect(out).toMatchObject({ posted: true, txid: expect.stringMatching(/^[0-9a-f]{64}$/), walletError: expect.stringContaining('serviceError') })
    const [{ args: posted }] = relayCalls(relay, 'postTip')
    expect(posted).toMatchObject({ txid: out.txid, outputIndex: 0, satoshis: 1000 })
    expect(pendingTips(storage)).toEqual([])
    const html = renderToString(
      createElement(Tipper, { config: config({ creatorIdentityKey: creatorKey }), initialSession: { wallet: asWallet(w), identityKey: w.identityKey, network: 'testnet' } }),
    )
    expect(html).not.toContain('Unfinished tips')
  })

  it('a tip the relay cannot take is kept and listed, never re-posted', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    const relay = okRelay()

    // The wallet failed, or the page closed, before a transaction came back.
    const closed = new FakeWallet()
    closed.createAction = async () => {
      throw new Error('the wallet closed the connection')
    }
    await expect(sendTip(asWallet(closed), config(), creatorKey, 1111, relay)).rejects.toThrow('closed the connection')
    // Only a txid came back.
    const txidOnly = new FakeWallet()
    txidOnly.createAction = async () => {
      throw Object.assign(new Error('broadcast failed'), { txid: 'ab'.repeat(32) })
    }
    await expect(sendTip(asWallet(txidOnly), config(), creatorKey, 2222, relay)).rejects.toThrow('broadcast failed')
    // The wallet's transaction does not pay the planned output.
    const odd = new FakeWallet()
    const create = odd.createAction.bind(odd)
    odd.createAction = async args =>
      create({ ...args, outputs: [{ ...args.outputs![0], lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex() }] })
    await expect(sendTip(asWallet(odd), config(), creatorKey, 3333, relay)).rejects.toThrow(/does not pay the tip/)

    expect(relayCalls(relay, 'postTip')).toHaveLength(0)
    expect(resumableTips('testnet', storage)).toEqual([])
    const stuck = stuckTips('testnet', storage)
    expect(stuck.map(t => [t.satoshis, t.txid, t.outputIndex])).toEqual([
      [1111, undefined, 0],
      [2222, 'ab'.repeat(32), 0],
      [3333, expect.stringMatching(/^[0-9a-f]{64}$/), -1],
    ])
    expect(stuck[0].lastError).toBe('the wallet closed the connection')
    await expect(postPending(stuck[2], relay, { storage })).rejects.toThrow(/no transaction the relay could take/)

    const html = renderToString(createElement(Tipper, { config: config({ creatorIdentityKey: creatorKey }) }))
    expect(html).toContain('Unfinished tips')
    expect(html).toContain('1111')
    expect(html).toContain('the wallet closed the connection')
    expect(html).toContain('ab'.repeat(32))
    expect(html).toContain('does not pay the planned tip')
    forgetTip(stuck[0].key, storage)
    expect(stuckTips('testnet', storage)).toHaveLength(2)
  })

  it('Forget asks first, and Copy details exports what the creator needs, no secret (C18)', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    const txidOnly = new FakeWallet()
    txidOnly.createAction = async () => {
      throw Object.assign(new Error('broadcast failed'), { txid: 'cd'.repeat(32) })
    }
    await expect(sendTip(asWallet(txidOnly), config(), creatorKey, 2222, okRelay())).rejects.toThrow('broadcast failed')
    const [record] = stuckTips('testnet', storage)

    // The details: exactly the fields a collect needs, as JSON.
    expect(JSON.parse(tipDetails(record)!)).toEqual({
      txid: 'cd'.repeat(32),
      derivationPrefix: record.derivationPrefix,
      derivationSuffix: record.derivationSuffix,
      recipient: creatorKey,
      satoshis: 2222,
      outputIndex: 0,
      senderIdentityKey: txidOnly.identityKey,
    })
    expect(tipDetails({ ...record, derivationPrefix: '' })).toBeUndefined()

    // Forget deletes only after a yes, and the question names the transaction and the way to keep the details.
    const asked: string[] = []
    expect(forgetWithConsent(record, q => (asked.push(q), false), storage)).toBe(false)
    expect(stuckTips('testnet', storage)).toHaveLength(1)
    expect(asked[0]).toContain('cd'.repeat(32))
    expect(asked[0]).toContain('Copy details')
    // The question carries the details themselves, so a yes never loses them unseen.
    expect(asked[0]).toContain(tipDetails(record)!)
    // A record with no derivation has no details to keep: the question does not send the user to Copy details.
    const bare = forgetQuestion({ ...record, derivationSuffix: '' })
    expect(bare).toContain('cd'.repeat(32))
    expect(bare).not.toContain('Copy details')
    expect(bare).not.toContain(record.derivationPrefix)

    // The page wires both buttons to the record; a record with no derivation offers no Copy details.
    const forgot: string[] = []
    const copied: string[] = []
    const damaged = { ...record, key: `${record.key}-damaged`, derivationSuffix: '' }
    const list = Unfinished({ records: [record, damaged], network: 'testnet', onForget: r => forgot.push(r.key), onCopy: r => copied.push(r.key) })
    const buttons = elementsOf(list).filter(e => e.type === 'button')
    expect(buttons.map(b => textOf(b))).toEqual(['Copy details', 'Forget', 'Forget'])
    for (const b of buttons) (b.props as { onClick: () => void }).onClick()
    expect(copied).toEqual([record.key])
    expect(forgot).toEqual([record.key, damaged.key])
    expect(renderToString(createElement(Tipper, { config: config({ creatorIdentityKey: creatorKey }) }))).toContain('Copy details')

    expect(forgetWithConsent(record, () => true, storage)).toBe(true)
    expect(stuckTips('testnet', storage)).toEqual([])
  })
})

/** Every React element in a tree a component returned (no rendering). */
function elementsOf(node: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  return [node, ...elementsOf((node.props as { children?: unknown }).children)]
}
const textOf = (e: ReactElement): string => {
  const c = (e.props as { children?: unknown }).children
  return (Array.isArray(c) ? c : [c]).map(x => (typeof x === 'string' ? x : isValidElement(x) ? textOf(x) : '')).join('').trim()
}

describe('collect.ts', () => {
  it('buildAtomicBeef completes a BEEF with ancestors the relay serves as plain transactions', async () => {
    const key = PrivateKey.fromRandom()
    const grand = new Transaction()
    grand.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    grand.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), satoshis: 5000 })
    grand.merklePath = new MerklePath(899999, [[{ offset: 0, hash: grand.id('hex'), txid: true }]])
    const parent = new Transaction()
    parent.addInput({ sourceTransaction: grand, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
    parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), satoshis: 4000 })
    await parent.sign()
    const parentPath = new MerklePath(900000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]])
    const child = new Transaction()
    child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
    child.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), satoshis: 3000 })
    await child.sign()
    const txid = child.id('hex')

    // The parent is known by txid only.
    const partial = new Beef()
    partial.mergeTxidOnly(parent.id('hex'))
    partial.mergeRawTx(child.toBinary())
    expect(partial.isValid()).toBe(false)

    const asked: string[] = []
    // GET /api/tx/:txid: the relay has already re-read Arcade's EF rawTx as plain (relay.test.ts covers that).
    const ancestor = async (id: string) => {
      asked.push(id)
      return { txid: id, rawTx: parent.toHex(), merklePath: parentPath.toHex() }
    }
    const atomic = await buildAtomicBeef(Utils.toHex(partial.toBinaryAtomic(txid)), txid, ancestor)
    expect(asked).toEqual([parent.id('hex')])
    const tx = Transaction.fromAtomicBEEF(atomic)
    expect(tx.id('hex')).toBe(txid)
    expect(Utils.toHex(tx.inputs[0].sourceTransaction!.toBinary())).toBe(Utils.toHex(parent.toBinary()))
    const merged = Beef.fromBinary(atomic)
    expect(merged.isValid()).toBe(true)
    expect(merged.findTxid(parent.id('hex'))!.isTxidOnly).toBe(false)

    // A complete BEEF is returned as is, without asking Arcade.
    const full = Utils.toHex(child.toAtomicBEEF())
    expect(Utils.toHex(await buildAtomicBeef(full, txid, async () => { throw new Error('no') }))).toBe(full)
    // No rawTx at Arcade: the BEEF cannot be completed.
    await expect(buildAtomicBeef(Utils.toHex(partial.toBinaryAtomic(txid)), txid, async () => undefined)).rejects.toThrow(/no rawTx/)
    // A transaction that is not the ancestor asked for is refused.
    await expect(buildAtomicBeef(Utils.toHex(partial.toBinaryAtomic(txid)), txid, async id => ({ txid: id, rawTx: grand.toHex() }))).rejects.toThrow(/hashes to/)
  })

  it('collector refuses an output that is not for self', async () => {
    const tipper = new FakeWallet()
    const creator = new FakeWallet()
    const stranger = new FakeWallet()
    const t = await makeTip(tipper, creator.identityKey)
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef })
    expect((await collectTip(asWallet(stranger), t.row, relay, collectDeps())).result).toBe('not-for-me')
    expect(stranger.accepted).toHaveLength(0)
    expect(relayCalls(relay, 'markInternalized')).toHaveLength(0)

    // Over the wallet wire substrate the error arrives without its parameter; the message still says it.
    const wire = new FakeWallet()
    wire.internalizeErrors = [new WalletError('The paymentRemittance parameter must be locked by script conforming to BRC-29', 6)]
    expect((await collectTip(asWallet(wire), t.row, relay, collectDeps())).result).toBe('not-for-me')
    expect(wire.accepted).toHaveLength(0)

    // The creator it was for collects it.
    expect((await collectTip(asWallet(creator), t.row, relay, collectDeps())).result).toBe('accepted')
    expect(creator.accepted).toHaveLength(1)
  })

  it('collects only after the relay reads seen-no-competitor, then reports it signed', async () => {
    vi.useFakeTimers()
    const tipper = new FakeWallet()
    const creator = new FakeWallet()
    const t = await makeTip(tipper, creator.identityKey)
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef }, [
      { verdict: 'pending', txStatus: 'RECEIVED' },
      new RelayError('Arcade status read failed', 502),
      { verdict: 'seen-no-competitor', txStatus: 'SEEN_ON_NETWORK' },
    ])
    const done = collectTip(asWallet(creator), t.row, relay, collectDeps({ sleep: undefined }))
    await vi.advanceTimersByTimeAsync(39_999)
    expect(creator.callsTo('internalizeAction')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect((await done).result).toBe('accepted')
    expect(relayCalls(relay, 'status')).toHaveLength(3)
    const [{ args }] = creator.callsTo('internalizeAction')
    expect(args).toEqual({
      tx: Utils.toArray(t.beef, 'hex'),
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: t.remittance }],
      description: 'Tip received',
    })
    const [{ args: report }] = relayCalls(relay, 'markInternalized')
    expect(report.txid).toBe(t.txid)
    expect(await verifyCreatorSignature(internalizedMessage(ORIGIN, t.txid), report.signature, creator.identityKey)).toBe(true)
  })

  it('collectTip retries at 10/30/60 s and reports accepted', async () => {
    vi.useFakeTimers()
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef })
    creator.internalizeErrors = [new Error('wallet storage busy'), new Error('wallet storage busy')]
    const at: number[] = []
    const internalize = creator.internalizeAction.bind(creator)
    creator.internalizeAction = async args => (at.push(Date.now()), internalize(args))
    const start = Date.now()
    const done = collectTip(asWallet(creator), t.row, relay, collectDeps({ sleep: undefined }))
    await vi.advanceTimersByTimeAsync(40_000)
    expect((await done).result).toBe('accepted')
    const gaps = at.slice(1).map((x, i) => x - at[i])
    expect(at[0] - start).toBe(0)
    expect(gaps).toEqual([10_000, 30_000])
    expect(relayCalls(relay, 'markInternalized')).toHaveLength(1)
  })

  it('collectTip is bounded: it gives up after its schedule and says why', async () => {
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef }, [{ verdict: 'pending', txStatus: 'RECEIVED' }])
    const sleeps: number[] = []
    const out = await collectTip(asWallet(creator), t.row, relay, collectDeps({ sleep: async ms => void sleeps.push(ms) }))
    expect(out).toEqual({ result: 'gave-up', error: expect.stringContaining('not seen it with no competitor yet (RECEIVED)') })
    expect(sleeps).toEqual([10_000, 30_000, 60_000, 60_000, 60_000])
    expect(creator.callsTo('internalizeAction')).toHaveLength(0)

    // The wallet switched network: never internalized, and the reason is kept.
    const seen = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef })
    creator.network = 'mainnet'
    expect(await collectTip(asWallet(creator), t.row, seen, collectDeps())).toEqual({ result: 'gave-up', error: 'wallet is on mainnet, app is on testnet' })
    expect(creator.callsTo('internalizeAction')).toHaveLength(0)
    creator.network = 'testnet'

    // An ancestor Arcade has no rawTx for: the BEEF cannot be completed, and that is what the creator sees.
    const partial = new Beef()
    partial.mergeTxidOnly('22'.repeat(32))
    const child = Transaction.fromAtomicBEEF(Utils.toArray(t.beef, 'hex'))
    child.inputs[0].sourceTXID = '22'.repeat(32)
    child.inputs[0].sourceTransaction = undefined
    partial.mergeRawTx(child.toBinary())
    const partialHex = Utils.toHex(partial.toBinaryAtomic(child.id('hex')))
    const row = { ...t.row, txid: child.id('hex'), remittances: [{ ...t.row.remittances[0], beefId: sha256(partialHex) }] }
    const missing = fakeRelay(row, { [sha256(partialHex)]: partialHex })
    const gaveUp = await collectTip(asWallet(creator), row, missing, collectDeps())
    expect(gaveUp).toEqual({ result: 'gave-up', error: expect.stringMatching(/no rawTx for ancestor 2{64}/) })
    expect(relayCalls(missing, 'ancestor').map(c => c.args)).toContain('22'.repeat(32))
  })

  it('failed only after REJECTED on two reads at least 20 s apart, with a re-post between', async () => {
    vi.useFakeTimers()
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const rejected = { verdict: 'terminal', txStatus: 'REJECTED', extraInfo: 'bad script' }
    const relay = fakeRelay(t.row, {}, [rejected])
    let settled = false
    const done = collectTip(asWallet(creator), t.row, relay, collectDeps({ sleep: undefined })).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(39_999)
    expect(settled).toBe(false) // the read at 10 s is not 20 s after the first
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toEqual({ result: 'failed', error: expect.stringContaining('REJECTED (bad script) on two reads') })
    expect(relay.calls.map(c => c.method)).toEqual(['status', 'rebroadcast', 'status', 'status'])
    expect(creator.callsTo('internalizeAction')).toHaveLength(0)

    // One REJECTED read, then seen: the tip is collected.
    const recovered = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef }, [rejected, {}])
    const later = collectTip(asWallet(creator), t.row, recovered, collectDeps({ sleep: undefined }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await later).result).toBe('accepted')

    // A REJECTED that may not be final is never called failed.
    const stale = fakeRelay(t.row, {}, [{ ...rejected, note: 'may not be final for a tx the network already accepted; re-read status' }])
    expect((await collectTip(asWallet(creator), t.row, stale, collectDeps())).result).toBe('gave-up')
  })

  it('tries each candidate with its own BEEF and skips a front-run one', async () => {
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const real = t.row.remittances[0]
    // Someone else posted the same transaction first with their own remittance, in a BEEF with a fake BUMP.
    const forged = Transaction.fromAtomicBEEF(Utils.toArray(t.beef, 'hex'))
    const source = forged.inputs[0].sourceTransaction!
    source.merklePath = new MerklePath(123, [[{ offset: 0, hash: source.id('hex'), txid: true }]])
    const otherBeef = Utils.toHex(forged.toAtomicBEEF())
    expect(otherBeef).not.toBe(t.beef)
    const bogus = { ...real, beefId: sha256(otherBeef), senderIdentityKey: new FakeWallet().identityKey }
    const wrongAmount = { ...real, beefId: sha256(otherBeef), derivationPrefix: newDerivation().derivationPrefix, satoshis: 999 }
    const row = { ...t.row, remittances: [bogus, wrongAmount, real] }
    const relay = fakeRelay(row, { [bogus.beefId]: otherBeef, [real.beefId]: t.beef })
    expect((await collectTip(asWallet(creator), row, relay, collectDeps())).result).toBe('accepted')
    const tried = creator.callsTo('internalizeAction').map(c => c.args)
    expect(tried).toHaveLength(2) // the 999-sat candidate does not match its output and never reaches the wallet
    expect(tried[0].outputs[0].paymentRemittance.senderIdentityKey).toBe(bogus.senderIdentityKey)
    expect(Utils.toHex(tried[0].tx)).toBe(otherBeef)
    expect(Utils.toHex(tried[1].tx)).toBe(t.beef)
    expect(creator.accepted).toHaveLength(1)
  })

  it('Collector de-duplicates tip events by txid and skips tips this wallet already collected', async () => {
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef })
    const storage = new MemoryStorage()
    let release!: () => void
    const held = new Promise<void>(r => (release = r))
    const collect = vi.fn(async (...args: Parameters<typeof collectTip>) => (await held, collectTip(...args)))
    const states: string[] = []
    const make = () =>
      new Collector({ wallet: asWallet(creator), identityKey: creator.identityKey, api: relay, deps: collectDeps(), storage, collect, onChange: (_, s) => states.push(s.state) })
    const c = make()
    c.onTip(t.row)
    c.onTip(t.row)
    c.onTip({ ...t.row })
    // A new candidate while the run is in flight waits for it (that run re-reads the candidates each attempt).
    const extra = { ...t.row.remittances[0], derivationPrefix: newDerivation().derivationPrefix }
    c.onTip({ ...t.row, remittances: [...t.row.remittances, extra] })
    expect(collect).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(c.states.get(t.txid)).toBe('accepted'))
    await new Promise(r => setTimeout(r, 10))
    expect(collect).toHaveBeenCalledTimes(1) // collected: no second run
    expect(states).toEqual(['collecting', 'accepted'])

    // A new Collector for the same wallet (a reload) skips it; another wallet's does not.
    const again = make()
    again.onTip(t.row)
    expect(again.states.get(t.txid)).toBe('accepted')
    expect(collect).toHaveBeenCalledTimes(1)
    const other = new FakeWallet()
    new Collector({ wallet: asWallet(other), identityKey: other.identityKey, api: relay, deps: collectDeps(), storage, collect }).onTip(t.row)
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2))
  })

  it('Collector runs again when a new candidate arrives for a tip that was not for this wallet', async () => {
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const bogus = { ...t.row.remittances[0], senderIdentityKey: new FakeWallet().identityKey }
    const relay = fakeRelay({ ...t.row, remittances: [bogus] }, { [bogus.beefId]: t.beef })
    const collect = vi.fn(collectTip)
    const c = new Collector({ wallet: asWallet(creator), identityKey: creator.identityKey, api: relay, deps: collectDeps(), storage: new MemoryStorage(), collect })
    c.onTip({ ...t.row, remittances: [bogus] })
    await vi.waitFor(() => expect(c.states.get(t.txid)).toBe('not-for-me'))
    relay.getTip = async () => t.row
    c.onTip({ ...t.row, remittances: [bogus] }) // nothing new: ignored
    expect(collect).toHaveBeenCalledTimes(1)
    expect(c.states.get(t.txid)).toBe('not-for-me')
    c.onTip(t.row) // the honest candidate arrives
    await vi.waitFor(() => expect(c.states.get(t.txid)).toBe('accepted'))
    expect(collect).toHaveBeenCalledTimes(2)
  })
  it('Collector re-sends the report for a tip it collected, remembers it when stopped, and retries gave-up tips', async () => {
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const storage = new MemoryStorage()
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef })
    const opts = { wallet: asWallet(creator), identityKey: creator.identityKey, api: relay, deps: collectDeps(), storage }

    // Collected, then the page stopped before the run finished: the txid is still remembered.
    let release!: () => void
    const held = new Promise<void>(r => (release = r))
    // The wallet accepted it while the page was closing.
    const first = new Collector({ ...opts, collect: async () => (await held, { result: 'accepted' as const, satoshis: 1000 }) })
    first.onTip(t.row)
    first.stop()
    release()
    await vi.waitFor(() => expect(storage.getItem(`tip:collected:${creator.identityKey}`)).toContain(t.txid))
    const reportsBefore = relayCalls(relay, 'markInternalized').length

    // On load, a collected tip whose relay row has no internalizedAt gets the signed report again, once.
    const reload = new Collector(opts)
    reload.onTip(t.row)
    reload.onTip(t.row)
    await vi.waitFor(() => expect(relayCalls(relay, 'markInternalized')).toHaveLength(reportsBefore + 1))
    const [last] = relayCalls(relay, 'markInternalized').slice(-1)
    expect(await verifyCreatorSignature(internalizedMessage(ORIGIN, t.txid), last.args.signature, creator.identityKey)).toBe(true)
    new Collector(opts).onTip({ ...t.row, internalizedAt: '2026-10-22T00:00:00Z' })
    await new Promise(r => setTimeout(r, 10))
    expect(relayCalls(relay, 'markInternalized')).toHaveLength(reportsBefore + 1)

    // A tip that gave up runs again on a seen-no-competitor status, or when the stream reopens.
    const other = new FakeWallet()
    const u = await makeTip(new FakeWallet(), other.identityKey, 1234)
    const urelay = fakeRelay(u.row, { [u.row.remittances[0].beefId]: u.beef })
    const outcomes: CollectOutcome[] = [{ result: 'gave-up', error: 'wallet storage busy' }, { result: 'gave-up', error: 'still busy' }]
    const collect = vi.fn(async (...a: Parameters<typeof collectTip>) => outcomes.shift() ?? collectTip(...a))
    const c = new Collector({ wallet: asWallet(other), identityKey: other.identityKey, api: urelay, deps: collectDeps(), storage, collect })
    c.onTip(u.row)
    await vi.waitFor(() => expect(c.info.get(u.txid)).toEqual({ state: 'gave-up', error: 'wallet storage busy' }))
    c.onStatus({ ...u.row, verdict: 'pending' })
    expect(collect).toHaveBeenCalledTimes(1)
    c.onStatus({ ...u.row, verdict: 'seen-no-competitor' })
    await vi.waitFor(() => expect(c.info.get(u.txid)).toEqual({ state: 'gave-up', error: 'still busy' }))
    c.retryGaveUp()
    await vi.waitFor(() => expect(c.info.get(u.txid)).toEqual({ state: 'accepted', satoshis: 1234 }))
    expect(collect).toHaveBeenCalledTimes(3)
  })

  it('Collector still shows a collected tip when the browser refuses to store it', async () => {
    const creator = new FakeWallet()
    const t = await makeTip(new FakeWallet(), creator.identityKey)
    const relay = fakeRelay(t.row, { [t.row.remittances[0].beefId]: t.beef })
    const storage = new MemoryStorage()
    storage.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = new Collector({
      wallet: asWallet(creator),
      identityKey: creator.identityKey,
      api: relay,
      deps: collectDeps(),
      storage,
      collect: async () => ({ result: 'accepted' as const, satoshis: 1000 }),
    })
    c.onTip(t.row)
    await vi.waitFor(() => expect(c.info.get(t.txid)).toEqual({ state: 'accepted', satoshis: 1000 }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(t.txid))
    // Within this page it is remembered anyway: a repeat event does not collect it again.
    c.onTip({ ...t.row, remittances: [...t.row.remittances, { ...t.row.remittances[0], derivationPrefix: newDerivation().derivationPrefix }] })
    expect(c.states.get(t.txid)).toBe('accepted')
  })
})

describe('TipList', () => {
  it('shows relay verdicts as seen on network / failed / pending, and received only after internalize', () => {
    const row = (txid: string, verdict: string, over: Partial<TipRow> = {}): TipRow => ({
      txid,
      txStatus: 'X',
      verdict,
      competingTxs: [],
      receivedAt: '',
      updatedAt: '',
      remittances: [{ beefId: '', outputIndex: 0, satoshis: 777, senderIdentityKey: '', derivationPrefix: '', derivationSuffix: '', receivedAt: '' }],
      ...over,
    })
    const html = renderToString(
      createElement(TipList, {
        tips: [
          row('1'.repeat(64), 'seen-no-competitor'),
          row('2'.repeat(64), 'terminal'),
          row('3'.repeat(64), 'on-network-not-seen'),
          row('4'.repeat(64), 'seen-no-competitor', { internalizedAt: '2026-10-22T00:00:00Z' }),
          row('5'.repeat(64), 'seen-no-competitor'),
        ],
        collect: { ['5'.repeat(64)]: { state: 'accepted' } },
      }),
    )
    expect(html).toContain('seen on network')
    expect(html).toContain('failed')
    expect(html).toContain('pending')
    expect(html.match(/>received</g)).toHaveLength(2) // the badge text, not its class
    expect(html).toContain('777')
    expect(html).not.toMatch(/confirm/i)

    // Sats: the amount this wallet received, else the amounts the relay validated; the reason a tip is not collected.
    const two = row('6'.repeat(64), 'seen-no-competitor')
    two.remittances = [two.remittances[0], { ...two.remittances[0], outputIndex: 1, satoshis: 1900 }]
    const more = renderToString(
      createElement(TipList, {
        tips: [two, row('7'.repeat(64), 'seen-no-competitor'), row('8'.repeat(64), 'terminal')],
        collect: {
          ['7'.repeat(64)]: { state: 'accepted', satoshis: 1234 },
          ['6'.repeat(64)]: { state: 'gave-up', error: 'wallet is on mainnet, app is on testnet' },
          ['8'.repeat(64)]: { state: 'failed', error: 'Arcade reported REJECTED on two reads, with a re-post between' },
        },
      }),
    )
    expect(more).toContain('777 / 1900')
    expect(more).toContain('>1234<')
    expect(more.match(/>777</g)).toHaveLength(1) // row 8 only: row 7 shows what was received
    expect(more).toContain('not collected yet: wallet is on mainnet, app is on testnet')
    expect(more).toContain('REJECTED on two reads')
  })
})

describe('web app and the real relay', () => {
  /** The real relay on 127.0.0.1 with a fake Arcade: SEEN_ON_NETWORK for every tip, `ancestors` by txid. */
  async function startRelay(ancestors: Record<string, object> = {}) {
    const arcadeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      if (!url.startsWith(ARCADE)) throw new Error(`unexpected fetch ${url}`)
      const txid = init.method === 'POST' ? Transaction.fromHexEF(String(init.body)).id('hex') : url.split('/').pop()!
      if (init.method !== 'POST' && ancestors[txid]) return new Response(JSON.stringify(ancestors[txid]), { status: 200 })
      const body = init.method === 'POST' ? { txid, status: 202, txStatus: 'RECEIVED' } : { txid, txStatus: 'SEEN_ON_NETWORK' }
      return new Response(JSON.stringify(body), { status: init.method === 'POST' ? 202 : 200 })
    }) as typeof fetch
    const cfg = loadServerConfig({}, quiet)
    const db = openDb(':memory:')
    const server = http.createServer(createApp(cfg, { db, arcade: new Arcade(cfg.arcadeUrl, arcadeFetch), limits: { tipBurst: 1000 } }))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    return {
      api: relayApi(fetch, `http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      async close() {
        server.closeAllConnections()
        await new Promise(r => server.close(r))
        db.close()
      },
    }
  }

  it('a tip goes through the relay and is collected by the creator it pays', async () => {
    const relay = await startRelay()
    try {
      const { api } = relay
      const creator = new FakeWallet()
      expect(await claimCreator(asWallet(creator), creator.identityKey, api)).toEqual({ role: 'creator' })
      const appCfg = await api.config()
      expect(appCfg.creatorIdentityKey).toBe(creator.identityKey)
      expect(await claimCreator(asWallet(new FakeWallet()), new FakeWallet().identityKey, api)).toEqual({ role: 'not-creator', creatorIdentityKey: creator.identityKey })

      const tipper = new FakeWallet()
      const storage = new MemoryStorage()
      const out = await sendTip(asWallet(tipper), appCfg, creator.identityKey, 1000, api, { storage })
      expect(out).toMatchObject({ posted: true, row: { verdict: 'seen-no-competitor' } })
      expect(pendingTips(storage)).toEqual([])

      const row = await api.getTip(out.txid)
      expect((await collectTip(asWallet(new FakeWallet()), row, api, collectDeps())).result).toBe('not-for-me')
      expect((await collectTip(asWallet(creator), row, api, collectDeps())).result).toBe('accepted')
      expect(creator.accepted).toHaveLength(1)
      expect((await api.getTip(out.txid)).internalizedAt).toEqual(expect.any(String)) // the relay verified the signed report
    } finally {
      await relay.close()
    }
  })

  it('an ancestor the BEEF names by txid only comes from Arcade through the relay', async () => {
    const key = PrivateKey.fromRandom()
    const lock = new P2PKH().lock(key.toAddress('testnet'))
    const g0 = new Transaction()
    g0.addInput({ sourceTXID: '33'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    g0.addOutput({ lockingScript: lock, satoshis: 9000 })
    const grand = new Transaction()
    grand.addInput({ sourceTransaction: g0, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
    grand.addOutput({ lockingScript: lock, satoshis: 8000 })
    await grand.sign()
    const grandPath = new MerklePath(900002, [[{ offset: 0, hash: grand.id('hex'), txid: true }]])
    const parent = new Transaction()
    parent.addInput({ sourceTransaction: grand, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
    parent.addOutput({ lockingScript: lock, satoshis: 7000 })
    await parent.sign()
    const relay = await startRelay({ [grand.id('hex')]: { txid: grand.id('hex'), txStatus: 'MINED', rawTx: grand.toHexEF(), merklePath: grandPath.toHex() } })
    try {
      const { api } = relay
      const creator = new FakeWallet()
      await claimCreator(asWallet(creator), creator.identityKey, api)
      const tipper = new FakeWallet()
      const { derivationPrefix, derivationSuffix } = newDerivation()
      const payee = await payeeLockingScript(asWallet(tipper), creator.identityKey, derivationPrefix, derivationSuffix)
      const child = new Transaction()
      child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
      child.addOutput({ lockingScript: LockingScript.fromHex(payee), satoshis: 1000 })
      child.addOutput({ lockingScript: lock, satoshis: 5900 })
      await child.sign()
      const beef = new Beef()
      beef.mergeTxidOnly(grand.id('hex')) // unproven parent, its mined parent by txid only
      beef.mergeRawTx(parent.toBinary())
      beef.mergeRawTx(child.toBinary())
      const txid = child.id('hex')
      await api.postTip({
        txid,
        beef: Utils.toHex(beef.toBinaryAtomic(txid)),
        outputIndex: 0,
        satoshis: 1000,
        remittance: { senderIdentityKey: tipper.identityKey, derivationPrefix, derivationSuffix },
      })
      expect(await api.ancestor(grand.id('hex'))).toEqual({ txid: grand.id('hex'), rawTx: grand.toHex(), merklePath: grandPath.toHex() })
      expect(await api.ancestor('44'.repeat(32))).toBeUndefined() // Arcade holds no rawTx
      expect((await collectTip(asWallet(creator), await api.getTip(txid), api, collectDeps())).result).toBe('accepted')
      const internalized = Beef.fromBinary(creator.accepted[0].tx)
      expect(internalized.isValid()).toBe(true)
      expect(internalized.findTxid(grand.id('hex'))!.isTxidOnly).toBe(false)
    } finally {
      await relay.close()
    }
  })
})

describe('web/** wording', () => {
  it('UI never says confirmation', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(join(SAMPLE, 'web'))
    expect(files.length).toBeGreaterThanOrEqual(11)
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/confirmation/i)
  })
})
