import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The prepared drop-in for bsv-blockchain/simple-mcp, checked offline against the workspace's own
// typescript, @types/node, @modelcontextprotocol/sdk and tsx: nothing is fetched or installed.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const syncDir = fileURLToPath(new URL('..', import.meta.url))
const filesDir = join(repoRoot, 'docs', 'deprecation', 'simple-mcp', 'files')
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

let dir: string

// A temp copy of `files/` with node_modules linked to the workspace copies, standing in for `npm install`.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'simple-mcp-deprecation-'))
  cpSync(filesDir, dir, { recursive: true })
  const link = (target: string, name: string) => {
    mkdirSync(join(dir, 'node_modules', name, '..'), { recursive: true })
    symlinkSync(realpathSync(target), join(dir, 'node_modules', name), 'dir')
  }
  link(join(repoRoot, 'packages', 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk'), '@modelcontextprotocol/sdk')
  link(join(repoRoot, 'node_modules', '@types', 'node'), '@types/node')
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('@bsv/simple-mcp deprecation release', () => {
  it('deprecation index.ts compiles standalone', () => {
    const r = spawnSync(
      process.execPath,
      [tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--skipLibCheck', 'src/index.ts'],
      { cwd: dir, encoding: 'utf8' },
    )
    expect(r.stdout + r.stderr).toBe('')
    expect(r.status).toBe(0)
  }, 60_000)

  it('prints the deprecation notice on start', () => {
    // cwd is this package so `--import tsx` resolves to the workspace tsx; stdin is empty, so the server exits.
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(dir, 'src', 'index.ts')], {
      cwd: syncDir,
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(r.stderr).toContain('deprecated')
    expect(r.stderr).toContain('claude mcp add bsv-mcp -e BSV_NETWORK=testnet -- npx -y @bsv/mcp')
    expect(r.status).toBe(0)
  }, 30_000)
})
