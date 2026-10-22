import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.js'
import { Arcade, verdictOf } from '../server/arcade.js'
import { efHexFromAtomicBeef, outputPaysScript } from '../server/beef.js'
import { KNOWN_HOSTS, loadServerConfig } from '../server/config.js'
import { openDb, type Db } from '../server/db.js'
import { Broadcaster } from '../server/sse.js'

const SAMPLE = fileURLToPath(new URL('..', import.meta.url))
const VERSIONS = fileURLToPath(new URL('../../../content/versions.json', import.meta.url))
const ARCADE = 'https://arcade-testnet-us-1.bsvblockchain.tech'
const PLACEHOLDER = 'a'.repeat(64)
const COMPETITOR = 'b'.repeat(64)

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

const SENDER = `03${'cd'.repeat(32)}`
const CREATOR = `02${'ab'.repeat(32)}`
const OTHER = `03${'ef'.repeat(32)}`

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

type Reply = { status: number; json?: unknown; text?: string } | Error
type Call = { url: string; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }

/** A fake fetch for Arcade: POST /tx answers `post`; GET /tx/{txid} answers `gets` in order (the last one repeats). */
function fakeArcade(post: Reply, gets: Reply[] = []) {
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

function relay(arc: ReturnType<typeof fakeArcade>, env: NodeJS.ProcessEnv = {}) {
  const cfg = loadServerConfig(env, quiet)
  const db = openDb(':memory:')
  opened.push(db)
  const broadcaster = new Broadcaster()
  const emit = vi.spyOn(broadcaster, 'emit')
  const arcade = new Arcade(cfg.arcadeUrl, arc.fetchImpl)
  const app = createApp(cfg, { db, arcade, broadcaster })
  const events = (name: string) => emit.mock.calls.filter(([e]) => e === name).map(([, d]) => d as any)
  return { app, db, events, cfg }
}

describe('POST /api/tips', () => {
  it('POST /api/tips submits EF (not BEEF) to {arcade}/tx as text/plain', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 200, json: fixture('status-seen', t.txid) }])
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
    expect(db.getTip(t.txid)).toMatchObject({ beefHex: t.beef, outputIndex: 0, satoshis: 1000, senderIdentityKey: SENDER, verdict: 'seen-no-competitor' })
  })

  it('POST /api/tips is idempotent by txid', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 200, json: fixture('status-seen', t.txid) }])
    const { app, db, events } = relay(arc)
    const first = await request(app).post('/api/tips').send(body(t))
    const second = await request(app).post('/api/tips').send(body(t))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(db.listTips()).toHaveLength(1)
    expect(events('tip')).toHaveLength(1)
    expect(events('tip')[0]).toMatchObject({ txid: t.txid, beefHex: t.beef })
    expect(arc.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('concurrent POSTs of one txid share one submission', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 200, json: fixture('status-seen', t.txid) }])
    const { app, db, events } = relay(arc)
    const [a, b] = await Promise.all([request(app).post('/api/tips').send(body(t)), request(app).post('/api/tips').send(body(t))])
    expect(b.body).toEqual(a.body)
    expect(db.listTips()).toHaveLength(1)
    expect(events('tip')).toHaveLength(1)
    expect(arc.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('a second POST with the same txid but a different remittance is 409', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 200, json: fixture('status-seen', t.txid) }])
    const { app, db } = relay(arc)
    await request(app).post('/api/tips').send(body(t))
    const res = await request(app)
      .post('/api/tips')
      .send(body(t, { remittance: { senderIdentityKey: SENDER, derivationPrefix: 'b3RoZXI=', derivationSuffix: 'c3VmZml4MDE=' } }))
    expect(res.status).toBe(409)
    expect(db.getTip(t.txid)!.derivationPrefix).toBe('cHJlZml4MDE=')
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

  it('an HTTP 400 with an ARC code is terminal without a status read', async () => {
    const t = await tip()
    const arc = fakeArcade({ status: 400, json: { error: 'malformed transaction or invalid unlocking script', status: 461, title: 'malformed', txid: t.txid } })
    const { app } = relay(arc)
    const res = await request(app).post('/api/tips').send(body(t))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ txStatus: 'REJECTED', verdict: 'terminal' })
    expect(res.body.note).toBeUndefined()
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
    const up = fakeArcade({ status: 202, json: fixture('submit-202', t.txid) }, [{ status: 200, json: fixture('status-seen', t.txid) }])
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
})

