import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const script = join(repoRoot, 'scripts', 'anti-goals.sh')

function run(...args: string[]) {
  const r = spawnSync('bash', [script, ...args], { cwd: repoRoot, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

function tempDirWith(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'anti-goals-'))
  writeFileSync(join(dir, 'doc.md'), text)
  return dir
}

describe('scripts/anti-goals.sh', () => {
  it('anti-goals.sh passes on the repo', () => {
    const r = run()
    expect(r.out).not.toContain('anti-goal hit')
    expect(r.code).toBe(0)
  })

  it('anti-goals.sh fails on a forbidden phrase', () => {
    const dir = tempDirWith('# Payments\n\nAfter broadcasting, wait for confirmation before shipping.\n')
    const r = run(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain('wait for confirmation')
  })

  it('accepts a forbidden phrase on a line that carries an allowlist marker', () => {
    const dir = tempDirWith('Never post to `/v1/tx`; that is the legacy ARC API.\n')
    expect(run(dir).code).toBe(0)
  })

  it('skips paths that do not exist', () => {
    const dir = tempDirWith('nothing to see\n')
    expect(run(join(dir, 'missing'), dir).code).toBe(0)
  })
})
