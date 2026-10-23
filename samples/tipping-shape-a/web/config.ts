export type Network = 'testnet' | 'mainnet'

export interface AppConfig {
  network: Network
  /** Unset until a creator is configured or claimed. */
  creatorIdentityKey?: string
  /**
   * The relay's PUBLIC_ORIGIN. Creator signatures name it (claim:<originator>:…, internalized:<originator>:…);
   * in development the page and the relay can sit on different ports, so never use location.origin instead.
   */
  originator: string
  /** Signed into the creator claim; it changes after every successful claim. Read it right before signing. */
  claimNonce: string
}

/** Reads the relay's settings (GET /api/config). The relay's BSV_NETWORK decides the app's network. */
export async function fetchConfig(fetchImpl: typeof fetch = (input, init) => fetch(input, init), base = ''): Promise<AppConfig> {
  const res = await fetchImpl(`${base}/api/config`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GET /api/config failed: HTTP ${res.status}`)
  const body = (await res.json()) as Partial<AppConfig>
  if (body.network !== 'testnet' && body.network !== 'mainnet') {
    throw new Error(`GET /api/config: unexpected network ${JSON.stringify(body.network)}`)
  }
  if (typeof body.originator !== 'string' || typeof body.claimNonce !== 'string') {
    throw new Error('GET /api/config: originator and claimNonce are required')
  }
  return {
    network: body.network,
    creatorIdentityKey: typeof body.creatorIdentityKey === 'string' ? body.creatorIdentityKey : undefined,
    originator: body.originator,
    claimNonce: body.claimNonce,
  }
}
