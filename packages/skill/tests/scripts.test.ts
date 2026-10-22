import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verdictOf } from '../../mcp/src/arcade/classify.ts'

const scripts = fileURLToPath(new URL('../skills/bsv-dev/scripts/', import.meta.url))
const guard = join(scripts, 'network-guard.sh')
const check = join(scripts, 'arcade-check.sh')

// Resolves a command on the caller's PATH, so the tests can run bash with a reduced PATH.
function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, cmd)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {}
  }
  return undefined
}
const bash = which('bash')!
const hasJq = which('jq') !== undefined

interface Run { code: number | null; stdout: string; stderr: string }
function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, [script, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('network-guard.sh', () => {
  it('unset network defaults to testnet', async () => {
    const r = await run(guard, [], {})
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('network: testnet')
  })

  it('mainnet prints the banner', async () => {
    const r = await run(guard, [], { BSV_NETWORK: 'mainnet' })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('*** MAINNET: real money. BSV_NETWORK=mainnet ***')
  })

  it('bad value exits 2', async () => {
    const r = await run(guard, [], { BSV_NETWORK: 'main' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BSV_NETWORK must be testnet or mainnet (got: main)')
  })
})

// A local stand-in for Arcade: GET /tx/{txid} answers from `statuses` (404 when absent), GET /policy from `policy`.
const statuses = new Map<string, string>()
let policy = ''
let server: Server
let base = ''
let closedBase = ''
let noJqDir = ''

const txid = (c: string) => c.repeat(64)
// The status-seen.json fixture from packages/mcp/test/fixtures/arcade.
const SEEN = '{"txid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","txStatus":"SEEN_ON_NETWORK","timestamp":"2026-10-22T16:14:40.000000Z"}'
// The policy.json fixture from packages/mcp/test/fixtures/arcade.
const POLICY = '{"policy":{"miningFee":{"satoshis":1,"bytes":1000},"maxtxsizepolicy":100000000,"maxscriptsizepolicy":100000000,"maxtxsigopscountspolicy":4294967295,"standardFormatSupported":true},"timestamp":"2026-10-22T17:06:31.333912669Z"}'

beforeAll(async () => {
  server = createServer((req, res) => {
    const m = /^\/tx\/([0-9a-f]{64})$/.exec(req.url ?? '')
    const body = m ? statuses.get(m[1]) : req.url === '/policy' ? policy : undefined
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' })
    res.end(body ?? '{"error":"not found"}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const closed = createServer()
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
  closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise((r) => closed.close(r))

  // A PATH holding everything the script may call except jq, to exercise the grep/sed fallback.
  noJqDir = mkdtempSync(join(tmpdir(), 'arcade-check-nojq-'))
  for (const cmd of ['curl', 'grep', 'sed', 'awk', 'tr']) symlinkSync(which(cmd)!, join(noJqDir, cmd))
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  rmSync(noJqDir, { recursive: true, force: true })
})

const noProxy = { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
const paths = [
  { name: 'with jq', env: () => ({ PATH: process.env.PATH, ...noProxy }), skip: !hasJq },
  { name: 'without jq', env: () => ({ PATH: noJqDir, ...noProxy }), skip: false },
]

describe('arcade-check.sh', () => {
  it('arcade-check usage error exits 2', async () => {
    const r = await run(check, [], { PATH: process.env.PATH })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage:')
  })

  it('rejects a txid that is not 64 hex characters before building a URL', async () => {
    const r = await run(check, ['abc/../policy', base], { PATH: process.env.PATH, ...noProxy })
    expect(r.code).toBe(2)
  })

  it('rejects a BSV_NETWORK other than testnet or mainnet', async () => {
    const r = await run(check, [txid('a')], { PATH: process.env.PATH, BSV_NETWORK: 'main' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BSV_NETWORK must be testnet or mainnet (got: main)')
  })

  it('exits 3 when Arcade cannot be reached', async () => {
    const r = await run(check, [txid('a'), closedBase], { PATH: process.env.PATH, ...noProxy })
    expect(r.code).toBe(3)
  })

  for (const p of paths) {
    describe(p.name, () => {
      it.skipIf(p.skip)('404 prints no-verdict', async () => {
        const r = await run(check, [txid('c'), base], p.env())
        expect(r.code).toBe(0)
        expect(r.stdout.trimEnd().endsWith('verdict: no-verdict')).toBe(true)
      })

      it.skipIf(p.skip)('seen without competitors prints seen-no-competitor', async () => {
        statuses.set(txid('a'), SEEN)
        const r = await run(check, [txid('a'), base + '/'], p.env())
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('"txStatus":"SEEN_ON_NETWORK"')
        expect(r.stdout.trimEnd().endsWith('verdict: seen-no-competitor')).toBe(true)
      })

      it.skipIf(p.skip)('takes the URL from ARCADE_URL when no argument is given', async () => {
        statuses.set(txid('a'), SEEN)
        const r = await run(check, [txid('a')], { ...p.env(), ARCADE_URL: base })
        expect(r.code).toBe(0)
        expect(r.stdout.trimEnd().endsWith('verdict: seen-no-competitor')).toBe(true)
      })

      it.skipIf(p.skip)('matches verdictOf for every status, with and without competitors', async () => {
        const all = ['UNKNOWN', 'RECEIVED', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'DOUBLE_SPEND_ATTEMPTED', 'REJECTED', 'PENDING_RETRY', 'STUMP_PROCESSING', 'MINED', 'IMMUTABLE', 'SOMETHING_NEW'] as const
        const competing = [undefined, [], [txid('b')]]
        let i = 0
        for (const txStatus of all) {
          for (const competingTxs of competing) {
            const id = (i++).toString(16).padStart(64, '0')
            const s = { txid: id, txStatus, timestamp: '2026-10-22T16:14:40.000000Z', ...(competingTxs ? { competingTxs } : {}) }
            statuses.set(id, JSON.stringify(s, null, competingTxs?.length ? 2 : undefined))
            const r = await run(check, [id, base], p.env())
            expect(r.code).toBe(0)
            expect(r.stdout.trimEnd().split('\n').pop(), JSON.stringify(s)).toBe(`verdict: ${verdictOf(s as never)}`)
          }
        }
      })

      it.skipIf(p.skip)('--policy prints satPerKb', async () => {
        policy = POLICY
        const r = await run(check, ['--policy', base], p.env())
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('"miningFee"')
        expect(r.stdout.trimEnd().endsWith('satPerKb: 1')).toBe(true)

        policy = POLICY.replace('"satoshis":1', '"satoshis":50').replace('"bytes":1000', '"bytes":500')
        const r2 = await run(check, ['--policy', base], p.env())
        expect(r2.stdout.trimEnd().endsWith('satPerKb: 100')).toBe(true)
      })
    })
  }
})

describe('arcade-check.sh curl options', () => {
  it('ignores ~/.curlrc and URL globbing', async () => {
    const src = readFileSync(check, 'utf8')
    expect(src).toMatch(/curl -q -g /)
    const home = mkdtempSync(join(tmpdir(), 'arcade-check-home-'))
    try {
      writeFileSync(join(home, '.curlrc'), 'fail\n')
      const r = await run(check, [txid('d'), base], { PATH: process.env.PATH, HOME: home, ...noProxy })
      expect(r.code).toBe(0)
      expect(r.stdout.trimEnd().endsWith('verdict: no-verdict')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
