import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const skillDir = fileURLToPath(new URL('../skills/bsv-dev/', import.meta.url))
const skill = readFileSync(skillDir + 'SKILL.md', 'utf8')
const fm = skill.match(/^---\n([\s\S]*?)\n---/)![1]

describe('SKILL.md', () => {
  it('has name bsv-dev and a description under 1024 chars', () => {
    expect(fm).toMatch(/^name: bsv-dev$/m)
    const d = fm.match(/^description: '([\s\S]*?)'$/m)![1]
    expect(d.length).toBeLessThanOrEqual(1024)
  })

  it('body is under 500 lines (target 250)', () => {
    expect(skill.split('\n').length).toBeLessThan(500)
  })

  it('has the six sections in order', () => {
    const idx = [
      '## What this skill is for',
      '## Default decisions',
      '## Agent safety',
      '## Tools to use',
      '## Operating procedure',
      '## Read when needed',
    ].map((h) => skill.indexOf(h))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  // Calls npm, so it runs only with SKILLS_REF_TESTS=1; CI's `skill` job runs `skills-ref validate` directly.
  it.skipIf(!process.env.SKILLS_REF_TESTS)('passes skills-ref validate', () => {
    expect(() =>
      execFileSync('npx', ['-y', 'skills-ref@0.1.5', 'validate', skillDir], { stdio: 'pipe' }),
    ).not.toThrow()
  }, 120_000)
})
