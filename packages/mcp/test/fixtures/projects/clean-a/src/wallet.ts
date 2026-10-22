import { WalletClient } from '@bsv/sdk'
import { ORIGINATOR, network } from './config.js'

export const wallet = new WalletClient('auto', ORIGINATOR)

export async function connect(): Promise<string> {
  await wallet.waitForAuthentication()
  const { network: walletNetwork } = await wallet.getNetwork()
  if (walletNetwork !== network) throw new Error(`Wallet is on ${walletNetwork}; this app expects ${network}`)
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
