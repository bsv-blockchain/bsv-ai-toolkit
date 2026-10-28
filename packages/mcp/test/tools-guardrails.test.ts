import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

const PROJECTS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects')
const SUMMARY_RE = /^check_guardrails: (\d+) errors, (\d+) warnings, shape (A|B|A\+B|unknown)$/

// Each tmp project has src/ok.ts plus `locked`, made unreadable (chmod 000) by the caller.
const tmpRoots: { root: string; locked: string }[] = []
function tmpProject(locked: 'file' | 'dir'): { root: string; locked: string } {
  const root = mkdtempSync(join(tmpdir(), 'bsv-guardrails-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{"name":"x"}')
  writeFileSync(join(root, 'src', 'ok.ts'), 'export const a = 1\n')
  let path: string
  if (locked === 'file') {
    path = join(root, 'src', 'locked.ts')
    writeFileSync(path, 'export const b = 2\n')
  } else {
    path = join(root, 'src', 'locked')
    mkdirSync(path)
    writeFileSync(join(path, 'b.ts'), 'export const b = 2\n')
  }
  const p = { root, locked: path }
  tmpRoots.push(p)
  return p
}
afterAll(() => {
  for (const { root, locked } of tmpRoots) {
    try { chmodSync(locked, 0o755) } catch { /* already gone or never locked */ }
    rmSync(root, { recursive: true, force: true })
  }
})
// chmod 000 does not stop root, and Windows ignores it.
const chmodBlocksReads = process.platform !== 'win32' && process.getuid?.() !== 0

async function connect() {
  const server = createServer(loadConfig({}))
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

async function check(args: Record<string, unknown>): Promise<any> {
  const client = await connect()
  return client.callTool({ name: 'check_guardrails', arguments: args })
}

const firstLine = (r: any): string => r.content[0].text.split('\n')[0]

describe('check_guardrails', () => {
  it('summary line counts errors and warnings', async () => {
    const r = await check({ path: join(PROJECTS, 'broken-a') })
    expect(r.isError).toBeFalsy()
    const m = firstLine(r).match(SUMMARY_RE)
    expect(m).not.toBeNull()
    expect(m![3]).toBe('A')
    const findings = r.structuredContent.findings as { severity: string }[]
    expect(Number(m![1])).toBe(findings.filter(f => f.severity === 'error').length)
    expect(Number(m![2])).toBe(findings.filter(f => f.severity === 'warn').length)
    expect(Number(m![1])).toBeGreaterThan(0)
  })

  it('clean-a reports 0 errors', async () => {
    const r = await check({ path: join(PROJECTS, 'clean-a') })
    expect(r.isError).toBeFalsy()
    expect(firstLine(r)).toMatch(/^check_guardrails: 0 errors, \d+ warnings, shape A$/)
    expect(r.structuredContent).toMatchObject({ shapeDetected: 'A' })
    expect(r.structuredContent.findings.filter((f: any) => f.severity === 'error')).toEqual([])
  })

  it('missing path is an error', async () => {
    const r = await check({ path: join(PROJECTS, 'does-not-exist') })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/path not found/)
  })

  it('relative path is an error', async () => {
    const r = await check({ path: 'test/fixtures/projects/broken-a' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/^path must be absolute/)
    expect(r.structuredContent).toBeUndefined()
  })

  it('tool is registered with the name check_guardrails', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('check_guardrails')
  })

  it.skipIf(!chmodBlocksReads)('an unreadable file is skipped and noted', async () => {
    const { root, locked } = tmpProject('file')
    chmodSync(locked, 0o000)

    const r = await check({ path: root })
    expect(r.isError).toBeFalsy()
    expect(firstLine(r)).toMatch(SUMMARY_RE)
    expect(r.content[0].text).toMatch(/^note: skipped src\/locked\.ts \(EACCES\)$/m)
  })

  it.skipIf(!chmodBlocksReads)('an unreadable directory is skipped and noted', async () => {
    const { root, locked } = tmpProject('dir')
    chmodSync(locked, 0o000)

    const r = await check({ path: root })
    expect(r.isError).toBeFalsy()
    expect(firstLine(r)).toMatch(SUMMARY_RE)
    expect(r.content[0].text).toMatch(/^note: skipped src\/locked\/ \(EACCES\)$/m)
  })
})
