import { describe, it, expect } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGuardrailMeta, runGuardrails } from '../src/lint/engine.js'
import type { Rule } from '../src/lint/rules/index.js'
import { g02 } from '../src/lint/rules/g02.js'
import { g06 } from '../src/lint/rules/g06.js'
import { g08 } from '../src/lint/rules/g08.js'
import type { ProjectFile } from '../src/lint/walk.js'
import type { Finding, GuardrailReport, ShapeDetected } from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECTS = join(HERE, 'fixtures', 'projects')
const CONTENT = join(HERE, '..', 'content')
const WALLET_IDS = ['G-01', 'G-02', 'G-03', 'G-04', 'G-06']

const reports = new Map<string, Promise<GuardrailReport>>()
function lint(project: string): Promise<GuardrailReport> {
  if (!reports.has(project)) reports.set(project, runGuardrails(join(PROJECTS, project), { contentDir: CONTENT, shape: 'auto' }))
  return reports.get(project)!
}

/** Runs one rule on a single in-memory file. */
function runOn(rule: Rule, rel: string, text: string, shape: ShapeDetected = 'A') {
  const file: ProjectFile = { rel, abs: `/x/${rel}`, text, isClient: rel.startsWith('src/'), isTest: false }
  const meta = loadGuardrailMeta(CONTENT).find(m => m.id === rule.id)!
  return rule.run({ files: [file], shape, root: '/x', meta, contentDir: CONTENT }).findings
}

async function expectFinding(project: string, id: string, file: string, severity: string, line?: number): Promise<Finding> {
  const { findings } = await lint(project)
  const hit = findings.find(f => f.id === id && f.file === file && f.severity === severity && (line === undefined || f.line === line))
  expect(hit, `${id} in ${project}/${file}${line === undefined ? '' : `:${line}`}; got ${JSON.stringify(findings)}`).toBeDefined()
  expect(hit!.ref).toBe(`bsv://guardrails#${id}`)
  return hit!
}

describe('wallet and manifest guardrails', () => {
  it('clean-a has no findings for G-01..G-06', async () => {
    const report = await lint('clean-a')
    expect(report.shapeDetected).toBe('A')
    expect(report.findings.filter(f => WALLET_IDS.includes(f.id))).toEqual([])
    expect(report.passed).toEqual(expect.arrayContaining(WALLET_IDS))
  })

  it('broken-a: G-01 isAuthenticated gate', async () => {
    const f = await expectFinding('broken-a', 'G-01', 'src/wallet.ts', 'error', 7)
    expect(f.snippet).toContain('isAuthenticated(')
  })

  it('broken-a: G-02 mainnet default', async () => {
    const f = await expectFinding('broken-a', 'G-02', 'src/config.ts', 'error', 3)
    expect(f.snippet).toContain("'mainnet'")
  })

  it('broken-a: G-02 no getNetwork beside createAction', async () => {
    await expectFinding('broken-a', 'G-02', 'src/wallet.ts', 'error', 13)
  })

  it('broken-a: G-03 missing manifest', async () => {
    await expectFinding('broken-a', 'G-03', 'public/manifest.json', 'error', 0)
  })

  it('broken-manifest: G-03 babbage differs', async () => {
    await expectFinding('broken-manifest', 'G-03', 'public/manifest.json', 'error', 14)
  })

  it('broken-manifest: G-04 level-2 without counterparty is warn', async () => {
    // The level-2 entry appears in both the metanet and the babbage block.
    await expectFinding('broken-manifest', 'G-04', 'public/manifest.json', 'warn', 9)
    await expectFinding('broken-manifest', 'G-04', 'public/manifest.json', 'warn', 18)
    // A spending allowance above 100000 sats is flagged too.
    await expectFinding('broken-manifest', 'G-04', 'public/manifest.json', 'warn', 11)
  })

  it('broken-a: G-06 PrivateKey in client', async () => {
    await expectFinding('broken-a', 'G-06', 'src/keys.ts', 'error', 4)
  })

  it('broken-a: G-06 key in .env', async () => {
    const f = await expectFinding('broken-a', 'G-06', '.env', 'error', 2)
    expect(f.snippet).toContain('SERVER_ROOT_KEY')
    expect(f.snippet).not.toMatch(/0{32}/)
  })

  it('clean-b: G-02 and G-06 have no findings on shape-B server code', async () => {
    const report = await lint('clean-b')
    expect(report.shapeDetected).toBe('B')
    expect(report.findings.filter(f => f.id === 'G-02' || f.id === 'G-06')).toEqual([])
    expect(report.passed).toEqual(expect.arrayContaining(['G-02', 'G-06']))
  })
})

