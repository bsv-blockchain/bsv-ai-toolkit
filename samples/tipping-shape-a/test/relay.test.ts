import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MerklePath, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.js'
import { Arcade, verdictOf } from '../server/arcade.js'
import { claimMessage, internalizedMessage, isIdentityKey, SIGNATURE_KEY_ID, TIPS_PROTOCOL, verifyCreatorSignature } from '../server/auth.js'
import { efHexFromAtomicBeef, outputPaysScript } from '../server/beef.js'
import { KNOWN_HOSTS, loadServerConfig } from '../server/config.js'
import { openDb, type Db } from '../server/db.js'
import type { Limits } from '../server/routes.js'
import { Broadcaster } from '../server/sse.js'

const SAMPLE = fileURLToPath(new URL('..', import.meta.url))
const VERSIONS = fileURLToPath(new URL('../../../content/versions.json', import.meta.url))
const ARCADE = 'https://arcade-testnet-us-1.bsvblockchain.tech'
const PLACEHOLDER = 'a'.repeat(64)
const COMPETITOR = 'b'.repeat(64)
const HOUR = 60 * 60 * 1000

const quiet = () => {}
const fixture = (name: string, txid: string): any =>
  JSON.parse(readFileSync(join(SAMPLE, 'test', 'fixtures', `${name}.json`), 'utf8').replaceAll(PLACEHOLDER, txid))

// A real AtomicBEEF, built in memory: a P2PKH source tx (with a one-leaf merkle path) and a signed child that
// spends it, paying `tipSats` at output 0 plus change. The keys are random and never leave this process.
async function buildTip(tipSats = 1000) {
  const key = PrivateKey.fromRandom()
  const address = key.toAddress('testnet')
  const source = new Transaction()
  source.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  source.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 5000 })
  source.merklePath = new MerklePath(900000, [[{ offset: 0, hash: source.id('hex'), txid: true }]])
  const child = new Transaction()
  child.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  child.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress('testnet')), satoshis: tipSats })
  child.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 3500 })
  await child.sign()
  return { child, txid: child.id('hex'), beef: Utils.toHex(child.toAtomicBEEF()) }
}

let signed: Promise<Awaited<ReturnType<typeof buildTip>>> | undefined
// One signed tip serves every test that does not need its own.
const tip = () => (signed ??= buildTip())

// Wallets stand in for the creator's: they sign exactly as the creator page will.
const creatorWallet = new ProtoWallet(PrivateKey.fromRandom())
const otherWallet = new ProtoWallet(PrivateKey.fromRandom())
const identityOf = async (w: ProtoWallet) => (await w.getPublicKey({ identityKey: true })).publicKey
const sign = async (w: ProtoWallet, message: string) =>
  Utils.toHex(
    (await w.createSignature({ data: Utils.toArray(message, 'utf8'), protocolID: TIPS_PROTOCOL, keyID: SIGNATURE_KEY_ID, counterparty: 'anyone' }))
      .signature,
  )

const SENDER = PrivateKey.fromRandom().toPublicKey().toString()
const OFF_CURVE = `03${'cd'.repeat(32)}`

function body(t: { txid: string; beef: string }, over: Record<string, unknown> = {}) {
  return {
    txid: t.txid,
    beef: t.beef,
    outputIndex: 0,
    satoshis: 1000,
    remittance: { senderIdentityKey: SENDER, derivationPrefix: 'cHJlZml4MDE=', derivationSuffix: 'c3VmZml4MDE=' },
    ...over,
  }
}
const withPrefix = (t: { txid: string; beef: string }, derivationPrefix: string) =>
  body(t, { remittance: { senderIdentityKey: SENDER, derivationPrefix, derivationSuffix: 'c3VmZml4MDE=' } })

type Reply = { status: number; json?: unknown; text?: string } | Error
type Call = { url: string; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }

/**
 * A fake fetch for Arcade: POST /tx answers `post`; GET /tx/{txid} answers `gets` in order (the last one repeats).
 * With `hold`, every answer waits for it, so concurrent requests overlap in flight.
 */
function fakeArcade(post: Reply, gets: Reply[] = [], hold?: Promise<void>) {
  const calls: Call[] = []
  let g = 0
  const answer = (r: Reply): Response => {
    if (r instanceof Error) throw r
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status })
  }
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    calls.push({ url, method, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined, signal: init.signal ?? undefined })
    await hold
    if (method === 'POST') return answer(post)
    const r = gets[Math.min(g++, gets.length - 1)]
    if (r === undefined) return answer({ status: 404, json: { title: 'not found' } })
    return answer(r)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const opened: Db[] = []
