import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Beef, Hash, LockingScript, MerklePath, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils, type WalletInterface } from '@bsv/sdk'
import { payeeLockingScript } from '../web/brc29'
import { afterAll, describe, expect, it } from 'vitest'
import { Arcade } from '../server/arcade.js'
import {
  checkFunding,
  collectSavedTip,
  readSavedTip,
  returnCoinsAndClean,
  savedTipStore,
  SWEEP_LABEL,
  lockRunDir,
  unlockRunDir,
  type GateCoinWallet,
  type Row,
} from '../scripts/gate-coins'
import { addProvenTx, tscToMerklePath, WhatsOnChain } from '../scripts/gate-woc'
import { derive, keyFilePath, loadOrCreateRootKey, openGateWallet } from '../scripts/gate-wallet'

// No test here touches ~/.bsv-gate, the network or a wallet with funds. CLI runs get only PATH, a temp HOME and the
// variables a test passes (always a temp BSV_GATE_KEY_FILE); in-process calls pass a temp BSV_GATE_KEY_FILE, and a
// temp HOME where $HOME matters. Keys are fresh random keys; Arcade and WhatsOnChain are fakes behind injected fetch.

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

// Each CLI run starts tsx afresh (about a second); a test runs several.
describe('gate keys', { timeout: 30_000 }, () => {
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

  it('refuses a key under a group- or world-writable directory between it and $HOME', () => {
    const home = tempDir()
    mkdirSync(join(home, 'shared', 'private'), { recursive: true })
    chmodSync(join(home, 'shared'), 0o775)
    chmodSync(join(home, 'shared', 'private'), 0o700)
    const key = join(home, 'shared', 'private', 'gate.key')
    expect(() => loadOrCreateRootKey({ create: true, env: { HOME: home, BSV_GATE_KEY_FILE: key } })).toThrow(/shared is writable by group or others/)
    expect(existsSync(key)).toBe(false)
    // Through a symlink, the real directory's mode is what counts.
    symlinkSync(join(home, 'shared'), join(home, 'alias'))
    expect(() => loadOrCreateRootKey({ create: true, env: { HOME: home, BSV_GATE_KEY_FILE: join(home, 'alias', 'private', 'gate.key') } })).toThrow(/writable by group or others/)
    chmodSync(join(home, 'shared'), 0o700)
    expect(loadOrCreateRootKey({ create: true, env: { HOME: home, BSV_GATE_KEY_FILE: key } }).source).toBe('created')
    chmodSync(home, 0o777) // $HOME itself counts
    expect(() => loadOrCreateRootKey({ create: false, env: { HOME: home, BSV_GATE_KEY_FILE: key } })).toThrow(/writable by group or others/)
    chmodSync(home, 0o700)
  })

  it('recover needs a run dir of this key', () => {
    const env = { BSV_TESTNET_GATE_KEY: randomKey(), BSV_GATE_KEY_FILE: join(tempDir(), 'none.key') }
    const none = gate(['recover'], env)
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('recover needs --dir')
    const notRun = gate(['recover', '--dir', tempDir()], env)
    expect(notRun.code).toBe(2)
    expect(notRun.stderr).toContain('is not a gate run dir')
    const other = tempDir()
    writeFileSync(join(other, 'run.json'), JSON.stringify({ kind: 'bsv-gate-run', fundingAddress: 'mOtherAddress' }))
    const wrong = gate(['recover', '--dir', other], env)
    expect(wrong.code).toBe(2)
    expect(wrong.stderr).toContain('wrong key?')

    // A run dir whose run is still alive is refused; once its process is gone, recover finishes it (nothing in it
    // here: both wallets open empty, no Arcade call is needed) and deletes it.
    const mine = tempDir()
    writeFileSync(join(mine, 'run.json'), JSON.stringify({ kind: 'bsv-gate-run', fundingAddress: derive(env.BSV_TESTNET_GATE_KEY).fundingAddress }))
    writeFileSync(join(mine, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: 'now' }))
    const busy = gate(['recover', '--dir', mine], env)
    expect(busy.code).toBe(2)
    expect(busy.stderr).toContain('in use by a live gate process')
    writeFileSync(join(mine, 'run.lock'), JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt: 'earlier' }))
    const done = gate(['recover', '--dir', mine], env)
    expect(done.code, done.stderr).toBe(0)
    expect(existsSync(mine)).toBe(false)
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
    for (const cmd of [['init'], ['address'], ['sweep', '--txid', 'ab'.repeat(32)], ['run'], ['recover', '--dir', tempDir()]]) {
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

describe('returning coins (offline: a fake wallet and a fake Arcade)', () => {
  const ARCADE = 'https://arcade.test'
  const funding = PrivateKey.fromRandom().toPublicKey().toAddress('testnet')
  const lock = new P2PKH().lock(funding)
  const spend = (source: Transaction | string, satoshis: number) =>
    new Transaction(
      1,
      [{ ...(typeof source === 'string' ? { sourceTXID: source } : { sourceTransaction: source }), sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff }],
      [{ lockingScript: lock, satoshis }],
      0,
    )
  // G is in a block; U (an import the toolbox left 'sending') spends it; S (the sweep-back) spends U.
  const g = spend('cd'.repeat(32), 5000)
  g.merklePath = new MerklePath(100, [[{ offset: 0, hash: g.id('hex'), txid: true }]])
  const u = spend(g, 4900)
  const sweepTx = spend(u, 4800)
  const S = sweepTx.id('hex')
  const sweepBeef = (() => {
    const b = new Beef()
    b.mergeTransaction(sweepTx)
    return b.toBinary()
  })()

  /** Arcade that has seen a txid only once it was POSTed (or from the start, when `known`). */
  function fakeArcade(opts: { known?: string[]; neverSees?: boolean; refuses?: string } = {}) {
    const seen = new Set(opts.known ?? [])
    const posts: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        const tx = Transaction.fromHexEF(String(init.body))
        posts.push(tx.id('hex'))
        if (tx.id('hex') === opts.refuses) return new Response(JSON.stringify({ status: 461, extraInfo: 'script verification failed' }), { status: 400 })
        if (!opts.neverSees) seen.add(tx.id('hex'))
        return new Response(JSON.stringify({ txid: tx.id('hex'), txStatus: 'RECEIVED' }), { status: 200 })
      }
      const txid = url.split('/tx/')[1]
      if (!seen.has(txid)) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ txid, txStatus: 'SEEN_ON_NETWORK' }), { status: 200 })
    }) as typeof fetch
    return { posts, arcade: new Arcade(ARCADE, fetchImpl) }
  }

  type Action = { txid: string; status: string; labels: string[] }
  /** A wallet holding `balance`; its sweep-back leaves a labelled S, 'sending' and throwing when `postFails`. */
  function fakeWallet(opts: { balance: number; actions?: Action[]; postFails?: boolean }) {
    const state = { balance: opts.balance, actions: [...(opts.actions ?? [])], created: [] as unknown[], closed: false }
    const w = {
      wallet: {
        balance: async () => state.balance,
        listActions: async (args: { labels: string[] }) => ({
          totalActions: state.actions.length,
          actions: state.actions.filter(a => args.labels.length === 0 || a.labels.some(l => args.labels.includes(l))),
        }),
        createAction: async (args: unknown) => {
          state.created.push(args)
          state.balance = 0 // the inputs are spent in storage either way
          state.actions.push({ txid: S, status: opts.postFails ? 'sending' : 'unproven', labels: [SWEEP_LABEL] })
          if (opts.postFails) throw new Error('WERR_REVIEW_ACTIONS: broadcast did not succeed')
          return { txid: S, tx: sweepBeef }
        },
      },
      beef: async (txid: string) => {
        if (txid !== S && txid !== u.id('hex')) throw new Error('unknown')
        return sweepBeef
      },
      close: async () => {
        state.closed = true
      },
    }
    return { state, w: w as unknown as GateCoinWallet }
  }
  const io = { out: () => {}, err: () => {} }
  const runDir = () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'run.json'), '{}')
    return dir
  }

  it('sweeps everything back in one sendMax output and deletes the run dir once Arcade sees it', async () => {
    const { arcade } = fakeArcade({ known: [S] })
    const { state, w } = fakeWallet({ balance: 4800 })
    const dir = runDir()
    const rows: Row[] = []
    expect(await returnCoinsAndClean([['tipper', w]], dir, funding, arcade, rows, io, 0)).toBeUndefined()
    expect(existsSync(dir)).toBe(false)
    expect(state.closed).toBe(true)
    expect(state.created).toEqual([
      expect.objectContaining({
        labels: [SWEEP_LABEL],
        outputs: [expect.objectContaining({ lockingScript: lock.toHex(), satoshis: 2099999999999999 })],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      }),
    ])
    expect(rows).toContainEqual(expect.objectContaining({ step: 'sweep-back tipper', txid: S, verdict: 'seen-no-competitor', bytes: sweepTx.toBinary().length }))
  })

  it('a sweep-back the toolbox could not post goes straight to Arcade (ancestors first); the dir goes only once it is seen', async () => {
    const { arcade, posts } = fakeArcade()
    const { w } = fakeWallet({ balance: 4800, postFails: true })
    const dir = runDir()
    expect(await returnCoinsAndClean([['tipper', w]], dir, funding, arcade, [], io, 0)).toBeUndefined()
    expect(posts).toEqual([u.id('hex'), S]) // G has a merkle path: not posted
    expect(existsSync(dir)).toBe(false)
  })

  it('keeps the run dir and fails when the balance reads 0 but Arcade never sees the sweep-back', async () => {
    const { arcade } = fakeArcade({ neverSees: true })
    const { w } = fakeWallet({ balance: 4800, postFails: true })
    const dir = runDir()
    const errs: string[] = []
    const left = await returnCoinsAndClean([['tipper', w]], dir, funding, arcade, [], { out: () => {}, err: l => void errs.push(l) }, 0)
    expect(left).toMatch(new RegExp(`tipper: ${S} is not seen on Arcade`))
    expect(existsSync(dir)).toBe(true)
    expect(errs.join('\n')).toContain(`pnpm gate recover --dir ${dir}`)
  })

  it('re-checks an unfinished action and an earlier sweep-back in an empty wallet (recover)', async () => {
    const { arcade, posts } = fakeArcade()
    const { w } = fakeWallet({ balance: 0, actions: [{ txid: S, status: 'sending', labels: [SWEEP_LABEL] }] })
    const dir = runDir()
    expect(await returnCoinsAndClean([['tipper', w]], dir, funding, arcade, [], io, 0)).toBeUndefined()
    expect(posts).toContain(S)
    expect(existsSync(dir)).toBe(false)
  })

  it('keeps the run dir while a tip that went out is not in the creator wallet', async () => {
    const { arcade } = fakeArcade()
    const { w } = fakeWallet({ balance: 0 })
    const dir = runDir()
    writeFileSync(join(dir, 'tip.json'), JSON.stringify({ txid: 'ab'.repeat(32), beef: '00', outputIndex: 0 }))
    expect(await returnCoinsAndClean([['creator', w]], dir, funding, arcade, [], io, 0)).toMatch(/may have gone out but is not in the creator wallet/)
    expect(existsSync(dir)).toBe(true)
  })

  it('names the ancestor Arcade refused', async () => {
    const { arcade, posts } = fakeArcade({ refuses: u.id('hex') })
    const { w } = fakeWallet({ balance: 4800, postFails: true })
    const left = await returnCoinsAndClean([['tipper', w]], runDir(), funding, arcade, [], io, 0)
    expect(left).toContain(`Arcade refused ancestor ${u.id('hex')} (REJECTED: script verification failed)`)
    expect(posts).toEqual([u.id('hex')]) // the sweep-back itself is not posted over a refused parent
  })

  it('keeps the run dir when a wallet with storage there could not be opened', async () => {
    const { arcade } = fakeArcade()
    const dir = runDir()
    writeFileSync(join(dir, 'tipper-02aabbccddeeff00.sqlite'), '')
    expect(await returnCoinsAndClean([['tipper', undefined]], dir, funding, arcade, [], io, 0)).toMatch(/tipper: its wallet in .* could not be opened/)
    expect(existsSync(dir)).toBe(true)
    // No storage, nothing to lose: the dir goes.
    const empty = runDir()
    expect(await returnCoinsAndClean([['creator', undefined]], empty, funding, arcade, [], io, 0)).toBeUndefined()
    expect(existsSync(empty)).toBe(false)
  })

  it('a write-ahead without a txid keeps the dir unless the tipper made nothing but imports and sweep-backs', async () => {
    const { arcade } = fakeArcade({ known: [S] })
    const writeAhead = { outputIndex: 0, satoshis: 1000, recipient: '02aa', senderIdentityKey: '03bb', derivationPrefix: 'cA==', derivationSuffix: 'cw==' }
    const quiet = runDir()
    writeFileSync(join(quiet, 'tip.json'), JSON.stringify(writeAhead))
    const imports = fakeWallet({ balance: 0, actions: [{ txid: 'aa'.repeat(32), status: 'completed', labels: ['p2pkh-funding'] }] })
    expect(await returnCoinsAndClean([['tipper', imports.w]], quiet, funding, arcade, [], io, 0)).toBeUndefined()
    expect(existsSync(quiet)).toBe(false)

    const busy = runDir()
    writeFileSync(join(busy, 'tip.json'), JSON.stringify(writeAhead))
    const tipped = fakeWallet({ balance: 0, actions: [{ txid: 'bb'.repeat(32), status: 'unproven', labels: [] }] })
    expect(await returnCoinsAndClean([['tipper', tipped.w]], busy, funding, arcade, [], io, 0)).toMatch(/txid not recorded/)
    expect(existsSync(busy)).toBe(true)
  })

  it('fills in a write-ahead without a txid from the tipper wallet, then collects it', async () => {
    const tipperKey = PrivateKey.fromRandom()
    const creatorKey = PrivateKey.fromRandom().toPublicKey().toString()
    const proto = new ProtoWallet(tipperKey)
    const derivation = { derivationPrefix: 'cA==', derivationSuffix: 'cw==' }
    const script = await payeeLockingScript(proto as unknown as WalletInterface, creatorKey, derivation.derivationPrefix, derivation.derivationSuffix)
    const tip = new Transaction(
      1,
      [{ sourceTransaction: g, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff }],
      [
        { lockingScript: lock, satoshis: 3000 },
        { lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress('testnet')), satoshis: 1000 },
        { lockingScript: LockingScript.fromHex(script), satoshis: 1000 },
      ],
      0,
    )
    const T = tip.id('hex')
    const tipBeef = new Beef()
    tipBeef.mergeTransaction(tip)
    const tipper = {
      wallet: {
        getPublicKey: (args: Parameters<ProtoWallet['getPublicKey']>[0]) => proto.getPublicKey(args),
        listActions: async () => ({ totalActions: 2, actions: [{ txid: 'aa'.repeat(32), status: 'completed', labels: ['p2pkh-funding'] }, { txid: T, status: 'unproven', labels: [] }] }),
      },
      beef: async (txid: string) => {
        if (txid !== T) throw new Error('unknown')
        return tipBeef.toBinary()
      },
    } as unknown as GateCoinWallet
    const dir = tempDir()
    writeFileSync(join(dir, 'tip.json'), JSON.stringify({ outputIndex: 0, satoshis: 1000, recipient: creatorKey, senderIdentityKey: tipperKey.toPublicKey().toString(), ...derivation }))
    const internalized: Array<{ tx: number[]; outputs: Array<{ outputIndex: number }> }> = []
    const creator = {
      wallet: {
        listActions: async () => ({ totalActions: 0, actions: [] }),
        internalizeAction: async (args: { tx: number[]; outputs: Array<{ outputIndex: number }> }) => {
          internalized.push(args)
          return { accepted: true }
        },
      },
    } as unknown as Parameters<typeof collectSavedTip>[0]
    await collectSavedTip(creator, dir, [], tipper)
    expect(readSavedTip(dir)).toMatchObject({ txid: T, outputIndex: 2, collected: true })
    expect(internalized).toHaveLength(1)
    expect(internalized[0].outputs[0].outputIndex).toBe(2) // the output paying the saved derivation, not the 1000-sat decoy
    expect(Transaction.fromAtomicBEEF(internalized[0].tx).id('hex')).toBe(T)
  })

  it('locks a run dir: a live holder refuses, a dead one is taken over', () => {
    const dir = runDir()
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: process.ppid, startedAt: 'earlier' }))
    expect(() => lockRunDir(dir)).toThrow(new RegExp(`in use by a live gate process \\(pid ${process.ppid}`))
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: dead, startedAt: 'earlier' }))
    lockRunDir(dir)
    expect(JSON.parse(readFileSync(join(dir, 'run.lock'), 'utf8')).pid).toBe(process.pid)
    unlockRunDir(dir)
    expect(existsSync(join(dir, 'run.lock'))).toBe(false)
  })

  it('saves the tip before the broadcast, keeps it after the relay has it, and collects it straight into the creator wallet', async () => {
    const dir = tempDir()
    const store = savedTipStore(dir)
    const base = { key: 'tip:pending:1', createdAt: '', network: 'testnet', recipient: '02aa', senderIdentityKey: '03bb', satoshis: 1000, outputIndex: 0, derivationPrefix: 'cA==', derivationSuffix: 'cw==' }
    store.setItem(base.key, JSON.stringify(base)) // the write-ahead, before createAction
    expect(readSavedTip(dir)).toMatchObject({ derivationPrefix: 'cA==', derivationSuffix: 'cw==', senderIdentityKey: '03bb' })
    expect(readSavedTip(dir)?.txid).toBeUndefined()
    store.setItem(base.key, JSON.stringify({ ...base, txid: S, beef: Utils.toHex(sweepBeef) }))
    store.removeItem(base.key) // sendTip, once the relay has it
    expect(readSavedTip(dir)).toMatchObject({ txid: S, beef: Utils.toHex(sweepBeef), outputIndex: 0, satoshis: 1000 })
    expect(statSync(join(dir, 'tip.json')).mode & 0o777).toBe(0o600)

    const internalized: unknown[] = []
    const creator = {
      wallet: {
        listActions: async () => ({ totalActions: 0, actions: [] }),
        internalizeAction: async (args: unknown) => {
          internalized.push(args)
          return { accepted: true }
        },
      },
    } as unknown as Parameters<typeof collectSavedTip>[0]
    const rows: Row[] = []
    await collectSavedTip(creator, dir, rows)
    expect(internalized).toEqual([
      {
        tx: sweepBeef,
        outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { senderIdentityKey: '03bb', derivationPrefix: 'cA==', derivationSuffix: 'cw==' } }],
        description: 'Tip received',
      },
    ])
    expect(readSavedTip(dir)?.collected).toBe(true)
    expect(rows).toContainEqual(expect.objectContaining({ txid: S, verdict: 'accepted' }))
    await collectSavedTip(creator, dir, rows) // collected: nothing more
    expect(internalized).toHaveLength(1)
  })
})

// Needs BSV_MCP_NETWORK_TESTS=1, a gate key (BSV_TESTNET_GATE_KEY or the key file) whose funding address holds at
// least the tip plus fees, and testnet Arcade.
describe('gate run on testnet', () => {
  it.skipIf(process.env.BSV_MCP_NETWORK_TESTS !== '1')(
    'run completes one tip at 0-conf on testnet',
    () => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', GATE, 'run'], { cwd: SAMPLE, env: process.env, encoding: 'utf8', timeout: 1_500_000 })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/^\| .*\| seen-no-competitor \|/m)
      expect(r.stdout).toMatch(/^\| .*\| accepted \|/m)
      expect(r.stdout).toMatch(/^\| sweep-back tipper \| [0-9a-f]{64} \|/m)
      expect(r.stdout).toMatch(/^probeTxid: [0-9a-f]{64}$/m)
    },
    1_600_000, // listing, imports, the tip, collection and two sweep-backs, each with up to two 20 s Arcade waits
  )
})
