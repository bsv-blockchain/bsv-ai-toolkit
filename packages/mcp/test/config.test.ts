import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadConfig, resolveNetwork, KNOWN_HOSTS, DEFAULT_ARCADE } from '../src/config.js'
describe('loadConfig', () => {
  it('defaults to testnet and the testnet Arcade', () => {
    const c = loadConfig({})
    expect(c.network).toBe('testnet'); expect(c.arcadeUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech'); expect(c.allowMainnetBroadcast).toBe(false)
  })
  it('mainnet default host', () => { expect(loadConfig({ BSV_NETWORK: 'mainnet' }).arcadeUrl).toBe('https://arcade-us-1.bsvblockchain.tech') })
  it('rejects other network values', () => { expect(() => loadConfig({ BSV_NETWORK: 'main' })).toThrow(/BSV_NETWORK/) })
  it('reads the version from package.json', () => { expect(loadConfig({}).version).toBe('2.0.0') })
  it('treats an empty ARCADE_URL as unset', () => {
    expect(loadConfig({ ARCADE_URL: '' }).arcadeUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech')
  })
  it('treats an unresolved plugin placeholder ARCADE_URL as unset', () => {
    expect(loadConfig({ ARCADE_URL: '${user_config.arcade_url}' }).arcadeUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech')
  })
  it('treats an unresolved plugin placeholder BSV_NETWORK as unset', () => {
    expect(loadConfig({ BSV_NETWORK: '${user_config.bsv_network}' }).network).toBe('testnet')
  })
  it('enables mainnet broadcast only for the exact string 1', () => {
    expect(loadConfig({ BSV_MCP_ALLOW_MAINNET_BROADCAST: '1' }).allowMainnetBroadcast).toBe(true)
    expect(loadConfig({ BSV_MCP_ALLOW_MAINNET_BROADCAST: 'true' }).allowMainnetBroadcast).toBe(false)
  })
  it('fails fast on a mainnet ARCADE_URL with the testnet default', () => {
    expect(() => loadConfig({ ARCADE_URL: 'https://arcade-us-1.bsvblockchain.tech' })).toThrow(/mismatch/)
  })
  it('fails fast on a trailing-dot testnet ARCADE_URL on mainnet', () => {
    expect(() => loadConfig({ BSV_NETWORK: 'mainnet', ARCADE_URL: 'https://arcade-testnet-us-1.bsvblockchain.tech./' })).toThrow(/mismatch/)
  })
  it('fails fast on an invalid ARCADE_URL', () => {
    expect(() => loadConfig({ ARCADE_URL: 'not a url' })).toThrow(/invalid arcadeUrl/)
  })
})
describe('resolveNetwork', () => {
  const cfg = loadConfig({})
  it('rejects a testnet host on mainnet', () => {
    expect(() => resolveNetwork({ network: 'mainnet', arcadeUrl: 'https://arcade-testnet-us-1.bsvblockchain.tech' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a known mainnet host on testnet', () => {
    expect(() => resolveNetwork({ arcadeUrl: 'https://arcade-eu-1.bsvblockchain.tech' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a trailing-dot mainnet host on testnet', () => {
    expect(() => resolveNetwork({ arcadeUrl: 'https://arcade-us-1.bsvblockchain.tech./' }, cfg)).toThrow(/mismatch/)
    expect(() => resolveNetwork({ arcadeUrl: 'https://arcade-us-1.bsvblockchain.tech%2E/' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a trailing-dot testnet host on mainnet', () => {
    expect(() => resolveNetwork({ network: 'mainnet', arcadeUrl: 'https://ARCADE-TESTNET-US-1.bsvblockchain.tech./' }, cfg)).toThrow(/mismatch/)
  })
  it('switching network without a URL uses that network default, not the configured ARCADE_URL', () => {
    expect(resolveNetwork({ network: 'mainnet' }, loadConfig({ ARCADE_URL: 'http://localhost:8080' })).arcadeUrl).toBe(DEFAULT_ARCADE.mainnet)
  })
  it('unknown host passes the cross-check', () => {
    expect(resolveNetwork({ arcadeUrl: 'http://localhost:8080' }, cfg)).toEqual({ network: 'testnet', arcadeUrl: 'http://localhost:8080' })
  })
  it('ttn host passes with a warning', () => {
    expect(resolveNetwork({ arcadeUrl: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech' }, cfg).warning).toMatch(/neither testnet nor mainnet/)
  })
})
describe('KNOWN_HOSTS', () => {
  it('matches content/versions.json services.arcade.hosts plus arcade.gorillapool.io on mainnet', () => {
    const v = JSON.parse(readFileSync(new URL('../content/versions.json', import.meta.url), 'utf8'))
    const hostnames = (urls: string[]) => urls.map((u) => new URL(u).hostname)
    const h = v.services.arcade.hosts
    expect(KNOWN_HOSTS).toEqual({
      testnet: hostnames(h.testnet),
      mainnet: [...hostnames(h.mainnet), 'arcade.gorillapool.io'],
      ttn: hostnames(h.ttn),
    })
  })
})
