export interface AppConfig {
  network: 'testnet' | 'mainnet'
  /** Unset until a creator is configured or claimed. */
  creatorIdentityKey?: string
  /** The wallet originator: the origin serving this app and its manifest. */
  originator: string
  arcadeUrl: string
}

/** Reads the relay's settings (GET /api/config). The relay's BSV_NETWORK decides the app's network. */
export async function fetchConfig(fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  const res = await fetchImpl('/api/config')
  if (!res.ok) throw new Error(`GET /api/config failed: HTTP ${res.status}`)
  const body = (await res.json()) as Partial<AppConfig>
  if (body.network !== 'testnet' && body.network !== 'mainnet') {
    throw new Error(`GET /api/config: unexpected network ${JSON.stringify(body.network)}`)
  }
  if (typeof body.originator !== 'string' || typeof body.arcadeUrl !== 'string') {
    throw new Error('GET /api/config: originator and arcadeUrl are required')
  }
  return {
    network: body.network,
    creatorIdentityKey: typeof body.creatorIdentityKey === 'string' ? body.creatorIdentityKey : undefined,
    originator: body.originator,
    arcadeUrl: body.arcadeUrl,
  }
}