describe('G-02 mainnet-default detection', () => {
  it.each([
    "const network = process.env.BSV_NETWORK ?? 'mainnet'",
    "const chain = env.CHAIN || 'main';",
    "const network: Network = 'mainnet'",
    "let defaultNetwork = 'mainnet' // fallback",
    "  network: process.env.BSV_NETWORK ?? 'mainnet',",
    "function connect(network = 'main') {",
    "const { network = 'mainnet' } = opts",
    "const BSV_NETWORK = 'mainnet'",
  ])('flags %s', line => {
    expect(runOn(g02, 'src/config.ts', line)).toHaveLength(1)
  })

  it.each([
    "  mainnet: { network: 'mainnet', arcadeUrl: 'https://arcade-us-1.bsvblockchain.tech' },",
    "case 'mainnet': return { chain: 'main' }",
    "setup({ chain: 'main', rootKeyHex })",
    "export const blockchainExplorer = 'main'",
    "export type Network = 'mainnet' | 'testnet'",
    "if (network === 'mainnet') {",
    "const { network: walletNetwork } = await wallet.getNetwork()",
    "const network = process.env.BSV_NETWORK ?? 'testnet'",
    "const chain = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'",
  ])('does not flag %s', line => {
    expect(runOn(g02, 'src/config.ts', line)).toEqual([])
  })
})

describe('G-06 .env detection', () => {
  // The secp256k1 generator point G, compressed: the public key of private key 1, a public test vector.
  const G = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  // Placeholder words, not a seed phrase: the rule only counts words.
  const PHRASE = Array(12).fill('word').join(' ')

  it.each([
    `SERVER_IDENTITY_KEY=02${G}`,
    `VITE_SERVER_PUBLIC_KEY=03${G}`,
    `SERVER_PUBKEY="02${G}"`,
    '# SERVER_ROOT_KEY=' + '0'.repeat(64),
  ])('does not flag %s', line => {
    expect(runOn(g06, '.env', line)).toEqual([])
  })

  it.each([`MNEMONIC="${PHRASE}"`, `WALLET_SEED=${PHRASE}`])('flags a 12-word phrase: %s', line => {
    const findings = runOn(g06, '.env', line)
    expect(findings).toHaveLength(1)
    expect(findings[0].snippet).not.toContain('word')
  })

  it('flags a key in a CRLF .env', () => {
    const findings = runOn(g06, '.env', `# test fixture, not a real key\r\nSERVER_ROOT_KEY=${'0'.repeat(64)}\r\n`)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(2)
    expect(findings[0].snippet).toBe('SERVER_ROOT_KEY=<redacted>')
  })

  it('skips the client-code check only for a pure shape-B project', () => {
    const line = 'const key = PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY)'
    expect(runOn(g06, 'src/index.ts', line, 'B')).toEqual([])
    expect(runOn(g06, 'src/index.ts', line, 'A+B')).toHaveLength(1)
  })
})