describe('tips: list, status, internalized', () => {
  function seed(db: Db, txid: string, beefHex = 'ab') {
    db.insertTip({
      txid, beefHex, outputIndex: 0, satoshis: 1000, senderIdentityKey: SENDER, derivationPrefix: 'cA==', derivationSuffix: 'cw==',
      txStatus: 'ACCEPTED_BY_NETWORK', verdict: 'on-network-not-seen', competingTxs: [],
    })
  }

  it('GET /api/tips/:txid/status re-reads Arcade and emits status on change', async () => {
    const txid = 'd'.repeat(64)
    const arc = fakeArcade({ status: 202, json: {} }, [{ status: 200, json: fixture('status-seen', txid) }])
    const { app, db, events } = relay(arc)
    seed(db, txid)
    const first = await request(app).get(`/api/tips/${txid}/status`)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ txid, txStatus: 'SEEN_ON_NETWORK', verdict: 'seen-no-competitor', competingTxs: [] })
    expect(db.getTip(txid)).toMatchObject({ txStatus: 'SEEN_ON_NETWORK', verdict: 'seen-no-competitor' })
    expect(events('status')).toEqual([expect.objectContaining({ txid, verdict: 'seen-no-competitor' })])

    const second = await request(app).get(`/api/tips/${txid}/status`)
    expect(second.body).toMatchObject({ verdict: 'seen-no-competitor' })
    expect(events('status')).toHaveLength(1) // unchanged: no new event
    expect(arc.calls.map(c => `${c.method} ${c.url}`)).toEqual([`GET ${ARCADE}/tx/${txid}`, `GET ${ARCADE}/tx/${txid}`])
  })

  it('a competing tx keeps the verdict pending; REJECTED blaming inputs carries the re-read note', async () => {
    const txid = 'd'.repeat(64)
    const competing = { ...fixture('status-seen', txid), competingTxs: [COMPETITOR] }
    const arc = fakeArcade({ status: 202, json: {} }, [{ status: 200, json: competing }, { status: 200, json: fixture('status-rejected', txid) }])
    const { app, db } = relay(arc)
    seed(db, txid)
    expect((await request(app).get(`/api/tips/${txid}/status`)).body).toMatchObject({ verdict: 'pending', competingTxs: [COMPETITOR] })
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
    expect(arc.calls).toHaveLength(0)
    seed(db, txid)
    const res = await request(app).get(`/api/tips/${txid}/status`)
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ transient: true })
    expect(db.getTip(txid)).toMatchObject({ verdict: 'on-network-not-seen' })
  })

  it('GET /api/tips lists stored tips newest first; POST internalized marks one', async () => {
    const arc = fakeArcade({ status: 202, json: {} })
    const { app, db } = relay(arc)
    seed(db, '1'.repeat(64))
    seed(db, '2'.repeat(64))
    const list = await request(app).get('/api/tips')
    expect(list.status).toBe(200)
    expect(list.body.map((r: { txid: string }) => r.txid)).toEqual(['2'.repeat(64), '1'.repeat(64)])

    const marked = await request(app).post(`/api/tips/${'1'.repeat(64)}/internalized`)
    expect(marked.status).toBe(200)
    expect(marked.body.internalizedAt).toEqual(expect.any(String))
    expect(db.getTip('1'.repeat(64))!.internalizedAt).toBe(marked.body.internalizedAt)
    expect((await request(app).post(`/api/tips/${'9'.repeat(64)}/internalized`)).status).toBe(404)
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
    expect((await request(app).post('/api/creator').send({ identityKey: 'nope' })).status).toBe(400)
    const first = await request(app).post('/api/creator').send({ identityKey: CREATOR.toUpperCase() })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ creatorIdentityKey: CREATOR })
    expect((await request(app).post('/api/creator').send({ identityKey: CREATOR })).status).toBe(200)
    const other = await request(app).post('/api/creator').send({ identityKey: OTHER })
    expect(other.status).toBe(409)
    expect((await request(app).get('/api/config')).body.creatorIdentityKey).toBe(CREATOR)
    expect(db.getSetting('creatorIdentityKey')).toBe(CREATOR)
  })

  it('CREATOR_IDENTITY_KEY fixes the creator; a claim by another key is 409', async () => {
    const { app } = relay(fakeArcade({ status: 202, json: {} }), { CREATOR_IDENTITY_KEY: CREATOR })
    expect((await request(app).get('/api/config')).body.creatorIdentityKey).toBe(CREATOR)
    expect((await request(app).post('/api/creator').send({ identityKey: OTHER })).status).toBe(409)
    expect((await request(app).post('/api/creator').send({ identityKey: CREATOR })).status).toBe(200)
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
  it('opens a WAL database file and inserts idempotently with parameters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tipping-db-'))
    try {
      const db = openDb(join(dir, 'tips.sqlite'))
      opened.push(db)
      const row = {
        txid: '1'.repeat(64), beefHex: 'ab', outputIndex: 0, satoshis: 1000, senderIdentityKey: SENDER, derivationPrefix: "it's", derivationSuffix: 'cw==',
        txStatus: 'UNKNOWN', verdict: 'pending', competingTxs: [],
      }
      expect(db.insertTip(row)).toEqual({ inserted: true })
      expect(db.insertTip({ ...row, satoshis: 5 })).toEqual({ inserted: false })
      expect(db.getTip(row.txid)).toMatchObject({ satoshis: 1000, derivationPrefix: "it's", competingTxs: [] })
      expect(db.getTip(row.txid)!.extraInfo).toBeUndefined()
      db.updateStatus(row.txid, { txStatus: 'REJECTED', verdict: 'terminal', competingTxs: [COMPETITOR], extraInfo: 'UTXO_SPENT' })
      expect(db.getTip(row.txid)).toMatchObject({ txStatus: 'REJECTED', competingTxs: [COMPETITOR], extraInfo: 'UTXO_SPENT' })
      db.setSetting('k', 'v')
      expect(db.getSetting('k')).toBe('v')
      expect(db.getSetting('missing')).toBeUndefined()
      expect(readdirSync(dir)).toContain('tips.sqlite-wal')
    } finally {
      while (opened.length) opened.pop()!.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('config.ts hosts', () => {
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
    expect(files.length).toBeGreaterThanOrEqual(7)
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/whatsonchain|\bwoc\b/i)
  })
})
