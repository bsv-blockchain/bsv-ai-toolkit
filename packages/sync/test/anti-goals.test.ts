import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const script = join(repoRoot, 'scripts', 'anti-goals.sh')
const tempDirs: string[] = []

function run(...args: string[]) {
  const r = spawnSync('bash', [script, ...args], { cwd: repoRoot, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

function tempDirWith(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'anti-goals-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'doc.md'), text)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Root reads any file regardless of mode, and Windows has no POSIX modes.
const cannotMakeUnreadable = process.platform === 'win32' || process.getuid?.() === 0

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

  it('matches prose phrases case-insensitively', () => {
    const dir = tempDirWith('Wait For Confirmation before shipping.\n')
    expect(run(dir).code).toBe(1)
  })

  it('fails on an unmarked SDK ARC import', () => {
    const dir = tempDirWith('import { Transaction, ARC } from "@bsv/sdk"\n')
    expect(run(dir).code).toBe(1)
  })

  it('does not treat an Arcade import as an ARC import', () => {
    const dir = tempDirWith('import { ArcadeClient } from "@bsv/mcp"\nconst url = process.env.ARCADE_URL\n')
    const r = run(dir)
    expect(r.out).not.toContain('anti-goal hit')
    expect(r.code).toBe(0)
  })

  it('accepts a forbidden phrase on a line that carries an allowlist marker', () => {
    const dir = tempDirWith('Never post to `/v1/tx`; that is the legacy ARC API.\n')
    expect(run(dir).code).toBe(0)
  })

  it('skips paths that do not exist', () => {
    const dir = tempDirWith('nothing to see\n')
    expect(run(join(dir, 'missing'), dir).code).toBe(0)
  })

  it.skipIf(cannotMakeUnreadable)('fails when a file cannot be read', () => {
    const dir = tempDirWith('wait for confirmation\n')
    chmodSync(join(dir, 'doc.md'), 0o000)
    const r = run(dir)
    expect(r.code).toBe(2)
    expect(r.out).not.toContain('anti-goals: ok')
  })
})
