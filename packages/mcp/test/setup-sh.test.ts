import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SETUP = fileURLToPath(new URL('../../../setup.sh', import.meta.url))

const REPOS = [
  'https://github.com/bsv-blockchain/ts-stack',
  'https://github.com/bsv-blockchain/BRCs',
  'https://github.com/bsv-blockchain/arcade',
  'https://github.com/bsv-blockchain/bsv-desktop',
  'https://github.com/bsv-blockchain/go-wallet-toolbox',
  'https://github.com/icellan/runar',
]

describe('setup.sh', () => {
  it('setup.sh --list prints the six repos', () => {
    const r = spawnSync('bash', [SETUP, '--list'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout.trimEnd().split('\n')).toEqual(REPOS)
    expect(r.stdout).not.toContain('bitcoin-sv/')
  })

  it('shallow-clones each repo into <target_dir>/<name> and prints the BSV_REPOS_DIR line', () => {
    // A fake git on PATH records its arguments and creates the destination, so nothing touches the network.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'setup-sh-')))
    const bin = join(tmp, 'bin')
    const log = join(tmp, 'git.log')
    const target = join(tmp, 'repos')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/bash\necho "$*" >> "${log}"\nmkdir -p "\${@: -1}"\n`, { mode: 0o755 })
    mkdirSync(join(target, 'BRCs'), { recursive: true }) // already present: skipped
    try {
      const r = spawnSync('bash', [SETUP, target], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
      expect(r.status).toBe(0)
      const calls = readFileSync(log, 'utf8').trimEnd().split('\n')
      expect(calls).toEqual(
        REPOS.filter((u) => !u.endsWith('/BRCs')).map((u) => `clone --quiet --depth 1 ${u} ${target}/${u.split('/').pop()}`),
      )
      expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`export BSV_REPOS_DIR=${target}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits 1 with usage when no target directory is given', () => {
    const r = spawnSync('bash', [SETUP], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/usage: .*setup\.sh <target_dir>/i)
  })
})