afterEach(() => {
  while (opened.length) opened.pop()!.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Tests run from one address, so the rate limit is off unless a test sets it.
function relay(arc: ReturnType<typeof fakeArcade>, env: NodeJS.ProcessEnv = {}, limits: Partial<Limits> = { tipBurst: 1000 }) {
  const cfg = loadServerConfig(env, quiet)
  const db = openDb(':memory:')
  opened.push(db)
  const broadcaster = new Broadcaster()
  const emit = vi.spyOn(broadcaster, 'emit')
  const arcade = new Arcade(cfg.arcadeUrl, arc.fetchImpl)
  const clock = { now: Date.now() }
  const app = createApp(cfg, { db, arcade, broadcaster, limits, now: () => clock.now })
  const events = (name: string) => emit.mock.calls.filter(([e]) => e === name).map(([, d]) => d as any)
  return { app, db, events, cfg, clock }
}

const seen = (txid: string, hold?: Promise<void>) =>
  fakeArcade({ status: 202, json: fixture('submit-202', txid) }, [{ status: 200, json: fixture('status-seen', txid) }], hold)

/** A promise to hold the fake Arcade with, and its release. */
function gate() {
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  return { held, release }
}

/** Resolves once `spy` has been called `n` times (the requests have reached the handler). */
async function calledTimes(spy: { mock: { calls: unknown[] } }, n: number) {
  for (let i = 0; i < 500 && spy.mock.calls.length < n; i++) await new Promise(r => setTimeout(r, 2))
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(n)
}

describe('POST /api/tips', () => {
  it('POST /api/tips submits EF (not BEEF) to {arcade}/tx as text/plain', async () => {
    const t = await tip()
    const arc = seen(t.txid)
    const { app, db } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ txid: t.txid, txStatus: 'SEEN_ON_NETWORK', verdict: 'seen-no-competitor', competingTxs: [] })

    const post = arc.calls.find(c => c.method === 'POST')!
    expect(post.url).toBe(`${ARCADE}/tx`)
    expect(post.headers['Content-Type']).toBe('text/plain')
    expect(post.body).toMatch(/^[0-9a-f]{8}0000000000ef/)
    expect(post.body).toBe(t.child.toHexEF())
    expect(post.body).not.toMatch(/^(0100beef|0200beef|01010101)/)
    // POST is provisional: the verdict comes from GET /tx/{txid}.
    expect(arc.calls.map(c => `${c.method} ${c.url}`)).toEqual([`POST ${ARCADE}/tx`, `GET ${ARCADE}/tx/${t.txid}`])
    for (const c of arc.calls) expect(c.signal).toBeInstanceOf(AbortSignal)
    expect(db.getBeef(t.txid)).toBe(t.beef)
    expect(db.getTip(t.txid)).toMatchObject({
      verdict: 'seen-no-competitor',
      remittances: [{ outputIndex: 0, satoshis: 1000, senderIdentityKey: SENDER, derivationPrefix: 'cHJlZml4MDE=', derivationSuffix: 'c3VmZml4MDE=' }],
    })
  })

  it('POST /api/tips is idempotent by txid', async () => {
    const t = await tip()
    const arc = seen(t.txid)
    const { app, db, events } = relay(arc)
    const first = await request(app).post('/api/tips').send(body(t))
    const second = await request(app).post('/api/tips').send(body(t))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(db.listTips()).toHaveLength(1)
    expect(db.getTip(t.txid)!.remittances).toHaveLength(1)
    expect(events('tip')).toHaveLength(1)
    expect(events('tip')[0]).toMatchObject({ txid: t.txid, remittances: [expect.objectContaining({ senderIdentityKey: SENDER })] })
    expect(arc.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('concurrent POSTs of one txid share one submission', async () => {
    const t = await tip()
    const { held, release } = gate()
    const arc = seen(t.txid, held)
    const { app, db, events } = relay(arc)
    const adds = vi.spyOn(db, 'addRemittance')
    const both = Promise.all([request(app).post('/api/tips').send(body(t)), request(app).post('/api/tips').send(body(t))])
    await calledTimes(adds, 2) // both requests are in flight while Arcade holds its answer
    release()
    const [a, b] = await both
    expect(b.body).toEqual(a.body)
    expect(db.listTips()).toHaveLength(1)
    expect(events('tip')).toHaveLength(1)
    expect(arc.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  // An observer can rebuild the AtomicBEEF from the network and post it first with a bogus remittance; the
  // tipper's own remittance must still be stored, and the creator's wallet decides which one is real.
  it('concurrent POSTs with different remittances are both stored as candidates', async () => {
    const t = await tip()
    const { held, release } = gate()
    const arc = seen(t.txid, held)
    const { app, db, events } = relay(arc)
    const adds = vi.spyOn(db, 'addRemittance')
    const both = Promise.all([
      request(app).post('/api/tips').send(withPrefix(t, 'YXR0YWNrZXI=')),
      request(app).post('/api/tips').send(withPrefix(t, 'aG9uZXN0')),
    ])
    await calledTimes(adds, 2)
    release()
    const [a, b] = await both
    expect([a.status, b.status]).toEqual([200, 200])
    // Both answers come after the shared submission, so both list both candidates.
    expect(a.body.remittances).toHaveLength(2)
    expect(b.body).toEqual(a.body)
    expect(db.getTip(t.txid)!.remittances.map(r => r.derivationPrefix).sort()).toEqual(['YXR0YWNrZXI=', 'aG9uZXN0'].sort())
    // Each new candidate is announced; Arcade is asked once.
    expect(events('tip')).toHaveLength(2)
    expect(arc.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('a new candidate for a settled tip is stored and announced without asking Arcade again', async () => {
    const t = await tip()
    const arc = seen(t.txid)
    const { app, db, events } = relay(arc)
    await request(app).post('/api/tips').send(body(t))
    const res = await request(app).post('/api/tips').send(withPrefix(t, 'b3RoZXI='))
    expect(res.status).toBe(200)
    expect(res.body.remittances).toHaveLength(2)
    expect(db.getTip(t.txid)!.remittances.map(r => r.derivationPrefix)).toEqual(['cHJlZml4MDE=', 'b3RoZXI='])
    expect(events('tip')).toHaveLength(2)
    expect(arc.calls).toHaveLength(2) // the first POST and its status read only
  })

  it('caps the remittance candidates per txid', async () => {
    const t = await tip()
    const { app, db } = relay(seen(t.txid), {}, { tipBurst: 1000, remittancesPerTip: 3 })
    for (const p of ['cDE=', 'cDI=', 'cDM=']) expect((await request(app).post('/api/tips').send(withPrefix(t, p))).status).toBe(200)
    const fourth = await request(app).post('/api/tips').send(withPrefix(t, 'cDQ='))
    expect(fourth.status).toBe(409)
    expect(fourth.body.error).toMatch(/3 remittance candidates/)
    // A stored candidate is still answered (idempotent), and the cap held.
    expect((await request(app).post('/api/tips').send(withPrefix(t, 'cDE='))).status).toBe(200)
    expect(db.getTip(t.txid)!.remittances).toHaveLength(3)
  })

  it('2xx then REJECTED is stored as terminal', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 200, json: fixture('status-rejected', t.txid) }])
    const { app, db, events } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ txStatus: 'REJECTED', verdict: 'terminal', competingTxs: [COMPETITOR], extraInfo: 'UTXO_SPENT' })
    // R15: a REJECTED that blames the inputs may be a stale view of a tx the network accepted elsewhere.
    expect(res.body.note).toMatch(/may not be final.*re-read status/)
    expect(db.getTip(t.txid)).toMatchObject({ txStatus: 'REJECTED', verdict: 'terminal', note: res.body.note })
    expect(events('status')).toEqual([expect.objectContaining({ txid: t.txid, verdict: 'terminal' })])
  })

  it('a repeat POST re-reads a terminal tip whose REJECTED may not be final', async () => {
    const t = await tip()
    const arc = fakeArcade(
      { status: 202, json: fixture('submit-202', t.txid) },
      [{ status: 200, json: fixture('status-rejected', t.txid) }, { status: 200, json: fixture('status-seen', t.txid) }],
    )
    const { app } = relay(arc)
    expect((await request(app).post('/api/tips').send(body(t))).body).toMatchObject({ verdict: 'terminal' })
    const again = await request(app).post('/api/tips').send(body(t))
    expect(again.body).toMatchObject({ verdict: 'seen-no-competitor' })
    expect(again.body.note).toBeUndefined()
    expect(arc.calls.map(c => c.method)).toEqual(['POST', 'GET', 'POST', 'GET'])
  })

  it('an HTTP 400 with an ARC code is terminal without a status read, and final', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 400, json: { error: 'malformed transaction or invalid unlocking script', status: 461, title: 'malformed', txid: t.txid } })
    const { app } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ txStatus: 'REJECTED', verdict: 'terminal' })
    expect(res.body.note).toBeUndefined()
    expect((await request(app).post('/api/tips').send(body(t))).body).toEqual(res.body)
    expect(arc.calls.map(c => c.method)).toEqual(['POST'])
  })

  it('already known re-reads status before deciding', async () => {
    const t = await tip()
    const arc = fakeArcade(
      { status: 400, json: { error: 'transaction already known', reason: 'txn-already-known', txid: t.txid } },
      [{ status: 200, json: fixture('status-seen', t.txid) }],
    )
    const { app } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.body).toMatchObject({ txStatus: 'SEEN_ON_NETWORK', verdict: 'seen-no-competitor' })
    expect(arc.calls.map(c => c.method)).toEqual(['POST', 'GET'])
  })

  it('a non-validation 4xx is not a verdict (R18)', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 401, json: { title: 'unauthorized' } })
    const { app, db } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ txStatus: 'UNKNOWN', verdict: 'pending' })
    expect(res.body.transient).toBeUndefined()
    expect(res.body.note).toMatch(/HTTP 401.*not a transaction verdict/)
    expect(db.getTip(t.txid)).toMatchObject({ verdict: 'pending', note: res.body.note })
    expect(arc.calls.map(c => c.method)).toEqual(['POST'])
  })

  it('Arcade unreachable keeps the row as pending and answers 502 transient', async () => {
    const t = await tip()
    const down = fakeArcade(new TypeError('fetch failed'))
    const { app, db, events, cfg } = relay(down)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ transient: true, txid: t.txid, txStatus: 'UNREACHABLE', verdict: 'pending' })
    expect(db.getTip(t.txid)).toMatchObject({ txStatus: 'UNREACHABLE', verdict: 'pending' })
    expect(events('tip')).toHaveLength(1)

    // The browser's retry submits again once Arcade is back; the tip is still announced once.
    const up = seen(t.txid)
    const events2 = new Broadcaster()
    const emit2 = vi.spyOn(events2, 'emit')
    const again = await request(createApp(cfg, { db, arcade: new Arcade(cfg.arcadeUrl, up.fetchImpl), broadcaster: events2 }))
      .post('/api/tips')
      .send(body(t))
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ verdict: 'seen-no-competitor' })
    expect(emit2.mock.calls.map(([e]) => e)).toEqual(['status'])
    expect(db.listTips()).toHaveLength(1)
  })

  it('txid that does not match the BEEF is 400', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: {} })
    const { app, db } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t, { txid: 'c'.repeat(64) }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/txid/)
    expect(arc.calls).toHaveLength(0)
    expect(db.listTips()).toHaveLength(0)
  })

  it('rejects malformed tips with 400 and never calls Arcade', async () => {
    const t = await tip()
    const plainBeef = Utils.toHex(t.child.toBEEF())
    const remit = (r: Record<string, unknown>) => ({ remittance: { senderIdentityKey: SENDER, derivationPrefix: 'cHJlZml4MDE=', derivationSuffix: 'c3VmZml4MDE=', ...r } })
    const bad: [string, Record<string, unknown>][] = [
      ['txid not hex', { txid: 'z'.repeat(64) }],
      ['beef not hex', { beef: 'nothex' }],
      ['beef is plain BEEF, not AtomicBEEF', { beef: plainBeef }],
      ['beef is EF hex', { beef: t.child.toHexEF() }],
      ['outputIndex out of range', { outputIndex: 2 }],
      ['outputIndex not an integer', { outputIndex: 0.5 }],
      ['outputIndex negative', { outputIndex: -1 }],
      ['satoshis differ from the output', { satoshis: 999 }],
      ['satoshis as a string', { satoshis: '1000' }],
      ['satoshis zero', { satoshis: 0 }],
      ['remittance missing', { remittance: undefined }],
      ['senderIdentityKey uncompressed', remit({ senderIdentityKey: `04${'cd'.repeat(32)}` })],
      ['senderIdentityKey not on the curve', remit({ senderIdentityKey: OFF_CURVE })],
      ['derivationPrefix empty', remit({ derivationPrefix: '' })],
      ['derivationSuffix not base64', remit({ derivationSuffix: 'not base64!' })],
    ]
    const arc = fakeArcade({ status: 202, json: {} })
    const { app, db } = relay(arc)
    for (const [why, over] of bad) {
      const res = await request(app).post('/api/tips').send(body(t, over))
      expect(res.status, why).toBe(400)
      expect(typeof res.body.error, why).toBe('string')
    }
    const notJson = await request(app).post('/api/tips').set('Content-Type', 'application/json').send('{"txid":')
    expect(notJson.status).toBe(400)
    expect(arc.calls).toHaveLength(0)
    expect(db.listTips()).toHaveLength(0)
  })

  it('caps the request body size', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: {} })
    const { app } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t, { beef: 'ab'.repeat(600 * 1024) }))
    expect(res.status).toBe(413)
    expect(res.body.error).toMatch(/too large/)
    expect(arc.calls).toHaveLength(0)
  })

  it('rate-limits POST /api/tips per client address', async () => {
    const { app, clock } = relay(fakeArcade({ status: 202, json: {} }), {}, {})
    const post = (ip = '203.0.113.7') => request(app).post('/api/tips').set('X-Forwarded-For', ip).send({})
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(400) // the burst: through to validation
    const limited = await post()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect((await post('203.0.113.8')).status).toBe(400) // another address has its own bucket
    clock.now += 6_000 // 10 per minute: one token back
    expect((await post()).status).toBe(400)
    expect((await post()).status).toBe(429)
  })
})

