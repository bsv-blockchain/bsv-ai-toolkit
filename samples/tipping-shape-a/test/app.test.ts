import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { Arcade } from '../server/arcade.js'
import { loadServerConfig } from '../server/config.js'
import { openDb } from '../server/db.js'

const SAMPLE = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_PATH = join(SAMPLE, 'public', 'manifest.json')
const SKILL_GUARD = fileURLToPath(new URL('../../../packages/skill/skills/bsv-dev/scripts/network-guard.sh', import.meta.url))

const TESTNET_ARCADE = 'https://arcade-testnet-us-1.bsvblockchain.tech'
const MAINNET_ARCADE = 'https://arcade-us-1.bsvblockchain.tech'
// A curve point; mainnet refuses to boot without a fixed creator key.
const CREATOR_KEY = `02${'ab'.repeat(32)}`

// A stand-in for the built web app, so the SPA fallback and route order can be checked without `vite build`.
const webDir = mkdtempSync(join(tmpdir(), 'tipping-web-'))
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>spa shell</title>')
afterAll(() => rmSync(webDir, { recursive: true, force: true }))

const quiet = () => {}
// These tests never reach Arcade: a fetch that fails loudly proves it.
const noFetch = (() => Promise.reject(new Error('unexpected fetch'))) as typeof fetch
const db = openDb(':memory:')
afterAll(() => db.close())
const app = () => createApp(loadServerConfig({}, quiet), { db, arcade: new Arcade(TESTNET_ARCADE, noFetch), webDir })

type Protocol = { protocolID: [number, string]; counterparty?: string }
type Group = { protocolPermissions: Protocol[]; basketAccess: { basket: string }[] }
const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { metanet: { groupPermissions: Group }; babbage: { groupPermissions: Group } }

describe('relay app', () => {
  it('GET /health returns ok with the network', async () => {
    const res = await request(app()).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, network: 'testnet', arcadeUrl: TESTNET_ARCADE, version: '0.1.0' })
  })

  it('manifest is served with manifest+json, open CORS and no-store', async () => {
    const res = await request(app()).get('/manifest.json')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/manifest\+json/)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(res.text)).toEqual(manifest())
  })

  it('serves the SPA shell for non-/api GETs, never for /api', async () => {
    const page = await request(app()).get('/creator')
    expect(page.status).toBe(200)
    expect(page.text).toContain('spa shell')
    const api = await request(app()).get('/api/nope')
    expect(api.status).toBe(404)
    expect(api.text).not.toContain('spa shell')
  })
})

describe('public/manifest.json', () => {
  it('manifest has identical metanet and babbage groupPermissions and one level-1 protocol', () => {
    const m = manifest()
    expect(m.babbage.groupPermissions).toEqual(m.metanet.groupPermissions)
    const level1 = m.metanet.groupPermissions.protocolPermissions.filter(p => p.protocolID[0] === 1)
    expect(level1.map(p => p.protocolID)).toEqual([[1, 'bsv tipping demo tips']])
    const brc29 = m.metanet.groupPermissions.protocolPermissions.filter(p => p.protocolID[0] === 2)
    expect(brc29).toEqual([expect.objectContaining({ protocolID: [2, '3241645161d8'], counterparty: 'self' })])
    expect(m.metanet.groupPermissions.basketAccess.map(b => b.basket)).toEqual(['bsv tipping demo'])
  })

  // @bsv/sdk rejects any other protocol name at the first signature; basket names follow the same alphabet here.
  it('every protocol and basket name uses lowercase letters, digits and spaces only', () => {
    const m = manifest()
    for (const group of [m.metanet.groupPermissions, m.babbage.groupPermissions]) {
      for (const p of group.protocolPermissions) expect(p.protocolID[1]).toMatch(/^[a-z0-9 ]+$/)
      for (const b of group.basketAccess) expect(b.basket).toMatch(/^[a-z0-9 ]+$/)
    }
  })
})

