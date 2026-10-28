import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkProject, type ProjectFile } from '../src/lint/walk.js'
import { detectShape } from '../src/lint/shape.js'
import { isSuppressed, runGuardrails } from '../src/lint/engine.js'
import type { Rule, RuleResult } from '../src/lint/rules/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MINIMAL = join(HERE, 'fixtures', 'projects', 'minimal')
const CONTENT = join(HERE, '..', 'content')

const tmpRoots: string[] = []
function tmpProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bsv-lint-'))
  tmpRoots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}
afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }) })

function pf(rel: string, text: string, isClient = true): ProjectFile {
  return { rel, abs: `/x/${rel}`, text, isClient, isTest: false }
}

// Throwaway rule: flags every line containing FLAGME (1-based line numbers).
function flagRule(id: string): Rule {
  return {
    id,
    run(ctx) {
      const findings: RuleResult['findings'] = []
      for (const f of ctx.files) {
        const lines = f.text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('FLAGME')) findings.push({ id, severity: ctx.meta.severity, file: f.rel, line: i + 1, snippet: lines[i].trim() })
        }
      }
      return { findings, applicable: true }
    },
  }
}

describe('lint engine', () => {
  it('walkProject skips node_modules, dist and .gitignore entries', async () => {
    const files = await walkProject(MINIMAL)
    expect(files.map(f => f.rel)).toEqual(['package.json', 'src/a.ts'])
  })

  it('isClient is true for src/ and false for server/', async () => {
    const root = tmpProject({ 'src/a.ts': 'x', 'server/b.ts': 'y', 'src/server/c.ts': 'z' })
    const byRel = Object.fromEntries((await walkProject(root)).map(f => [f.rel, f]))
    expect(byRel['src/a.ts'].isClient).toBe(true)
    expect(byRel['server/b.ts'].isClient).toBe(false)
    expect(byRel['src/server/c.ts'].isClient).toBe(false)
  })

  it('detectShape A for WalletClient in src', () => {
    expect(detectShape([pf('src/w.ts', "const w = new WalletClient('auto', 'app')")])).toBe('A')
    expect(detectShape([pf('server/w.ts', 'const w = new WalletClient ()', false)])).toBe('unknown')
  })

  it('detectShape A+B when both markers present', () => {
    expect(detectShape([pf('src/w.ts', 'new WalletClient()'), pf('server/s.ts', 'await Setup.createWallet({})', false)])).toBe('A+B')
    expect(detectShape([pf('server/s.ts', "import 'go-wallet-toolbox'", false)])).toBe('B')
  })

  it('isSuppressed matches same line and line above', () => {
    const f = pf('src/x.ts', [
      'a // bsv-guardrail-ignore G-09 same line', // 1
      '# bsv-guardrail-ignore G-10 hash form', // 2
      'b', // 3
      '<!-- bsv-guardrail-ignore G-12 html -->', // 4
      '/* bsv-guardrail-ignore G-14 block */ c', // 5
      'd', // 6
      'e', // 7
    ].join('\n'))
    expect(isSuppressed(f, 1, 'G-09')).toBe(true)
    expect(isSuppressed(f, 2, 'G-09')).toBe(true) // line above
    expect(isSuppressed(f, 3, 'G-09')).toBe(false) // two lines below
    expect(isSuppressed(f, 3, 'G-10')).toBe(true)
    expect(isSuppressed(f, 1, 'G-10')).toBe(false) // id must match
    expect(isSuppressed(f, 5, 'G-12')).toBe(true)
    expect(isSuppressed(f, 5, 'G-14')).toBe(true)
    expect(isSuppressed(f, 6, 'G-14')).toBe(true)
    expect(isSuppressed(f, 7, 'G-14')).toBe(false)
    expect(isSuppressed(pf('src/y.ts', 'bsv-guardrail-ignore G-09 not a comment'), 1, 'G-09')).toBe(false)
  })

  it('ignore comment suppresses a finding', async () => {
    const report = await runGuardrails(MINIMAL, { contentDir: CONTENT, rules: [flagRule('G-09'), flagRule('G-10')] })
    expect(report.passed).toContain('G-09')
    expect(report.findings.map(f => f.id)).toEqual(['G-10'])
    const [g10] = report.findings
    expect(g10).toMatchObject({ file: 'src/a.ts', line: 2, severity: 'error', ref: 'bsv://guardrails#G-10' })
    expect(g10.fix).toBe('A POST 2xx is provisional; read `GET /tx/{txid}`; money counts and is final at `SEEN_ON_NETWORK`+ with no competing tx; never earlier, never `MINED`.')
  })

  it('manual rules land in manualChecklist', async () => {
    const report = await runGuardrails(MINIMAL, { contentDir: CONTENT, rules: [] })
    expect(report.shapeDetected).toBe('unknown')
    expect(report.manualChecklist).toContain('G-05')
    expect(report.manualChecklist).toContain('G-26') // contract
  })

  it('a throwing rule becomes a warn finding and the run continues', async () => {
    const boom: Rule = { id: 'G-09', run() { throw new Error('boom') } }
    const report = await runGuardrails(MINIMAL, { contentDir: CONTENT, rules: [boom, flagRule('G-10')] })
    const g09 = report.findings.find(f => f.id === 'G-09')
    expect(g09).toMatchObject({ severity: 'warn', file: '', line: 0, ref: 'bsv://guardrails#G-09' })
    expect(g09!.fix).toMatch(/boom/)
    expect(report.passed).not.toContain('G-09')
    expect(report.findings.some(f => f.id === 'G-10')).toBe(true)
  })

  it('shape B makes A-only rules notApplicable', async () => {
    const report = await runGuardrails(MINIMAL, { contentDir: CONTENT, shape: 'B', rules: [flagRule('G-01')] })
    expect(report.notApplicable).toContain('G-01')
    expect(report.findings).toEqual([])
  })
})
