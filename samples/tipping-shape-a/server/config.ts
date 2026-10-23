import express from 'express'
import { isIdentityKey } from './auth.js'

// Relay settings from the environment. This is the app's own startup network check: BSV_NETWORK is the one
// network switch (testnet unless set), anything other than testnet or mainnet refuses to start, and mainnet
// prints a banner. No variable here ever holds a key: the relay signs nothing.

export type Network = 'testnet' | 'mainnet'

export interface ServerConfig {
  network: Network
  arcadeUrl: string
  /** The wallet originator: the one origin serving the app, /manifest.json and /api. */
  publicOrigin: string
  port: number
  dataDir: string
  /**
   * The creator's 33-byte compressed identity key (hex). Unset: the first wallet to claim the creator page (with a
   * signature) becomes the creator. Required on mainnet.
   */
  creatorIdentityKey?: string
  /** Express 'trust proxy': which peers may set X-Forwarded-For (so req.ip, and the rate limit, see the client). */
  trustProxy: boolean | number | string
}

/**
 * TRUST_PROXY default: trust X-Forwarded-For only from loopback, link-local and private-network peers, which covers
 * a reverse proxy on the same host or in the same compose network. Set TRUST_PROXY to the proxy's address(es) or a
 * hop count when it sits elsewhere, or to false when nothing sits in front of the relay.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal'

export const DEFAULT_ARCADE: Record<Network, string> = {
  testnet: 'https://arcade-testnet-us-1.bsvblockchain.tech',
  mainnet: 'https://arcade-us-1.bsvblockchain.tech',
}

// Known public Arcade hosts per network, so an ARCADE_URL that belongs to the other network fails at boot.
// Mirrors content/versions.json services.arcade.hosts in the kit repo (a test keeps them in step), plus
// arcade.gorillapool.io on mainnet. ttn (the Teranode test network) is neither network: it boots with a warning.
export const KNOWN_HOSTS: Record<Network | 'ttn', string[]> = {
  mainnet: [
    'arcade-us-1.bsvblockchain.tech',
    'arcade-eu-1.bsvblockchain.tech',
    'arcade-ap-1.bsvblockchain.tech',
    'arcade-v2-us-1.bsvblockchain.tech',
    'arcade.gorillapool.io',
  ],
  testnet: ['arcade-testnet-us-1.bsvblockchain.tech', 'arcade-v2-testnet-us-1.bsvblockchain.tech'],
  ttn: ['arcade-v2-ttn-us-1.bsvblockchain.tech'],
}

// Where `pnpm dev` serves the app (Vite's default port); the deployed origin comes from PUBLIC_ORIGIN.
const DEV_ORIGIN = 'http://localhost:5173'

const MAINNET_BANNER = [
  '**************************************************',
  '*** MAINNET: real money. BSV_NETWORK=mainnet ***',
  '**************************************************',
]

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** Reads and validates the relay settings; throws on any invalid value. `log` receives the mainnet banner and warnings. */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): ServerConfig {
  const raw = nonEmpty(env.BSV_NETWORK) ?? 'testnet'
  if (raw !== 'testnet' && raw !== 'mainnet') {
    throw new Error(`BSV_NETWORK must be "testnet" or "mainnet", got "${raw}"`)
  }
  const network: Network = raw
  const arcadeUrl = nonEmpty(env.ARCADE_URL) ?? DEFAULT_ARCADE[network]
  const warning = checkArcadeHost(network, arcadeUrl)

  const cfg: ServerConfig = {
    network,
    arcadeUrl,
    publicOrigin: readOrigin(env),
    port: readPort(env.PORT),
    dataDir: nonEmpty(env.DATA_DIR) ?? './data',
    trustProxy: readTrustProxy(env.TRUST_PROXY),
  }
  const creator = nonEmpty(env.CREATOR_IDENTITY_KEY)
  if (creator !== undefined) {
    if (!isIdentityKey(creator)) {
      throw new Error('CREATOR_IDENTITY_KEY must be a 33-byte compressed public key in hex (66 characters, 02 or 03 first)')
    }
    cfg.creatorIdentityKey = creator.toLowerCase()
  } else if (network === 'mainnet') {
    // First-claim mode lets whoever reaches /creator first collect tips: never with real money.
    throw new Error('CREATOR_IDENTITY_KEY is required on mainnet (the first-claim creator mode is for testnet only)')
  }

  if (network === 'mainnet') MAINNET_BANNER.forEach(line => log(line))
  if (warning !== undefined) log(`warning: ${warning}`)
  if (creator === undefined && env.NODE_ENV === 'production') {
    log('warning: CREATOR_IDENTITY_KEY is unset: the first wallet to claim /creator becomes the creator')
  }
  return cfg
}

