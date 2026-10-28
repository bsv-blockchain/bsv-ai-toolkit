import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Network } from './types.js'

export const DEFAULT_ARCADE: Record<Network, string> = {
  testnet: 'https://arcade-testnet-us-1.bsvblockchain.tech',
  mainnet: 'https://arcade-us-1.bsvblockchain.tech',
}

// Hostnames. Mirrors content/versions.json#services.arcade.hosts (a test keeps them in step),
// plus arcade.gorillapool.io on mainnet.
export const KNOWN_HOSTS: { mainnet: string[]; testnet: string[]; ttn: string[] } = {
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

export interface Config {
  network: Network
  arcadeUrl: string
  allowMainnetBroadcast: boolean
  reposDir?: string
  wocApiKey?: string
  version: string
}

// package.json sits one level above both src/ (vitest) and build/ (runtime).
export function readPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version
}

// Claude Code can pass an unset optional userConfig value through as the literal '${user_config.<key>}'.
const UNRESOLVED_PLACEHOLDER = /^\$\{[^}]*\}$/

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' || UNRESOLVED_PLACEHOLDER.test(value) ? undefined : value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = nonEmpty(env.BSV_NETWORK) ?? 'testnet'
  if (raw !== 'testnet' && raw !== 'mainnet') {
    throw new Error(`BSV_NETWORK must be "testnet" or "mainnet", got "${raw}"`)
  }
  const network: Network = raw
  const arcadeUrl = nonEmpty(env.ARCADE_URL) ?? DEFAULT_ARCADE[network]
  checkHost(network, arcadeUrl) // fail fast at startup; a ttn warning is surfaced per call by resolveNetwork
  return {
    network,
    arcadeUrl,
    allowMainnetBroadcast: env.BSV_MCP_ALLOW_MAINNET_BROADCAST === '1',
    reposDir: nonEmpty(env.BSV_REPOS_DIR),
    wocApiKey: nonEmpty(env.WOC_API_KEY),
    version: readPackageVersion(),
  }
}

export function resolveNetwork(
  input: { network?: Network; arcadeUrl?: string },
  cfg: Config,
): { network: Network; arcadeUrl: string; warning?: string } {
  const network = input.network ?? cfg.network
  // A configured ARCADE_URL belongs to the configured network; switching network without a URL uses that network's default.
  const arcadeUrl = nonEmpty(input.arcadeUrl) ?? (network === cfg.network ? cfg.arcadeUrl : DEFAULT_ARCADE[network])

  const warning = checkHost(network, arcadeUrl)
  return warning ? { network, arcadeUrl, warning } : { network, arcadeUrl }
}

// Throws on an unparseable URL or a host known to belong to the other network; returns a warning for a ttn host.
function checkHost(network: Network, arcadeUrl: string): string | undefined {
  let host: string
  try {
    // Lowercase and drop trailing dots so a fully-qualified 'host.' (or 'host%2E') cannot dodge the lists.
    host = new URL(arcadeUrl).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    throw new Error(`invalid arcadeUrl: ${arcadeUrl}`)
  }

  const other: Network = network === 'mainnet' ? 'testnet' : 'mainnet'
  if (KNOWN_HOSTS[other].includes(host)) {
    throw new Error(`network/host mismatch: ${host} is a known ${other} Arcade host, but network is ${network}`)
  }
  if (KNOWN_HOSTS.ttn.includes(host)) {
    return `ttn host: neither testnet nor mainnet (${host} is the Teranode test network)`
  }
  return undefined
}
