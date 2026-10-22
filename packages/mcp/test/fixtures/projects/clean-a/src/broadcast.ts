import { Transaction, type WalletInterface } from '@bsv/sdk'

// Broadcast only through Arcade: never the SDK ARC class or the legacy /v1/tx API.
const ARCADE_URL = process.env.ARCADE_URL ?? 'https://arcade-testnet-us-1.bsvblockchain.tech'
const TIMEOUT_MS = 10000

export type TxStatus = 'SEEN_ON_NETWORK' | 'SEEN_MULTIPLE_NODES' | 'MINED' | 'REJECTED'
export interface ArcadeStatus { txid: string; txStatus: TxStatus; competingTxs?: string[]; rawTx?: string }

// Final at SEEN_ON_NETWORK or later with no competing tx; the app never waits for MINED.
const FINAL = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'STUMP_PROCESSING', 'MINED', 'IMMUTABLE'])
export const STATUS_LABELS: Record<string, string> = { SEEN_ON_NETWORK: 'Paid', MINED: 'Paid (in a block)' }

async function arcade(path: string, init: RequestInit = {}): Promise<Response> {
  const url = ARCADE_URL + path
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

export async function submit(efHex: string): Promise<string> {
  const res = await arcade('/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: efHex })
  if (!res.ok) throw new Error(`Arcade refused the transaction: HTTP ${res.status}`)
  const { txid } = (await res.json()) as { txid: string }
  return txid
}

/** A 2xx from POST /tx is provisional: read the status back before counting money. */
export async function status(txid: string): Promise<ArcadeStatus> {
  const res = await arcade('/tx/' + txid)
  return (await res.json()) as ArcadeStatus
}

export function isFinal(s: ArcadeStatus): boolean {
  return FINAL.has(s.txStatus) && !s.competingTxs?.length
}

export function statusLabel(s: ArcadeStatus): string {
  return s.txStatus === 'MINED' ? 'In a block' : STATUS_LABELS[s.txStatus] ?? 'Pending'
}

/** Arcade's rawTx is Extended Format: read it with fromHexEF. */
export function fromStatus(status: ArcadeStatus): Transaction {
  return Transaction.fromHexEF(status.rawTx ?? '')
}

/** A plain copy of an Extended Format transaction, for building BEEF. */
export function plain(rawTx: string): Transaction {
  return Transaction.fromHex(Transaction.fromHexEF(rawTx).toHex())
}

export async function receive(
  wallet: WalletInterface,
  tx: number[],
  remittance: { senderIdentityKey: string; derivationPrefix: string; derivationSuffix: string },
): Promise<void> {
  await wallet.internalizeAction({
    tx,
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: remittance }],
    description: 'Receive a tip',
  })
}
