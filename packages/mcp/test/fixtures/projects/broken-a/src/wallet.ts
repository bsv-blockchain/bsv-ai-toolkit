import { WalletClient } from '@bsv/sdk'
import { ORIGINATOR } from './config.js'

export const wallet = new WalletClient('auto', ORIGINATOR)

export async function connect(): Promise<string> {
  if (!(await wallet.isAuthenticated())) throw new Error('Wallet not connected')
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return publicKey
}

export async function tip(lockingScript: string, satoshis: number): Promise<string | undefined> {
  const { txid } = await wallet.createAction({
    description: 'Send a tip',
    outputs: [{ lockingScript, satoshis, outputDescription: 'tip' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  })
  return txid
}