describe('fabricated tips', () => {
  // Any well-formed AtomicBEEF can be posted, funded or not; Arcade rejects it. It must cost the relay little:
  // no BEEF in lists or events, and it is pruned after a day.
  it('a fabricated tip is stored terminal, its BEEF served only on demand, and pruned after a day', async () => {
    const fake = await buildTip(700)
    const arc = fakeArcade({ status: 400, json: { error: 'invalid unlocking script', status: 461 } })
    const { app, db, events, clock } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(fake, { satoshis: 700 }))
    expect(res.body).toMatchObject({ verdict: 'terminal' })
    expect(JSON.stringify(res.body)).not.toContain(fake.beef)
    expect(JSON.stringify(events('tip'))).not.toContain(fake.beef)
    const list = await request(app).get('/api/tips')
    expect(list.body).toHaveLength(1)
    expect(list.body[0].beefHex).toBeUndefined()
    expect(JSON.stringify(list.body)).not.toContain(fake.beef)
    expect((await request(app).get(`/api/tips/${fake.txid}/beef`)).body).toEqual({ txid: fake.txid, beefHex: fake.beef })
    expect((await request(app).get(`/api/tips/${fake.txid}`)).body).toMatchObject({ txid: fake.txid, remittances: [expect.objectContaining({ satoshis: 700 })] })

    // A day later, the next new tip prunes it.
    clock.now += 25 * HOUR
    const t = await tip()
    const arc2 = seen(t.txid)
    const later = createApp(loadServerConfig({}, quiet), { db, arcade: new Arcade(ARCADE, arc2.fetchImpl), now: () => clock.now, limits: { tipBurst: 1000 } })
    expect((await request(later).post('/api/tips').send(body(t))).status).toBe(200)
    expect(db.getTip(fake.txid)).toBeUndefined()
    expect(db.getTip(t.txid)).toBeDefined()
  })
})

