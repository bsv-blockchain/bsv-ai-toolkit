export const ORIGINATOR = 'tipjar.example.com'

export type Network = 'mainnet' | 'testnet'

// Testnet unless mainnet is configured explicitly.
export const network = (process.env.BSV_NETWORK ?? 'testnet') as Network
