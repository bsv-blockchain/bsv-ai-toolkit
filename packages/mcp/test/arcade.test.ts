import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verdictOf, detectHexFormat, classify400 } from '../src/arcade/classify.js'
import { ArcadeClient } from '../src/arcade/client.js'
import { mockFetch } from './helpers/mockFetch.js'
import type { TransactionStatus } from '../src/types.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'arcade')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const BASE = 'https://arcade.example'
const TXID = 'a'.repeat(64)
const received: TransactionStatus = { txid: TXID, txStatus: 'RECEIVED', timestamp: '2026-10-22T16:14:39.000000Z' }

describe('verdictOf', () => {
  it('verdictOf: seen-no-competitor for SEEN_ON_NETWORK without competitors', () => {
    expect(verdictOf(fixture('status-seen.json'))).toBe('seen-no-competitor')
  })
  it('verdictOf: pending when competingTxs present', () => {
    expect(verdictOf(fixture('status-competing.json'))).toBe('pending')
  })
  it('verdictOf: terminal for REJECTED', () => {
    expect(verdictOf(fixture('status-rejected.json'))).toBe('terminal')
  })
})

describe('detectHexFormat', () => {
  it('detectHexFormat: beef prefixes 0100beef, 0200beef, 01010101', () => {
    expect(detectHexFormat('0100beef00')).toBe('beef')
    expect(detectHexFormat('0200BEEF00')).toBe('beef')
    expect(detectHexFormat('01010101' + 'ab'.repeat(32))).toBe('beef')
  })
  it('detectHexFormat: ef marker after version', () => {
    const { rawTx } = fixture('status-mined-ef-rawtx.json')
    expect(detectHexFormat(rawTx)).toBe('ef')
    expect(detectHexFormat('01000000' + '01' + 'ab'.repeat(36))).toBe('raw')
  })
})

describe('classify400', () => {
  it('classify400: 476 is transient-476', () => {
    expect(classify400(fixture('submit-400-476.json')).kind).toBe('transient-476')
  })
  it('classify400: txn-already-known is already-known', () => {
    expect(classify400(fixture('submit-400-exists.json')).kind).toBe('already-known')
  })
  it('classify400: 461 is terminal with arcCode 461', () => {
    expect(classify400(fixture('submit-400-terminal.json'))).toEqual({ kind: 'terminal', arcCode: 461 })
  })
})

describe('ArcadeClient', () => {
  it('submit posts text/plain to {base}/tx', async () => {
    const f = mockFetch([{ method: 'POST', path: /^\/tx$/, status: 202, body: fixture('submit-202.json') }])
    const r = await new ArcadeClient({ baseUrl: BASE + '/', fetchImpl: f }).submit('0100', { callbackToken: 'tok', fullStatusUpdates: true })
    expect(r).toEqual({ postStatus: 202, body: fixture('submit-202.json'), transient: false })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].method).toBe('POST')
    expect(f.calls[0].path).toBe('/tx')
    expect(f.calls[0].headers['content-type']).toBe('text/plain')
    expect(f.calls[0].headers['x-callbacktoken']).toBe('tok')
    expect(f.calls[0].headers['x-fullstatusupdates']).toBe('true')
    expect(f.calls[0].body).toBe('0100')
  })
  it('submit returns transient UNREACHABLE on network error', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const r = await new ArcadeClient({ baseUrl: BASE, fetchImpl }).submit('0100')
    expect(r).toEqual({ postStatus: 0, body: { error: 'UNREACHABLE' }, transient: true })
  })
  it('submit sets AbortSignal timeout', async () => {
    let signal: unknown
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal
      return new Response(JSON.stringify(fixture('submit-202.json')), { status: 202 })
    }) as typeof fetch
    await new ArcadeClient({ baseUrl: BASE, fetchImpl, timeoutMs: 50 }).submit('0100')
    expect(signal).toBeInstanceOf(AbortSignal)
  })
  it('status 404 returns notFound', async () => {
    const f = mockFetch([{ method: 'GET', path: /^\/tx\/[0-9a-f]{64}$/, status: 404, body: { error: 'transaction not found' } }])
    expect(await new ArcadeClient({ baseUrl: BASE, fetchImpl: f }).status(TXID)).toEqual({ notFound: true })
  })
  it('policy derives satPerKb 1 from the testnet fixture', async () => {
    const f = mockFetch([{ method: 'GET', path: /^\/policy$/, status: 200, body: fixture('policy.json') }])
    const p = await new ArcadeClient({ baseUrl: BASE, fetchImpl: f }).policy()
    expect(p.satPerKb).toBe(1)
    expect(p.timestamp).toBe(fixture('policy.json').timestamp)
    expect(p.policy.miningFee).toEqual({ satoshis: 1, bytes: 1000 })
  })
  it('waitForSeen stops at seen-no-competitor', async () => {
    const f = mockFetch([
      { method: 'GET', path: /^\/tx\//, status: 200, body: received },
      { method: 'GET', path: /^\/tx\//, status: 200, body: fixture('status-seen.json') },
    ])
    const s = await new ArcadeClient({ baseUrl: BASE, fetchImpl: f }).waitForSeen(TXID, 5000, 1)
    expect(s).toEqual(fixture('status-seen.json'))
    expect(f.calls).toHaveLength(2)
  })
  it('waitForSeen returns last status on timeout', async () => {
    const f = mockFetch([{ method: 'GET', path: /^\/tx\//, status: 200, body: received }])
    const s = await new ArcadeClient({ baseUrl: BASE, fetchImpl: f }).waitForSeen(TXID, 30, 5)
    expect(s).toEqual(received)
    expect(f.calls.length).toBeGreaterThan(1)
  })
})
