import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transaction } from '@bsv/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { arcadeSubmit, arcadeStatus, arcadePolicy, arcadeHealth } from '../src/tools/arcade.js'
import { createServer } from '../src/server.js'
import { mockFetch, type MockRoute } from './helpers/mockFetch.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'arcade')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

// A real transaction: the EF hex Arcade returned for a mined testnet tx, and the same tx re-read as plain.
const EF_STATUS = fixture('status-mined-ef-rawtx.json')
const EF_HEX: string = EF_STATUS.rawTx
const REAL_TXID: string = EF_STATUS.txid
const RAW_HEX = Transaction.fromHexEF(EF_HEX).toHex()
const TXID = 'a'.repeat(64)
const BEEF_HEX = '0100beef' + 'aa'.repeat(40)
const TESTNET_TX = 'https://arcade-testnet-us-1.bsvblockchain.tech/tx'
const R15 = 'may not be final for a tx the network already accepted; re-read status'

const testnet = () => loadConfig({})
const post = (status: number, body: any, delayMs?: number): MockRoute => ({ method: 'POST', path: /^\/tx$/, status, body, delayMs })
const get = (status: number, body: any): MockRoute => ({ method: 'GET', path: /^\/tx\/[0-9a-f]{64}$/, status, body })
const received = { txid: TXID, txStatus: 'RECEIVED', timestamp: '2026-10-22T16:14:39.000000Z' }

