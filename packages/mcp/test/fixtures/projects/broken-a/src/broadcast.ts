import { ARC, Transaction, type WalletInterface } from '@bsv/sdk'

// Deliberate violations for the broadcast and money guardrail tests (G-09 to G-21).
const ARCADE_URL = process.env.ARCADE_URL ?? 'https://arcade-testnet-us-1.bsvblockchain.tech'

export const arc = new ARC('https://arc.taal.com', { deploymentId: 'tipjar' })

export async function submit(efHex: string): Promise<string> {
  const res = await fetch(ARCADE_URL + '/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: efHex })
  const { txid } = (await res.json()) as { txid: string }
  return txid
}

export async function ancestors(txids: string[]): Promise<Transaction[]> {
  const out: Transaction[] = []
  for (const txid of txids) {
    const res = await fetch('https://api.whatsonchain.com/v1/bsv/test/tx/' + txid + '/hex')
    out.push(Transaction.fromHex(await res.text()))
  }
  return out
}

export function settle(status: { txStatus: string; rawTx: string }, credit: () => void): Transaction {
  if (status.txStatus === 'MINED') credit()
  return Transaction.fromHex(status.rawTx)
}

export const PENDING_LABEL = 'Waiting for confirmation'

export async function receive(wallet: WalletInterface, tx: number[]): Promise<void> {
  await wallet.internalizeAction({ tx, outputs: [{ outputIndex: 0, protocol: 'wallet payment' }], description: 'Receive a tip' })
}
