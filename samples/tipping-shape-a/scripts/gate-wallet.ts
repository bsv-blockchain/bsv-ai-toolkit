import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'

// The gate's keys and headless wallets. The root key lives only in BSV_TESTNET_GATE_KEY (CI) or in a key file
// outside the repo (mode 0600); nothing here prints, logs or puts the key in an error message. The gate prints
// public things only: the funding address and the two identity keys.

type Env = Record<string, string | undefined>

export type GateNetwork = 'testnet'

export interface RootKey {
  rootKeyHex: string
  source: 'env' | 'file' | 'created'
}

/** The public values the gate derives from its root key: safe to print. */
export interface Derived {
  /** Testnet P2PKH address of the root key: the gate's coins live here between runs (the faucet pays it). */
  fundingAddress: string
  tipperIdentityKey: string
  /** The identity key of the creator wallet, whose root is derived from the gate's root key (creatorRootKey). */
  creatorIdentityKey: string
}

export interface GateWallet {
  /** A wallet-toolbox Wallet: a BRC-100 WalletInterface (plus balance()). */
  wallet: Wallet
  identityKey: string
  /** The BEEF (binary) the wallet's storage holds for one of its transactions, with its unproven ancestors. */
  beef(txid: string): Promise<number[]>
  close(): Promise<void>
}

/** A problem the operator must fix (no key, unsafe key file, wrong network): exit code 2. */
export class GateUsageError extends Error {
  readonly exitCode = 2
}

const ENV_KEY = 'BSV_TESTNET_GATE_KEY'

/** BSV_GATE_KEY_FILE, else ~/.bsv-gate/tipping-shape-a.key (outside any repo). */
export function keyFilePath(env: Env = process.env): string {
  const set = env.BSV_GATE_KEY_FILE?.trim()
  return set ? set : join(homeOf(env), '.bsv-gate', 'tipping-shape-a.key')
}

/** $HOME (as `env` gives it), else the OS's idea of it. */
export const homeOf = (env: Env = process.env) => env.HOME?.trim() || homedir()

/** 64 hex characters that are a valid secp256k1 scalar (1 ≤ k < n). Never echoes the value. */
function parseRootKey(raw: string, where: string): string {
  const hex = raw.trim().toLowerCase()
  const invalid = () => new GateUsageError(`${where} is not a valid key: expected 64 hex characters, a secp256k1 private key`)
  if (!/^[0-9a-f]{64}$/.test(hex)) throw invalid()
  let key: PrivateKey
  try {
    key = new PrivateKey(hex, 'hex', 'be', 'error') // throws on k ≥ n
  } catch {
    throw invalid()
  }
  if (key.isZero()) throw invalid()
  return hex
}

const POSIX = process.platform !== 'win32'

/** True when `path` sits inside a git work tree (a .git directory or file in it or any parent). */
function insideGitWorkTree(path: string): boolean {
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    if (exists(join(dir, '.git'))) return true
    if (dirname(dir) === dir) return false
  }
}

/**
 * Where a key file may live: never inside a git work tree (one `git add -A` from publishing it), and never under a
 * directory that group or others can write (they could swap the file or a directory above it). Modes are read on
 * real paths (symlinks resolved): the key's directory (or, before it exists, its nearest existing ancestor) and,
 * when that is inside $HOME, every directory up to and including $HOME.
 */
function checkKeyLocation(path: string, home: string): void {
  if (insideGitWorkTree(path)) {
    throw new GateUsageError(`key file ${path} is inside a git work tree; keep it outside every repo (set BSV_GATE_KEY_FILE)`)
  }
  if (!POSIX) return
  let dir = dirname(resolve(path))
  while (!exists(dir) && dirname(dir) !== dir) dir = dirname(dir)
  const real = realpathSync(dir)
  const realHome = exists(home) ? realpathSync(home) : resolve(home)
  const underHome = real === realHome || real.startsWith(realHome + sep)
  for (let d = real; ; d = dirname(d)) {
    if ((statSync(d).mode & 0o022) !== 0) throw new GateUsageError(`${d} is writable by group or others; run: chmod go-w ${d}`)
    if (!underHome || d === realHome || dirname(d) === d) return
  }
}

