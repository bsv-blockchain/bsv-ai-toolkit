import { describe, it, expect } from 'vitest'
import { lintContent, staleVerified } from '../src/lint.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = new URL('../../../content', import.meta.url).pathname
describe('lintContent', () => {
  it('passes on the repo content', async () => {
    expect((await lintContent(root)).errors).toEqual([])
  })
  it('fails a fact without verified', async () => {
    const d = mkdtempSync(join(tmpdir(), 'c-')); mkdirSync(join(d, 'facts'))
    writeFileSync(join(d, 'facts', 'x.md'), '---\ntitle: X\n---\nbody\n')
    const { errors } = await lintContent(d)
    expect(errors.some(e => e.includes('facts/x.md') && e.includes('verified'))).toBe(true)
  })
  it('requires G-01..G-38 in order', async () => {
    const d = mkdtempSync(join(tmpdir(), 'c-'))
    writeFileSync(join(d, 'guardrails.yaml'), '- id: G-02\n  title: t\n  shape: both\n  rule: r\n  why: w\n  detect: manual\n  severity: warn\n  refs: []\n')
    const { errors } = await lintContent(d)
    expect(errors.some(e => e.includes('G-01'))).toBe(true)
    const short = mkdtempSync(join(tmpdir(), 'c-'))
    const item = (n: number) => `- id: G-${String(n).padStart(2, '0')}\n  title: t\n  shape: both\n  rule: r\n  why: w\n  detect: manual\n  severity: warn\n  refs: []\n`
    writeFileSync(join(short, 'guardrails.yaml'), Array.from({ length: 34 }, (_, i) => item(i + 1)).join('\n'))
    const tail = (await lintContent(short)).errors.filter(e => e.startsWith('guardrails.yaml'))
    expect(tail.some(e => e.includes('G-01..G-38') && e.includes('expected G-35'))).toBe(true)
  })
})

describe('staleVerified', () => {
  const today = new Date('2026-10-22T12:00:00Z')
  function dir() {
    const d = mkdtempSync(join(tmpdir(), 's-')); mkdirSync(join(d, 'facts'))
    writeFileSync(join(d, 'facts', 'fresh.md'), '---\ntitle: F\nverified: 2026-08-23\n---\n')
    writeFileSync(join(d, 'facts', 'old.md'), '---\ntitle: O\nverified: 2026-08-22\n---\n')
    writeFileSync(join(d, 'versions.json'), JSON.stringify({ verified: '2026-10-22', packages: { a: { pinned: '1', verified: '2026-01-01' } } }))
    return d
  }
  it('flags every verified date older than the limit, in markdown frontmatter and JSON', async () => {
    const stale = await staleVerified(dir(), 60, today)
    expect(stale).toEqual([
      'facts/old.md: verified 2026-08-22 is 61 days old (max 60)',
      'versions.json packages.a: verified 2026-01-01 is 294 days old (max 60)',
    ])
  })
  it('passes on the repo content today', async () => {
    expect(await staleVerified(root, 60, today)).toEqual([])
  })
})
