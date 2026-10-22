import { describe, it, expect } from 'vitest'
import { lintContent } from '../src/lint.js'
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
  it('requires G-01..G-34 in order', async () => {
    const d = mkdtempSync(join(tmpdir(), 'c-'))
    writeFileSync(join(d, 'guardrails.yaml'), '- id: G-02\n  title: t\n  shape: both\n  rule: r\n  why: w\n  detect: manual\n  severity: warn\n  refs: []\n')
    const { errors } = await lintContent(d)
    expect(errors.some(e => e.includes('G-01'))).toBe(true)
  })
})