/**
 * Reads a key file that only its owner can read. Refuses symlinks (O_NOFOLLOW), non-files, files owned by another
 * user and group/world-readable modes, checked on the open descriptor so the file cannot be swapped between the
 * check and the read.
 */
function readKeyFile(path: string, home: string): string {
  checkKeyLocation(path, home)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (e) {
    throw new GateUsageError(`key file ${path} could not be opened (${(e as NodeJS.ErrnoException).code ?? 'error'}); it must be a regular file, not a symlink`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new GateUsageError(`key file ${path} is not a regular file`)
    if (POSIX && typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new GateUsageError(`key file ${path} belongs to another user`)
    }
    if (POSIX && (st.mode & 0o077) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(4, '0')
      throw new GateUsageError(`key file ${path} is readable by group or others (mode ${mode}); run: chmod 600 ${path}`)
    }
    return parseRootKey(readFileSync(fd, 'utf8'), `key file ${path}`)
  } finally {
    closeSync(fd)
  }
}

/**
 * Writes a new key file atomically, never over an existing one: the key goes to a temp file created 0600 in the
 * same directory (made 0700), is synced, then hard-linked into place (link fails if the path exists) and the temp
 * name removed. Returns false when another file got there first.
 */
function writeKeyFileExclusive(path: string, hex: string, home: string): boolean {
  checkKeyLocation(path, home)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Ends in .key, so the repo's *.key ignore rule covers it too.
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp.key`)
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    try {
      writeSync(fd, `${hex}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(tmp, path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw e
    }
    return true
  } finally {
    unlinkSync(tmp)
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

/**
 * The gate's root key: BSV_TESTNET_GATE_KEY wins; else the key file; else, only when `create`, a new random key
 * written to the key file (0600, never overwriting). Without a key and without `create`: GateUsageError.
 */
export function loadOrCreateRootKey(opts: { create: boolean; env?: Env }): RootKey {
  const env = opts.env ?? process.env
  const fromEnv = env[ENV_KEY]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { rootKeyHex: parseRootKey(fromEnv, ENV_KEY), source: 'env' }
  const path = keyFilePath(env)
  if (exists(path)) return { rootKeyHex: readKeyFile(path, homeOf(env)), source: 'file' }
  if (!opts.create) {
    throw new GateUsageError(`no gate key: set ${ENV_KEY} or create the key file ${path} with \`pnpm gate init\``)
  }
  const hex = parseRootKey(PrivateKey.fromRandom().toHex(), 'the new key') // toHex pads to 32 bytes
  // Lost a race with another init: use the key that won.
  if (!writeKeyFileExclusive(path, hex, homeOf(env))) return { rootKeyHex: readKeyFile(path, homeOf(env)), source: 'file' }
  return { rootKeyHex: hex, source: 'created' }
}

/**
 * The creator wallet's root key: sha256(root key bytes || utf8 'creator'), so one secret covers both gate wallets
 * deterministically (G-24). Private: it never leaves this module.
 */
function creatorRootKey(rootKeyHex: string): string {
  const root = parseRootKey(rootKeyHex, 'the root key')
  return parseRootKey(Utils.toHex(Hash.sha256([...Utils.toArray(root, 'hex'), ...Utils.toArray('creator', 'utf8')])), 'the derived creator key')
}

/** The public values derived from the root key (safe to print). Deterministic. */
export function derive(rootKeyHex: string): Derived {
  const root = PrivateKey.fromHex(parseRootKey(rootKeyHex, 'the root key'))
  // Setup.getKeyPair(rootKeyHex).address is the mainnet form; the faucet needs the testnet address of the same key.
  return {
    fundingAddress: root.toPublicKey().toAddress('testnet'),
    tipperIdentityKey: root.toPublicKey().toString(),
    creatorIdentityKey: PrivateKey.fromHex(creatorRootKey(rootKeyHex)).toPublicKey().toString(),
  }
}

/**
 * A headless @bsv/wallet-toolbox wallet with SQLite storage under `dataDir` (one file per wallet and identity;
 * the gate uses a fresh temp dir per command).
 * Built the way Setup.createWallet + Setup.createWalletSQLite build one (wallet-toolbox 2.14.9,
 * out/src/Setup.js), with these divergences, each marked below:
 * - Services: Arcade (`arcadeUrl`) is the only broadcaster: the ARC URLs are blanked (C4) and the Bitails and
 *   WhatsOnChain post fallbacks removed after construction (C20). Reads keep the toolbox's providers; the gate's
 *   pass/fail comes from the relay's Arcade verdict, not from the toolbox.
 * - No .env: the root key is passed in; SetupEnv (identity keys, devKeys, taalApiKey) is not used.
 * - No throwaway wallet: Setup.createStorageKnex builds and destroys a second wallet only to resolve options.
 * The Monitor is created as Setup creates it and, as there, never started: every gate action broadcasts at once
 * (acceptDelayedBroadcast: false), so nothing waits for the Monitor.
 */
export async function openGateWallet(
  rootKeyHex: string,
  name: 'tipper' | 'creator',
  network: GateNetwork,
  arcadeUrl: string,
  dataDir: string,
): Promise<GateWallet> {
  if (network !== 'testnet') throw new GateUsageError('gate runs on testnet only')
  // Imported here so init/address never load the toolbox. Note: the toolbox's Setup module calls dotenv.config()
  // when it loads (a .env in the working directory fills unset variables); the gate reads its settings before this.
  const { Monitor, Services, Setup, StorageKnex, Wallet, WalletStorageManager, randomBytesHex } = await import('@bsv/wallet-toolbox')
  const chain = 'test'
  const rootHex = name === 'tipper' ? parseRootKey(rootKeyHex, 'the root key') : creatorRootKey(rootKeyHex)
  // The toolbox is CommonJS and loads @bsv/sdk's CommonJS build; its key objects must come from that same build
  // (the ESM build's classes are different classes), so the key deriver is made with the toolbox's copy.
  const cjsSdk = createRequire(import.meta.url)('@bsv/sdk') as typeof import('@bsv/sdk')
  const rootKey = cjsSdk.PrivateKey.fromHex(rootHex)
  const identityKey = rootKey.toPublicKey().toString()
  const keyDeriver = new cjsSdk.CachedKeyDeriver(rootKey) as unknown as ConstructorParameters<typeof Wallet>[0]['keyDeriver']
  const storage = new WalletStorageManager(identityKey)

  // Divergence (C4): Setup uses Services.createDefaultOptions(chain) with its taalApiKey; the gate sets Arcade and
  // blanks both ARC URLs so no legacy ARC endpoint is ever posted to.
  const defaults = Services.createDefaultOptions(chain)
  const services = new Services({
    ...defaults,
    arcadeUrl,
    arcadeConfig: { deploymentId: defaults.arcConfig.deploymentId },
    arcUrl: '',
    arcGorillaPoolUrl: '',
  })
  // Divergence (C20): the toolbox still adds Bitails and WhatsOnChain as broadcast fallbacks (they cannot be
  // configured away), so the post collection is cut down to Arcade alone: a post Arcade refuses fails the action
  // instead of going out elsewhere. Reads (rawTx, merkle path, status, UTXO checks) keep the toolbox's providers.
  for (const { name: provider } of [...services.postBeefServices.services]) {
    if (provider !== 'ArcadeBeef') services.postBeefServices.remove(provider)
  }
  if (services.postBeefServices.count !== 1) throw new Error('the gate wallet must broadcast through Arcade alone')
  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(chain, storage, services))
  const wallet = new Wallet({ chain, keyDeriver, storage, services, monitor })

  // As Setup.createWalletSQLite → createWalletKnex → createStorageKnex, minus the throwaway wallet (divergence).
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const databaseName = `${name}-${identityKey.slice(0, 16)}`
  const knex = Setup.createSQLiteKnex(join(dataDir, `${databaseName}.sqlite`))
  const active = new StorageKnex({
    chain,
    knex,
    commissionSatoshis: 0,
    commissionPubKeyHex: undefined,
    feeModel: { model: 'sat/kb', value: 100 },
  })
  await active.migrate(databaseName, randomBytesHex(33))
  await active.makeAvailable()
  await storage.addWalletStorageProvider(active)

  return {
    wallet,
    identityKey,
    beef: async txid => (await active.getBeefForTransaction(txid, {})).toBinary(),
    close: async () => {
      await wallet.destroy() // destroys the storage providers, which closes knex
    },
  }
}
