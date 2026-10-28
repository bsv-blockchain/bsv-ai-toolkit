import { describe, it, expect, afterAll, vi } from 'vitest'
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
import { codeSearch, findFunctionDefinition } from '../src/tools/search.js'
import { formatVersionsTable, versionsCheck, type VersionsFile } from '../src/tools/versions.js'
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
  it('escapes backslashes and pipes in table cells', () => {
    const table = formatVersionsTable({
      rows: [{ name: 'a|b', pinned: '1.0', latest: 'x\\|y', verifiedOn: '2026-10-22', ageDays: 0, drift: false, note: 'c:\\d' }],
    })
    expect(table).toContain('| a\\|b |')
    expect(table).toContain('| x\\\\\\|y |')
    expect(table).toContain('| c:\\\\d |')
  })

  const base = (): VersionsFile => JSON.parse(readFileSync(join(CONTENT, 'versions.json'), 'utf8'))

  // npm answers each package's pinned version unless overridden; GitHub and Arcade answer the pinned values;
  // a request to `failHost` rejects like a network error.
  function registryFetch(v: VersionsFile, overrides: Record<string, unknown> = {}, failHost?: string) {
    const calls: string[] = []
    const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      calls.push(url.toString())
      if (!init.signal) throw new Error(`no timeout signal on ${url}`)
      if (url.hostname === failHost) throw new TypeError('fetch failed')
      let body: unknown
      if (url.hostname === 'registry.npmjs.org') {
        const name = decodeURIComponent(url.pathname.slice(1).replace(/\/latest$/, ''))
        body = { name, version: name in overrides ? overrides[name] : v.packages[name].pinned }
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

  it('an unreachable Arcade host is drift with latest unknown', async () => {
    const v = base()
    const host = new URL(v.services.arcade.hosts.mainnet[0]).hostname
    const { rows } = await versionsCheck(v, registryFetch(v, {}, host))
    expect(rows.find((r) => r.name === `arcade:${host}`)).toMatchObject({ latest: 'unknown', drift: true, note: expect.stringMatching(/^check failed: fetch failed/) })
    expect(rows.filter((r) => r.drift).length).toBe(1)
  })

  it('runar-sdk drifts once npm catches up with git', async () => {
    const v = base()
    for (const [latest, drift] of [['0.4.7', false], ['1.0.0-rc.1', true], ['1.0.0', true]] as const) {
      const { rows } = await versionsCheck(v, registryFetch(v, { 'runar-sdk': latest }))
      expect(rows.find((r) => r.name === 'runar-sdk'), latest).toMatchObject({ latest, drift })
    }
  })

  it('a malformed registry version is drift', async () => {
    const v = base()
    const { rows } = await versionsCheck(v, registryFetch(v, { '@bsv/sdk': 'garbage', 'runar-sdk': undefined }))
    expect(rows.find((r) => r.name === '@bsv/sdk')).toMatchObject({ latest: 'unknown', drift: true, note: expect.stringMatching(/malformed version: garbage/) })
    expect(rows.find((r) => r.name === 'runar-sdk')).toMatchObject({ latest: 'unknown', drift: true })
  })

  it('an unreadable verified date is drift', async () => {
    const v = base()
    v.packages['@bsv/simple'].verified = 'soon'
    const { rows } = await versionsCheck(v, registryFetch(v))
    expect(rows.find((r) => r.name === '@bsv/simple')).toMatchObject({ latest: '0.7.0', drift: true, note: expect.stringMatching(/verified date unreadable/) })
    expect(Number.isFinite(rows.find((r) => r.name === '@bsv/simple')!.ageDays)).toBe(false)
  })

  it('sends GITHUB_TOKEN to api.github.com only, and only when it is set', async () => {
    const v = base()
    const seen: { host: string; auth: string | undefined }[] = []
    const inner = registryFetch(v)
    const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get('authorization') ?? undefined
      seen.push({ host: new URL(input instanceof Request ? input.url : input.toString()).hostname, auth })
      return inner(input, init)
    }) as typeof fetch
    const token = 'test-token-not-a-secret'

    try {
      vi.stubEnv('GITHUB_TOKEN', token)
      const { rows } = await versionsCheck(v, f, { probe: false })
      expect(seen.filter((s) => s.host === 'api.github.com').map((s) => s.auth)).toEqual([`Bearer ${token}`])
      expect(seen.filter((s) => s.host !== 'api.github.com').every((s) => s.auth === undefined)).toBe(true)
      expect(JSON.stringify(rows)).not.toContain(token)

      for (const unset of ['', undefined]) {
        seen.length = 0
        vi.stubEnv('GITHUB_TOKEN', unset)
        await versionsCheck(v, f, { probe: false })
        expect(seen.find((s) => s.host === 'api.github.com'), String(unset)).toMatchObject({ auth: undefined })
      }
    } finally {
      vi.unstubAllEnvs()
    }
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
  // Without rg: grep must still honour the file glob, stop at one hit per file, and skip .git and node_modules.
  it('the grep fallback keeps the file filter, one hit per file and the skipped dirs', async () => {
    const reposDir = mkdtempSync(join(tmpdir(), 'bsv-repos-'))
    tmpDirs.push(reposDir)
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(reposDir, rel)), { recursive: true })
      writeFileSync(join(reposDir, rel), text)
    }
    put('ts-sdk/src/wallet.ts', 'export function createAction(a) {}\ncreateAction(1)\ncreateAction(2)\n')
    put('ts-sdk/src/notes.md', 'createAction(x) in prose\n')
    put('ts-sdk/.git/objects/x.ts', 'function createAction() {}\n')
    put('ts-sdk/node_modules/dep/index.js', 'function createAction() {}\n')
    put('py-sdk/src/wallet.py', 'def createAction(x):\n  pass\n')
    const cfg = loadConfig({ BSV_REPOS_DIR: reposDir })
    const noRg = { rg: 'bsv-mcp-test-no-such-rg', grep: 'grep' }

    const defs = await findFunctionDefinition({ function_name: 'createAction', repository_name: 'ts-sdk' }, cfg, noRg)
    expect(defs.split('\n')).toEqual(['ts-sdk/src/wallet.ts:1:export function createAction(a) {}'])

    const all = await codeSearch({ query: 'createAction', file_extension: 'ts' }, cfg, noRg)
    expect(all.split('\n')).toEqual(['ts-sdk/src/wallet.ts:1:export function createAction(a) {}'])

    const py = await findFunctionDefinition({ function_name: 'createAction' }, cfg, noRg)
    expect(py.split('\n').sort()).toEqual(['py-sdk/src/wallet.py:1:def createAction(x):', 'ts-sdk/src/wallet.ts:1:export function createAction(a) {}'])
  })

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
