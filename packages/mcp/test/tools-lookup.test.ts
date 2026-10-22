import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { lookupBrc, normalizeBrcId } from '../src/tools/brc.js'
import { loadDocsIndex, resolveDocsUrl } from '../src/tools/docs.js'
import { versionsCheck, type VersionsFile } from '../src/tools/versions.js'
import { mockFetch } from './helpers/mockFetch.js'

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'content')
const WRITEDOCS = 'https://bsv.writedocs.io/docs/'
const BSVB = 'https://docs.bsvblockchain.org/docs/'

// Answers by full URL (mockFetch matches on pathname only, and the docs hosts share paths). Unlisted → 404.
function urlFetch(pages: Record<string, { status: number; body: string }>) {
  const calls: string[] = []
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push(url)
    const page = pages[url] ?? { status: 404, body: 'Not Found' }
    return new Response(page.body, { status: page.status })
  }
  return Object.assign(impl as typeof fetch, { calls })
}

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('brc_lookup', () => {
  it('normalizeBrcId variants', () => {
    for (const input of ['1', '0001', 'BRC-1', 'brc1', ' brc-0001 ']) expect(normalizeBrcId(input)).toBe('0001')
    expect(normalizeBrcId('BRC-100')).toBe('0100')
    for (const input of ['', 'abc', 'brc-', '1a', '../1', '-1']) expect(normalizeBrcId(input)).toBeNull()
  })

  it('brc_lookup finds a category the old list missed', async () => {
    const reposDir = mkdtempSync(join(tmpdir(), 'bsv-repos-'))
    tmpDirs.push(reposDir)
    mkdirSync(join(reposDir, 'BRCs', 'scripts'), { recursive: true })
    writeFileSync(join(reposDir, 'BRCs', 'scripts', '0014.md'), '# BRC-14: Bitcoin Script Binary, Hex and ASM Formats\n')
    const f = mockFetch([])
    const r = await lookupBrc('BRC-14', loadConfig({ BSV_REPOS_DIR: reposDir }), f)
    expect(r.source).toBe('local')
    expect(r.markdown).toMatch(/^# BRC-14/)
    expect(r.url).toMatch(/\/BRCs\/scripts\/0014\.md$/)
    expect(f.calls.length).toBe(0)
  })

  it('brc_lookup falls back to GitHub with the index category', async () => {
    const f = mockFetch([{ method: 'GET', path: /\/payments\/0029\.md$/, status: 200, body: '# BRC-29: Simple Authenticated BSV P2PKH Payment Protocol\n' }])
    const r = await lookupBrc('29', loadConfig({}), f)
    expect(f.calls[0].url).toBe('https://raw.githubusercontent.com/bsv-blockchain/BRCs/master/payments/0029.md')
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal)
    expect(r).toMatchObject({ source: 'github', url: 'https://raw.githubusercontent.com/bsv-blockchain/BRCs/master/payments/0029.md' })
    expect(r.markdown).toMatch(/^# BRC-29/)
  })
})

describe('docs_url', () => {
  const index = loadDocsIndex()
  const md = (host: string, id: string) => `${host}${index.ids[id].path}.md`

  it('docs_url prefers writedocs when both answer', async () => {
    const f = urlFetch({
      [md(WRITEDOCS, 'guides.payments')]: { status: 200, body: '# Gate an API behind payments\n' },
      [md(BSVB, 'guides.payments')]: { status: 200, body: '# Gate an API behind payments\n' },
    })
    const r = await resolveDocsUrl('guides.payments', index, f)
    expect(r).toEqual({
      id: 'guides.payments',
      title: 'Gate an API behind payments',
      url: `${WRITEDOCS}guides/payments`,
      markdownUrl: `${WRITEDOCS}guides/payments.md`,
      host: WRITEDOCS,
    })
  })

  it('soft 404 is a miss', async () => {
    const f = urlFetch({
      [md(WRITEDOCS, 'guides.payments')]: { status: 200, body: '# Page Not Found\n\nThe page you requested does not exist.\n' },
      [md(BSVB, 'guides.payments')]: { status: 200, body: '# Gate an API behind payments\n' },
    })
    const r = await resolveDocsUrl('guides.payments', index, f)
    expect(r).toMatchObject({ url: `${BSVB}guides/payments`, host: BSVB })
  })

  it('docs_url falls to legacy', async () => {
    const legacy = index.ids['reference.wallet-api'].legacy!
    const f = urlFetch({
      [md(BSVB, 'reference.wallet-api')]: { status: 200, body: '# Page Not Found\n' },
      [legacy]: { status: 200, body: '# createAction\n' },
    })
    const r = await resolveDocsUrl('reference.wallet-api', index, f)
    expect(r).toMatchObject({ markdownUrl: legacy, url: legacy.replace(/\.md$/, '') })
    expect(f.calls).toEqual([md(WRITEDOCS, 'reference.wallet-api'), md(BSVB, 'reference.wallet-api'), legacy])
  })

  it('docs_url unknown id lists ids', async () => {
    const f = urlFetch({})
    const r = await resolveDocsUrl('guides.nope', index, f)
    expect(r).toMatchObject({ id: 'guides.nope', tried: [] })
    expect('error' in r && r.error).toMatch(/guides\.payments/)
    expect('error' in r && r.error).toMatch(/reference\.wallet-api/)
    expect(f.calls.length).toBe(0)
  })
})

describe('versions_check', () => {
  const base = (): VersionsFile => JSON.parse(readFileSync(join(CONTENT, 'versions.json'), 'utf8'))

  // npm answers each package's pinned version unless overridden; GitHub and Arcade answer the pinned values.
  function registryFetch(v: VersionsFile, overrides: Record<string, string> = {}) {
    const calls: string[] = []
    const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      calls.push(url.toString())
      if (!init.signal) throw new Error(`no timeout signal on ${url}`)
      let body: unknown
      if (url.hostname === 'registry.npmjs.org') {
        const name = decodeURIComponent(url.pathname.slice(1).replace(/\/latest$/, ''))
        body = { name, version: overrides[name] ?? v.packages[name].pinned }
      } else if (url.hostname === 'api.github.com') {
        body = { sha: v.git.runar.commit + '0'.repeat(33) }
      } else if (url.pathname === '/health') {
        body = { healthy: true, version: v.services.arcade.version }
      } else {
        return new Response('not found', { status: 404 })
      }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return Object.assign(impl as typeof fetch, { calls })
  }

  it('versionsCheck flags drift and age', async () => {
    const v = base()
    v.packages['@bsv/sdk'].verified = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10)
    const f = registryFetch(v, { '@bsv/sdk': '3.3.0' })
    const { rows } = await versionsCheck(v, f)
    const sdk = rows.find((r) => r.name === '@bsv/sdk')!
    expect(sdk).toMatchObject({ pinned: '3.2.1', latest: '3.3.0', drift: true })
    expect(sdk.ageDays).toBeGreaterThanOrEqual(100)
    expect(rows.find((r) => r.name === '@bsv/wallet-toolbox')).toMatchObject({ drift: false })
    expect(rows.find((r) => r.name === 'runar-sdk')).toMatchObject({ drift: false, note: expect.stringMatching(/unsafe/) })
    const arcade = rows.filter((r) => r.name.startsWith('arcade:'))
    expect(arcade.length).toBe(v.services.arcade.hosts.testnet.length + v.services.arcade.hosts.mainnet.length)
    expect(arcade.every((r) => r.pinned === 'v0.16.0' && !r.drift)).toBe(true)
    expect(rows.find((r) => r.name.includes('runar') && r.pinned === 'd207ee8')).toMatchObject({ latest: 'd207ee8', drift: false })
  })

  it('versionsCheck skips the probe when probeTxid is empty', async () => {
    const v = base()
    v.services.arcade.probeTxid = ''
    const f = registryFetch(v)
    const r = await versionsCheck(v, f, { probe: true })
    expect(r.rawTxProbe).toBeUndefined()
    expect(f.calls.some((u) => /\/tx\//.test(u))).toBe(false)
  })
})

describe('search tools', () => {
  it('code_search without BSV_REPOS_DIR returns the setup hint', async () => {
    const server = createServer(loadConfig({}), { fetchImpl: mockFetch([]) })
    const client = new Client({ name: 'test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const r: any = await client.callTool({ name: 'code_search', arguments: { query: 'createAction' } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('BSV_REPOS_DIR is not set; run setup.sh <dir> and set BSV_REPOS_DIR=<dir>')
  })
})
