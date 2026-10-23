import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGuardrailMeta, runGuardrails } from '../src/lint/engine.js'
import { rules, type Rule } from '../src/lint/rules/index.js'
import { g09 } from '../src/lint/rules/g09.js'
import { g10 } from '../src/lint/rules/g10.js'
import { g12 } from '../src/lint/rules/g12.js'
import { g14 } from '../src/lint/rules/g14.js'
import { g15 } from '../src/lint/rules/g15.js'
import { g16 } from '../src/lint/rules/g16.js'
import { g21 } from '../src/lint/rules/g21.js'
import { g25 } from '../src/lint/rules/g25.js'
import { g31 } from '../src/lint/rules/g31.js'
import { g34 } from '../src/lint/rules/g34.js'
import { g36 } from '../src/lint/rules/g36.js'
import { inLoop, scan, withAliases } from '../src/lint/rules/util.js'
import type { ProjectFile } from '../src/lint/walk.js'
import type { Finding, GuardrailReport } from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECTS = join(HERE, 'fixtures', 'projects')
const CONTENT = join(HERE, '..', 'content')

const reports = new Map<string, Promise<GuardrailReport>>()
function lint(project: string): Promise<GuardrailReport> {
  if (!reports.has(project)) reports.set(project, runGuardrails(join(PROJECTS, project), { contentDir: CONTENT, shape: 'auto' }))
  return reports.get(project)!
}

function pf(rel: string, text: string): ProjectFile {
  const isClient = /^(?:src|web|app)\//.test(rel)
  return { rel, abs: `/x/${rel}`, text, isClient, isTest: /\.test\.ts$/.test(rel) }
}

/** Runs one rule over in-memory files (`{ rel: text }`); a bare string is `src/app.ts`. */
function runOn(rule: Rule, files: string | Record<string, string>) {
  const map = typeof files === 'string' ? { 'src/app.ts': files } : files
  const meta = loadGuardrailMeta(CONTENT).find(m => m.id === rule.id)!
  const list = Object.entries(map).map(([rel, text]) => pf(rel, text))
  return rule.run({ files: list, shape: 'A', root: '/x', meta, contentDir: CONTENT }).findings
}

async function expectFinding(project: string, id: string, file: string, severity: string, line?: number): Promise<Finding> {
  const { findings } = await lint(project)
  const hit = findings.find(f => f.id === id && f.file === file && f.severity === severity && (line === undefined || f.line === line))
  expect(hit, `${id} in ${project}/${file}${line === undefined ? '' : `:${line}`}; got ${JSON.stringify(findings)}`).toBeDefined()
  expect(hit!.ref).toBe(`bsv://guardrails#${id}`)
  return hit!
}

const BROADCAST = 'src/broadcast.ts'

const tmpRoots: string[] = []
afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }) })