describe('arcadeSubmit', () => {
  it('refuses BEEF before contacting Arcade', async () => {
    const f = mockFetch([])
    await expect(arcadeSubmit({ hex: BEEF_HEX }, testnet(), f)).rejects.toThrow(/convert to EF or raw/)
    expect(f.calls.length).toBe(0)
  })

  it('refuses BEEF with leading whitespace before contacting Arcade', async () => {
    const f = mockFetch([])
    await expect(arcadeSubmit({ hex: '\n' + BEEF_HEX }, testnet(), f)).rejects.toThrow(/convert to EF or raw/)
    expect(f.calls.length).toBe(0)
  })

  it('mainnet broadcast disabled without the flag', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json'))])
    await expect(arcadeSubmit({ hex: RAW_HEX }, loadConfig({ BSV_NETWORK: 'mainnet' }), f)).rejects.toThrow(
      /^mainnet broadcast disabled; set BSV_MCP_ALLOW_MAINNET_BROADCAST=1$/,
    )
    expect(f.calls.length).toBe(0)
  })

  it('mainnet broadcast disabled when the network input selects mainnet', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json'))])
    await expect(arcadeSubmit({ hex: RAW_HEX, network: 'mainnet' }, testnet(), f)).rejects.toThrow(
      /^mainnet broadcast disabled; set BSV_MCP_ALLOW_MAINNET_BROADCAST=1$/,
    )
    expect(f.calls.length).toBe(0)
  })

  it('mainnet allowed with the flag', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json')), get(200, fixture('status-seen.json'))])
    const cfg = loadConfig({ BSV_NETWORK: 'mainnet', BSV_MCP_ALLOW_MAINNET_BROADCAST: '1' })
    const r = await arcadeSubmit({ hex: RAW_HEX, waitForSeen: false }, cfg, f)
    expect(f.calls[0].method).toBe('POST')
    expect(f.calls[0].url).toBe('https://arcade-us-1.bsvblockchain.tech/tx')
    expect(r.verdict).toBe('seen-no-competitor')
  })

  it('2xx is provisional: re-reads status and waits for seen', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json')), get(200, received), get(200, fixture('status-seen.json'))])
    const r = await arcadeSubmit({ hex: '  ' + RAW_HEX + '\n' }, testnet(), f)
    expect(r).toMatchObject({ verdict: 'seen-no-competitor', postStatus: 202, txStatus: 'SEEN_ON_NETWORK', transient: false, competingTxs: [] })
    expect(f.calls[0].url).toBe(TESTNET_TX)
    expect(f.calls[0].body).toBe(RAW_HEX)
    expect(f.calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })

  it('476 is transient', async () => {
    const f = mockFetch([post(400, fixture('submit-400-476.json'))])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ transient: true, arcCode: 476, txStatus: 'UNKNOWN', verdict: 'pending', postStatus: 400 })
    expect(f.calls).toHaveLength(1)
  })

  it('already-known reads status', async () => {
    const f = mockFetch([post(400, fixture('submit-400-exists.json')), get(200, fixture('status-seen.json'))])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ verdict: 'seen-no-competitor', txStatus: 'SEEN_ON_NETWORK', postStatus: 400, transient: false })
  })

  it('terminal 400 carries the ARC code', async () => {
    const f = mockFetch([post(400, fixture('submit-400-terminal.json'))])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ verdict: 'terminal', arcCode: 461, transient: false, postStatus: 400 })
    expect(r.extraInfo).toMatch(/malformed/)
    expect(f.calls).toHaveLength(1)
  })

  it('terminal 400 blaming inputs carries the re-read warning', async () => {
    const f = mockFetch([post(400, { status: 466, error: 'UTXO_SPENT' })])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ verdict: 'terminal', txStatus: 'REJECTED', arcCode: 466, extraInfo: 'UTXO_SPENT', warning: R15 })
  })

  it('terminal 400 reads the reason field for extraInfo and the re-read warning', async () => {
    const f = mockFetch([post(400, { status: 466, reason: 'UTXO_SPENT' })])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ verdict: 'terminal', extraInfo: 'UTXO_SPENT', warning: R15 })
  })

  it('a 404 from POST /tx is not a transaction verdict', async () => {
    const f = mockFetch([post(404, { error: 'not found' })])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ txStatus: 'UNKNOWN', verdict: 'pending', transient: false, postStatus: 404 })
    expect(r.warning).toMatch(/HTTP 404.*not a transaction verdict/)
    expect(f.calls).toHaveLength(1)
  })

  it('a 422 from POST /tx is a validation answer', async () => {
    const f = mockFetch([post(422, { error: 'invalid script' })])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ txStatus: 'REJECTED', verdict: 'terminal', transient: false, postStatus: 422 })
    expect(r.warning).toBeUndefined()
  })

  it('503 is transient UNREACHABLE', async () => {
    const f = mockFetch([post(503, { error: 'busy' })])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ txStatus: 'UNREACHABLE', transient: true, verdict: 'pending', postStatus: 503 })
    expect(r.txid).toBe(REAL_TXID) // computed locally; Arcade's body carries none
    expect(f.calls).toHaveLength(1)
  })

  it('network error is transient UNREACHABLE with the txid of an EF submission', async () => {
    const f = mockFetch([]) // no route: fetch throws
    const r = await arcadeSubmit({ hex: EF_HEX }, testnet(), f)
    expect(r).toMatchObject({ txid: REAL_TXID, postStatus: 0, txStatus: 'UNREACHABLE', transient: true, verdict: 'pending' })
  })

  it('per-request timeout stays within timeoutMs when waiting for seen', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json'), 5000)])
    const started = Date.now()
    const r = await arcadeSubmit({ hex: RAW_HEX, timeoutMs: 200 }, testnet(), f)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r).toMatchObject({ txStatus: 'UNREACHABLE', transient: true })
  })

  it('ttn host returns a warning', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json')), get(200, fixture('status-seen.json'))])
    const r = await arcadeSubmit({ hex: RAW_HEX, arcadeUrl: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech', waitForSeen: false }, testnet(), f)
    expect(r.warning).toMatch(/ttn/)
    expect(f.calls[0].url).toBe('https://arcade-v2-ttn-us-1.bsvblockchain.tech/tx')
  })

  it('REJECTED blaming inputs stays terminal with a re-read warning', async () => {
    const f = mockFetch([post(202, fixture('submit-202.json')), get(200, fixture('status-rejected.json'))])
    const r = await arcadeSubmit({ hex: RAW_HEX }, testnet(), f)
    expect(r).toMatchObject({ verdict: 'terminal', txStatus: 'REJECTED', extraInfo: 'UTXO_SPENT', warning: R15 })
  })
})

