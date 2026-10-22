import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Beef, Hash, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { Arcade } from '../server/arcade.js'
import { checkFunding } from '../scripts/gate'
import { addProvenTx, tscToMerklePath, WhatsOnChain } from '../scripts/gate-woc'
import { derive, keyFilePath, loadOrCreateRootKey, openGateWallet } from '../scripts/gate-wallet'

// No test here touches ~/.bsv-gate: every run gets a temp HOME and a temp BSV_GATE_KEY_FILE. Keys are fresh random
// keys that never hold funds.

const SAMPLE = fileURLToPath(new URL('..', import.meta.url))
const GATE = join(SAMPLE, 'scripts', 'gate.ts')
const OUTPUT = /^funding address: [1mn][1-9A-HJ-NP-Za-km-z]{25,34}\ntipper identity: [0-9a-f]{66}\ncreator identity: [0-9a-f]{66}\n$/

const temps: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'))
  temps.push(dir)
  return dir
}
afterAll(() => temps.forEach(d => rmSync(d, { recursive: true, force: true })))

const randomKey = () => PrivateKey.fromRandom().toHex()

/** Runs the gate CLI with only the given variables (plus PATH and a temp HOME): nothing leaks in from this shell. */
function gate(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', GATE, ...args], {
    cwd: SAMPLE,
    env: { PATH: process.env.PATH ?? '', HOME: tempDir(), ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('gate keys', () => {
  it('init writes the key file with mode 0600 and prints only an address and identities', () => {
    const dir = join(tempDir(), 'gate')
    const file = join(dir, 'tipping-shape-a.key')
    const first = gate(['init'], { BSV_GATE_KEY_FILE: file })
    expect(first.code).toBe(0)
    expect(first.stdout).toMatch(OUTPUT)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const key = readFileSync(file, 'utf8').trim()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(first.stdout).not.toContain(key)
    expect(first.stderr).not.toContain(key)
    // Only the key file is left behind (the temp file used for the atomic write is gone).
    expect(readdirSync(dir)).toEqual(['tipping-shape-a.key'])

    // A second init keeps the key: same output, file unchanged.
    const again = gate(['init'], { BSV_GATE_KEY_FILE: file })
    expect(again.code).toBe(0)
    expect(again.stdout).toBe(first.stdout)
    expect(readFileSync(file, 'utf8').trim()).toBe(key)
    // address reads the same key and never creates one.
    expect(gate(['address'], { BSV_GATE_KEY_FILE: file }).stdout).toBe(first.stdout)
    const missing = join(tempDir(), 'none.key')
    const none = gate(['address'], { BSV_GATE_KEY_FILE: missing })
    expect(none.code).toBe(2)
    expect(existsSync(missing)).toBe(false)
  })

  it('env key wins over the file', () => {
    const file = join(tempDir(), 'gate.key')
    const fileKey = randomKey()
    writeFileSync(file, `${fileKey}\n`, { mode: 0o600 })
    const envKey = randomKey()
    const env = { BSV_TESTNET_GATE_KEY: envKey, BSV_GATE_KEY_FILE: file }
    expect(loadOrCreateRootKey({ create: false, env })).toEqual({ rootKeyHex: envKey, source: 'env' })
    expect(loadOrCreateRootKey({ create: false, env: { BSV_GATE_KEY_FILE: file } })).toEqual({ rootKeyHex: fileKey, source: 'file' })
    expect(keyFilePath({ BSV_GATE_KEY_FILE: file })).toBe(file)

    const out = gate(['address'], env)
    expect(out.code).toBe(0)
    expect(out.stdout).toMatch(OUTPUT)
    expect(out.stdout).toContain(`tipper identity: ${derive(envKey).tipperIdentityKey}\n`)
    expect(out.stdout + out.stderr).not.toContain(envKey)
    expect(out.stdout + out.stderr).not.toContain(fileKey)
  })

  it('refuses a key file readable by group or others, a bad key, and never echoes the key', () => {
    const file = join(tempDir(), 'gate.key')
    const key = randomKey()
    writeFileSync(file, `${key}\n`, { mode: 0o600 })
    chmodSync(file, 0o644)
    expect(() => loadOrCreateRootKey({ create: true, env: { BSV_GATE_KEY_FILE: file } })).toThrow(/readable by group or others.*chmod 600/)
    const cli = gate(['address'], { BSV_GATE_KEY_FILE: file })
    expect(cli.code).toBe(2)
    expect(cli.stdout + cli.stderr).not.toContain(key)
    expect(readFileSync(file, 'utf8').trim()).toBe(key) // never overwritten

    // A symlink is refused even when its target is a private key file.
    chmodSync(file, 0o600)
    const link = join(tempDir(), 'link.key')
    symlinkSync(file, link)
    expect(() => loadOrCreateRootKey({ create: true, env: { BSV_GATE_KEY_FILE: link } })).toThrow(/not a symlink/)

    const n = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141' // the group order: not a valid scalar
    for (const bad of ['zz', key.slice(2), '0'.repeat(64), n, `${key}00`]) {
      let message = ''
      try {
        loadOrCreateRootKey({ create: false, env: { BSV_TESTNET_GATE_KEY: bad } })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(/BSV_TESTNET_GATE_KEY is not a valid key/)
      expect(message).not.toContain(bad)
    }
  })

  it('refuses a key path inside a git work tree and a key directory others can write', () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const inRepo = join(repo, 'keys', 'gate.key')
    expect(() => loadOrCreateRootKey({ create: true, env: { BSV_GATE_KEY_FILE: inRepo } })).toThrow(/inside a git work tree/)
    expect(existsSync(inRepo)).toBe(false)
    mkdirSync(join(repo, 'keys'))
    writeFileSync(inRepo, `${randomKey()}\n`, { mode: 0o600 })
    expect(() => loadOrCreateRootKey({ create: false, env: { BSV_GATE_KEY_FILE: inRepo } })).toThrow(/inside a git work tree/)

    const open = join(tempDir(), 'shared')
    mkdirSync(open)
    chmodSync(open, 0o777)
    const created = join(open, 'gate.key')
    expect(() => loadOrCreateRootKey({ create: true, env: { BSV_GATE_KEY_FILE: created } })).toThrow(/writable by group or others/)
    expect(existsSync(created)).toBe(false)
    chmodSync(open, 0o775)
    writeFileSync(created, `${randomKey()}\n`, { mode: 0o600 })
    expect(() => loadOrCreateRootKey({ create: false, env: { BSV_GATE_KEY_FILE: created } })).toThrow(/writable by group or others/)
    chmodSync(open, 0o700)
    expect(loadOrCreateRootKey({ create: false, env: { BSV_GATE_KEY_FILE: created } }).source).toBe('file')
  })

  it('derive is deterministic', () => {
    const key = randomKey()
    const a = derive(key)
    expect(derive(key)).toEqual(a)
    expect(a.tipperIdentityKey).toBe(PrivateKey.fromHex(key).toPublicKey().toString())
    // Public values only.
    expect(Object.keys(a).sort()).toEqual(['creatorIdentityKey', 'fundingAddress', 'tipperIdentityKey'])
    // The creator's root is sha256(root key bytes || utf8 'creator'); only its identity key leaves the module.
    const creatorRoot = Utils.toHex(Hash.sha256([...Utils.toArray(key, 'hex'), ...Utils.toArray('creator', 'utf8')]))
    expect(a.creatorIdentityKey).toBe(PrivateKey.fromHex(creatorRoot).toPublicKey().toString())
    expect(JSON.stringify(a)).not.toContain(creatorRoot)
    expect(a.creatorIdentityKey).not.toBe(a.tipperIdentityKey)
    // A testnet P2PKH address of the root key: the faucet pays it, sweep spends it.
    expect(a.fundingAddress).toBe(PrivateKey.fromHex(key).toPublicKey().toAddress('testnet'))
    expect(a.fundingAddress).toMatch(/^[mn]/)
    expect(derive(randomKey())).not.toEqual(a)
  })

  it('mainnet is refused with exit 2', () => {
    for (const cmd of [['init'], ['address'], ['sweep', '--txid', 'ab'.repeat(32)], ['run']]) {
      const file = join(tempDir(), 'gate.key')
      const out = gate(cmd, { BSV_NETWORK: 'mainnet', BSV_GATE_KEY_FILE: file })
      expect(out.code).toBe(2)
      expect(out.stderr).toContain('gate runs on testnet only')
      expect(out.stdout).toBe('')
      expect(existsSync(file)).toBe(false) // refused before any key is read or made
    }
  })

  it('run refuses without a key', () => {
    const file = join(tempDir(), 'gate.key')
    const out = gate(['run'], { BSV_GATE_KEY_FILE: file })
    expect(out.code).toBe(2)
    expect(out.stderr).toContain('BSV_TESTNET_GATE_KEY')
    expect(existsSync(file)).toBe(false)
  })
})

describe('gate wallet', () => {
  it('opens a toolbox wallet under the data dir with Arcade set and the ARC fallbacks off', async () => {
    const dataDir = join(tempDir(), 'data')
    const key = randomKey()
    const arcadeUrl = 'https://arcade-testnet-us-1.bsvblockchain.tech'
    const tipper = await openGateWallet(key, 'tipper', 'testnet', arcadeUrl, dataDir)
    const creator = await openGateWallet(key, 'creator', 'testnet', arcadeUrl, dataDir)
    try {
      expect(tipper.identityKey).toBe(derive(key).tipperIdentityKey)
      expect(creator.identityKey).toBe(derive(key).creatorIdentityKey)
      expect((await tipper.wallet.getPublicKey({ identityKey: true })).publicKey).toBe(tipper.identityKey)
      expect(await tipper.wallet.getNetwork({})).toEqual({ network: 'testnet' })
      const options = (tipper.wallet as unknown as { services: { options: Record<string, unknown> } }).services.options
      expect(options.arcadeUrl).toBe(arcadeUrl)
      expect(options.arcUrl).toBe('')
      expect(options.arcGorillaPoolUrl).toBe('')
      // Broadcast through Arcade alone: no Bitails or WhatsOnChain fallback for a failed post.
      const services = (tipper.wallet as unknown as { services: { postBeefServices: { services: { name: string }[] } } }).services
      expect(services.postBeefServices.services.map(s => s.name)).toEqual(['ArcadeBeef'])
      expect(readdirSync(dataDir).filter(f => f.endsWith('.sqlite')).sort()).toEqual(
        [`creator-${creator.identityKey.slice(0, 16)}.sqlite`, `tipper-${tipper.identityKey.slice(0, 16)}.sqlite`].sort(),
      )
    } finally {
      await tipper.close()
      await creator.close()
    }
    await expect(openGateWallet(key, 'tipper', 'mainnet' as 'testnet', arcadeUrl, dataDir)).rejects.toThrow(/testnet only/)
  }, 30_000) // each wallet runs the toolbox's SQLite migrations (a few seconds); nothing here reaches the network
})

describe('TSC proof', () => {
  it('turns a WhatsOnChain TSC proof into a merkle path that computes the block root', () => {
    // A block of five transactions; the faucet tx is the last one, so level 0 duplicates it ('*').
    const leaves = Array.from({ length: 5 }, (_, i) => Utils.toHex(Hash.sha256(Utils.toArray(`tx ${i}`, 'utf8'))))
    const hashPair = (a: string, b: string) =>
      Utils.toHex(Hash.hash256([...Utils.toArray(a, 'hex').reverse(), ...Utils.toArray(b, 'hex').reverse()]).reverse())
    const levels: string[][] = [leaves]
    while (levels[levels.length - 1].length > 1) {
      const row = levels[levels.length - 1]
      const next: string[] = []
      for (let i = 0; i < row.length; i += 2) next.push(hashPair(row[i], row[i + 1] ?? row[i]))
      levels.push(next)
    }
    const root = levels[levels.length - 1][0]
    const index = 4
    const nodes = levels.slice(0, -1).map((row, h) => {
      const sibling = (index >> h) ^ 1
      return sibling < row.length ? row[sibling] : '*'
    })
    const path = tscToMerklePath({ index, txOrId: leaves[index], target: 'ab'.repeat(32), nodes }, 123)
    expect(path).toBeInstanceOf(MerklePath)
    expect(path.blockHeight).toBe(123)
    expect(path.computeRoot(leaves[index])).toBe(root)
    expect(MerklePath.fromHex(path.toHex()).computeRoot(leaves[index])).toBe(root)
    expect(() => tscToMerklePath({ index: 1, txOrId: leaves[1], target: 'ab'.repeat(32), nodes: ['zz'] }, 1)).toThrow()
  })
})

describe('funding coins (offline: Arcade and WhatsOnChain answer from fakes)', () => {
  const ARCADE = 'https://arcade.test'
  const fundingScript = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress('testnet'))
  const txOf = (inputs: { sourceTXID?: string; sourceTransaction?: Transaction }[], satoshis: number) =>
    new Transaction(
      1,
      inputs.map(i => ({ ...i, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })),
      [{ lockingScript: fundingScript, satoshis }],
      0,
    )
  // G: mined, unknown to Arcade (a faucet tx). P: spends G, known to Arcade, not in a block yet (a gate sweep-back).
  const g = txOf([{ sourceTXID: 'cd'.repeat(32) }], 5000)
  const p = txOf([{ sourceTransaction: g }], 4000)
  const blockHash = 'ef'.repeat(32)

  function fakes(routes: Record<string, { status?: number; body: unknown }>) {
    const urls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))
      if (hit === undefined) return new Response('not found', { status: 404 })
      const { status = 200, body } = hit[1]
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }) as typeof fetch
    return { urls, arcade: new Arcade(ARCADE, fetchImpl), woc: new WhatsOnChain(fetchImpl) }
  }

  it('builds a proven BEEF: Arcade first for a tx it knows, WhatsOnChain (hex and TSC proof) for one it never saw', async () => {
    const f = fakes({
      [`/tx/${p.id('hex')}`]: { body: { txid: p.id('hex'), txStatus: 'SEEN_ON_NETWORK', rawTx: p.toHexEF() } },
      [`/tx/${g.id('hex')}/hex`]: { body: g.toHex() },
      [`/tx/${g.id('hex')}/proof/tsc`]: { body: [{ index: 0, txOrId: g.id('hex'), target: blockHash, nodes: [] }] },
      [`/block/hash/${blockHash}`]: { body: { hash: blockHash, height: 1234, merkleroot: g.id('hex') } },
    })
    const beef = await addProvenTx(new Beef(), p.id('hex'), f.arcade, f.woc)
    expect(beef.findTxid(p.id('hex'))?.tx?.id('hex')).toBe(p.id('hex'))
    expect(beef.findBump(g.id('hex'))?.blockHeight).toBe(1234)
    expect(beef.isValid(false)).toBe(true)
    // P came from Arcade: WhatsOnChain was asked only for its proof, never its hex.
    expect(f.urls.some(u => u.endsWith(`/tx/${p.id('hex')}/hex`))).toBe(false)
    expect(f.urls.filter(u => u.startsWith(ARCADE))).toEqual([`${ARCADE}/tx/${p.id('hex')}`, `${ARCADE}/tx/${g.id('hex')}`])
  }, 20_000)

  it('refuses an unmined tx Arcade never saw, and hex that does not hash to the txid', async () => {
    const unmined = fakes({ [`/tx/${p.id('hex')}/hex`]: { body: p.toHex() } })
    await expect(addProvenTx(new Beef(), p.id('hex'), unmined.arcade, unmined.woc)).rejects.toThrow(/not in a block yet/)
    // No walk up a WhatsOnChain-only ancestry: G was never asked for.
    expect(unmined.urls.some(u => u.includes(g.id('hex')))).toBe(false)

    const lying = fakes({ [`/tx/${p.id('hex')}/hex`]: { body: g.toHex() } })
    await expect(addProvenTx(new Beef(), p.id('hex'), lying.arcade, lying.woc)).rejects.toThrow(/hashes to/)
  }, 20_000)

  it('lists the funding address coins from WhatsOnChain', async () => {
    const f = fakes({
      '/address/mxAddress/unspent': { body: [{ height: 0, tx_pos: 1, tx_hash: p.id('hex'), value: 4000 }, { height: 9, tx_pos: 0, tx_hash: g.id('hex'), value: 5000 }] },
    })
    expect(await f.woc.unspent('mxAddress')).toEqual([
      { txid: p.id('hex'), vout: 1, satoshis: 4000, height: 0 },
      { txid: g.id('hex'), vout: 0, satoshis: 5000, height: 9 },
    ])
  })

  it('refuses to run when the funding address holds less than the tip plus fees', () => {
    expect(() => checkFunding({ address: 'mxAddress', usable: 1200, unusable: 700, sats: 1000 })).toThrow(
      /mxAddress holds 1200 usable sats \(700 more not yet usable\); the gate needs at least 1500.*bsvfaucet\.com/,
    )
    expect(() => checkFunding({ address: 'mxAddress', usable: 1500, unusable: 0, sats: 1000 })).not.toThrow()
  })
})

// Needs a funded gate key (BSV_TESTNET_GATE_KEY or the key file, swept with `gate sweep`) and testnet Arcade.
describe('gate run on testnet', () => {
  it.skipIf(process.env.BSV_MCP_NETWORK_TESTS !== '1')(
    'run completes one tip at 0-conf on testnet',
    () => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', GATE, 'run'], { cwd: SAMPLE, env: process.env, encoding: 'utf8', timeout: 240_000 })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/^\| .*\| seen-no-competitor \|/m)
      expect(r.stdout).toMatch(/^\| .*\| accepted \|/m)
      expect(r.stdout).toMatch(/^\| sweep-back tipper \| [0-9a-f]{64} \|/m)
      expect(r.stdout).toMatch(/^probeTxid: [0-9a-f]{64}$/m)
    },
    300_000,
  )
})
