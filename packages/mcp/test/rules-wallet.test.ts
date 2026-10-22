import { describe, it, expect } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGuardrails } from '../src/lint/engine.js'
import type { Finding, GuardrailReport } from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECTS = join(HERE, 'fixtures', 'projects')
const CONTENT = join(HERE, '..', 'content')
const WALLET_IDS = ['G-01', 'G-02', 'G-03', 'G-04', 'G-06']

const reports = new Map<string, Promise<GuardrailReport>>()
function lint(project: string): Promise<GuardrailReport> {
  if (!reports.has(project)) reports.set(project, runGuardrails(join(PROJECTS, project), { contentDir: CONTENT, shape: 'auto' }))
  return reports.get(project)!
}

async function expectFinding(project: string, id: string, file: string, severity: string, line?: number): Promise<Finding> {
  const { findings } = await lint(project)
  const hit = findings.find(f => f.id === id && f.file === file && f.severity === severity && (line === undefined || f.line === line))
  expect(hit, `${id} in ${project}/${file}${line === undefined ? '' : `:${line}`}; got ${JSON.stringify(findings)}`).toBeDefined()
  expect(hit!.ref).toBe(`bsv://guardrails#${id}`)
  return hit!
}

describe('wallet and manifest guardrails', () => {
  it('clean-a has no findings for G-01..G-06', async () => {
    const report = await lint('clean-a')
    expect(report.shapeDetected).toBe('A')
    expect(report.findings.filter(f => WALLET_IDS.includes(f.id))).toEqual([])
    expect(report.passed).toEqual(expect.arrayContaining(WALLET_IDS))
  })

  it('broken-a: G-01 isAuthenticated gate', async () => {
    const f = await expectFinding('broken-a', 'G-01', 'src/wallet.ts', 'error', 7)
    expect(f.snippet).toContain('isAuthenticated(')
  })

  it('broken-a: G-02 mainnet default', async () => {
    const f = await expectFinding('broken-a', 'G-02', 'src/config.ts', 'error', 3)
    expect(f.snippet).toContain("'mainnet'")
  })

  it('broken-a: G-02 no getNetwork beside createAction', async () => {
    await expectFinding('broken-a', 'G-02', 'src/wallet.ts', 'error', 13)
  })

  it('broken-a: G-03 missing manifest', async () => {
    await expectFinding('broken-a', 'G-03', 'public/manifest.json', 'error', 0)
  })

  it('broken-manifest: G-03 babbage differs', async () => {
    await expectFinding('broken-manifest', 'G-03', 'public/manifest.json', 'error', 14)
  })

  it('broken-manifest: G-04 level-2 without counterparty is warn', async () => {
    // The level-2 entry appears in both the metanet and the babbage block.
    await expectFinding('broken-manifest', 'G-04', 'public/manifest.json', 'warn', 9)
    await expectFinding('broken-manifest', 'G-04', 'public/manifest.json', 'warn', 18)
    // A spending allowance above 100000 sats is flagged too.
    await expectFinding('broken-manifest', 'G-04', 'public/manifest.json', 'warn', 11)
  })

  it('broken-a: G-06 PrivateKey in client', async () => {
    await expectFinding('broken-a', 'G-06', 'src/keys.ts', 'error', 4)
  })

  it('broken-a: G-06 key in .env', async () => {
    const f = await expectFinding('broken-a', 'G-06', '.env', 'error', 2)
    expect(f.snippet).toContain('SERVER_ROOT_KEY')
    expect(f.snippet).not.toMatch(/0{32}/)
  })
})
