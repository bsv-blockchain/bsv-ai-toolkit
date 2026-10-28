import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadConfig, resolveNetwork, KNOWN_HOSTS, DEFAULT_BROADCASTER } from '../src/config.js'
describe('loadConfig', () => {
  it('defaults to testnet and the testnet BSV Broadcaster', () => {
    const c = loadConfig({})
    expect(c.network).toBe('testnet'); expect(c.broadcasterUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech'); expect(c.allowMainnetBroadcast).toBe(false)
  })
  it('mainnet default host', () => { expect(loadConfig({ BSV_NETWORK: 'mainnet' }).broadcasterUrl).toBe('https://arcade-us-1.bsvblockchain.tech') })
  it('rejects other network values', () => { expect(() => loadConfig({ BSV_NETWORK: 'main' })).toThrow(/BSV_NETWORK/) })
  it('reads the version from package.json', () => { expect(loadConfig({}).version).toBe('2.0.0') })
  it('treats an empty BSV_BROADCASTER_URL as unset', () => {
    expect(loadConfig({ BSV_BROADCASTER_URL: '' }).broadcasterUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech')
  })
  it('treats an unresolved plugin placeholder BSV_BROADCASTER_URL as unset', () => {
    expect(loadConfig({ BSV_BROADCASTER_URL: '${user_config.broadcaster_url}' }).broadcasterUrl).toBe('https://arcade-testnet-us-1.bsvblockchain.tech')
  })
  it('treats an unresolved plugin placeholder BSV_NETWORK as unset', () => {
    expect(loadConfig({ BSV_NETWORK: '${user_config.bsv_network}' }).network).toBe('testnet')
  })
  it('enables mainnet broadcast only for the exact string 1', () => {
    expect(loadConfig({ BSV_MCP_ALLOW_MAINNET_BROADCAST: '1' }).allowMainnetBroadcast).toBe(true)
    expect(loadConfig({ BSV_MCP_ALLOW_MAINNET_BROADCAST: 'true' }).allowMainnetBroadcast).toBe(false)
  })
  it('fails fast on a mainnet BSV_BROADCASTER_URL with the testnet default', () => {
    expect(() => loadConfig({ BSV_BROADCASTER_URL: 'https://arcade-us-1.bsvblockchain.tech' })).toThrow(/mismatch/)
  })
  it('fails fast on a trailing-dot testnet BSV_BROADCASTER_URL on mainnet', () => {
    expect(() => loadConfig({ BSV_NETWORK: 'mainnet', BSV_BROADCASTER_URL: 'https://arcade-testnet-us-1.bsvblockchain.tech./' })).toThrow(/mismatch/)
  })
  it('fails fast on an invalid BSV_BROADCASTER_URL', () => {
    expect(() => loadConfig({ BSV_BROADCASTER_URL: 'not a url' })).toThrow(/invalid broadcasterUrl/)
  })
})
describe('BSV_BROADCASTER_URL and the deprecated ARCADE_URL', () => {
  const LOCAL = 'http://localhost:8080'
  const OTHER = 'http://localhost:9090'
  const DEPRECATED = 'ARCADE_URL is deprecated; use BSV_BROADCASTER_URL'
  it('reads BSV_BROADCASTER_URL and warns about nothing', () => {
    const warn = vi.fn()
    expect(loadConfig({ BSV_BROADCASTER_URL: LOCAL }, warn).broadcasterUrl).toBe(LOCAL)
    expect(warn).not.toHaveBeenCalled()
  })
  it('falls back to ARCADE_URL alone, with one deprecation warning', () => {
    const warn = vi.fn()
    expect(loadConfig({ ARCADE_URL: LOCAL }, warn).broadcasterUrl).toBe(LOCAL)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(DEPRECATED)
  })
  it('lets BSV_BROADCASTER_URL win when both are set, without the warning', () => {
    const warn = vi.fn()
    expect(loadConfig({ BSV_BROADCASTER_URL: LOCAL, ARCADE_URL: OTHER }, warn).broadcasterUrl).toBe(LOCAL)
    expect(warn).not.toHaveBeenCalled()
  })
  it('treats an empty or unresolved-placeholder value as unset under either name', () => {
    const warn = vi.fn()
    const testnet = 'https://arcade-testnet-us-1.bsvblockchain.tech'
    expect(loadConfig({ ARCADE_URL: '${user_config.arcade_url}' }, warn).broadcasterUrl).toBe(testnet)
    expect(loadConfig({ ARCADE_URL: '' }, warn).broadcasterUrl).toBe(testnet)
    expect(loadConfig({ BSV_BROADCASTER_URL: '${user_config.broadcaster_url}', ARCADE_URL: '${user_config.arcade_url}' }, warn).broadcasterUrl).toBe(testnet)
    expect(warn).not.toHaveBeenCalled()
    // A placeholder under the new name does not hide a real value under the old one.
    expect(loadConfig({ BSV_BROADCASTER_URL: '${user_config.broadcaster_url}', ARCADE_URL: LOCAL }, warn).broadcasterUrl).toBe(LOCAL)
    expect(warn).toHaveBeenCalledWith(DEPRECATED)
  })
  it('applies the network/host cross-check to ARCADE_URL too', () => {
    expect(() => loadConfig({ ARCADE_URL: 'https://arcade-us-1.bsvblockchain.tech' }, () => {})).toThrow(/mismatch/)
  })
})
describe('resolveNetwork', () => {
  const cfg = loadConfig({})
  it('rejects a testnet host on mainnet', () => {
    expect(() => resolveNetwork({ network: 'mainnet', broadcasterUrl: 'https://arcade-testnet-us-1.bsvblockchain.tech' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a known mainnet host on testnet', () => {
    expect(() => resolveNetwork({ broadcasterUrl: 'https://arcade-eu-1.bsvblockchain.tech' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a trailing-dot mainnet host on testnet', () => {
    expect(() => resolveNetwork({ broadcasterUrl: 'https://arcade-us-1.bsvblockchain.tech./' }, cfg)).toThrow(/mismatch/)
    expect(() => resolveNetwork({ broadcasterUrl: 'https://arcade-us-1.bsvblockchain.tech%2E/' }, cfg)).toThrow(/mismatch/)
  })
  it('rejects a trailing-dot testnet host on mainnet', () => {
    expect(() => resolveNetwork({ network: 'mainnet', broadcasterUrl: 'https://ARCADE-TESTNET-US-1.bsvblockchain.tech./' }, cfg)).toThrow(/mismatch/)
  })
  it('switching network without a URL uses that network default, not the configured BSV_BROADCASTER_URL', () => {
    expect(resolveNetwork({ network: 'mainnet' }, loadConfig({ BSV_BROADCASTER_URL: 'http://localhost:8080' })).broadcasterUrl).toBe(DEFAULT_BROADCASTER.mainnet)
  })
  it('unknown host passes the cross-check', () => {
    expect(resolveNetwork({ broadcasterUrl: 'http://localhost:8080' }, cfg)).toEqual({ network: 'testnet', broadcasterUrl: 'http://localhost:8080' })
  })
  it('ttn host passes with a warning', () => {
    expect(resolveNetwork({ broadcasterUrl: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech' }, cfg).warning).toMatch(/neither testnet nor mainnet/)
  })
})
describe('KNOWN_HOSTS', () => {
  it('matches content/versions.json services.broadcaster.hosts plus arcade.gorillapool.io on mainnet', () => {
    const v = JSON.parse(readFileSync(new URL('../content/versions.json', import.meta.url), 'utf8'))
    const hostnames = (urls: string[]) => urls.map((u) => new URL(u).hostname)
    const h = v.services.broadcaster.hosts
    expect(KNOWN_HOSTS).toEqual({
      testnet: hostnames(h.testnet),
      mainnet: [...hostnames(h.mainnet), 'arcade.gorillapool.io'],
      ttn: hostnames(h.ttn),
    })
  })
})