describe('arcadeStatus', () => {
  it('404 is no-verdict', async () => {
    const f = mockFetch([get(404, {})])
    const r = await arcadeStatus({ txid: TXID }, testnet(), f)
    expect(r).toMatchObject({ txid: TXID, verdict: 'no-verdict', isFinalForApp: false, rawTxPresent: false })
    expect(r.txStatus).not.toBe('REJECTED')
    expect(r.note).toMatch(/never given this txid/)
  })

  it('status reports rawTx format ef with the EF reminder', async () => {
    const f = mockFetch([get(200, EF_STATUS)])
    const r = await arcadeStatus({ txid: REAL_TXID }, testnet(), f)
    expect(r).toMatchObject({ rawTxPresent: true, rawTxFormat: 'ef', verdict: 'seen-no-competitor', isFinalForApp: true, blockHeight: 1764542 })
    expect(r.note).toMatch(/re-read as plain/)
  })

  it('isFinalForApp false with competitors', async () => {
    const f = mockFetch([get(200, fixture('status-competing.json'))])
    const r = await arcadeStatus({ txid: TXID }, testnet(), f)
    expect(r).toMatchObject({ isFinalForApp: false, verdict: 'pending', rawTxPresent: false })
    expect(r.competingTxs).toHaveLength(1)
  })

  it('REJECTED with parent rejected stays terminal with a re-read note', async () => {
    const parent = { ...fixture('status-rejected.json'), extraInfo: 'Parent rejected: input tx not found' }
    const r = await arcadeStatus({ txid: TXID }, testnet(), mockFetch([get(200, parent)]))
    expect(r).toMatchObject({ verdict: 'terminal', isFinalForApp: false, note: R15 })

    const script = { ...fixture('status-rejected.json'), extraInfo: 'script verification failed' }
    const s = await arcadeStatus({ txid: TXID }, testnet(), mockFetch([get(200, script)]))
    expect(s.verdict).toBe('terminal')
    expect(s.note).toBeUndefined()
  })
})

describe('arcadePolicy and arcadeHealth', () => {
  it('policy returns satPerKb', async () => {
    const f = mockFetch([{ method: 'GET', path: /^\/policy$/, status: 200, body: fixture('policy.json') }])
    const r = await arcadePolicy({}, testnet(), f)
    expect(r.satPerKb).toBe(1)
    expect(f.calls[0].url).toBe('https://arcade-testnet-us-1.bsvblockchain.tech/policy')
  })

  it('health returns version', async () => {
    const f = mockFetch([{ method: 'GET', path: /^\/health$/, status: 200, body: fixture('health.json') }])
    const r = await arcadeHealth({}, testnet(), f)
    expect(r.version).toBe('v0.16.0')
  })
})

describe('createServer', () => {
  async function connect(routes: MockRoute[]) {
    const server = createServer(testnet(), { fetchImpl: mockFetch(routes) })
    const client = new Client({ name: 'test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return client
  }

  it('reports @bsv/mcp with the package version and lists the arcade tools', async () => {
    const client = await connect([])
    expect(client.getServerVersion()).toMatchObject({ name: '@bsv/mcp', version: '2.0.0' })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['arcade_submit', 'arcade_status', 'arcade_policy', 'arcade_health']))
  })

  it('returns structuredContent and JSON text', async () => {
    const client = await connect([get(404, {})])
    const r: any = await client.callTool({ name: 'arcade_status', arguments: { txid: TXID } })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent.verdict).toBe('no-verdict')
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent)
  })

  it('returns isError with the message when a handler throws', async () => {
    const client = await connect([])
    const r: any = await client.callTool({ name: 'arcade_submit', arguments: { hex: BEEF_HEX } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/convert to EF or raw/)
  })
})
