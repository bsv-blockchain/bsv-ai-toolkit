import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLinks } from '../src/links.js'

type Reply = { status: number; body?: string; type?: string } | 'network-error'
type Calls = { url: string; method: string }[]

function mockFetch(routes: Record<string, Reply | { HEAD: Reply; GET: Reply }>): Calls {
  const calls: Calls = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const route = routes[url] ?? { status: 404, body: 'not found' }
    const reply = typeof route === 'object' && 'HEAD' in route ? route[method as 'HEAD' | 'GET'] : route
    if (reply === 'network-error') throw new TypeError('fetch failed')
    return new Response(method === 'HEAD' ? null : (reply.body ?? ''), { status: reply.status, headers: { 'content-type': reply.type ?? 'text/html' } })
  })
  return calls
}

function contentDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'l-'))
  writeFileSync(join(d, 'docs-index.yaml'), 'hosts: ["https://a.test/docs/", "https://b.test/docs/"]\nids: {}\n')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true })
    writeFileSync(join(d, name), text)
  }
  return d
}

afterEach(() => vi.unstubAllGlobals())

describe('checkLinks', () => {
  it('passes a link that answers HEAD 200', async () => {
    const d = contentDir({ 'facts/a.md': 'See https://ok.test/page for more.\n' })
    const calls = mockFetch({ 'https://ok.test/page': { status: 200 } })
    expect((await checkLinks(d, [])).broken).toEqual([])
    expect(calls).toEqual([{ url: 'https://ok.test/page', method: 'HEAD' }])
  })
  it('reports a 404 with its file and status', async () => {
    const d = contentDir({ 'facts/a.md': '[gone](https://gone.test/x).\n' })
    mockFetch({})
    expect((await checkLinks(d, [])).broken).toEqual([{ url: 'https://gone.test/x', file: join(d, 'facts/a.md'), status: 404 }])
  })
  it('falls back to GET when HEAD is refused', async () => {
    const d = contentDir({ 'a.md': 'https://nohead.test/x\n' })
    const calls = mockFetch({ 'https://nohead.test/x': { HEAD: { status: 405 }, GET: { status: 200 } } })
    expect((await checkLinks(d, [])).broken).toEqual([])
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET'])
  })
  it('treats a 200 body starting with # Page Not Found as broken', async () => {
    const d = contentDir({ 'a.md': 'https://soft.test/docs/missing.md\n' })
    mockFetch({ 'https://soft.test/docs/missing.md': { status: 200, type: 'text/markdown; charset=utf-8', body: '# Page Not Found\n\nThe URL was not found.' } })
    expect((await checkLinks(d, [])).broken).toEqual([{ url: 'https://soft.test/docs/missing.md', file: join(d, 'a.md'), status: 200 }])
  })
  it('reports a network failure as status 0', async () => {
    const d = contentDir({ 'a.md': 'https://down.test/x\n' })
    mockFetch({ 'https://down.test/x': 'network-error' })
    expect((await checkLinks(d, [])).broken).toEqual([{ url: 'https://down.test/x', file: join(d, 'a.md'), status: 0 }])
  })
  it('only needs a bare origin or an inline-code API base to be reachable', async () => {
    const d = contentDir({ 'a.md': 'Host https://api.test and base `https://api.test/v1/bsv/main`.\n', 'v.json': '{"h": "https://down.test"}\n' })
    mockFetch({ 'https://down.test': 'network-error' })
    expect((await checkLinks(d, [])).broken).toEqual([{ url: 'https://down.test', file: join(d, 'v.json'), status: 0 }])
  })
  it('skips templated and local URLs', async () => {
    const d = contentDir({ 'a.md': 'https://{originator}/manifest.json and http://localhost:3321 and https://<host>/x\n' })
    const calls = mockFetch({})
    expect((await checkLinks(d, [])).broken).toEqual([])
    expect(calls).toEqual([])
  })
  it('checks each URL once and scans the extra dirs', async () => {
    const d = contentDir({ 'a.md': 'https://gone.test/x\n' })
    const extra = mkdtempSync(join(tmpdir(), 'e-'))
    writeFileSync(join(extra, 'ref.md'), 'https://gone.test/x and https://gone.test/y\n')
    const calls = mockFetch({})
    const { broken } = await checkLinks(d, [extra, join(extra, 'missing-dir')])
    expect(broken).toEqual([
      { url: 'https://gone.test/x', file: join(d, 'a.md'), status: 404 },
      { url: 'https://gone.test/y', file: join(extra, 'ref.md'), status: 404 },
    ])
    expect(calls.filter((c) => c.url === 'https://gone.test/x' && c.method === 'HEAD')).toHaveLength(1)
  })
  it('a docs-index id passes when any host serves <host><path>.md, and its legacy URL is checked', async () => {
    const d = contentDir({})
    writeFileSync(join(d, 'docs-index.yaml'), [
      'hosts: ["https://a.test/docs/", "https://b.test/docs/"]',
      'ids:',
      '  one: { path: guides/one, title: One }',
      '  two: { path: guides/two, title: Two, legacy: "https://old.test/two" }',
      '',
    ].join('\n'))
    mockFetch({
      'https://a.test/docs/guides/one.md': { status: 200, type: 'text/markdown', body: '# Page Not Found' },
      'https://b.test/docs/guides/one.md': { status: 200, type: 'text/markdown', body: '# One' },
      'https://a.test/docs/guides/two.md': { status: 404 },
      'https://b.test/docs/guides/two.md': { status: 200, type: 'text/markdown', body: '# Page Not Found' },
      'https://old.test/two': { status: 404 },
    })
    expect((await checkLinks(d, [])).broken).toEqual([
      { url: 'https://old.test/two', file: join(d, 'docs-index.yaml'), status: 404 },
      { url: 'https://a.test/docs/guides/two.md', file: join(d, 'docs-index.yaml'), status: 404 },
    ])
  })
})