/**
 * The line the relay logs once it listens. It names the Arcade origin only: an ARCADE_URL may carry credentials or a
 * private path, and logs travel further than the environment.
 */
export function bootLine(cfg: ServerConfig): string {
  return `bsv-tipping-demo relay on :${cfg.port} network=${cfg.network} arcade=${new URL(cfg.arcadeUrl).origin} origin=${cfg.publicOrigin}`
}

// Throws on an unparseable URL or a host known to belong to the other network; returns a warning for a ttn host.
function checkArcadeHost(network: Network, arcadeUrl: string): string | undefined {
  let host: string
  try {
    // Lowercase and drop trailing dots so a fully-qualified 'host.' cannot dodge the lists.
    host = new URL(arcadeUrl).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    throw new Error(`invalid ARCADE_URL: ${arcadeUrl}`)
  }
  const other: Network = network === 'mainnet' ? 'testnet' : 'mainnet'
  if (KNOWN_HOSTS[other].includes(host)) {
    throw new Error(`network/host mismatch: ${host} is a known ${other} Arcade host, but BSV_NETWORK is ${network}`)
  }
  if (KNOWN_HOSTS.ttn.includes(host)) return `ttn host: neither testnet nor mainnet (${host} is the Teranode test network)`
  return undefined
}

function readOrigin(env: NodeJS.ProcessEnv): string {
  const value = nonEmpty(env.PUBLIC_ORIGIN)
  if (value === undefined) {
    if (env.NODE_ENV === 'production') throw new Error('PUBLIC_ORIGIN is required in production (e.g. https://tipping.example.com)')
    return DEV_ORIGIN
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`PUBLIC_ORIGIN must be an origin such as https://tipping.example.com, got "${value}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PUBLIC_ORIGIN must be an http(s) origin, got "${value}"`)
  }
  // In production the origin is the one people open: wallets need it secure, and a loopback origin would make
  // every signature name a host nobody else reaches (a copied development .env, or the container's own address).
  if (env.NODE_ENV === 'production') {
    if (url.protocol !== 'https:') throw new Error(`PUBLIC_ORIGIN must be https:// in production, got "${value}"`)
    if (isLoopback(url.hostname)) throw new Error(`PUBLIC_ORIGIN must be the public origin in production, not a loopback host: "${value}"`)
  }
  return url.origin
}

// localhost and *.localhost, 127.0.0.0/8 (the URL parser normalizes short forms such as 127.1), and [::1].
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]'
}

// 'true' / 'false', a hop count, or a comma-separated list of addresses, subnets or the names Express knows.
function readTrustProxy(value: string | undefined): boolean | number | string {
  const raw = nonEmpty(value?.trim()) ?? DEFAULT_TRUST_PROXY
  const parsed = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw
  try {
    express().set('trust proxy', parsed) // Express validates the addresses here
  } catch (e) {
    throw new Error(`TRUST_PROXY is not valid (${e instanceof Error ? e.message : String(e)}): "${raw}"`)
  }
  return parsed
}

function readPort(value: string | undefined): number {
  const raw = nonEmpty(value)
  if (raw === undefined) return 8080
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error(`PORT must be a whole number from 1 to 65535, got "${raw}"`)
  return port
}