describe('tips: list, detail, status, internalized', () => {
  function seed(db: Db, txid: string, beefHex = 'ab') {
    db.insertTip({ txid, beefHex, txStatus: 'ACCEPTED_BY_NETWORK', verdict: 'on-network-not-seen', competingTxs: [] })
    db.addRemittance(txid, { outputIndex: 0, satoshis: 1000, senderIdentityKey: SENDER, derivationPrefix: 'cA==', derivationSuffix: 'cw==' }, 16)
  }

  it('GET /api/tips/:txid/status re-reads Arcade and emits status on change', async () => {
    const txid = 'd'.repeat(64)
    const arc = fakeArcade({ status: 202, json: {} }, [{ status: 200, json: fixture('status-seen', txid) }])
    const { app, db, events, clock } = relay(arc)
    seed(db, txid)
    const first = await request(app).get(`/api/tips/${txid}/status`)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ txid, txStatus: 'SEEN_ON_NETWORK', verdict: 'seen-no-competitor', competingTxs: [] })
    expect(db.getTip(txid)).toMatchObject({ txStatus: 'SEEN_ON_NETWORK', verdict: 'seen-no-competitor' })
    expect(events('status')).toEqual([expect.objectContaining({ txid, verdict: 'seen-no-competitor' })])

    // Within 2 s of a live read the stored status answers; after that Arcade is read again.
    expect((await request(app).get(`/api/tips/${txid}/status`)).body).toEqual(first.body)
    expect(arc.calls).toHaveLength(1)
    clock.now += 2_000
    expect((await request(app).get(`/api/tips/${txid}/status`)).body).toMatchObject({ verdict: 'seen-no-competitor' })
    expect(events('status')).toHaveLength(1) // unchanged: no new event
    expect(arc.calls.map(c => `${c.method} ${c.url}`)).toEqual([`GET ${ARCADE}/tx/${txid}`, `GET ${ARCADE}/tx/${txid}`])
  })

  it('concurrent status reads of one txid share one Arcade read', async () => {
    const txid = 'd'.repeat(64)
    const { held, release } = gate()
    const arc = fakeArcade({ status: 202, json: {} }, [{ status: 200, json: fixture('status-seen', txid) }], held)
    const { app, db } = relay(arc)
    seed(db, txid)
    const lookups = vi.spyOn(db, 'getTip') // once per request, when the :txid is checked
    const all = Promise.all([1, 2, 3].map(() => request(app).get(`/api/tips/${txid}/status`)))
    await calledTimes(lookups, 3)
    release()
    const replies = await all
    for (const r of replies) expect(r.body).toMatchObject({ verdict: 'seen-no-competitor' })
    expect(arc.calls).toHaveLength(1)
  })

  it('a competing tx keeps the verdict pending; REJECTED blaming inputs carries the re-read note', async () => {
    const txid = 'd'.repeat(64)
    const competing = { ...fixture('status-seen', txid), competingTxs: [COMPETITOR] }
    const arc = fakeArcade({ status: 202, json: {} }, [{ status: 200, json: competing }, { status: 200, json: fixture('status-rejected', txid) }])
    const { app, db, clock } = relay(arc)
    seed(db, txid)
    expect((await request(app).get(`/api/tips/${txid}/status`)).body).toMatchObject({ verdict: 'pending', competingTxs: [COMPETITOR] })
    clock.now += 2_000
    const rejected = await request(app).get(`/api/tips/${txid}/status`)
    expect(rejected.body).toMatchObject({ verdict: 'terminal', note: expect.stringMatching(/may not be final/) })
  })

  it('a status read Arcade has never seen resubmits the stored EF', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 404, json: {} }, { status: 200, json: fixture('status-seen', t.txid) }])
    const { app, db } = relay(arc)
    seed(db, t.txid, t.beef)
    const res = await request(app).get(`/api/tips/${t.txid}/status`)
    expect(res.body).toMatchObject({ verdict: 'seen-no-competitor' })
    const post = arc.calls.find(c => c.method === 'POST')!
    expect(post.body).toBe(t.child.toHexEF())
  })

  it('status of an unknown tip is 404 and an Arcade failure is 502 transient', async () => {
    const txid = 'd'.repeat(64)
    const arc = fakeArcade(new TypeError('fetch failed'), [new TypeError('fetch failed')])
    const { app, db } = relay(arc)
    expect((await request(app).get(`/api/tips/${'e'.repeat(64)}/status`)).status).toBe(404)
    expect((await request(app).get('/api/tips/nothex/status')).status).toBe(400)
    expect((await request(app).get(`/api/tips/${'e'.repeat(64)}`)).status).toBe(404)
    expect((await request(app).get(`/api/tips/${'e'.repeat(64)}/beef`)).status).toBe(404)
    expect(arc.calls).toHaveLength(0)
    seed(db, txid)
    const res = await request(app).get(`/api/tips/${txid}/status`)
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ transient: true })
    expect(db.getTip(txid)).toMatchObject({ verdict: 'on-network-not-seen' })
  })

  it('GET /api/tips lists stored tips newest first with their candidates', async () => {
    const { app, db } = relay(fakeArcade({ status: 202, json: {} }))
    seed(db, '1'.repeat(64))
    seed(db, '2'.repeat(64))
    const list = await request(app).get('/api/tips')
    expect(list.status).toBe(200)
    expect(list.body.map((r: { txid: string }) => r.txid)).toEqual(['2'.repeat(64), '1'.repeat(64)])
    expect(list.body[0].remittances).toEqual([expect.objectContaining({ derivationPrefix: 'cA==' })])
  })

  it('POST internalized needs the creator signature over internalized:<txid>', async () => {
    const { app, db } = relay(fakeArcade({ status: 202, json: {} }))
    const txid = '1'.repeat(64)
    seed(db, txid)
    const creator = await identityOf(creatorWallet)
    const mark = (signature?: string, id = txid) => request(app).post(`/api/tips/${id}/internalized`).send(signature === undefined ? {} : { signature })

    expect((await mark(await sign(creatorWallet, internalizedMessage(txid)))).status).toBe(409) // no creator yet
    await request(app).post('/api/creator').send({ identityKey: creator, signature: await sign(creatorWallet, claimMessage(creator)) })

    expect((await mark()).status).toBe(403)
    expect((await mark(await sign(otherWallet, internalizedMessage(txid)))).status).toBe(403)
    expect((await mark(await sign(creatorWallet, internalizedMessage('2'.repeat(64))))).status).toBe(403)
    expect((await mark(await sign(creatorWallet, claimMessage(creator)))).status).toBe(403)
    expect(db.getTip(txid)!.internalizedAt).toBeUndefined()

    const ok = await mark(await sign(creatorWallet, internalizedMessage(txid)))
    expect(ok.status).toBe(200)
    expect(ok.body.internalizedAt).toEqual(expect.any(String))
    expect(db.getTip(txid)!.internalizedAt).toBe(ok.body.internalizedAt)
    expect((await mark(await sign(creatorWallet, internalizedMessage('9'.repeat(64))), '9'.repeat(64))).status).toBe(404)
  })
})

