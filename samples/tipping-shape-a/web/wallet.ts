import { Utils, WalletClient, type WalletInterface } from '@bsv/sdk'
import type { Network } from './config'

// The user's BRC-100 wallet holds every key; this app only asks it for public keys, signatures and actions.

/** The wallet originator: the host serving this app and /manifest.json (one origin; the SDK drops the port). */
export const ORIGINATOR = () => window.location.host

/**
 * The app's level-1 protocol, granted once by the manifest for every keyID and counterparty. Protocol names
 * must be lowercase letters, digits and single spaces, or @bsv/sdk throws at the first signature (C10).
 */
export const TIPS_PROTOCOL: [1, string] = [1, 'bsv tipping demo tips']
/** The keyID of the creator's signatures (server/auth.ts verifies with the same). */
export const SIGNATURE_KEY_ID = '1'

export interface Session {
  wallet: WalletInterface
  identityKey: string
  network: Network
}

type Connectable = WalletInterface & { connectToSubstrate?: () => Promise<void> }

/**
 * Connect wallet: find it, wait until the user has unlocked it (never isAuthenticated, which throws on a locked
 * wallet in @bsv/sdk 3.2.1), read the identity key and the wallet's network. Then raise the grouped permission
 * prompt with one harmless protected call, without waiting for it: a refusal surfaces again at the first real use.
 */
export async function login(wallet: Connectable = new WalletClient('auto', ORIGINATOR())): Promise<Session> {
  if (typeof wallet.connectToSubstrate === 'function') await wallet.connectToSubstrate()
  await wallet.waitForAuthentication({})
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  const network = await walletNetwork(wallet)
  void wallet.getPublicKey({ protocolID: TIPS_PROTOCOL, keyID: 'permissions', counterparty: 'self' }).catch(() => {})
  return { wallet, identityKey, network }
}

/** The wallet's network, read now: the user can switch networks without logging out. */
export async function walletNetwork(wallet: WalletInterface): Promise<Network> {
  const { network } = await wallet.getNetwork({})
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`the wallet reported an unknown network ${JSON.stringify(network)}`)
  return network
}

/** The banner text when the wallet and the app are on different networks, else undefined. */
export function networkMismatch(walletNet: string, appNet: string): string | undefined {
  return walletNet === appNet ? undefined : `wallet is on ${walletNet}, app is on ${appNet}`
}

/** Throws when the wallet is not on the app's network; call it before every money path. */
export function assertNetwork(walletNet: string, appNet: string): void {
  const mismatch = networkMismatch(walletNet, appNet)
  if (mismatch !== undefined) throw new Error(mismatch)
}

/** The identity key's signature (hex) over a UTF-8 message, verifiable by anyone who knows the identity key. */
export async function signText(wallet: WalletInterface, message: string): Promise<string> {
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(message, 'utf8'),
    protocolID: TIPS_PROTOCOL,
    keyID: SIGNATURE_KEY_ID,
    counterparty: 'anyone',
  })
  return Utils.toHex(signature)
}