describe('broadcast and money guardrails on fixtures', () => {
  it('clean-a has zero errors overall', async () => {
    const report = await lint('clean-a')
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
    expect(report.findings).toEqual([])
    expect(report.passed).toEqual(expect.arrayContaining(['G-09', 'G-10', 'G-12', 'G-14', 'G-15', 'G-16', 'G-21', 'G-25', 'G-31', 'G-34']))
  })

  it('clean-b has no findings', async () => {
    expect((await lint('clean-b')).findings).toEqual([])
  })

  it('broken-a: G-09 ARC class', async () => {
    expect((await expectFinding('broken-a', 'G-09', BROADCAST, 'error', 1)).snippet).toContain('import { ARC')
    expect((await expectFinding('broken-a', 'G-09', BROADCAST, 'error', 6)).snippet).toContain('new ARC(')
  })

  it('broken-a: G-09 arc.taal.com', async () => {
    expect((await expectFinding('broken-a', 'G-09', BROADCAST, 'error', 6)).snippet).toContain('arc.taal.com')
  })

  it('broken-a: G-10 MINED branch', async () => {
    expect((await expectFinding('broken-a', 'G-10', BROADCAST, 'error', 24)).snippet).toContain("'MINED'")
    // POST /tx with no GET /tx/{txid} read in the same module
    expect((await expectFinding('broken-a', 'G-10', BROADCAST, 'error', 9)).snippet).toContain('no GET /tx/')
  })

  it('broken-a: G-12 WoC hex loop', async () => {
    const f = await expectFinding('broken-a', 'G-12', BROADCAST, 'error', 17)
    expect(f.snippet).toContain('browser code')
    expect(f.snippet).toContain('inside a loop, no rate-limit gate')
    const { findings } = await lint('broken-a')
    expect(findings.filter(f => f.id === 'G-12').map(f => f.line)).toEqual([17]) // the Arcade POST is not a WoC call
  })

  it('broken-a: G-14 waiting for confirmation (warn)', async () => {
    await expectFinding('broken-a', 'G-14', BROADCAST, 'warn', 28)
  })

  it('broken-a: G-15 fetch without signal (warn)', async () => {
    await expectFinding('broken-a', 'G-15', BROADCAST, 'warn', 9)
    await expectFinding('broken-a', 'G-15', BROADCAST, 'warn', 17)
  })

  it('broken-a: G-16 fromHex(rawTx)', async () => {
    expect((await expectFinding('broken-a', 'G-16', BROADCAST, 'error', 25)).snippet).toContain('fromHex(status.rawTx)')
    // ancestry walked one transaction at a time from an indexer
    await expectFinding('broken-a', 'G-16', BROADCAST, 'error', 17)
  })

  it('broken-a: G-21 missing paymentRemittance', async () => {
    await expectFinding('broken-a', 'G-21', BROADCAST, 'error', 31)
  })

  it('broken-a: G-25 runar 0.4.6', async () => {
    expect((await expectFinding('broken-a', 'G-25', 'package.json', 'error', 7)).snippet).toContain('runar-sdk')
  })

  it('broken-a: G-31 @bsv/sdk 3.0.0 behind 3.2.1 (warn)', async () => {
    const f = await expectFinding('broken-a', 'G-31', 'package.json', 'warn', 6)
    expect(f.snippet).toContain('3.2.1')
    const { findings } = await lint('broken-a')
    expect(findings.filter(f => f.id === 'G-31')).toHaveLength(1) // runar-sdk 0.4.6 equals its pin
  })

  it('broken-a: G-34 no trust model (warn)', async () => {
    // README line 1, so an ignore comment there can suppress it (ruling R24)
    await expectFinding('broken-a', 'G-34', 'README.md', 'warn', 1)
  })

  it('exit-criterion set is all errors', async () => {
    const { findings } = await lint('broken-a')
    for (const id of ['G-09', 'G-01', 'G-02', 'G-12', 'G-03']) {
      expect(findings.filter(f => f.id === id).length, id).toBeGreaterThan(0)
      expect(findings.filter(f => f.id === id).every(f => f.severity === 'error'), id).toBe(true)
    }
  })
})

describe('rule registry', () => {
  it('every detect: static guardrail has exactly one registered rule', () => {
    const staticIds = loadGuardrailMeta(CONTENT).filter(m => m.detect === 'static').map(m => m.id)
    expect(rules.map(r => r.id).sort()).toEqual([...staticIds].sort())
    for (const id of staticIds) expect(rules.filter(r => r.id === id), id).toHaveLength(1)
    expect(rules).toHaveLength(17)
  })
})