describe('config and creator', () => {
  it('GET /api/config answers network, originator and arcadeUrl', async () => {
    const { app } = relay(fakeArcade({ status: 202, json: {} }), { PUBLIC_ORIGIN: 'https://tipping.example.com' })
    const res = await request(app).get('/api/config')
    expect(res.body).toEqual({ network: 'testnet', originator: 'https://tipping.example.com', arcadeUrl: ARCADE })
  })

  it('creator claim: first claim wins, second different key is 409', async () => {
    const { app, db } = relay(fakeArcade({ status: 202, json: {} }))
    const creator = await identityOf(creatorWallet)
    const other = await identityOf(otherWallet)
    const claim = async (identityKey: string, wallet?: ProtoWallet, message = claimMessage(identityKey)) =>
      request(app).post('/api/creator').send({ identityKey, ...(wallet ? { signature: await sign(wallet, message) } : {}) })

    expect((await claim('nope')).status).toBe(400)
    expect((await claim(OFF_CURVE)).status).toBe(400)
    expect((await claim(creator)).status).toBe(403) // no signature
    expect((await claim(creator, otherWallet)).status).toBe(403) // someone else's key signing the claim
    expect((await claim(creator, creatorWallet, claimMessage(other))).status).toBe(403) // the wrong message
    expect(db.getSetting('creatorIdentityKey')).toBeUndefined()

    const first = await claim(creator.toUpperCase(), creatorWallet, claimMessage(creator))
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ creatorIdentityKey: creator })
    expect((await claim(creator, creatorWallet)).status).toBe(200)
    expect((await claim(other, otherWallet)).status).toBe(409)
    expect((await request(app).get('/api/config')).body.creatorIdentityKey).toBe(creator)
    expect(db.getSetting('creatorIdentityKey')).toBe(creator)
  })

  it('CREATOR_IDENTITY_KEY fixes the creator; a claim by another key is 409', async () => {
    const creator = await identityOf(creatorWallet)
    const other = await identityOf(otherWallet)
    const { app } = relay(fakeArcade({ status: 202, json: {} }), { CREATOR_IDENTITY_KEY: creator })
    expect((await request(app).get('/api/config')).body.creatorIdentityKey).toBe(creator)
    expect((await request(app).post('/api/creator').send({ identityKey: other, signature: await sign(otherWallet, claimMessage(other)) })).status).toBe(409)
    expect((await request(app).post('/api/creator').send({ identityKey: creator, signature: await sign(creatorWallet, claimMessage(creator)) })).status).toBe(200)
  })
})