describe('loadServerConfig', () => {
  it('loadServerConfig rejects BSV_NETWORK=main', () => {
    expect(() => loadServerConfig({ BSV_NETWORK: 'main' }, quiet)).toThrow(/BSV_NETWORK must be "testnet" or "mainnet"/)
  })

  it('defaults ARCADE_URL per network', () => {
    expect(loadServerConfig({}, quiet).arcadeUrl).toBe(TESTNET_ARCADE)
    expect(loadServerConfig({ BSV_NETWORK: '', ARCADE_URL: '' }, quiet)).toMatchObject({ network: 'testnet', arcadeUrl: TESTNET_ARCADE })
    expect(loadServerConfig({ BSV_NETWORK: 'mainnet', CREATOR_IDENTITY_KEY: CREATOR_KEY }, quiet).arcadeUrl).toBe(MAINNET_ARCADE)
    expect(loadServerConfig({ ARCADE_URL: 'https://arcade.example.com' }, quiet).arcadeUrl).toBe('https://arcade.example.com')
  })

  it('rejects a known Arcade host of the other network', () => {
    expect(() => loadServerConfig({ ARCADE_URL: MAINNET_ARCADE }, quiet)).toThrow(/network\/host mismatch/)
    expect(() => loadServerConfig({ BSV_NETWORK: 'mainnet', ARCADE_URL: `${TESTNET_ARCADE}./` }, quiet)).toThrow(/network\/host mismatch/)
    expect(() => loadServerConfig({ ARCADE_URL: 'not a url' }, quiet)).toThrow(/invalid ARCADE_URL/)
  })

  it('prints the MAINNET banner on mainnet only', () => {
    const lines: string[] = []
    loadServerConfig({}, l => lines.push(l))
    expect(lines.join('\n')).not.toMatch(/MAINNET/)
    loadServerConfig({ BSV_NETWORK: 'mainnet', CREATOR_IDENTITY_KEY: CREATOR_KEY }, l => lines.push(l))
    expect(lines.join('\n')).toMatch(/MAINNET: real money/)
  })

  it('requires PUBLIC_ORIGIN in production and reads the other settings', () => {
    expect(() => loadServerConfig({ NODE_ENV: 'production' }, quiet)).toThrow(/PUBLIC_ORIGIN/)
    const key = `02${'ab'.repeat(32)}`
    expect(
      loadServerConfig(
        { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://tipping.example.com/', PORT: '9090', DATA_DIR: '/data', CREATOR_IDENTITY_KEY: key.toUpperCase() },
        quiet,
      ),
    ).toEqual({
      network: 'testnet',
      arcadeUrl: TESTNET_ARCADE,
      publicOrigin: 'https://tipping.example.com',
      port: 9090,
      dataDir: '/data',
      creatorIdentityKey: key,
      trustProxy: 'loopback, linklocal, uniquelocal',
    })
    expect(loadServerConfig({}, quiet)).toMatchObject({ publicOrigin: 'http://localhost:5173', port: 8080, dataDir: './data' })
    expect(loadServerConfig({}, quiet).creatorIdentityKey).toBeUndefined()
    expect(() => loadServerConfig({ PORT: '80a' }, quiet)).toThrow(/PORT/)
    expect(() => loadServerConfig({ CREATOR_IDENTITY_KEY: '04abcd' }, quiet)).toThrow(/CREATOR_IDENTITY_KEY/)
    expect(() => loadServerConfig({ PUBLIC_ORIGIN: 'tipping.example.com' }, quiet)).toThrow(/PUBLIC_ORIGIN/)
  })
})

describe('boot guard', () => {
  it("network-guard.sh is identical to the skill's", () => {
    expect(readFileSync(join(SAMPLE, 'scripts', 'network-guard.sh'))).toEqual(readFileSync(SKILL_GUARD))
  })
})