describe('code scanning helpers', () => {
  it('withAliases follows URL constants but not responses read from them', () => {
    const code = "const WOC = 'https://api.whatsonchain.com'\nconst url = `${WOC}/chain/info`\nconst res = await fetch(url)"
    const re = withAliases(code, /whatsonchain/i)
    expect(['WOC', 'url', 'res', 'wocUrl'].map(n => re.test(`x(${n})`))).toEqual([true, true, false, false])
  })

  it('blanks comments but keeps URLs, line numbers and string text', () => {
    const s = scan(pf('src/a.ts', "const u = 'https://x.test/a' // never ARC\n/* new ARC( */ const r = /['\"]x/\nconst t = `a${b}c` // c"))
    const first = s.code.split('\n')[0]
    expect(first.trimEnd()).toBe("const u = 'https://x.test/a'")
    expect(first).toHaveLength("const u = 'https://x.test/a' // never ARC".length)
    expect(s.code.split('\n')[1]).not.toContain('ARC')
    expect(s.code.split('\n')[2]).toContain('`a${b}c`')
    expect(s.masked.split('\n')[2]).toContain('${b}')
    expect(s.masked).not.toContain('https')
  })

  it('inLoop follows for/while bodies and .map/Promise.all calls', () => {
    const text = [
      'for (const x of xs) {', // 1
      '  a(x)', // 2
      '}', // 3
      'b()', // 4
      'await Promise.all(xs.map(x =>', // 5
      '  c(x)))', // 6
      'd()', // 7
    ].join('\n')
    const s = scan(pf('src/a.ts', text))
    // the last character of each line: a loop's own brackets are outside its body
    const at = (n: number) => inLoop(s, s.starts[n - 1] + text.split('\n')[n - 1].length - 1)
    expect([1, 2, 3, 4, 5, 6, 7].map(at)).toEqual([false, true, false, false, true, false, false])
  })
})

describe('G-09 never ARC', () => {
  it.each([
    "import { ARC } from '@bsv/sdk'",
    "import {\n  Transaction,\n  ARC,\n} from '@bsv/sdk'",
    'tx.broadcast(new ARC(url))',
    "const url = 'https://arc.gorillapool.io'",
    "await fetch(base + '/v1/tx', { method: 'POST' })",
    "await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', { method: 'POST' })",
  ])('flags %s', text => {
    expect(runOn(g09, text)).toHaveLength(1)
  })

  it.each([
    '// never use ARC or /v1/tx; Arcade only',
    '/* not arc.taal.com */',
    "const url = 'https://arcade.gorillapool.io'",
    "await fetch(ARCADE_URL + '/tx', { method: 'POST' })",
    "import { ARCADE_URL } from './config.js'",
  ])('does not flag %s', text => {
    expect(runOn(g09, text)).toEqual([])
  })

  it('ignores Markdown docs that name ARC', () => {
    expect(runOn(g09, { 'README.md': 'Never use the SDK `ARC` class or `/v1/tx`.' })).toEqual([])
  })
})