describe('SSE', () => {
  it('SSE sends headers, keepalive and X-Accel-Buffering: no', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const broadcaster = new Broadcaster()
    const db = openDb(':memory:')
    opened.push(db)
    const server = createApp(loadServerConfig({}, quiet), { db, arcade: new Arcade(ARCADE, fakeArcade({ status: 202 }).fetchImpl), broadcaster }).listen(0)
    try {
      await new Promise<void>(resolve => server.once('listening', resolve))
      const { port } = server.address() as AddressInfo
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/events`, resolve).on('error', reject)
      })
      // The headers arrive before any event: flushHeaders() ran.
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/)
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers['x-accel-buffering']).toBe('no')
      expect(res.headers['connection']).toBe('keep-alive')

      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      const until = async (s: string) => {
        for (let i = 0; i < 100 && !text.includes(s); i++) await new Promise(r => setImmediate(r))
        return text.includes(s)
      }
      vi.advanceTimersByTime(14_999)
      expect(await until(': keepalive')).toBe(false)
      vi.advanceTimersByTime(1)
      expect(await until(': keepalive\n\n')).toBe(true)
      broadcaster.emit('tip', { txid: 'f'.repeat(64) })
      expect(await until(`event: tip\ndata: {"txid":"${'f'.repeat(64)}"}\n\n`)).toBe(true)
      res.destroy()
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('SSE refuses streams beyond the cap and drops a client that stops reading', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fakeRes = () => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 0,
        writableEnded: false,
        destroyed: false,
        writableLength: 0,
        status(code: number) { res.statusCode = code; return res },
        set: () => res,
        json: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(() => { res.destroyed = true; res.emit('close') }),
      })
      return res
    }
    const b = new Broadcaster({ maxClients: 2, maxBufferedBytes: 1024 })
    const [a, slow, third] = [fakeRes(), fakeRes(), fakeRes()]
    for (const r of [a, slow, third]) b.add(r as unknown as express.Response)
    expect([a.statusCode, slow.statusCode, third.statusCode]).toEqual([200, 200, 503])
    expect(third.flushHeaders).not.toHaveBeenCalled()
    expect(b.size).toBe(2)

    slow.writableLength = 4096 // the peer stopped reading
    b.emit('status', { txid: 'f'.repeat(64) })
    expect(a.write).toHaveBeenCalledTimes(1)
    expect(slow.write).not.toHaveBeenCalled()
    expect(slow.destroy).toHaveBeenCalled()
    expect(b.size).toBe(1)
    a.emit('close')
    expect(b.size).toBe(0)
  })
})

describe('arcade.ts', () => {
  it('verdictOf: final at SEEN with no competitor; terminal for REJECTED and DOUBLE_SPEND_ATTEMPTED', () => {
    expect(verdictOf({ txStatus: 'SEEN_ON_NETWORK' })).toBe('seen-no-competitor')
    expect(verdictOf({ txStatus: 'SEEN_MULTIPLE_NODES', competingTxs: [] })).toBe('seen-no-competitor')
    expect(verdictOf({ txStatus: 'SEEN_ON_NETWORK', competingTxs: [COMPETITOR] })).toBe('pending')
    expect(verdictOf({ txStatus: 'REJECTED', competingTxs: [COMPETITOR] })).toBe('terminal')
    expect(verdictOf({ txStatus: 'DOUBLE_SPEND_ATTEMPTED' })).toBe('terminal')
    expect(verdictOf({ txStatus: 'ACCEPTED_BY_NETWORK' })).toBe('on-network-not-seen')
    expect(verdictOf({ txStatus: 'PENDING_RETRY' })).toBe('pending')
    expect(verdictOf({ txStatus: 'SOMETHING_NEW' })).toBe('no-verdict')
  })

  it('submit trims the hex, refuses BEEF and classifies transient answers', async () => {
    const arc = fakeArcade({ status: 503, json: {} })
    const a = new Arcade(`${ARCADE}/`, arc.fetchImpl, 1234)
    expect(await a.submit(' 0100000000\n')).toMatchObject({ postStatus: 503, transient: true })
    expect(arc.calls[0]).toMatchObject({ url: `${ARCADE}/tx`, body: '0100000000' })
    await expect(a.submit('01010101abcd')).rejects.toThrow(/BEEF/)
    const locktime = new Arcade(ARCADE, fakeArcade({ status: 400, json: { status: 476 } }).fetchImpl)
    expect(await locktime.submit('0100000000')).toMatchObject({ postStatus: 400, transient: true })
    const terminal = new Arcade(ARCADE, fakeArcade({ status: 422, json: { status: 461 } }).fetchImpl)
    expect(await terminal.submit('0100000000')).toMatchObject({ postStatus: 422, transient: false })
  })

  it('waitForSeen polls until seen and stops at the deadline', async () => {
    const txid = 'd'.repeat(64)
    const arc = fakeArcade({ status: 202 }, [{ status: 200, json: { txid, txStatus: 'RECEIVED' } }, { status: 200, json: fixture('status-seen', txid) }])
    const a = new Arcade(ARCADE, arc.fetchImpl)
    expect(await a.waitForSeen(txid, 5000, 1)).toMatchObject({ txStatus: 'SEEN_ON_NETWORK' })
    const slow = fakeArcade({ status: 202 }, [{ status: 200, json: { txid, txStatus: 'RECEIVED' } }])
    const started = Date.now()
    expect(await new Arcade(ARCADE, slow.fetchImpl).waitForSeen(txid, 30, 10)).toMatchObject({ txStatus: 'RECEIVED' })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('auth.ts', () => {
  it('isIdentityKey accepts curve points only, and no x >= p alias', () => {
    expect(isIdentityKey(SENDER)).toBe(true)
    expect(isIdentityKey(SENDER.toUpperCase())).toBe(true)
    expect(isIdentityKey(OFF_CURVE)).toBe(false)
    expect(isIdentityKey(`02${'ff'.repeat(32)}`)).toBe(false)
    expect(isIdentityKey(`04${'ab'.repeat(32)}`)).toBe(false)
    expect(isIdentityKey(undefined)).toBe(false)
  })

  it('verifyCreatorSignature checks key, message and protocol', async () => {
    const creator = await identityOf(creatorWallet)
    const sig = await sign(creatorWallet, 'internalized:x')
    expect(await verifyCreatorSignature('internalized:x', sig, creator)).toBe(true)
    expect(await verifyCreatorSignature('internalized:y', sig, creator)).toBe(false)
    expect(await verifyCreatorSignature('internalized:x', sig, await identityOf(otherWallet))).toBe(false)
    expect(await verifyCreatorSignature('internalized:x', 'zz', creator)).toBe(false)
    expect(await verifyCreatorSignature('internalized:x', undefined, creator)).toBe(false)
    // @bsv/sdk enforces the protocol-name rule the manifest follows (C10).
    expect(TIPS_PROTOCOL[1]).toMatch(/^[a-z0-9 ]+$/)
  })
})

describe('beef.ts', () => {
  it('turns an AtomicBEEF into EF hex and reads an output', async () => {
    const t = await tip()
    expect(efHexFromAtomicBeef(t.beef, t.txid)).toBe(t.child.toHexEF())
    expect(() => efHexFromAtomicBeef(t.beef, 'c'.repeat(64))).toThrow(/txid/)
    expect(outputPaysScript(t.beef, 0)).toEqual({ lockingScriptHex: t.child.outputs[0].lockingScript.toHex(), satoshis: 1000 })
    expect(() => outputPaysScript(t.beef, 5)).toThrow(/outputIndex/)
  })
})

describe('db.ts', () => {
  const remittance = { outputIndex: 0, satoshis: 1000, senderIdentityKey: SENDER, derivationPrefix: "it's", derivationSuffix: 'cw==' }
  const newTip = (txid: string, verdict = 'pending') => ({ txid, beefHex: 'ab', txStatus: 'UNKNOWN', verdict, competingTxs: [] })

  it('opens a WAL database file and inserts idempotently with parameters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tipping-db-'))
    try {
      const db = openDb(join(dir, 'tips.sqlite'))
      opened.push(db)
      const txid = '1'.repeat(64)
      expect(db.insertTip(newTip(txid))).toEqual({ inserted: true })
      expect(db.insertTip({ ...newTip(txid), beefHex: 'cd' })).toEqual({ inserted: false })
      expect(db.getBeef(txid)).toBe('ab')
      expect(db.addRemittance(txid, remittance, 16)).toBe('inserted')
      expect(db.addRemittance(txid, remittance, 16)).toBe('exists')
      expect(db.getTip(txid)).toMatchObject({ competingTxs: [], remittances: [expect.objectContaining({ derivationPrefix: "it's" })] })
      expect(db.getTip(txid)!.extraInfo).toBeUndefined()
      expect(db.getTip(txid)).not.toHaveProperty('beefHex')
      db.updateStatus(txid, { txStatus: 'REJECTED', verdict: 'terminal', competingTxs: [COMPETITOR], extraInfo: 'UTXO_SPENT' })
      expect(db.getTip(txid)).toMatchObject({ txStatus: 'REJECTED', competingTxs: [COMPETITOR], extraInfo: 'UTXO_SPENT' })
      db.setSetting('k', 'v')
      expect(db.getSetting('k')).toBe('v')
      expect(db.getSetting('missing')).toBeUndefined()
      expect(readdirSync(dir)).toContain('tips.sqlite-wal')
    } finally {
      while (opened.length) opened.pop()!.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prune deletes old terminal tips, then the oldest unseen above the cap, with their candidates', () => {
    const db = openDb(':memory:')
    opened.push(db)
    const ids = ['1', '2', '3', '4', '5'].map(c => c.repeat(64))
    db.insertTip(newTip(ids[0], 'seen-no-competitor')) // oldest, but seen: kept
    db.insertTip(newTip(ids[1], 'terminal'))
    db.insertTip(newTip(ids[2]))
    db.insertTip(newTip(ids[3]))
    db.insertTip(newTip(ids[4], 'seen-no-competitor'))
    for (const id of ids) db.addRemittance(id, remittance, 16)

    // Not yet a day old: nothing to do under the cap.
    expect(db.prune({ now: Date.now(), terminalMaxAgeMs: 24 * HOUR, maxTips: 10 })).toBe(0)
    // A day later the terminal tip goes; a cap of 3 then evicts the oldest unseen tip.
    expect(db.prune({ now: Date.now() + 25 * HOUR, terminalMaxAgeMs: 24 * HOUR, maxTips: 3 })).toBe(2)
    expect(db.listTips().map(t => t.txid).sort()).toEqual([ids[0], ids[3], ids[4]].sort())
    // Seen tips are never evicted for the cap.
    expect(db.prune({ now: Date.now(), terminalMaxAgeMs: 24 * HOUR, maxTips: 1 })).toBe(1)
    expect(db.listTips().map(t => t.txid).sort()).toEqual([ids[0], ids[4]].sort())
    // Candidates go with their tip: the same txid stored again starts with none.
    db.insertTip(newTip(ids[2]))
    expect(db.getTip(ids[2])!.remittances).toEqual([])
  })

  it('addRemittance holds the cap', () => {
    const db = openDb(':memory:')
    opened.push(db)
    const txid = '1'.repeat(64)
    db.insertTip(newTip(txid))
    expect(db.addRemittance(txid, { ...remittance, derivationPrefix: 'a' }, 2)).toBe('inserted')
    expect(db.addRemittance(txid, { ...remittance, derivationPrefix: 'b' }, 2)).toBe('inserted')
    expect(db.addRemittance(txid, { ...remittance, derivationPrefix: 'c' }, 2)).toBe('full')
    expect(db.addRemittance(txid, { ...remittance, derivationPrefix: 'a' }, 2)).toBe('exists')
  })
})

describe('config.ts', () => {
  it('KNOWN_HOSTS match content/versions.json services.arcade.hosts plus arcade.gorillapool.io on mainnet', () => {
    const h = JSON.parse(readFileSync(VERSIONS, 'utf8')).services.arcade.hosts
    const names = (urls: string[]) => urls.map(u => new URL(u).hostname)
    expect(KNOWN_HOSTS).toEqual({ testnet: names(h.testnet), mainnet: [...names(h.mainnet), 'arcade.gorillapool.io'], ttn: names(h.ttn) })
  })

  it('warns at boot on a ttn Arcade host', () => {
    const lines: string[] = []
    expect(loadServerConfig({ ARCADE_URL: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech' }, l => lines.push(l)).arcadeUrl).toMatch(/ttn/)
    expect(lines.join('\n')).toMatch(/neither testnet nor mainnet/)
    const quietLines: string[] = []
    loadServerConfig({}, l => quietLines.push(l))
    expect(quietLines).toEqual([])
  })

  it('refuses mainnet without CREATOR_IDENTITY_KEY and warns in production without it', async () => {
    const creator = await identityOf(creatorWallet)
    expect(() => loadServerConfig({ BSV_NETWORK: 'mainnet' }, quiet)).toThrow(/CREATOR_IDENTITY_KEY is required on mainnet/)
    expect(loadServerConfig({ BSV_NETWORK: 'mainnet', CREATOR_IDENTITY_KEY: creator }, quiet).creatorIdentityKey).toBe(creator)
    expect(() => loadServerConfig({ CREATOR_IDENTITY_KEY: OFF_CURVE }, quiet)).toThrow(/CREATOR_IDENTITY_KEY/)
    const lines: string[] = []
    loadServerConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://tipping.example.com' }, l => lines.push(l))
    expect(lines.join('\n')).toMatch(/CREATOR_IDENTITY_KEY is unset/)
    const fixed: string[] = []
    loadServerConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://tipping.example.com', CREATOR_IDENTITY_KEY: creator }, l => fixed.push(l))
    expect(fixed).toEqual([])
  })
})

describe('relay boundaries', () => {
  it('relay never calls whatsonchain', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(join(SAMPLE, 'server'))
    expect(files.length).toBeGreaterThanOrEqual(10)
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/whatsonchain|\bwoc\b/i)
  })
})