describe('G-08 digests signed from the wire', () => {
  const run = (text: string) => runOn(g08, 'src/channel.ts', text)
  const applicable = (text: string) => {
    const file: ProjectFile = { rel: 'src/channel.ts', abs: '/x/src/channel.ts', text, isClient: true, isTest: false }
    const meta = loadGuardrailMeta(CONTENT).find(m => m.id === 'G-08')!
    return g08.run({ files: [file], shape: 'A', root: '/x', meta, contentDir: CONTENT }).applicable
  }

  it('flags hashToDirectlySign from a message', () => {
    const findings = run('await wallet.createSignature({ hashToDirectlySign: msg.digest, protocolID })\n')
    expect(findings).toMatchObject([{ id: 'G-08', file: 'src/channel.ts', line: 1, severity: 'warn' }])
  })

  it.each([
    'createSignature({ hashToDirectlySign: req.body.hash, protocolID, keyID })',
    'createSignature({ hashToDirectlySign: JSON.parse(text).digest })',
    'createSignature({ hashToDirectlySign: (await res.json()).digest })',
    'createSignature({ hashToDirectlySign: Utils.toArray(url.searchParams.get("d"), "hex") })',
    'createSignature({ hashToDirectlySign: event.data.digest })',
    'createSignature({ hashToDirectlySign: payload.hash })',
    'createSignature({\n  protocolID,\n  hashToDirectlySign:\n    message.digest,\n})',
  ])('flags %s', text => {
    expect(run(text)).toHaveLength(1)
  })

  it('flags the digest property of a message parameter', () => {
    const text = 'socket.on("state", async ({ digest }) => {})\nasync function onState(msg) {\n  const { digest } = msg\n  await wallet.createSignature({ hashToDirectlySign: digest })\n}\n'
    expect(run(text).map(f => f.line)).toEqual([4])
  })

  it('accepts a rebuilt digest', () => {
    expect(run('const digest = channelDigest(tx)\nawait wallet.createSignature({ hashToDirectlySign: digest })\n')).toEqual([])
    expect(run('await wallet.createSignature({ hashToDirectlySign: Hash.hash256(TransactionSignature.format(params)) })\n')).toEqual([])
    expect(run('await wallet.createSignature({ data: msg.bytes, protocolID })\n')).toEqual([])
  })

  it('ignores comments', () => {
    expect(run('// never createSignature({ hashToDirectlySign: msg.digest })\nexport const x = 1\n')).toEqual([])
  })

  it.each([
    'const digest = stateDigest(channel, msg.move)\nawait wallet.createSignature({ hashToDirectlySign: digest })\n',
    'await wallet.createSignature({ hashToDirectlySign: Hash.hash256(buildPreimage(ch, msg.n)) })\n',
    'const preimage = TS.format({ sourceTXID: params.txid, sourceOutputIndex: 0 })\nawait wallet.createSignature({ hashToDirectlySign: Hash.hash256(preimage) })\n',
    'const body = buildState(ch, n)\nawait wallet.createSignature({ hashToDirectlySign: body.preimage })\n',
    'await wallet.createSignature({ hashToDirectlySign: Hash.hash256(TS.format({ sourceTXID: msg.txid })) })\n',
    'await wallet.createSignature({ hashToDirectlySign: fast ? cached : rebuild(msg.n) })\n',
    'async function sign(body) {\n  const preimage = build(body)\n  {\n    const body = buildState()\n    await wallet.createSignature({ hashToDirectlySign: body.digest })\n  }\n}\n',
  ])('accepts a digest rebuilt from wire data: %s', text => {
    expect(run(text)).toEqual([])
  })

  it.each([
    'createSignature({ hashToDirectlySign: Utils.toArray(msg.digest, "hex") })',
    'createSignature({ hashToDirectlySign: Buffer.from(req.body.hash, "hex") })',
    'const d = hexToBytes(payload.digest)\ncreateSignature({ hashToDirectlySign: d })',
    'createSignature({ hashToDirectlySign: Hash.hash256(msg.preimage) })',
    'createSignature({ hashToDirectlySign: sha256(body.preimage) })',
    'createSignature({ hashToDirectlySign: Hash.sha256(Utils.toArray(req.body.preimage, "hex")) })',
    'createSignature({ hashToDirectlySign: fast ? msg.digest : rebuild() })',
    'createSignature({ hashToDirectlySign: fast\n  ? rebuild()\n  : payload.digest })',
    'function build() {\n  const body = buildState()\n  return body\n}\nasync function onRequest(body) {\n  await wallet.createSignature({ hashToDirectlySign: body.digest })\n}',
  ])('flags a wire digest behind a decoder: %s', text => {
    expect(run(text)).toHaveLength(1)
  })

  it('not applicable without createSignature', () => {
    expect(applicable('export const digest = msg.digest\n')).toBe(false)
    expect(applicable('await wallet.createSignature({ data })\n')).toBe(true)
  })

  it('clean-a keeps zero findings', async () => {
    expect((await lint('clean-a')).findings).toEqual([])
  })
})