describe('G-10 SEEN_ON_NETWORK, never MINED', () => {
  it.each([
    "if (status.txStatus === 'MINED') credit()",
    "while (s.txStatus !== 'MINED') await sleep(1000)",
    "const paid = res.txStatus === 'MINED'",
    "if (['MINED', 'IMMUTABLE'].includes(s.txStatus)) release()",
    "switch (s.txStatus) {\n  case 'MINED':\n    await credit(order)\n    break\n}",
    'if (tx.confirmations >= 1) fulfil(order)',
  ])('flags %s', text => {
    expect(runOn(g10, text)).toHaveLength(1)
  })

  it.each([
    "type TxStatus = 'SEEN_ON_NETWORK' | 'MINED' | 'REJECTED'",
    "const LABELS = { SEEN_ON_NETWORK: 'Paid', 'MINED': 'In a block' }",
    "const label = s.txStatus === 'MINED' ? 'In a block' : 'Pending'",
    "{s.txStatus === 'MINED' && <Badge>In a block</Badge>}",
    "switch (s) {\n  case 'MINED':\n    return 'In a block'\n}",
    "switch (s) {\n  case 'SEEN_ON_NETWORK':\n  case 'MINED':\n    credit()\n}",
    "const FINAL = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED', 'IMMUTABLE'])",
    "if (s.txStatus === 'SEEN_ON_NETWORK' || s.txStatus === 'MINED') credit()",
    "// never branch on 'MINED' === status",
    '<p>{tx.confirmations} confirmations</p>',
  ])('does not flag %s', text => {
    expect(runOn(g10, text)).toEqual([])
  })

  it('ignores test files', () => {
    expect(runOn(g10, { 'test/x.test.ts': "if (s.txStatus === 'MINED') credit()" })).toEqual([])
  })

  it('reads a long run of case labels in linear time', () => {
    const start = Date.now()
    expect(runOn(g10, 'case' + '  9:case'.repeat(40) + ' x')).toEqual([])
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('reads a condition split over lines as one: SEEN beside MINED passes, MINED alone is flagged', () => {
    const gate = (statuses: string[]) => [
      'if (',
      ...statuses.map((v, i) => `  s.txStatus === '${v}'${i < statuses.length - 1 ? ' ||' : ''}`),
      ') {',
      '  credit(order)',
      '}',
    ].join('\n')
    expect(runOn(g10, gate(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED']))).toEqual([])
    expect(runOn(g10, gate(['MINED', 'IMMUTABLE'])).map(f => f.line)).toEqual([2])
    const joined = "const final =\n  s.txStatus === 'SEEN_ON_NETWORK' ||\n  s.txStatus === 'MINED'"
    expect(runOn(g10, joined)).toEqual([])
    expect(runOn(g10, "if (\n  s.txStatus === 'MINED'\n) {\n  return 'In a block'\n}")).toEqual([])
  })

  it('does not count a POST to the app\'s own relay as an Arcade broadcast', () => {
    const relay = "await fetch('/api/tx', {\n  method: 'POST',\n  body: JSON.stringify({ beef }),\n  signal: AbortSignal.timeout(10000),\n})"
    expect(runOn(g10, relay)).toEqual([])
  })

  it('flags a POST /tx with no GET /tx/ read in the module, and passes when one follows', () => {
    const post = "const r = await fetch(`${ARCADE_URL}/tx`, {\n  method: 'POST',\n  body: hex,\n})"
    const findings = runOn(g10, post)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(1)
    expect(runOn(g10, `${post}\nconst s = await fetch(\`\${ARCADE_URL}/tx/\${txid}\`)`)).toEqual([])
    // A WhatsOnChain read is not an Arcade status read.
    expect(runOn(g10, `${post}\nawait fetch('https://api.whatsonchain.com/v1/bsv/test/tx/' + txid)`)).toHaveLength(1)
  })
})

describe('G-12 Arcade first, WhatsOnChain gated', () => {
  const WOC = "const WOC = 'https://api.whatsonchain.com/v1/bsv/test'\n"

  it('flags a WhatsOnChain call in a module with no gate', () => {
    const findings = runOn(g12, { 'server/woc.ts': `${WOC}export const info = () => fetch(\`\${WOC}/chain/info\`)` })
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(2)
  })

  it('flags a WhatsOnChain tx hex read in browser code even behind a gate', () => {
    const text = `${WOC}const gate = makeGate(350)\nexport const hex = (id: string) => gate(() => fetch(\`\${WOC}/tx/\${id}/hex\`))`
    expect(runOn(g12, { 'src/woc.ts': text })).toHaveLength(1)
    expect(runOn(g12, { 'server/woc.ts': text })).toEqual([])
  })

  it.each([
    'import pLimit from \'p-limit\'\nconst limit = pLimit(1)',
    'const wocGate = new Bottleneck({ minTime: 350 })',
    'const throttled = throttle(get, 350)',
    'await new Promise(r => setTimeout(r, 350))',
    'const queue = new PQueue({ interval: 350, intervalCap: 1 })',
  ])('does not flag a module with a limiter: %s', limiter => {
    const text = `${WOC}${limiter}\nfor (const a of addrs) await fetch(\`\${WOC}/address/\${a}/unspent\`)`
    expect(runOn(g12, { 'server/woc.ts': text })).toEqual([])
  })

  it.each([
    "import { gated } from './woc-gate.js'\nexport const unspent = (a: string) => gated(() => fetch(`${WOC}/address/${a}/unspent`))",
    "import { limit } from './limit.js'\nexport const info = () => limit(() => fetch(`${WOC}/chain/info`))",
    "import { run } from './gate.js'\nexport async function info() {\n  return run(async () => {\n    const res = await fetch(`${WOC}/chain/info`)\n    return res.json()\n  })\n}",
  ])('does not flag a call wrapped in an imported gate: %s', text => {
    expect(runOn(g12, { 'server/woc.ts': `${WOC}${text}` })).toEqual([])
  })

  it('counts a callee imported from a gate module as a gate', () => {
    const text = "import { wocCall } from './woc-gate.js'\nexport const info = () => wocCall(() => fetch(`${WOC}/chain/info`))"
    expect(runOn(g12, { 'server/woc.ts': `${WOC}${text}` })).toEqual([])
  })

  it.each([
    // framework and utility thunks are not gates
    "onMount(async () => {\n  for (const a of addrs) await fetch(`${WOC}/address/${a}/unspent`)\n})",
    "onMounted(async () => {\n  await fetch(`${WOC}/chain/info`)\n})",
    "export default defineEventHandler(async () => {\n  for (const a of addrs) await fetch(`${WOC}/address/${a}/unspent`)\n})",
    "for (const a of addrs) await withRetry(() => fetch(`${WOC}/address/${a}/unspent`))",
    "setInterval(() => fetch(`${WOC}/chain/info`), 1000)",
    "button.onclick = () => fetch(`${WOC}/chain/info`)",
    // a gate whose one task loops over the calls does not space them (`limit` is a gate only by wrapping, not a module token)
    "limit(async () => {\n  for (const a of addrs) await fetch(`${WOC}/address/${a}/unspent`)\n})",
    // a named function inside a gate call is its own function
    "limit(async () => {\n  async function load() {\n    return fetch(`${WOC}/chain/info`)\n  }\n  return load\n})",
    "scheduleRender()\nawait fetch(`${WOC}/chain/info`)",
    "export const status = 'Queue position'\nawait fetch(`${WOC}/chain/info`)",
    "app.get('/h', async (req, res) => {\n  res.json(await fetch(`${WOC}/chain/info`))\n})",
    "await Promise.all(addrs.map(a => fetch(`${WOC}/address/${a}/unspent`)))",
    "useEffect(() => { fetch(`${WOC}/chain/info`) }, [])",
  ])('still flags an ungated call: %s', text => {
    expect(runOn(g12, { 'server/woc.ts': `${WOC}${text}` })).toHaveLength(1)
  })

  it('does not count "gate" inside another word as a limiter', () => {
    const text = `${WOC}navigate('/home')\nawait fetch(\`\${WOC}/chain/info\`)`
    expect(runOn(g12, { 'server/woc.ts': text })).toHaveLength(1)
  })

  it('ignores WhatsOnChain in comments', () => {
    expect(runOn(g12, { 'server/a.ts': '// fetch from whatsonchain.com only behind a gate' })).toEqual([])
  })
})

describe('G-14 no confirmation waits', () => {
  it.each([
    "<p>Waiting for confirmation…</p>",
    "setMessage('Wait for a confirmation before closing')",
    '<span>Awaiting confirmation</span>',
    'const t = `Waiting for ${n} block confirmations`',
    'if (info.confirmations >= 6) done()',
    'while (tx.confirmations < 1) await sleep(60000)',
  ])('flags %s', text => {
    expect(runOn(g14, text)).toHaveLength(1)
  })

  it.each([
    '// never show "waiting for confirmation"',
    "const label = tx.confirmations > 0 ? 'In a block' : 'Accepted'",
    "setMessage('Payment received')",
    "<p>Waiting for wallet confirmation…</p>",
  ])('does not flag %s', text => {
    expect(runOn(g14, text)).toEqual([])
  })

  it('checks UI strings only in client files', () => {
    expect(runOn(g14, { 'server/log.ts': "log('waiting for confirmation of block template')" })).toEqual([])
  })
})

describe('G-15 timeouts on Arcade and WhatsOnChain calls', () => {
  it.each([
    "await fetch(ARCADE_URL + '/tx/' + txid)",
    "await fetch(`${process.env.ARCADE_URL}/tx`, {\n  method: 'POST',\n  body: hex,\n})",
    "const woc = 'https://api.whatsonchain.com/v1/bsv/test'\nawait fetch(woc + '/chain/info')",
  ])('flags %s', text => {
    expect(runOn(g15, text)).toHaveLength(1)
  })

  it.each([
    "await fetch(ARCADE_URL + '/tx/' + txid, { signal: AbortSignal.timeout(10000) })",
    "await fetch(`${ARCADE_URL}/tx`, {\n  method: 'POST',\n  body: hex,\n  signal: AbortSignal.timeout(10000),\n})",
    "const signal = AbortSignal.timeout(5000)\nawait fetch(ARCADE_URL + '/policy', init)\nconst init = { signal }",
    "await fetch('https://example.com/api')",
    "// fetch(ARCADE_URL + '/tx')",
    // Prettier output of the kit's recommended POST: `signal` lands on line 8 (ruling R23)
    "const res = await fetch(`${ARCADE_URL}/tx`, {\n  method: 'POST',\n  headers: {\n    'Content-Type': 'text/plain',\n    'X-CallbackToken': token,\n  },\n  body: efHex,\n  signal: AbortSignal.timeout(10000),\n})",
  ])('does not flag %s', text => {
    expect(runOn(g15, text)).toEqual([])
  })
})

describe('G-16 Arcade rawTx is Extended Format', () => {
  it.each([
    'const tx = Transaction.fromHex(status.rawTx)',
    'const tx = Transaction.fromHex(rawTxHex)',
    "for (const id of parents) {\n  const r = await fetch(`${WOC}/tx/${id}/hex`)\n}",
    "await Promise.all(ids.map(id => fetch(INDEXER + '/tx/' + id + '/hex')))",
  ])('flags %s', text => {
    expect(runOn(g16, text)).toHaveLength(1)
  })

  it.each([
    'const tx = Transaction.fromHexEF(status.rawTx)',
    'const tx = Transaction.fromHex(Transaction.fromHexEF(x.rawTx).toHex())',
    'const tx = Transaction.fromHex(hex)',
    "const r = await fetch(`${WOC}/tx/${id}/hex`)",
    '// Transaction.fromHex(status.rawTx) is wrong',
  ])('does not flag %s', text => {
    expect(runOn(g16, text)).toEqual([])
  })
})

describe('G-21 BRC-29 payouts with remittance', () => {
  it.each([
    "await wallet.internalizeAction({ tx, outputs: [{ outputIndex: 0, protocol: 'wallet payment' }], description: 'x' })",
    "const outputs = [{ outputIndex: 0, protocol: 'wallet payment' }]\nawait wallet.internalizeAction({ tx, outputs, description: 'x' })",
  ])('flags %s', text => {
    expect(runOn(g21, text)).toHaveLength(1)
  })

  it('flags wallet payment and basket insertion on one output even with a remittance', () => {
    const text = "const o = { outputIndex: 0, protocol: 'wallet payment', paymentRemittance: r, basketInsertion: { basket: 'x' } }"
    expect(runOn(g21, text)).toHaveLength(1)
  })

  it.each([
    "await wallet.internalizeAction({\n  tx,\n  outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix } }],\n  description: 'Receive',\n})",
    "await wallet.internalizeAction({ tx, outputs: [{ outputIndex: 1, protocol: 'basket insertion', insertionRemittance: { basket: 'tokens' } }], description: 'x' })",
    "const outputs = [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: r }]\nawait wallet.internalizeAction({ tx, outputs, description: 'x' })",
    "// call internalizeAction( with paymentRemittance",
    'async internalizeAction(args: InternalizeActionArgs) { return this.inner.internalizeAction(args) }',
  ])('does not flag %s', text => {
    expect(runOn(g21, text)).toEqual([])
  })
})

describe('G-25 Rúnar from upstream', () => {
  const pkg = (deps: Record<string, string>, extra: object = {}) => JSON.stringify({ name: 'x', dependencies: deps, ...extra }, null, 2)

  it.each(['0.4.6', '^0.4.0', '~0.4.6', '0.4.x'])('flags runar-* at %s from npm', v => {
    expect(runOn(g25, { 'package.json': pkg({ 'runar-lang': v }) })).toHaveLength(1)
  })

  it.each([
    pkg({ 'runar-sdk': 'file:vendor/runar/runar-sdk-1.0.0-rc.1.tgz' }),
    pkg({ 'runar-sdk': '0.4.6' }, { pnpm: { overrides: { 'runar-sdk': 'file:vendor/runar/runar-sdk-1.0.0-rc.1.tgz' } } }),
    pkg({ 'runar-sdk': 'github:icellan/runar#d207ee8' }),
  ])('does not flag a vendored or git pin', text => {
    expect(runOn(g25, { 'package.json': text })).toEqual([])
  })

  it('flags a lockfile that resolves runar-* 0.4.x from npm', () => {
    const lock = "packages:\n\n  runar-sdk@0.4.6:\n    resolution: {integrity: sha512-x}\n\n  runar-lang@file:vendor/runar/runar-lang.tgz:\n    resolution: {tarball: file:vendor/runar/runar-lang.tgz}\n"
    const findings = runOn(g25, { 'pnpm-lock.yaml': lock })
    expect(findings.map(f => f.line)).toEqual([3])
  })

  it('flags runar-sdk in browser code of a Vite project without a node:url alias', () => {
    const client = { 'src/contract.ts': "import { RunarContract } from 'runar-sdk'" }
    const plainConfig = "import { fileURLToPath } from 'node:url'\nexport default defineConfig({ plugins: [react()] })"
    const aliased = "export default defineConfig({ resolve: { alias: { 'node:url': '/src/shims/url.ts' } } })"
    expect(runOn(g25, { ...client, 'vite.config.ts': plainConfig })).toHaveLength(1)
    expect(runOn(g25, { ...client, 'vite.config.ts': aliased })).toEqual([])
    expect(runOn(g25, client)).toEqual([]) // not a Vite project
    expect(runOn(g25, { 'server/contract.ts': client['src/contract.ts'], 'vite.config.ts': plainConfig })).toEqual([])
  })
})

describe('G-31 versions against the kit pins', () => {
  const pinned = JSON.parse(readFileSync(join(CONTENT, 'versions.json'), 'utf8')).packages['@bsv/sdk'].pinned as string
  const pkg = (v: string) => `{\n  "dependencies": {\n    "@bsv/sdk": "${v}"\n  }\n}`

  it.each(['3.0.0', '~3.1.4', '2.9.0'])('warns on @bsv/sdk %s', v => {
    expect(pinned).toBe('3.2.1')
    const findings = runOn(g31, { 'package.json': pkg(v) })
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3)
  })

  it.each(['3.2.1', '3.2.0', '^3.0.0', '3.3.0', 'workspace:*', 'latest'])('does not warn on @bsv/sdk %s', v => {
    expect(runOn(g31, { 'package.json': pkg(v) })).toEqual([])
  })

  it('ignores packages the kit does not pin', () => {
    expect(runOn(g31, { 'package.json': '{ "dependencies": { "left-pad": "0.0.1" } }' })).toEqual([])
  })
})

describe('G-34 trust model', () => {
  it('warns with neither TRUST.md nor a trust-model heading, at README line 1 (line 0 with no README)', () => {
    expect(runOn(g34, { 'README.md': '# App\n\nWe trust the model.\n' })).toMatchObject([{ file: 'README.md', line: 1 }])
    expect(runOn(g34, { 'src/app.ts': 'x' })).toMatchObject([{ file: 'README.md', line: 0 }])
  })

  it('can be suppressed with an ignore comment on README line 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bsv-g34-'))
    tmpRoots.push(root)
    writeFileSync(join(root, 'README.md'), '<!-- bsv-guardrail-ignore G-34 trust model lives in the wiki -->\n# App\n')
    const report = await runGuardrails(root, { contentDir: CONTENT, rules: [g34] })
    expect(report.findings).toEqual([])
    expect(report.passed).toContain('G-34')
  })

  it.each([
    { 'README.md': '# App', 'TRUST.md': '# Trust' },
    { 'README.md': '# App\n\n## Trust model\n' },
    { 'docs/TRUST.md': '# Trust' },
    { 'README.md': '# App\n\n### Security and trust model\n' },
  ])('passes %o', files => {
    expect(runOn(g34, files)).toEqual([])
  })
})

describe('G-36 lock time units', () => {
  const CHANNEL = 'src/channel.ts'
  const meta = () => loadGuardrailMeta(CONTENT).find(m => m.id === 'G-36')!

  it('flags lockTime from Date.now() without /1000', () => {
    const findings = runOn(g36, { [CHANNEL]: 'const lockTime = Date.now() + 86400\n' })
    expect(findings).toMatchObject([{ id: 'G-36', file: CHANNEL, line: 1, severity: 'error' }])
  })

  it('accepts seconds', () => {
    expect(runOn(g36, { [CHANNEL]: 'const lockTime = Math.floor(Date.now() / 1000) + 86_400\n' })).toEqual([])
    expect(runOn(g36, { [CHANNEL]: 'const nLockTime = Math.floor(Date.now() / 1_000)\n' })).toEqual([])
    expect(runOn(g36, { [CHANNEL]: 'tx.lockTime = (new Date(at).getTime() / 1e3) | 0\n' })).toEqual([])
  })

  it('accepts a height', () => {
    expect(runOn(g36, { [CHANNEL]: 'const lockTime = tipHeight + 54\n' })).toEqual([])
  })

  it('flags a lock time built over several lines inside one bracket', () => {
    const text = 'const state = buildState({\n  lockTime:\n    Date.now() + 3600,\n})\n'
    expect(runOn(g36, { [CHANNEL]: text }).map(f => f.line)).toEqual([2])
    const ok = 'const state = buildState({\n  lockTime:\n    Math.floor(Date.now() / 1000) + 3600,\n})\n'
    expect(runOn(g36, { [CHANNEL]: ok })).toEqual([])
  })

  it.each([
    'if (state.lockTime <= mtp && Date.now() - lastTry > RETRY_MS) post(state)',
    'const due = tx.lockTime > 0 && Date.now() > nextAttemptAt',
    'if (lockTime * 1000 < Date.now()) post(state)',
    'const waitMs = lockTime * 1000 - Date.now()',
    'const lockTime = useHeight\n  ? tipHeight + 6\n  : Math.floor(Date.now() / 1000) + 3600',
    'const lockTime = Math.floor((Date.now() + delayMs) / 1000)',
    'lockTime = toSeconds(Date.now())',
    'const lockTime = secondsFrom(Date.now()) + 3600',
    'const state = { lockTime: Math.floor(toSec(Date.now() + delayMs)) }',
    'const lockTime = unixSeconds(new Date(at).getTime())',
    'const lockTime = BigInt(Date.now()) / 1000n',
    'const lockTime = (BigInt(Date.now()) + delay) / 1_000n + 3600n',
  ])('accepts watcher and converted code: %s', text => {
    expect(runOn(g36, { [CHANNEL]: text })).toEqual([])
  })

  it.each([
    'const state = { lockTime: Date.now() * 1000 }',
    'lockTime = Date.now() + timeoutMs / 1000',
    'const state = { lockTime: Date.now() / 1000 + 3600 }',
    'const lockTime = useHeight\n  ? tipHeight + 6\n  : Date.now() + 3600',
    'if (lockTime < Date.now()) post(state)',
    'const lockTime = toMillis(Date.now())',
    'const lockTime = BigInt(Date.now())',
  ])('flags %s', text => {
    expect(runOn(g36, { [CHANNEL]: text })).toHaveLength(1)
  })

  it('flags the fourth argument of new Transaction', () => {
    expect(runOn(g36, { [CHANNEL]: 'const tx = new Transaction(1, [], [], Date.now())\n' })).toHaveLength(1)
    expect(runOn(g36, { [CHANNEL]: 'const tx = new Transaction(1, [], [], Math.floor(Date.now() / 1000))\n' })).toEqual([])
  })

  it('ignores test files and comments', () => {
    expect(runOn(g36, { 'src/channel.test.ts': 'const lockTime = Date.now()\n' })).toEqual([])
    expect(runOn(g36, { [CHANNEL]: '// never set lockTime = Date.now()\nconst lockTime = 0\n' })).toEqual([])
  })

  it('not applicable without a lock time', () => {
    const files = [pf('src/app.ts', 'export const x = Date.now()')]
    expect(g36.run({ files, shape: 'A', root: '/x', meta: meta(), contentDir: CONTENT }).applicable).toBe(false)
  })

  it('clean-a lands G-36 in notApplicable', async () => {
    const report = await lint('clean-a')
    expect(report.notApplicable).toContain('G-36')
    expect(report.passed).not.toContain('G-36')
  })

  it('broken-a has no G-36 finding', async () => {
    expect((await lint('broken-a')).findings.filter(f => f.id === 'G-36')).toEqual([])
  })
})
