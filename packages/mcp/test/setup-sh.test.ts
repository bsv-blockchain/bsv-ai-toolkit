import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

// chmod 000 does not stop root, and Windows ignores it.
const chmodBlocksEntry = process.platform !== 'win32' && process.getuid?.() !== 0

const cloneCall = (url: string, target: string) => `clone --quiet --depth 1 ${url} ${target}/${url.split('/').pop()}`

describe('setup.sh', () => {
  it('setup.sh --list prints the six repos', () => {
    const r = spawnSync('bash', [SETUP, '--list'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout.trimEnd().split('\n')).toEqual(REPOS)
    expect(r.stdout).not.toContain('bitcoin-sv/')
  })

  it('exits 1 with usage when no target directory is given', () => {
    const r = spawnSync('bash', [SETUP], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/usage: .*setup\.sh <target_dir>/i)
  })

  // A fake git first on PATH records its arguments and creates the destination (or fails), so nothing
  // touches the network.
  describe('cloning (fake git)', () => {
    let tmp: string
    let bin: string
    let log: string
    let target: string

    const fakeGit = (exitCode: number) =>
      writeFileSync(join(bin, 'git'), `#!/bin/bash\necho "$*" >> "${log}"\n[ ${exitCode} -eq 0 ] && mkdir -p "\${@: -1}"\nexit ${exitCode}\n`, { mode: 0o755 })
    const run = (args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
      spawnSync('bash', [SETUP, ...args], { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...opts.env } })
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : [])

    beforeEach(() => {
      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'setup-sh-')))
      bin = join(tmp, 'bin')
      log = join(tmp, 'git.log')
      target = join(tmp, 'repos')
      mkdirSync(bin)
    })
    afterEach(() => {
      try { chmodSync(target, 0o755) } catch { /* never locked */ }
      rmSync(tmp, { recursive: true, force: true })
    })

    it('shallow-clones each repo into <target_dir>/<name> and prints the BSV_REPOS_DIR line', () => {
      fakeGit(0)
      mkdirSync(join(target, 'BRCs'), { recursive: true }) // already present: skipped
      const r = run([target])
      expect(r.status).toBe(0)
      expect(calls()).toEqual(REPOS.filter((u) => !u.endsWith('/BRCs')).map((u) => cloneCall(u, target)))
      expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`export BSV_REPOS_DIR=${target}`)
    })

    it('exits 1 when a clone fails, and still prints the BSV_REPOS_DIR line', () => {
      fakeGit(1)
      const r = run([target])
      expect(r.status).toBe(1)
      expect(calls()).toEqual(REPOS.map((u) => cloneCall(u, target)))
      expect(r.stderr).toContain('6 repository clone(s) failed')
      expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`export BSV_REPOS_DIR=${target}`)
    })

    it.skipIf(!chmodBlocksEntry)('exits 1 without cloning when the target directory cannot be entered', () => {
      fakeGit(0)
      mkdirSync(target)
      chmodSync(target, 0o000)
      const r = run([target])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`cannot enter ${target}`)
      expect(calls()).toEqual([])
      expect(r.stdout).not.toContain('export BSV_REPOS_DIR')
    })

    it('resolves a relative target against the working directory, ignoring CDPATH', () => {
      fakeGit(0)
      const work = join(tmp, 'work')
      mkdirSync(work)
      mkdirSync(join(tmp, 'elsewhere', 'repos'), { recursive: true }) // what `cd repos` would pick via CDPATH
      const r = run(['repos'], { cwd: work, env: { CDPATH: join(tmp, 'elsewhere') } })
      expect(r.status).toBe(0)
      expect(calls()).toEqual(REPOS.map((u) => cloneCall(u, join(work, 'repos'))))
      expect(r.stdout.trimEnd().split('\n').at(-1)).toBe(`export BSV_REPOS_DIR=${join(work, 'repos')}`)
    })
  })
})
